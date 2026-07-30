import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { SplatSource } from './splatSource.js';
import {
  createSegmentationModel,
  listSegmentationModels,
} from './segmentationModels.js';
import { createDetectionModel } from './detectionModels.js';
import {
  consolidateObjectProposals,
  DetectionSuggestionPipeline,
} from './detectionPipeline.js';
import { DetectionHud } from './detectionHud.js';
import {
  getSelectionSource,
  listSelectionSources,
} from './selectionSources.js';
import {
  createProjectionIndexSpace,
  findOccluderRevealCandidates,
  projectionSlot,
  projectSplatsAsync,
  liftProjectedMaskAsync,
} from './lift.js';
import { buildGridAsync, growAsync } from './grow.js';
import { Highlight } from './highlight.js';
import {
  buildMaskConfidence,
  combineMasks,
  offsetMask,
  paintMask,
} from './maskTools.js';
import { ObjectPreview } from './objectPreview.js';
import { HudEffects } from './hudEffects.js';
import { ClassicRegionProposer } from './classicProposals.js';
import { SegmentDock } from './segmentDock.js';
import { ScanTray } from './scanTray.js';
import {
  analyzeSelectedObject,
  generateSyntheticOrbitViews,
  syntheticViewSet,
} from './syntheticViews.js';
import {
  analyzeSceneFrame,
  buildSceneQualityMask,
  chooseHomeView,
} from './sceneNavigation.js';
import { ViewfinderControls } from './viewfinderControls.js';
import {
  buildProjectedSelectionGuidance,
  canvasToBlob,
  MaskPropagationRouter,
  ProjectedPromptPropagationProvider,
  TemporalSamTrackingProvider,
} from './maskPropagation.js';
import { refineSelectionAsync, selectionStats } from './refinement.js';
import {
  addViewEvidence,
  createViewEvidence,
  estimateRefinementTime,
  formatDuration,
  fuseViewEvidence,
  updateTimingAverage,
} from './multiviewRefinement.js';

const SAM_INPUT_MAX = 1024; // longest side handed to the encoder
const SAM_TRACKING_NATIVE = 832; // browser capture; SAM 3.1 resizes internally
const MAX_STAGED_TRACKING_BYTES = 128 * 1024 * 1024;
const VIEW_SETTLE_MS = 280;

// ---------------------------------------------------------------- scene ----

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.id = 'viewport';
renderer.domElement.dataset.selectionState = 'idle';
document.body.appendChild(renderer.domElement);
const rendererLogicalSize = new THREE.Vector2();

const scene = new THREE.Scene();
// Synthetic views use their own resident Gaussian cutout. This keeps the
// visible cockpit viewer and its depth order completely untouched.
const refinementScene = new THREE.Scene();
refinementScene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 500);
camera.position.set(0, 0, 4);
scene.add(camera);
const focusCloud = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({
    color: 0xa8fff2,
    size: 5.2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  }),
);
focusCloud.frustumCulled = false;
focusCloud.renderOrder = 650;
focusCloud.visible = false;
scene.add(focusCloud);
const worldOriginMarker = new THREE.Group();
const worldAxes = new THREE.AxesHelper(1);
const worldOriginDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.055, 12, 8),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  }),
);
worldOriginMarker.add(worldAxes, worldOriginDot);
worldOriginMarker.visible = false;
worldOriginMarker.renderOrder = 700;
scene.add(worldOriginMarker);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  invalidateEncoding();
});

// ------------------------------------------------------------ app state ----

const ui = {
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  count: document.getElementById('count'),
  total: document.getElementById('total'),
  drop: document.getElementById('drop'),
  bar: document.getElementById('bar'),
  workPanel: document.getElementById('workPanel'),
  workTitle: document.getElementById('workTitle'),
  workDetail: document.getElementById('workDetail'),
  workElapsed: document.getElementById('workElapsed'),
  workSteps: document.getElementById('workSteps'),
  workJobs: document.getElementById('workJobs'),
  projectionPip: document.getElementById('projectionPip'),
  projectionCanvas: document.getElementById('projectionCanvas'),
  projectionStatus: document.getElementById('projectionStatus'),
  projectionEmpty: document.getElementById('projectionEmpty'),
  projectionMaskTools: document.getElementById('projectionMaskTools'),
  projectionSeedLegend: document.getElementById('projectionSeedLegend'),
  projectionSeedsToggle: document.getElementById('projectionSeedsToggle'),
  projectionEditorOpen: document.getElementById('projectionEditorOpen'),
  projectionEditorBack: document.getElementById('projectionEditorBack'),
  selectionOutline: document.getElementById('selectionOutline'),
  brushCursor: document.getElementById('brushCursor'),
  detectorSuggestionLabel: document.getElementById('detectorSuggestionLabel'),
  detectorSuggestionName: document.getElementById('detectorSuggestionName'),
  detectorSuggestionScore: document.getElementById('detectorSuggestionScore'),
  objectHintHud: document.getElementById('objectHintHud'),
  openSelectionSetup: document.getElementById('openSelectionSetup'),
  encodingCue: document.getElementById('encodingCue'),
  encodingCueTitle: document.getElementById('encodingCueTitle'),
  encodingCueDetail: document.getElementById('encodingCueDetail'),
  encodingCursor: document.getElementById('encodingCursor'),
  encodingCursorLabel: document.getElementById('encodingCursorLabel'),
  selectionProps: document.getElementById('selectionProps'),
  selectionResult: document.getElementById('selectionResult'),
  selectionMeta: document.getElementById('selectionMeta'),
  componentSizeRow: document.getElementById('componentSizeRow'),
  autoProps: document.getElementById('autoProps'),
  fillProps: document.getElementById('fillProps'),
  radiusProps: document.getElementById('radiusProps'),
  fusionProps: document.getElementById('fusionProps'),
  objectPreviewHud: document.getElementById('objectPreviewHud'),
  objectPreviewViewport: document.getElementById('objectPreviewViewport'),
  objectPreviewCanvas: document.getElementById('objectPreviewCanvas'),
  objectPreviewEmpty: document.getElementById('objectPreviewEmpty'),
  objectPreviewStatus: document.getElementById('objectPreviewStatus'),
  previewRefineInside: document.getElementById('previewRefineInside'),
  undoPreview: document.getElementById('undoPreview'),
  keepPreview: document.getElementById('keepPreview'),
  previewScan: document.getElementById('previewScan'),
  previewCleanup: document.getElementById('previewCleanup'),
  previewCleanupUndo: document.getElementById('previewCleanupUndo'),
  open2dMaskEditor: document.getElementById('open2dMaskEditor'),
  startHologramCleanup: document.getElementById('startHologramCleanup'),
  previewOrbit: document.getElementById('previewOrbit'),
  previewNearby: document.getElementById('previewNearby'),
  previewLegendStrong: document.getElementById('previewLegendStrong'),
  previewLegendReview: document.getElementById('previewLegendReview'),
  previewLegendProtected: document.getElementById('previewLegendProtected'),
  previewLegendNew: document.getElementById('previewLegendNew'),
  previewLegendRemoved: document.getElementById('previewLegendRemoved'),
  changeDiffHud: document.getElementById('changeDiffHud'),
  changeDiffTitle: document.getElementById('changeDiffTitle'),
  changeDiffStats: document.getElementById('changeDiffStats'),
  changeDiffDetail: document.getElementById('changeDiffDetail'),
  multiviewGate: document.getElementById('multiviewGate'),
  multiviewCapability: document.getElementById('multiviewCapability'),
  multiviewCapabilityDetail: document.getElementById('multiviewCapabilityDetail'),
  multiviewControls: document.getElementById('multiviewControls'),
  multiviewProgress: document.querySelector('#multiviewProgress i'),
  multiviewStatus: document.getElementById('multiviewStatus'),
  multiviewReview: document.getElementById('multiviewReview'),
  multiviewCanvas: document.getElementById('multiviewCanvas'),
  multiviewReviewStatus: document.getElementById('multiviewReviewStatus'),
  multiviewAccept: document.getElementById('acceptMultiview'),
  multiviewReject: document.getElementById('rejectMultiview'),
  suggestionsToggle: document.getElementById('suggestionsToggle'),
  scanTray: document.getElementById('scanTray'),
  viewfinderMode: document.getElementById('viewfinderMode'),
  selectionMode: document.getElementById('selectionMode'),
  exploreExitHud: document.getElementById('exploreExitHud'),
  exploreExitDetail: document.getElementById('exploreExitDetail'),
  exploreSpeed: document.getElementById('exploreSpeed'),
  exploreSpeedValue: document.getElementById('exploreSpeedValue'),
  homeView: document.getElementById('homeView'),
  frameScene: document.getElementById('frameScene'),
  setHomeView: document.getElementById('setHomeView'),
  qualityFilterToggle: document.getElementById('qualityFilterToggle'),
  originToggle: document.getElementById('originToggle'),
  gpuAdapter: document.getElementById('gpuAdapter'),
  focusRefineHud: document.getElementById('focusRefineHud'),
  focusRefinePath: document.getElementById('focusRefinePath'),
  focusRefineDetail: document.getElementById('focusRefineDetail'),
};

function showGraphicsAdapter() {
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const fullName = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const normalized = String(fullName || 'unknown adapter');
  const kind = /swiftshader|llvmpipe|software/i.test(normalized)
    ? 'software'
    : /intel/i.test(normalized)
      ? 'integrated'
      : /nvidia|geforce|radeon rx|radeon pro/i.test(normalized)
        ? 'discrete'
        : 'unknown';
  const concise = normalized
    .replace(/^ANGLE \(/i, '')
    .replace(/\s+Direct3D.*$/i, '')
    .replace(/\s+vs_\d+_\d+.*$/i, '')
    .replace(/^NVIDIA,\s*/i, '')
    .replace(/^NVIDIA GeForce\s*/i, 'GeForce ')
    .replace(/\s+GPU\b/i, '')
    .replace(/\)+$/, '')
    .trim();
  ui.gpuAdapter.textContent = `GPU · ${concise || 'unknown adapter'}`;
  ui.gpuAdapter.dataset.kind = kind;
  ui.gpuAdapter.title = `${normalized}\nRequested mode: high performance`;
  return {
    name: concise || normalized,
    fullName: normalized,
    kind,
    supported: kind === 'discrete',
  };
}

function blockUnsupportedGraphics(adapter) {
  renderer.setAnimationLoop(null);
  renderer.dispose();
  const gate = document.createElement('div');
  gate.id = 'gpuGate';
  gate.setAttribute('role', 'alert');
  gate.innerHTML = `
    <article>
      <h1>Dedicated graphics required</h1>
      <p>GaussianEdit has stopped before loading the scene or AI models.</p>
      <p>Active adapter: <strong></strong></p>
      <p>Choose the dedicated NVIDIA or AMD GPU for this browser in Windows
      Graphics settings, fully restart the browser, then try again.</p>
      <button type="button">Check again</button>
    </article>
  `;
  gate.querySelector('strong').textContent = adapter.name;
  gate.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(gate);
  document.body.dataset.gpuBlocked = 'true';
  ui.status.textContent = 'dedicated GPU required';
  ui.status.className = '';
  ui.drop.style.display = 'none';
}

const graphicsAdapter = showGraphicsAdapter();
if (!graphicsAdapter.supported) {
  blockUnsupportedGraphics(graphicsAdapter);
  // bootstrap.js normally prevents this module from being imported at all.
  // Keep a fail-closed second check in case the browser changes adapters while
  // creating the real renderer.
  throw new Error(`Unsupported graphics adapter: ${graphicsAdapter.fullName}`);
}

const state = {
  splat: null,
  grid: null,
  highlight: null,
  selection: new Set(),
  confidence: null,
  locked: null,
  provisional: new Set(),
  // Review holds that a display threshold cannot override, such as geometry
  // that has not yet received support from enough independent views.
  forcedProvisional: new Set(),
  recentlyAdded: new Set(),
  focusStack: [],
  dockedSegments: [],
  activeDockSegmentId: null,
  selectionHistory: [],
  selectionActionHistory: [],
  gaussianCleanupUndo: null,
  manualExcluded: new Set(),
  active: null,      // latest editable selection operation
  extent: 'suggested',
  fillThreshold: 18,
  screenRadius: 5,
  modelQuality: 'fast',
  fusion: 'smart',
  editMode: 'off',
  projectionEditorOpen: false,
  edgeBrush: 2,
  showProjectionSeeds: false,
  polygonPoints: [],
  frozen: null,      // camera snapshot taken at encode time
  encoded: false,
  busy: false,
  busyReason: '',
  pendingSelection: null,
  exploration: false,
  explorationSpeed: 1,
  sceneFrame: null,
  automaticHome: null,
  sceneOverview: null,
  homePose: null,
  originVisible: false,
  sceneQuality: {
    available: false,
    enabled: false,
    hiddenCount: 0,
    threshold: Infinity,
  },
  objectSuggestionsEnabled: true,
  slack: 0.006,      // fraction of scene diagonal
  radius: 0.008,
  // Keep the first-click result local and responsive. Hidden surfaces are
  // discovered by the ordered SAM 3 scan instead of a large browser-side
  // neighbourhood flood through millions of Gaussians.
  steps: 3,
  minimumConfidence: 0.34,
  confirmConfidence: 0.72,
  maskOffset: 0,
  boundarySoftness: 4,
  selectionOpacity: 0.9,
  nearbyRadius: 0,
  removeDisconnected: false,
  componentSize: 24,
  gaussianCleanup: false,
  orbitSelected: {
    enabled: false,
    previousTarget: null,
  },
  nearbyContext: {
    enabled: false,
    hidden: new Set(),
  },
  multiview: {
    count: 8,
    minimumViews: 2,
    confidence: 0.64,
    propagationProfile: 'fast',
    propagationModel: null,
    trackerStatus: 'checking',
    trackerDetail: '',
    trackerDevice: '',
    trackerCheckedAt: 0,
    timing: {},
    session: null,
    restoringView: false,
  },
};
let activeSelectionTimer = 0;
let encodingRippleStartedAt = 0;
let encodingCueRevealTimer = 0;
let encodingRippleFrame = { strength: 0, phase: 0, width: 0 };
const encodingRippleTravel = new THREE.Vector3(1, 0, 0);
const encodingRippleLift = new THREE.Vector3(0, 1, 0);
const encodingRippleRight = new THREE.Vector3();
const encodingRippleUp = new THREE.Vector3();
let workKey = 'idle';
let workStartedAt = 0;
let workLastPaintAt = 0;
let recentSelectionTimer = 0;
let changeDiffHideTimer = 0;
let nextDockSegmentId = 1;
const workJobs = new Map();
let workPanelHideTimer = 0;
const viewfinder = new ViewfinderControls({
  camera,
  orbitControls: controls,
  element: renderer.domElement,
  getSceneScale: () => state.splat?.scale ?? 1,
  onViewChanged: () => markViewDirty({
    detail: 'Navigation in progress · selection will update when movement settles.',
  }),
  onRequestSelection: () => setExplorationMode(false),
  onLockChange: (locked) => {
    document.body.dataset.viewfinderLocked = String(locked);
    ui.exploreExitDetail.textContent = locked
      ? 'click to freeze this view'
      : 'click the scene for mouse look';
  },
});

function cloneCameraPose(pose) {
  if (!pose) return null;
  return {
    position: pose.position.clone(),
    target: pose.target.clone(),
    up: pose.up.clone(),
    direction: pose.direction?.clone?.() ?? null,
    distance: pose.distance ?? pose.position.distanceTo(pose.target),
    score: pose.score ?? null,
  };
}

function currentCameraPose() {
  return {
    position: camera.position.clone(),
    target: controls.target.clone(),
    up: camera.up.clone(),
    direction: camera.position.clone().sub(controls.target).normalize(),
    distance: camera.position.distanceTo(controls.target),
  };
}

function applyNavigationPose(pose, detail = 'Camera moved to Home.') {
  if (!pose || !state.splat) return;
  setOrbitSelected(false);
  camera.position.copy(pose.position);
  camera.up.copy(pose.up);
  controls.target.copy(pose.target);
  camera.lookAt(pose.target);
  camera.updateMatrixWorld(true);
  controls.update();
  markViewDirty({ force: true, detail });
}

function setExplorationMode(enabled) {
  const next = Boolean(enabled && state.splat);
  if (next === state.exploration) return;
  state.exploration = next;
  document.body.dataset.exploration = String(next);
  ui.viewfinderMode.setAttribute('aria-pressed', String(next));
  ui.selectionMode.setAttribute('aria-pressed', String(!next));
  ui.hint.innerHTML = next
    ? 'Mouse look · click to freeze this view. <kbd>W/A/S/D</kbd> fly · <kbd>Q/E</kbd> turn · <kbd>Tab</kbd> switches modes.'
    : 'Click an object to select it. <kbd>Shift</kbd>+click removes. <kbd>Tab</kbd> opens Viewfinder.';
  viewfinder.setActive(next);

  if (next) {
    clearTimeout(automaticMultiviewTimer);
    const session = state.multiview.session;
    if (session) {
      session.canceled = true;
      finishMultiviewSession(session, 'Object scan stopped for exploration');
    }
    viewRevision++;
    lastViewChangeAt = performance.now();
    clearTimeout(encodeTimer);
    encodeQueued = false;
    pendingModelViewEncode = null;
    state.pendingSelection = null;
    state.encoded = false;
    clearObjectSuggestions();
    setGaussianCleanup(false);
    if (state.highlight?.points) state.highlight.points.visible = false;
    renderer.domElement.dataset.selectionState = 'exploring';
    setStatus('exploring', 'ready');
    return;
  }

  if (state.highlight?.points) state.highlight.points.visible = true;
  renderSelectionState();
  renderer.domElement.dataset.selectionState = 'idle';
  invalidateEncoding('Exploration finished · preparing this settled view for selection.');
}

ui.viewfinderMode.addEventListener('click', (event) => {
  event.currentTarget.blur();
  setExplorationMode(true);
  viewfinder.requestLock();
});
ui.selectionMode.addEventListener('click', (event) => {
  event.currentTarget.blur();
  setExplorationMode(false);
});
ui.exploreExitHud.addEventListener('click', (event) => {
  event.currentTarget.blur();
  setExplorationMode(false);
});
ui.exploreSpeed.addEventListener('input', () => {
  state.explorationSpeed = Number(ui.exploreSpeed.value);
  viewfinder.setSpeed(state.explorationSpeed);
  ui.exploreSpeedValue.textContent = `${state.explorationSpeed.toFixed(1)}×`;
});
ui.homeView.addEventListener('click', () => {
  applyNavigationPose(state.homePose, 'Returned to the saved Home view.');
});
ui.frameScene.addEventListener('click', () => {
  applyNavigationPose(
    state.sceneOverview,
    'Framed the robust scene centre; distant outliers were ignored.',
  );
});
ui.setHomeView.addEventListener('click', () => {
  if (!state.splat) return;
  state.homePose = currentCameraPose();
  setStatus('home saved', 'ready');
});
ui.qualityFilterToggle.addEventListener('click', (event) => {
  event.currentTarget.blur();
  if (!state.splat || !state.sceneQuality.available) return;
  state.sceneQuality.enabled = !state.sceneQuality.enabled;
  state.splat.setQualityFilterEnabled(state.sceneQuality.enabled);
  ui.qualityFilterToggle.setAttribute('aria-pressed', String(state.sceneQuality.enabled));
  ui.qualityFilterToggle.textContent = state.sceneQuality.enabled ? 'Clean view on' : 'Clean view';
  setStatus(
    state.sceneQuality.enabled
      ? `${state.sceneQuality.hiddenCount.toLocaleString()} outliers hidden`
      : 'raw scene visible',
    'ready',
  );
  if (!state.exploration) {
    invalidateEncoding('Scene visibility changed · preparing the selectable projection.');
  }
});
ui.originToggle.addEventListener('click', () => {
  if (!state.splat) return;
  state.originVisible = !state.originVisible;
  worldOriginMarker.visible = state.originVisible;
  ui.originToggle.setAttribute('aria-pressed', String(state.originVisible));
  ui.originToggle.textContent = state.originVisible ? 'Hide origin' : 'Show origin';
});

const objectPreview = new ObjectPreview(renderer, ui.objectPreviewCanvas, {
  onStats(stats) {
    ui.objectPreviewStatus.textContent = stats.total ? previewStatusText(stats) : 'nothing selected';
    ui.objectPreviewEmpty.hidden = stats.total > 0;
    ui.previewLegendStrong.hidden = !stats.confirmed;
    ui.previewLegendReview.hidden = !stats.provisional;
    ui.previewLegendProtected.hidden = !stats.locked;
    ui.previewLegendNew.hidden = !stats.new;
    ui.previewLegendRemoved.hidden = !stats.removed;
  },
  onBrushStart: beginGaussianCleanupStroke,
  onBrush: removeGaussianCleanupIndices,
  onBrushEnd: finishGaussianCleanupStroke,
  onSurfacePick: focusCameraFromPreviewSurface,
});
const segmentDock = new SegmentDock(camera, renderer.domElement, {
  onInspect: inspectDockSegment,
});
const scanTray = new ScanTray(ui.scanTray, {
  getFusionTarget: () => ui.objectPreviewViewport.getBoundingClientRect(),
});
const hudEffects = new HudEffects(renderer);
const objectDetector = createDetectionModel('yolov10n');
const detectionPipeline = new DetectionSuggestionPipeline(objectDetector);
const refinedObjectDetector = createDetectionModel('yolo12s-refined');
const refinedDetectionPipeline = new DetectionSuggestionPipeline(
  refinedObjectDetector,
  {
    minimumHints: 0,
    maximumHints: 72,
    firstPassThreshold: 0.11,
    detailPassThreshold: 0.11,
  },
);
const detectionHud = new DetectionHud(ui.objectHintHud, renderer.domElement);
const classicRegionProposer = new ClassicRegionProposer();
let objectSuggestionTimer = 0;
let classicSuggestionTimer = 0;
let objectSuggestionRun = 0;
let refinedObjectSuggestionRun = 0;
let objectSuggestionRevision = -1;
let objectSuggestions = [];
let hoveredObjectSuggestion = null;
let startupSelectionModelSettled = false;

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

function setProgress(f) {
  ui.bar.hidden = f == null;
  if (f != null) ui.bar.firstElementChild.style.width = `${Math.min(1, Math.max(0, f)) * 100}%`;
}

function renderSelectionState({ recentlyAdded = state.recentlyAdded } = {}) {
  if (!state.splat || !state.highlight) {
    ui.objectPreviewHud.hidden = true;
    return;
  }
  const appearance = {
    confidence: state.confidence,
    locked: state.locked,
    provisional: state.provisional,
    confirmThreshold: state.confirmConfidence,
    recentlyAdded,
    opacity: state.selectionOpacity,
    boundarySoftness: state.boundarySoftness,
  };
  state.highlight.set(state.selection, appearance);
  objectPreview.update({
    centers: state.splat.centers,
    colors: state.splat.colors,
    sourceOpacity: state.splat.opacity,
    radii: state.splat.radii,
    grid: state.grid,
    selection: state.selection,
    viewMatrix: state.frozen?.viewMatrix,
    ...appearance,
  });
  ui.objectPreviewHud.dataset.updating = 'false';
  ui.objectPreviewHud.hidden = state.selection.size === 0;
  if (state.selection.size === 0 && state.gaussianCleanup) {
    state.gaussianCleanup = false;
    objectPreview.setEditMode('view');
    ui.previewCleanup.setAttribute('aria-pressed', 'false');
  }
  const scanning = Boolean(state.multiview.session);
  ui.previewRefineInside.disabled = state.selection.size === 0;
  ui.open2dMaskEditor.disabled = !state.active?.currentMask;
  ui.startHologramCleanup.disabled = state.selection.size === 0 || scanning;
  ui.keepPreview.disabled = state.selection.size === 0;
  ui.undoPreview.disabled = state.selectionActionHistory.length === 0;
  ui.previewCleanup.hidden = scanning;
  ui.previewCleanup.disabled = state.selection.size === 0;
  ui.previewCleanupUndo.hidden = scanning || !state.gaussianCleanupUndo;
  ui.previewCleanupUndo.disabled = !state.gaussianCleanupUndo;
  ui.previewOrbit.hidden = scanning;
  ui.previewOrbit.disabled = state.selection.size === 0;
  ui.previewNearby.hidden = scanning;
  ui.previewNearby.disabled = state.selection.size === 0;
  ui.count.textContent = state.selection.size.toLocaleString();
  const stats = selectionStats(
    state.selection,
    state.confidence,
    state.locked,
    state.confirmConfidence,
    state.provisional,
  );
  if (state.active) {
    ui.selectionResult.textContent = selectionStatusText(stats);
  }
  ui.objectPreviewHud.dataset.provisional = String(stats.provisional > 0);
  if (state.nearbyContext.enabled) {
    rebuildNearbyContextMask();
    updateDockVisibilityMask();
  }
  updateFocusRefineHud();
  refreshMultiviewCapability();
  // Selection geometry changed; do not wait for the resting cockpit cadence.
  lastCockpitRenderedAt = 0;
}

function markObjectPreviewUpdating(label = 'Updating preview…') {
  if (!state.selection.size || ui.objectPreviewHud.hidden) return;
  objectPreview.setUpdating(true);
  ui.objectPreviewHud.dataset.updating = 'true';
  ui.objectPreviewStatus.textContent = label;
}

function focusCameraFromPreviewSurface({
  index,
  position,
  centre,
  cutawayHalfSize,
}) {
  if (!state.splat || !state.selection.has(index) || !position) return;
  const surfaceNormal = estimateSelectedSurfaceNormal(
    index,
    position,
    centre,
    cutawayHalfSize,
  );
  const distance = Math.max(
    cutawayHalfSize * 1.18,
    state.splat.scale * 0.006,
    state.grid?.cell * 8 || 0,
  );
  const destination = position.clone().addScaledVector(surfaceNormal, distance);
  const direction = position.clone().sub(destination).normalize();
  applyNavigationPose({
    position: destination,
    target: position.clone(),
    up: camera.up.clone(),
    direction,
    distance,
  }, 'Camera placed on the selected surface normal.');
  setWork({
    key: `preview-surface-${index}`,
    state: 'ready',
    title: 'Viewing the chosen side',
    detail: 'The camera is aligned to the surface you clicked in the 3D cutaway.',
  });
}

function estimateSelectedSurfaceNormal(index, position, centre, cutawayHalfSize) {
  const grid = state.grid;
  const centers = state.splat.centers;
  const fallback = position.clone().sub(centre ?? controls.target);
  if (fallback.lengthSq() < 1e-12) fallback.copy(camera.position).sub(position);
  fallback.normalize();
  if (!grid?.start || !grid?.items) return fallback;

  const reach = Math.max(
    grid.cell * 2.2,
    (state.splat.radii?.[index] ?? 0) * 7,
    cutawayHalfSize * 0.045,
  );
  const ix = Math.max(0, Math.min(
    grid.nx - 1,
    Math.floor((position.x - grid.minX) / grid.cell),
  ));
  const iy = Math.max(0, Math.min(
    grid.ny - 1,
    Math.floor((position.y - grid.minY) / grid.cell),
  ));
  const iz = Math.max(0, Math.min(
    grid.nz - 1,
    Math.floor((position.z - grid.minZ) / grid.cell),
  ));
  const cellReach = Math.max(1, Math.ceil(reach / grid.cell));
  const candidates = [];
  const reach2 = reach * reach;
  for (let dz = -cellReach; dz <= cellReach; dz++) {
    const z = iz + dz;
    if (z < 0 || z >= grid.nz) continue;
    for (let dy = -cellReach; dy <= cellReach; dy++) {
      const y = iy + dy;
      if (y < 0 || y >= grid.ny) continue;
      for (let dx = -cellReach; dx <= cellReach; dx++) {
        const x = ix + dx;
        if (x < 0 || x >= grid.nx) continue;
        const cell = (z * grid.ny + y) * grid.nx + x;
        for (let cursor = grid.start[cell]; cursor < grid.start[cell + 1]; cursor++) {
          const candidate = grid.items[cursor];
          if (!state.selection.has(candidate)) continue;
          const ox = centers[candidate * 3] - position.x;
          const oy = centers[candidate * 3 + 1] - position.y;
          const oz = centers[candidate * 3 + 2] - position.z;
          const distance2 = ox * ox + oy * oy + oz * oz;
          if (distance2 <= reach2) candidates.push(candidate);
          if (candidates.length >= 96) break;
        }
        if (candidates.length >= 96) break;
      }
      if (candidates.length >= 96) break;
    }
    if (candidates.length >= 96) break;
  }
  if (candidates.length < 6) return fallback;

  const mean = new THREE.Vector3();
  for (const candidate of candidates) {
    mean.x += centers[candidate * 3];
    mean.y += centers[candidate * 3 + 1];
    mean.z += centers[candidate * 3 + 2];
  }
  mean.multiplyScalar(1 / candidates.length);
  const covariance = [0, 0, 0, 0, 0, 0];
  for (const candidate of candidates) {
    const x = centers[candidate * 3] - mean.x;
    const y = centers[candidate * 3 + 1] - mean.y;
    const z = centers[candidate * 3 + 2] - mean.z;
    covariance[0] += x * x;
    covariance[1] += x * y;
    covariance[2] += x * z;
    covariance[3] += y * y;
    covariance[4] += y * z;
    covariance[5] += z * z;
  }
  const normal = smallestSymmetricEigenvector(covariance);
  if (!normal || normal.lengthSq() < 1e-10) return fallback;
  if (normal.dot(fallback) < 0) normal.negate();
  return normal.normalize();
}

function smallestSymmetricEigenvector([xx, xy, xz, yy, yz, zz]) {
  const matrix = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iteration = 0; iteration < 12; iteration++) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(matrix[0][1]);
    for (const [row, column] of [[0, 2], [1, 2]]) {
      const value = Math.abs(matrix[row][column]);
      if (value > largest) {
        largest = value;
        p = row;
        q = column;
      }
    }
    if (largest < 1e-10) break;
    const angle = 0.5 * Math.atan2(
      2 * matrix[p][q],
      matrix[q][q] - matrix[p][p],
    );
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let column = 0; column < 3; column++) {
      const mp = matrix[p][column];
      const mq = matrix[q][column];
      matrix[p][column] = cosine * mp - sine * mq;
      matrix[q][column] = sine * mp + cosine * mq;
    }
    for (let row = 0; row < 3; row++) {
      const mp = matrix[row][p];
      const mq = matrix[row][q];
      matrix[row][p] = cosine * mp - sine * mq;
      matrix[row][q] = sine * mp + cosine * mq;
    }
    for (let row = 0; row < 3; row++) {
      const vp = vectors[row][p];
      const vq = vectors[row][q];
      vectors[row][p] = cosine * vp - sine * vq;
      vectors[row][q] = sine * vp + cosine * vq;
    }
  }
  let smallest = 0;
  if (matrix[1][1] < matrix[smallest][smallest]) smallest = 1;
  if (matrix[2][2] < matrix[smallest][smallest]) smallest = 2;
  return new THREE.Vector3(
    vectors[0][smallest],
    vectors[1][smallest],
    vectors[2][smallest],
  );
}

function previewStatusText(stats) {
  const parts = [`${stats.total.toLocaleString()} included`];
  if (stats.provisional) parts.push(`${stats.provisional.toLocaleString()} low evidence`);
  if (stats.locked) parts.push(`${stats.locked.toLocaleString()} protected`);
  return parts.join(' · ');
}

function selectionStatusText(stats) {
  const strong = Math.max(0, stats.confirmed - stats.locked);
  return previewStatusText({
    total: stats.total,
    confirmed: strong,
    provisional: stats.provisional,
    locked: stats.locked,
  });
}

function rebuildProvisionalState(selection = state.selection) {
  const provisional = new Set();
  for (const index of selection) {
    if (state.locked?.[index]) continue;
    if (state.forcedProvisional.has(index)
      || (state.confidence?.[index] ?? 0) < state.confirmConfidence) {
      provisional.add(index);
    }
  }
  state.provisional = provisional;
}

function createDockSegment() {
  const ids = Int32Array.from(state.selection);
  const confidenceValues = new Float32Array(ids.length);
  const lockedValues = new Uint8Array(ids.length);
  const provisionalValues = new Uint8Array(ids.length);
  const forcedProvisionalValues = new Uint8Array(ids.length);
  const previewConfidence = [];
  const previewLocked = [];
  const previewProvisional = new Set();
  const originalAnchor = [0, 0, 0];
  for (let ordinal = 0; ordinal < ids.length; ordinal++) {
    const index = ids[ordinal];
    const confidence = state.confidence?.[index] ?? 1;
    const locked = state.locked?.[index] ?? 0;
    const provisional = state.provisional.has(index);
    const forcedProvisional = state.forcedProvisional.has(index);
    confidenceValues[ordinal] = confidence;
    lockedValues[ordinal] = locked;
    provisionalValues[ordinal] = provisional ? 1 : 0;
    forcedProvisionalValues[ordinal] = forcedProvisional ? 1 : 0;
    previewConfidence[index] = confidence;
    previewLocked[index] = locked;
    if (provisional) previewProvisional.add(index);
    originalAnchor[0] += state.splat.centers[index * 3];
    originalAnchor[1] += state.splat.centers[index * 3 + 1];
    originalAnchor[2] += state.splat.centers[index * 3 + 2];
  }
  originalAnchor[0] /= ids.length;
  originalAnchor[1] /= ids.length;
  originalAnchor[2] /= ids.length;
  const id = nextDockSegmentId++;
  return {
    id,
    name: `Object ${id}`,
    ids,
    selection: new Set(ids),
    confidenceValues,
    lockedValues,
    provisionalValues,
    forcedProvisionalValues,
    previewConfidence,
    previewLocked,
    previewProvisional,
    confirmThreshold: state.confirmConfidence,
    active: state.active,
    viewMatrix: state.frozen?.viewMatrix?.slice?.() ?? null,
    originalAnchor,
    createdAt: performance.now(),
  };
}

function renderDockSegment(segment) {
  segmentDock.add(segment, {
    centers: state.splat.centers,
    colors: state.splat.colors,
    sourceOpacity: state.splat.opacity,
    radii: state.splat.radii,
    grid: state.grid,
  });
}

function updateDockVisibilityMask() {
  if (!state.splat) return;
  const hidden = new Set();
  for (const segment of state.dockedSegments) {
    for (const index of segment.ids) hidden.add(index);
  }
  const focus = state.focusStack.at(-1);
  if (focus) {
    for (let index = 0; index < state.splat.count; index++) {
      if (!focus.selection.has(index)) hidden.add(index);
    }
  }
  if (state.nearbyContext.enabled) {
    for (const index of state.nearbyContext.hidden) hidden.add(index);
  }
  state.splat.setHiddenSplats(hidden);
}

function rebuildNearbyContextMask() {
  state.nearbyContext.hidden.clear();
  if (!state.nearbyContext.enabled || !state.splat || !state.selection.size) return;
  const analysis = analyzeSelectedObject({
    centers: state.splat.centers,
    selection: state.selection,
    camera,
  });
  // One adaptive rule replaces another user-facing radius knob: retain the
  // object plus one object radius of surrounding scene context.
  const maximumDistance = analysis.radius * 2;
  const maximumDistanceSq = maximumDistance * maximumDistance;
  for (let index = 0; index < state.splat.count; index++) {
    if (state.selection.has(index)) continue;
    const dx = state.splat.centers[index * 3] - analysis.centre.x;
    const dy = state.splat.centers[index * 3 + 1] - analysis.centre.y;
    const dz = state.splat.centers[index * 3 + 2] - analysis.centre.z;
    if (dx * dx + dy * dy + dz * dz > maximumDistanceSq) {
      state.nearbyContext.hidden.add(index);
    }
  }
}

function setNearbyContext(enabled) {
  state.nearbyContext.enabled = Boolean(enabled && state.selection.size);
  ui.previewNearby.setAttribute('aria-pressed', String(state.nearbyContext.enabled));
  rebuildNearbyContextMask();
  updateDockVisibilityMask();
  setWork({
    key: `nearby-context-${state.nearbyContext.enabled}`,
    state: 'ready',
    title: state.nearbyContext.enabled ? 'Nearby scene shown' : 'Full scene restored',
    detail: state.nearbyContext.enabled
      ? `${state.nearbyContext.hidden.size.toLocaleString()} distant splats hidden; the object and one object-radius of context remain.`
      : 'Only docked objects remain hidden.',
  });
}

function setOrbitSelected(enabled) {
  if (!enabled || !state.splat || !state.selection.size) {
    state.orbitSelected.enabled = false;
    if (state.orbitSelected.previousTarget) {
      controls.target.copy(state.orbitSelected.previousTarget);
      controls.update();
    }
    state.orbitSelected.previousTarget = null;
    ui.previewOrbit.setAttribute('aria-pressed', 'false');
    return;
  }
  const analysis = analyzeSelectedObject({
    centers: state.splat.centers,
    selection: state.selection,
    camera,
  });
  state.orbitSelected.previousTarget = controls.target.clone();
  state.orbitSelected.enabled = true;
  controls.target.copy(analysis.centre);
  controls.update();
  ui.previewOrbit.setAttribute('aria-pressed', 'true');
  setWork({
    key: 'orbit-selected',
    state: 'ready',
    title: 'Camera centered on selected object',
    detail: 'Drag the main scene to orbit around this object. Turn Orbit selected off to restore the previous center.',
  });
}

function updateFocusRefineHud() {
  const depth = state.focusStack.length;
  ui.focusRefineHud.hidden = depth === 0;
  if (!depth) return;
  ui.focusRefinePath.textContent =
    `Scene › isolated object › refinement ${depth}`;
  ui.focusRefineDetail.textContent = state.selection.size
    ? `${state.selection.size.toLocaleString()} splats are in the current result. Refine inside again, go back, or dock it.`
    : 'Only the parent object is visible. Click the precise part you want to keep.';
}

function updateFocusCloud(selection = null) {
  if (!state.splat || !selection?.size) {
    focusCloud.visible = false;
    focusCloud.geometry.setDrawRange(0, 0);
    return;
  }
  const positions = new Float32Array(selection.size * 3);
  let ordinal = 0;
  for (const index of selection) {
    const target = ordinal++ * 3;
    positions[target] = state.splat.centers[index * 3];
    positions[target + 1] = state.splat.centers[index * 3 + 1];
    positions[target + 2] = state.splat.centers[index * 3 + 2];
  }
  focusCloud.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  focusCloud.geometry.computeBoundingSphere();
  focusCloud.geometry.setDrawRange(0, selection.size);
  focusCloud.visible = true;
}

function enterFocusedRefinement() {
  if (!state.splat || !state.selection.size) return;
  if (state.busy || state.multiview.session) {
    setWork({
      key: 'focus-waiting',
      state: 'queued',
      title: 'Isolated refinement waiting',
      detail: `Waiting for ${state.busyReason || 'the current operation'}.`,
    });
    return;
  }
  const parent = {
    ...captureSparseSelectionState({
      manualExcluded: true,
      active: true,
    }),
    active: state.active,
    cameraPosition: camera.position.clone(),
    cameraTarget: controls.target.clone(),
    cameraNear: camera.near,
    cameraFar: camera.far,
  };
  setGaussianCleanup(false);
  setNearbyContext(false);
  setOrbitSelected(false);
  state.focusStack.push(parent);

  state.selection = new Set();
  state.confidence = new Float32Array(state.splat.count);
  state.locked = new Uint8Array(state.splat.count);
  state.provisional = new Set();
  state.forcedProvisional = new Set();
  state.recentlyAdded.clear();
  state.manualExcluded.clear();
  state.gaussianCleanupUndo = null;
  dismissActiveSelection();
  state.splat.object3D.visible = true;
  updateDockVisibilityMask();
  updateFocusCloud(parent.selection);

  // Keep the exact accepted camera for the first isolated frame. The selected
  // proxy is guaranteed to remain under the user's click; changing the target
  // here can rotate a tiny or irregular selection out of view.
  renderSelectionState();
  updateFocusRefineHud();
  invalidateEncoding('Isolated object ready · preparing this focused view for selection.');
  setWork({
    key: `focus-enter-${state.focusStack.length}`,
    state: 'ready',
    title: `Refining inside object · level ${state.focusStack.length}`,
    detail: 'Only the parent object remains visible. Click a more precise part, then refine again or dock it.',
  });
}

function leaveFocusedRefinement() {
  if (!state.focusStack.length || state.busy || state.multiview.session) return;
  const parent = state.focusStack.pop();
  dismissActiveSelection();
  restoreSparseSelectionState(parent);
  state.gaussianCleanupUndo = null;
  state.active = parent.active;
  state.recentlyAdded.clear();
  camera.position.copy(parent.cameraPosition);
  controls.target.copy(parent.cameraTarget);
  camera.near = parent.cameraNear;
  camera.far = parent.cameraFar;
  camera.updateProjectionMatrix();
  controls.update();
  updateDockVisibilityMask();
  updateFocusCloud(state.focusStack.at(-1)?.selection ?? null);
  renderSelectionState();
  updateFocusRefineHud();
  if (state.active) {
    setMethodUI(state.active.sources);
    setFusionUI(state.active.fusion);
    setExtentUI(state.active.extent);
  }
  invalidateEncoding('Previous object restored · preparing its selection view.');
  setWork({
    key: `focus-back-${state.focusStack.length}`,
    state: 'ready',
    title: state.focusStack.length ? 'Previous refinement restored' : 'Returned to scene',
    detail: `${state.selection.size.toLocaleString()} splats restored exactly.`,
  });
}

function inspectDockSegment(segmentId) {
  const segment = state.dockedSegments.find((item) => item.id === segmentId);
  if (!segment || !state.splat || !state.highlight) return;
  state.activeDockSegmentId = segmentId;
  segmentDock.setActive(segmentId);
  state.highlight.clearGhost();
  state.highlight.setGhost(segment.selection);
  objectPreview.update({
    centers: state.splat.centers,
    colors: state.splat.colors,
    sourceOpacity: state.splat.opacity,
    selection: segment.selection,
    confidence: segment.previewConfidence,
    locked: segment.previewLocked,
    provisional: segment.previewProvisional,
    confirmThreshold: segment.confirmThreshold,
    viewMatrix: segment.viewMatrix,
    opacity: 0.86,
    boundarySoftness: 2,
  });
  ui.objectPreviewHud.hidden = false;
  ui.objectPreviewEmpty.hidden = true;
  ui.objectPreviewStatus.textContent =
    `cargo · ${segment.ids.length.toLocaleString()} points · origin ghost`;
  setWork({
    key: `dock-inspect-${segmentId}`,
    state: 'ready',
    title: `${segment.name} in object dock`,
    detail: 'The cyan ghost marks its exact source location. Edit returns it to the scene.',
  });
}

function clearDock() {
  segmentDock.clear();
  state.dockedSegments.length = 0;
  state.activeDockSegmentId = null;
}

function restoreDockSegment(segmentId, { openInspector = false } = {}) {
  const segmentIndex = state.dockedSegments.findIndex((item) => item.id === segmentId);
  if (segmentIndex < 0 || !state.splat) return;
  const [segment] = state.dockedSegments.splice(segmentIndex, 1);
  segmentDock.remove(segmentId);
  state.activeDockSegmentId = null;
  state.highlight?.clearGhost();

  const confidence = new Float32Array(state.splat.count);
  const locked = new Uint8Array(state.splat.count);
  const provisional = new Set();
  const forcedProvisional = new Set();
  for (let ordinal = 0; ordinal < segment.ids.length; ordinal++) {
    const index = segment.ids[ordinal];
    confidence[index] = segment.confidenceValues[ordinal];
    locked[index] = segment.lockedValues[ordinal];
    if (segment.provisionalValues?.[ordinal]) provisional.add(index);
    if (segment.forcedProvisionalValues?.[ordinal]) forcedProvisional.add(index);
  }
  state.selection = new Set(segment.ids);
  state.confidence = confidence;
  state.locked = locked;
  state.provisional = provisional;
  state.forcedProvisional = forcedProvisional;
  state.manualExcluded.clear();
  state.gaussianCleanupUndo = null;
  state.active = segment.active;
  updateDockVisibilityMask();
  renderSelectionState();

  if (openInspector && state.active) {
    setMethodUI(state.active.sources);
    setFusionUI(state.active.fusion);
    setExtentUI(state.active.extent);
    ui.selectionProps.hidden = false;
    document.body.dataset.inspector = 'true';
    if (state.active.currentMask) {
      renderSelectionOutline(
        state.active.currentMask,
        state.active.maskW,
        state.active.maskH,
      );
    }
  }
  setWork({
    key: `dock-return-${segmentId}`,
    state: 'ready',
    title: `${segment.name} returned`,
    detail: `${segment.ids.length.toLocaleString()} splats restored at their exact source positions.`,
  });
}

function showRecentlyAdded(indices) {
  clearTimeout(recentSelectionTimer);
  state.recentlyAdded = new Set(indices);
  renderSelectionState();
  if (!state.recentlyAdded.size) return;
  recentSelectionTimer = setTimeout(() => {
    state.recentlyAdded.clear();
    renderSelectionState();
  }, 1800);
}

const CONTROL_DIFF_COPY = {
  extent: {
    title: 'Object size changed',
    detail: 'Blue is newly included. Gray is leaving the previous object.',
  },
  fillThreshold: {
    title: 'Color range changed',
    detail: 'Color agreement changes which parts Auto marks as certain; it is not treated as model confidence.',
  },
  screenRadius: {
    title: 'Radius changed',
    detail: 'The radius cue changed. Auto-led uses its overlap as certainty evidence.',
  },
  source: {
    title: 'Starting method changed',
    detail: 'The selected methods were recombined and the exact 3D difference is highlighted.',
  },
  fusion: {
    title: 'Cue combination changed',
    detail: 'Auto-led keeps the learned shape; Add all expands it; Overlap only trims it.',
  },
  model: {
    title: 'Starting model changed',
    detail: 'The same click was resolved with the selected current-view model.',
  },
  border: {
    title: 'Painted edge changed',
    detail: 'The painted pixels were lifted back into the scene and hologram.',
  },
  samPrompt: {
    title: 'SAM guidance changed',
    detail: 'The keep or exclude point asked Fast SAM to redraw the visible object mask.',
  },
  polygon: {
    title: 'Point-to-point outline applied',
    detail: 'The outlined 2D area was added to or cut from the mask, then lifted into 3D.',
  },
  gaussianCleanup: {
    title: '3D splats cleaned',
    detail: 'Red splats were removed directly from the object; protected splats were preserved.',
  },
  slack: {
    title: 'Depth changed',
    detail: 'This changes how far behind the visible surface the object may continue.',
  },
  radius: {
    title: 'Connection reach changed',
    detail: 'This changes the size of gaps that connected object points may cross.',
  },
  steps: {
    title: 'Object continuation changed',
    detail: 'This changes how many neighbor-to-neighbor links the selection may follow.',
  },
  minimumConfidence: {
    title: 'Selection strictness changed',
    detail: 'Moving toward precise removes weak matches; moving toward forgiving restores them.',
  },
  confirmConfidence: {
    title: 'Strong match / review changed',
    detail: 'The selected object is unchanged; only the evidence labels and colors moved.',
  },
  maskOffset: {
    title: 'Selection edge changed',
    detail: 'Positive values expand the 2D edge; negative values pull it inward.',
  },
  boundarySoftness: {
    title: 'Uncertain edge changed',
    detail: 'This widens or narrows the amber transition near the object edge.',
  },
  selectionOpacity: {
    title: 'Highlight changed',
    detail: 'Visual only—no object points were added or removed.',
  },
  nearbyRadius: {
    title: 'Nearby points changed',
    detail: 'This admits nearby unassigned points as uncertain candidates.',
  },
  componentSize: {
    title: 'Small islands changed',
    detail: 'This controls the smallest disconnected piece that remains selected.',
  },
  removeDisconnected: {
    title: 'Stray-speck cleanup changed',
    detail: 'Small disconnected pieces are removed when cleanup is on; protected points remain.',
  },
  protection: {
    title: 'Protection changed',
    detail: 'Protected points stay selected during cleanup and later all-sides scans.',
  },
};

function beginControlDiff(controlId, title = null) {
  const active = state.active;
  if (!active || !state.splat) return;
  const copy = CONTROL_DIFF_COPY[controlId] ?? {};
  active.controlDiff = {
    controlId,
    title: title ?? copy.title ?? 'Selection changed',
    detail: copy.detail ?? 'Blue was added. Gray was removed.',
    baseSelection: new Set(state.selection),
    baseConfidence: state.confidence?.slice() ?? null,
    baseLocked: state.locked?.slice() ?? null,
    baseProvisional: new Set(state.provisional),
    baseConfirmThreshold: state.confirmConfidence,
    baseMask: active.currentMask?.slice?.() ?? null,
    released: false,
  };
  clearTimeout(changeDiffHideTimer);
}

function releaseControlDiff(controlId) {
  const diff = state.active?.controlDiff;
  if (!diff || diff.controlId !== controlId) return;
  diff.released = true;
  if (diff.published) scheduleChangeDiffHide(diff);
}

function publishControlDiff(active, currentMask = null) {
  const diff = active?.controlDiff;
  if (!diff) return;
  const added = new Set();
  const removed = new Set();
  for (const index of state.selection) {
    if (!diff.baseSelection.has(index)) added.add(index);
  }
  for (const index of diff.baseSelection) {
    if (!state.selection.has(index)) removed.add(index);
  }
  let becameCertain = 0;
  let becameUncertain = 0;
  let becameProtected = 0;
  let becameUnprotected = 0;
  const compared = new Set([...diff.baseSelection, ...state.selection]);
  for (const index of compared) {
    if (!diff.baseSelection.has(index) || !state.selection.has(index)) continue;
    const wasCertain = !diff.baseProvisional.has(index)
      && (diff.baseConfidence?.[index] ?? 0) >= diff.baseConfirmThreshold;
    const isCertain = !state.provisional.has(index)
      && (state.confidence?.[index] ?? 0) >= state.confirmConfidence;
    if (!wasCertain && isCertain) becameCertain++;
    else if (wasCertain && !isCertain) becameUncertain++;
    const wasProtected = Boolean(diff.baseLocked?.[index]);
    const isProtected = Boolean(state.locked?.[index]);
    if (!wasProtected && isProtected) becameProtected++;
    else if (wasProtected && !isProtected) becameUnprotected++;
  }
  state.recentlyAdded = added;
  renderSelectionState();
  state.highlight?.showDiff?.(added, removed);

  ui.changeDiffTitle.textContent = diff.title;
  const diffStats = [
    diffStat('added', `+${added.size.toLocaleString()} added`),
    diffStat('removed', `−${removed.size.toLocaleString()} removed`),
  ];
  if (becameCertain) {
    diffStats.push(diffStat('confirmed', `${becameCertain.toLocaleString()} became strong matches`));
  }
  if (becameUncertain) {
    diffStats.push(diffStat('uncertain', `${becameUncertain.toLocaleString()} moved to review`));
  }
  if (becameProtected) {
    diffStats.push(diffStat('protected', `${becameProtected.toLocaleString()} protected`));
  }
  if (becameUnprotected) {
    diffStats.push(diffStat('uncertain', `${becameUnprotected.toLocaleString()} unprotected`));
  }
  ui.changeDiffStats.replaceChildren(...diffStats);
  ui.changeDiffDetail.textContent = diff.detail;
  ui.changeDiffHud.hidden = false;
  diff.published = true;
  if (diff.baseMask && currentMask && diff.baseMask.length === currentMask.length) {
    renderSelectionOutline(currentMask, active.maskW, active.maskH, diff.baseMask);
  }
  if (diff.released) scheduleChangeDiffHide(diff);
}

function diffStat(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function scheduleChangeDiffHide(diff) {
  clearTimeout(changeDiffHideTimer);
  changeDiffHideTimer = setTimeout(() => {
    if (state.active?.controlDiff !== diff) return;
    state.active.controlDiff = null;
    ui.changeDiffHud.hidden = true;
    state.recentlyAdded.clear();
    renderSelectionState();
    if (state.active?.currentMask) {
      renderSelectionOutline(
        state.active.currentMask,
        state.active.maskW,
        state.active.maskH,
      );
    }
  }, 4200);
}

function pushSelectionHistory(label) {
  if (!state.splat) return;
  state.selectionHistory.push(captureSparseSelectionState({
    label,
  }));
  if (state.selectionHistory.length > 8) state.selectionHistory.shift();
}

function pushSelectionActionHistory(label = 'Selection change') {
  if (!state.splat) return;
  state.selectionActionHistory.push(captureSparseSelectionState({
    label,
    manualExcluded: true,
    active: true,
  }));
  if (state.selectionActionHistory.length > 12) state.selectionActionHistory.shift();
}

function captureSparseSelectionState({
  label = '',
  manualExcluded = false,
  active = false,
} = {}) {
  const selection = Int32Array.from(state.selection);
  const confidenceValues = new Float32Array(selection.length);
  const lockedValues = new Uint8Array(selection.length);
  for (let ordinal = 0; ordinal < selection.length; ordinal++) {
    const index = selection[ordinal];
    confidenceValues[ordinal] = state.confidence?.[index] ?? 0;
    lockedValues[ordinal] = state.locked?.[index] ?? 0;
  }
  const snapshot = {
    label,
    selection,
    confidenceValues,
    lockedValues,
    provisional: Int32Array.from(state.provisional),
    forcedProvisional: Int32Array.from(state.forcedProvisional),
    manualExcluded: manualExcluded
      ? Int32Array.from(state.manualExcluded)
      : null,
  };
  if (active) snapshot.active = state.active;
  return snapshot;
}

function restoreSparseSelectionState(snapshot) {
  const confidence = new Float32Array(state.splat.count);
  const locked = new Uint8Array(state.splat.count);
  for (let ordinal = 0; ordinal < snapshot.selection.length; ordinal++) {
    const index = snapshot.selection[ordinal];
    confidence[index] = snapshot.confidenceValues?.[ordinal] ?? 0;
    locked[index] = snapshot.lockedValues?.[ordinal] ?? 0;
  }
  state.selection = new Set(snapshot.selection);
  state.confidence = confidence;
  state.locked = locked;
  state.provisional = new Set(snapshot.provisional ?? []);
  state.forcedProvisional = new Set(snapshot.forcedProvisional ?? []);
  if (snapshot.manualExcluded) {
    state.manualExcluded = new Set(snapshot.manualExcluded);
  }
  if (Object.hasOwn(snapshot, 'active')) state.active = snapshot.active;
}

function undoLastRefinement() {
  const snapshot = state.selectionHistory.pop();
  if (!snapshot) return;
  restoreSparseSelectionState(snapshot);
  state.recentlyAdded.clear();
  renderSelectionState();
  setWork({
    key: `refinement-undone-${state.selectionHistory.length}`,
    state: 'ready',
    title: 'Refinement undone',
    detail: `${snapshot.label} reverted · ${state.selection.size.toLocaleString()} splats restored`,
  });
}

function setWork({
  key,
  state: workState = 'busy',
  title,
  detail = '',
  steps = [],
  active = -1,
}) {
  clearTimeout(workPanelHideTimer);
  ui.workPanel.hidden = false;
  const lane = workLane(key);
  const now = performance.now();
  const previous = workJobs.get(lane);
  const changed = !previous || previous.key !== key;
  workJobs.set(lane, {
    lane,
    key,
    state: workState,
    title,
    detail,
    steps,
    active,
    startedAt: changed ? now : previous.startedAt,
    updatedAt: now,
  });
  renderWorkPanel(lane);
}

function updateWorkElapsed(now) {
  const workState = ui.workPanel.dataset.state;
  if ((workState !== 'busy' && workState !== 'queued') || now - workLastPaintAt < 150) return;
  workLastPaintAt = now;
  ui.workElapsed.textContent = `${((now - workStartedAt) / 1000).toFixed(1)} s`;
  for (const output of ui.workJobs.querySelectorAll('span[data-started]')) {
    output.textContent = `${((now - +output.dataset.started) / 1000).toFixed(1)}s`;
  }
}

function workLane(key) {
  if (/^(startup-model|model-|waiting-model|waiting-scene)/.test(key)) return 'model';
  if (/^(detector|suggestions)/.test(key)) return 'detector';
  if (/^(load|demo-scene)/.test(key)) return 'scene';
  if (/^(encode|view|ready-)/.test(key)) return 'view';
  if (/^(selection|completion|border|refinement|locked)/.test(key)) return 'selection';
  if (/^(multiview|cameras)/.test(key)) return 'multiview';
  return 'system';
}

function renderWorkPanel(preferredLane) {
  const now = performance.now();
  const jobs = [...workJobs.values()];
  const activeJobs = jobs.filter((job) => job.state === 'busy' || job.state === 'queued');
  const recentJobs = jobs.filter((job) =>
    (job.state === 'ready' || job.state === 'error') && now - job.updatedAt < 3500);
  const preferred = workJobs.get(preferredLane);
  let primary = activeJobs[0] ?? preferred ?? recentJobs.at(-1);
  if (!primary) return;

  const parallel = activeJobs.length > 1;
  if (parallel) {
    const summary = summarizeActiveWork(activeJobs);
    primary = {
      ...primary,
      key: activeJobs.map((job) => job.key).join('|'),
      state: activeJobs.some((job) => job.state === 'busy') ? 'busy' : 'queued',
      title: summary.title,
      detail: summary.detail,
      steps: [],
      active: -1,
      startedAt: Math.min(...activeJobs.map((job) => job.startedAt)),
    };
  }

  const changed = primary.key !== workKey;
  workKey = primary.key;
  workStartedAt = primary.startedAt;
  ui.workPanel.dataset.state = primary.state;
  ui.workTitle.textContent = primary.title;
  ui.workDetail.textContent = primary.detail;
  if (changed || (primary.state !== 'busy' && primary.state !== 'queued')) {
    ui.workElapsed.textContent = primary.state === 'busy' || primary.state === 'queued'
      ? `${((now - primary.startedAt) / 1000).toFixed(1)} s`
      : '';
  }

  ui.workSteps.replaceChildren(...primary.steps.map((label, index) => {
    const step = document.createElement('span');
    step.textContent = label;
    step.dataset.state = index < primary.active ? 'done'
      : index === primary.active ? 'active' : 'pending';
    return step;
  }));
  ui.workSteps.hidden = !primary.steps.length || primary.state === 'ready';

  const displayedJobs = parallel
    ? [...activeJobs, ...recentJobs.filter((job) => !activeJobs.includes(job))].slice(0, 4)
    : [];
  ui.workJobs.replaceChildren(...displayedJobs.map((job) => {
    const row = document.createElement('div');
    row.dataset.state = job.state;
    const dot = document.createElement('i');
    const label = document.createElement('b');
    label.textContent = `${capitalize(job.lane)} · ${job.title}`;
    const timing = document.createElement('span');
    if (job.state === 'busy' || job.state === 'queued') {
      timing.dataset.started = String(job.startedAt);
      timing.textContent = `${((now - job.startedAt) / 1000).toFixed(1)}s`;
    } else {
      timing.textContent = job.state;
    }
    row.append(dot, label, timing);
    return row;
  }));
  ui.workJobs.hidden = displayedJobs.length < 2;

  const operational = state.splat && state.encoded && activeJobs.length === 0
    && primary.state === 'ready';
  if (operational) {
    clearTimeout(workPanelHideTimer);
    workPanelHideTimer = setTimeout(() => {
      const stillActive = [...workJobs.values()]
        .some((job) => job.state === 'busy' || job.state === 'queued');
      if (state.splat && state.encoded && !stillActive) ui.workPanel.hidden = true;
    }, 2200);
  }
}

function updateWorkDetail(lane, detail) {
  const job = workJobs.get(lane);
  if (!job) {
    ui.workDetail.textContent = detail;
    return;
  }
  job.detail = detail;
  job.updatedAt = performance.now();
  renderWorkPanel(lane);
}

function completeWorkLane(lane, title, detail = '') {
  const job = workJobs.get(lane);
  if (!job) return;
  workJobs.set(lane, {
    ...job,
    state: 'ready',
    title: title || job.title,
    detail: detail || job.detail,
    updatedAt: performance.now(),
  });
  renderWorkPanel(lane);
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function summarizeActiveWork(jobs) {
  const lanes = new Set(jobs.map((job) => job.lane));
  if (lanes.has('scene')) {
    return {
      title: 'Opening scene',
      detail: lanes.has('model')
        ? 'Loading the scene and the object-selection model.'
        : 'Loading the scene and preparing it for selection.',
    };
  }
  if (lanes.has('multiview')) {
    return {
      title: 'Refining selection',
      detail: 'Checking additional camera views and updating the 3D result.',
    };
  }
  if (lanes.has('selection')) {
    return {
      title: 'Updating selection',
      detail: lanes.has('view')
        ? 'Applying the selection and updating the current camera view.'
        : 'Applying the requested selection changes.',
    };
  }
  if (lanes.has('model') && lanes.has('view')) {
    return {
      title: 'Preparing object selection',
      detail: 'Loading the selection model and preparing the current camera view.',
    };
  }
  if (lanes.has('model') || lanes.has('detector')) {
    return {
      title: 'Automatic tools loading',
      detail: state.encoded
        ? 'Selection is ready. Auto object and hover hints are still being prepared.'
        : 'Preparing automatic object selection and hover hints.',
    };
  }
  return {
    title: 'Updating tools',
    detail: jobs.map((job) => job.title).join(' · '),
  };
}

function setBusy(reason) {
  state.busy = true;
  state.busyReason = reason;
}

function clearBusy(reason) {
  if (state.busyReason !== reason) return;
  state.busy = false;
  state.busyReason = '';
}

function setSelectionReadiness(mode, detail = '') {
  const previousMode = renderer.domElement.dataset.selectionState;
  renderer.domElement.dataset.selectionState = mode;
  // Camera motion is communicated by the traveling splat wave. Text appears
  // only once the camera has actually settled and encoding has begun.
  clearTimeout(encodingCueRevealTimer);
  ui.encodingCue.hidden = true;
  if (mode === 'error') {
    ui.encodingCue.hidden = false;
  } else if (mode === 'encoding') {
    encodingCueRevealTimer = setTimeout(() => {
      if (renderer.domElement.dataset.selectionState === 'encoding') {
        ui.encodingCue.hidden = false;
      }
    }, 420);
  }
  ui.encodingCue.dataset.state = mode;
  ui.encodingCueTitle.textContent = mode === 'error'
    ? 'Selection view unavailable'
    : 'Encoding selection view';
  ui.encodingCueDetail.textContent = detail || (mode === 'error'
    ? 'Move the camera to retry.'
    : 'Selection will be ready when this view is frozen.');
  if ((mode === 'settling' && previousMode !== 'settling')
    || (mode === 'encoding' && previousMode !== 'encoding')) {
    encodingRippleStartedAt = performance.now();
  }
  if (mode !== 'settling' && mode !== 'encoding') {
    encodingRippleFrame = { strength: 0, phase: 0, width: 0 };
    state.splat?.setEncodingRipple(0);
  }
  if (!state.pendingSelection) ui.encodingCursorLabel.textContent = 'encoding';
  ui.encodingCursor.style.display = 'none';
}

function clearHoveredObjectSuggestion() {
  hoveredObjectSuggestion = null;
  hudEffects.setSuggestion(null);
  ui.detectorSuggestionLabel.style.display = 'none';
}

function clearObjectSuggestions() {
  clearTimeout(objectSuggestionTimer);
  clearTimeout(classicSuggestionTimer);
  objectSuggestionRun++;
  refinedObjectSuggestionRun++;
  objectSuggestionRevision = -1;
  objectSuggestions = [];
  detectionHud.clear();
  if (state.objectSuggestionsEnabled) {
    ui.suggestionsToggle.textContent = 'Target scanner · waiting';
  }
  classicRegionProposer.clear();
  clearHoveredObjectSuggestion();
}

function scheduleObjectSuggestions(revision = viewRevision, delay = 0) {
  clearTimeout(objectSuggestionTimer);
  if (state.exploration || !state.objectSuggestionsEnabled
    || !state.splat || !state.encoded || state.active
    || state.multiview.session) return;
  objectSuggestionTimer = setTimeout(() => runObjectSuggestions(revision), delay);
}

let objectSuggestionInferenceRunning = false;
let refinedSuggestionInferenceRunning = false;

async function runObjectSuggestions(revision) {
  if (state.exploration || !state.objectSuggestionsEnabled || !state.encoded
    || state.active || state.multiview.session
    || revision !== viewRevision || !capture.width) return;

  // Transformers.js model setup and inference share the same browser GPU.
  // Running YOLO while SAM is compiling/encoding makes both dramatically
  // slower. Classic cached regions remain available while YOLO waits its turn.
  const model = currentSam();
  const selectionInferencePending = !startupSelectionModelSettled
    || modelViewEncodeRunning
    || (model.ready && model.viewRevision !== revision);
  if (selectionInferencePending) {
    ui.suggestionsToggle.textContent = 'Smart object hints · YOLO queued';
    setWork({
      key: `suggestions-waiting-${revision}`,
      state: 'queued',
      title: 'Object hints queued',
      detail: 'Auto object is using the graphics processor first. Nearby visual regions already highlight on hover.',
      steps: ['Auto object', 'object hints', 'cached hover'],
      active: 0,
    });
    scheduleObjectSuggestions(revision, 120);
    return;
  }

  const run = ++objectSuggestionRun;
  objectSuggestionInferenceRunning = true;
  try {
    if (!objectDetector.ready) {
      ui.suggestionsToggle.textContent = 'Smart object hints · loading YOLO';
      setWork({
        key: 'detector-model',
        state: 'busy',
        title: 'Loading object hints',
        detail: 'Downloading the small YOLO detector once; scene interaction stays available.',
        steps: ['model', 'current view', 'object hints'],
        active: 0,
      });
      await objectDetector.load((event) => {
        if (run !== objectSuggestionRun) return;
        const percent = Number.isFinite(event?.progress)
          ? ` · ${Math.round(event.progress)}%`
          : '';
        updateWorkDetail(
          'detector',
          `${event?.status === 'progress' ? 'Downloading detector' : 'Preparing detector'}${percent}`,
        );
      });
      if (run !== objectSuggestionRun || revision !== viewRevision || !state.encoded
        || state.active || state.multiview.session) return;
    }

    setWork({
      key: `suggestions-${revision}`,
      state: 'busy',
      title: 'Finding object hints',
      detail: 'Scanning the cached 2D projection once for hover suggestions.',
      steps: ['model', 'current view', 'object hints'],
      active: 1,
    });
    ui.suggestionsToggle.textContent = 'Smart object hints · YOLO scanning';
    const contentRegion = findProjectionDisplayCrop();
    const proposals = await detectionPipeline.detect(capture, {
      contentRegion,
      onPass: ({ pass, total, detections }) => {
        if (run !== objectSuggestionRun) return;
        updateWorkDetail(
          'detector',
          total > 1
            ? `Checking detail region ${pass} of ${total} · ${detections} hints so far`
            : 'Checking recognizable objects in the visible scene',
        );
      },
    });
    if (run !== objectSuggestionRun || revision !== viewRevision
      || !state.encoded || !state.objectSuggestionsEnabled
      || state.active || state.multiview.session) return;
    objectSuggestionRevision = revision;
    objectSuggestions = proposals;
    detectionHud.setDetections(proposals, capture.width, capture.height);
    ui.suggestionsToggle.textContent =
      `Target scanner · ${proposals.length} found`;
    const knownLabels = objectDetector.labels?.length ?? 0;
    ui.suggestionsToggle.title = knownLabels
      ? `YOLO currently recognizes ${knownLabels} trained categories. A cropped first pass and tiled detail passes improve small-object coverage; unknown objects still use visual-region hints.`
      : 'YOLO class hints are combined with generic visual-region hints for unfamiliar objects.';
    completeWorkLane(
      'detector',
      'Targets ready',
      proposals.length
        ? `${proposals.length} recognizable region${proposals.length === 1 ? '' : 's'} cached for this view`
        : 'No recognized YOLO classes in this view; edge-aware visual-region hints remain available.',
    );
    runRefinedObjectSuggestions(revision, contentRegion);
  } catch (error) {
    if (run !== objectSuggestionRun || revision !== viewRevision) return;
    console.warn('[detector] object hints unavailable', error);
    objectSuggestionRevision = -1;
    objectSuggestions = [];
    ui.suggestionsToggle.textContent = 'Target scanner · visual mode';
    setWork({
      key: `detector-error-${revision}`,
      state: 'error',
      title: 'Object hints unavailable',
      detail: `YOLO could not run: ${error.message}. Normal click selection is unaffected.`,
    });
  } finally {
    objectSuggestionInferenceRunning = false;
  }
}

async function runRefinedObjectSuggestions(revision, contentRegion) {
  if (state.exploration || state.active || state.multiview.session
    || !state.objectSuggestionsEnabled || revision !== viewRevision) return;
  const run = ++refinedObjectSuggestionRun;
  refinedSuggestionInferenceRunning = true;
  try {
    await refinedObjectDetector.load();
    if (run !== refinedObjectSuggestionRun || revision !== viewRevision
      || state.active || state.multiview.session || !state.encoded) return;
    const proposals = await refinedDetectionPipeline.detect(capture, {
      contentRegion,
    });
    if (run !== refinedObjectSuggestionRun || revision !== viewRevision
      || state.active || state.multiview.session || !state.encoded) return;
    objectSuggestions = consolidateObjectProposals([
      ...proposals,
      ...objectSuggestions,
    ]).sort((a, b) => b.score - a.score).slice(0, 56);
    objectSuggestionRevision = revision;
    detectionHud.setDetections(objectSuggestions, capture.width, capture.height);
    ui.suggestionsToggle.textContent =
      `Target scanner · ${objectSuggestions.length} found`;
    ui.suggestionsToggle.title =
      'Immediate target hints were checked again at higher resolution. Unknown objects still use visual-region hints.';
  } catch (error) {
    if (run === refinedObjectSuggestionRun && revision === viewRevision) {
      // Refined detection is an optional silent upgrade. Immediate target
      // hints and ordinary click selection remain authoritative.
      console.info('[detector] refined target pass skipped', error.message);
    }
  } finally {
    refinedSuggestionInferenceRunning = false;
  }
}

function isYoloSuggestion(suggestion) {
  return Boolean(suggestion?.source?.startsWith?.('yolo'));
}

function showHoveredObjectSuggestion(next, rect) {
  if (hoveredObjectSuggestion?.id === next?.id) return;
  hoveredObjectSuggestion = next;
  hudEffects.setSuggestion(next, capture.width, capture.height);
  if (!next) {
    ui.detectorSuggestionLabel.style.display = 'none';
    return;
  }
  // The fallback is a geometric/visual hover proposal, not an object class
  // predicted by a color model. Keep that implementation detail out of the
  // target label so users never mistake it for a YOLO detection.
  ui.detectorSuggestionName.textContent = next.label;
  ui.detectorSuggestionScore.textContent = isYoloSuggestion(next)
    ? `${Math.round(next.score * 100)}% match`
    : 'visual region';
  const labelX = rect.left + next.box.x1 / capture.width * rect.width;
  const labelY = rect.top + next.box.y1 / capture.height * rect.height - 5;
  ui.detectorSuggestionLabel.style.left = `${Math.max(8, labelX)}px`;
  ui.detectorSuggestionLabel.style.top = `${Math.max(24, labelY)}px`;
  ui.detectorSuggestionLabel.style.display = 'block';
}

function updateObjectSuggestionHover(event) {
  if (!state.objectSuggestionsEnabled || !state.encoded || state.active
    || classicRegionProposer.revision !== viewRevision) {
    clearTimeout(classicSuggestionTimer);
    clearHoveredObjectSuggestion();
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * capture.width;
  const y = (event.clientY - rect.top) / rect.height * capture.height;
  const matches = objectSuggestionRevision === viewRevision
    ? objectSuggestions.filter(({ box }) =>
      x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2)
    : [];
  matches.sort((a, b) => a.area - b.area || b.score - a.score);
  if (matches[0]) {
    clearTimeout(classicSuggestionTimer);
    showHoveredObjectSuggestion(matches[0], rect);
    return;
  }
  if (hoveredObjectSuggestion?.source === 'classic-fill') {
    const { box } = hoveredObjectSuggestion;
    if (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2) return;
  }
  clearHoveredObjectSuggestion();
  clearTimeout(classicSuggestionTimer);
  const revision = viewRevision;
  classicSuggestionTimer = setTimeout(() => {
    if (revision !== viewRevision || !state.encoded || state.active) return;
    const proposal = classicRegionProposer.propose(x, y);
    showHoveredObjectSuggestion(proposal, rect);
  }, 0);
}

renderer.domElement.addEventListener('pointermove', updateObjectSuggestionHover);
renderer.domElement.addEventListener('pointerleave', () => {
  clearTimeout(classicSuggestionTimer);
  clearHoveredObjectSuggestion();
});

function updateEncodingRipple(now) {
  const splat = state.splat;
  const readiness = renderer.domElement.dataset.selectionState;
  if (!splat || (readiness !== 'settling' && readiness !== 'encoding')) return;

  // One restrained screen-diagonal wavefront crosses the point cloud, then
  // leaves it completely still. A narrow spatial band avoids a whole-object
  // breathing/jelly deformation while still showing that work is continuing.
  const cycleMs = (now - encodingRippleStartedAt) % 5000;
  const activeMs = 2750;
  if (cycleMs >= activeMs) {
    encodingRippleFrame = { strength: 0, phase: 0, width: 0 };
    splat.setEncodingRipple(0);
    return;
  }

  const progress = cycleMs / activeMs;
  const ease = Math.sin(progress * Math.PI);
  const width = splat.scale * 0.034;
  encodingRippleRight.setFromMatrixColumn(camera.matrixWorld, 0);
  encodingRippleUp.setFromMatrixColumn(camera.matrixWorld, 1);
  encodingRippleTravel.copy(encodingRippleRight)
    .multiplyScalar(0.9)
    .addScaledVector(encodingRippleUp, 0.28)
    .normalize();
  encodingRippleLift.copy(encodingRippleUp).normalize();
  encodingRippleFrame = {
    strength: splat.scale * 0.0031 * ease,
    phase: splat.scale * THREE.MathUtils.lerp(-0.72, 0.72, progress),
    width,
  };
  splat.setEncodingRipple(
    encodingRippleFrame.strength,
    encodingRippleFrame.phase,
    encodingRippleFrame.width,
    encodingRippleTravel,
    encodingRippleLift,
  );
}

// ------------------------------------------------------------------ SAM ----

const sam = createSegmentationModel('fast');
const segmentationModels = new Map([['fast', sam]]);

function currentSam() {
  return segmentationModels.get(state.modelQuality) ?? sam;
}

const projectedPromptProvider = new ProjectedPromptPropagationProvider(
  () => state.multiview.propagationModel ?? currentSam(),
);
const propagationProvider = new MaskPropagationRouter({
  temporal: new TemporalSamTrackingProvider(),
  fallback: projectedPromptProvider,
});

setWork({
  key: 'startup-model',
  state: 'busy',
  title: 'Loading selection model',
  detail: 'Checking the local cache for the automatic selection model.',
  steps: ['selection model', 'scene', 'current view'],
  active: 0,
});
sam.load((p) => {
  if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
    if (!state.busyReason.startsWith('scene load')) {
      setStatus(`model ${Math.round(p.progress)}%`, 'busy');
    }
    setWork({
      key: 'startup-model',
      state: 'busy',
      title: 'Loading selection model',
      detail: `Automatic selection model · ${Math.round(p.progress)}%`,
      steps: ['selection model', 'scene', 'current view'],
      active: 0,
    });
  }
}).then(() => {
  startupSelectionModelSettled = true;
  if (!state.busyReason.startsWith('scene load')) {
    setStatus(`${sam.family} · ${sam.device}`, 'ready');
  }
  completeWorkLane(
    'model',
    'Selection model ready',
    `${sam.family} is cached and ready for this session.`,
  );
  if (state.splat && state.encoded && state.frozen?.revision === viewRevision && capture.width) {
    scheduleModelViewEncoding(sam, viewRevision, state.splat, capture);
  } else if (state.splat && !encodeRunning) {
    scheduleEncode(0);
  } else if (!state.splat) {
    setWork({
      key: 'waiting-scene',
      state: 'ready',
      title: 'Selection model cached',
      detail: 'Drop a splat file to begin.',
      steps: ['selection model', 'scene', 'current view'],
      active: 1,
    });
  }
}).catch((e) => {
  startupSelectionModelSettled = true;
  console.error(e);
  if (!state.busyReason.startsWith('scene load')) setStatus('model failed', '');
  setWork({
    key: 'startup-model-error',
    state: 'error',
    title: 'Automatic model failed to load',
    detail: 'Edge, color, and radius selection still work. Auto object can be retried later.',
  });
});

// --------------------------------------------------------- view capture ----

const capture = document.createElement('canvas');
const captureCtx = capture.getContext('2d', { willReadFrequently: true });
const currentViewReadback = {
  target: null,
  pixels: null,
  image: null,
  width: 0,
  height: 0,
};
const projectionCtx = ui.projectionCanvas.getContext('2d');
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');
const multiviewCapture = document.createElement('canvas');
const multiviewCaptureCtx = multiviewCapture.getContext('2d', { willReadFrequently: true });
const multiviewSeedCanvas = document.createElement('canvas');
const multiviewSeedCtx = multiviewSeedCanvas.getContext('2d');
const multiviewMaskCanvas = document.createElement('canvas');
const multiviewMaskCtx = multiviewMaskCanvas.getContext('2d');
const refinementCamera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
const refinementReadback = {
  target: null,
  pixels: null,
  image: null,
  width: 0,
  height: 0,
};
const scanDiagnostics = {
  current: null,
  last: null,
};
window.__gaussianEditDiagnostics = scanDiagnostics;
let projectionDisplayCrop = null;
let projectionCropRevision = -1;

function setProjectionStatus(text, stale = false) {
  ui.projectionStatus.textContent = text;
  ui.projectionPip.dataset.stale = String(stale);
}

/**
 * Show the exact frozen image used by SAM. Optional overlays make the
 * 2D -> 3D lift visible: orange is the decoded mask. Optional diagnostics can
 * reveal the front-surface Gaussian origins accepted as lift seeds.
 */
function renderProjectionPreview({
  mask = null,
  maskW = 0,
  maskH = 0,
  point = null,
  points = null,
  proj = null,
  seeds = null,
  label = 'encoded view',
  stale = false,
} = {}) {
  if (!capture.width || !capture.height) return;

  projectionDisplayCrop = findProjectionDisplayCrop();
  const crop = projectionDisplayCrop;
  const out = ui.projectionCanvas;
  const outputWidth = Math.max(1, Math.round(crop.w));
  const outputHeight = Math.max(1, Math.round(crop.h));
  if (out.width !== outputWidth || out.height !== outputHeight) {
    out.width = outputWidth;
    out.height = outputHeight;
  }
  projectionCtx.clearRect(0, 0, out.width, out.height);
  projectionCtx.drawImage(
    capture,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    out.width,
    out.height,
  );

  if (mask && maskW > 0 && maskH > 0) {
    if (maskCanvas.width !== maskW || maskCanvas.height !== maskH) {
      maskCanvas.width = maskW;
      maskCanvas.height = maskH;
    }
    const pixels = maskCtx.createImageData(maskW, maskH);
    const baselineMask = state.active?.controlDiff?.baseMask;
    const hasBaseline = baselineMask?.length === mask.length;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const added = Boolean(mask[i] && hasBaseline && !baselineMask[i]);
      const removed = Boolean(!mask[i] && hasBaseline && baselineMask[i]);
      if (!mask[i] && !removed) continue;
      pixels.data[p] = removed ? 142 : added ? 112 : 255;
      pixels.data[p + 1] = removed ? 151 : added ? 215 : 92;
      pixels.data[p + 2] = removed ? 154 : added ? 255 : 43;
      pixels.data[p + 3] = added || removed ? 138 : 104;
    }
    maskCtx.putImageData(pixels, 0, 0);
    const maskScaleX = maskW / capture.width;
    const maskScaleY = maskH / capture.height;
    projectionCtx.drawImage(
      maskCanvas,
      crop.x * maskScaleX,
      crop.y * maskScaleY,
      crop.w * maskScaleX,
      crop.h * maskScaleY,
      0,
      0,
      out.width,
      out.height,
    );
  }

  if (state.showProjectionSeeds && proj && seeds?.length && state.frozen) {
    const sourceScaleX = capture.width / state.frozen.viewW;
    const sourceScaleY = capture.height / state.frozen.viewH;
    const displayScaleX = out.width / crop.w;
    const displayScaleY = out.height / crop.h;
    // Dense scenes can produce tens of thousands of seeds. A representative
    // sample keeps this diagnostic overlay cheap and legible.
    const stride = Math.max(1, Math.ceil(seeds.length / 5000));
    projectionCtx.fillStyle = 'rgba(88, 214, 168, 0.9)';
    for (let n = 0; n < seeds.length; n += stride) {
      const i = seeds[n];
      const x = (proj.sx[i] * sourceScaleX - crop.x) * displayScaleX;
      const y = (proj.sy[i] * sourceScaleY - crop.y) * displayScaleY;
      if (x < 0 || y < 0 || x >= out.width || y >= out.height) continue;
      projectionCtx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  const markers = (points ?? (point ? [{ ...point, label: 1 }] : []))
    .map((marker) => ({
      ...marker,
      x: (marker.x - crop.x) * out.width / crop.w,
      y: (marker.y - crop.y) * out.height / crop.h,
    }));
  const boxStart = markers.find((marker) => marker.label === 2);
  const boxEnd = markers.find((marker) => marker.label === 3);
  if (boxStart && boxEnd) {
    projectionCtx.strokeStyle = '#70d7ff';
    projectionCtx.lineWidth = 2;
    projectionCtx.setLineDash([8, 5]);
    projectionCtx.strokeRect(
      boxStart.x,
      boxStart.y,
      boxEnd.x - boxStart.x,
      boxEnd.y - boxStart.y,
    );
    projectionCtx.setLineDash([]);
  }
  for (const marker of markers) {
    if (marker.label === 2 || marker.label === 3) continue;
    projectionCtx.beginPath();
    projectionCtx.arc(marker.x, marker.y, 6, 0, Math.PI * 2);
    projectionCtx.strokeStyle = '#fff';
    projectionCtx.lineWidth = 2;
    projectionCtx.stroke();
    if (marker.label === 0) {
      projectionCtx.beginPath();
      projectionCtx.moveTo(marker.x - 3, marker.y - 3);
      projectionCtx.lineTo(marker.x + 3, marker.y + 3);
      projectionCtx.moveTo(marker.x + 3, marker.y - 3);
      projectionCtx.lineTo(marker.x - 3, marker.y + 3);
      projectionCtx.strokeStyle = '#ff5c2b';
      projectionCtx.stroke();
    } else {
      projectionCtx.beginPath();
      projectionCtx.arc(marker.x, marker.y, 2, 0, Math.PI * 2);
      projectionCtx.fillStyle = '#58d6a8';
      projectionCtx.fill();
    }
  }

  ui.projectionEmpty.hidden = true;
  ui.projectionMaskTools.hidden = !Boolean(state.active?.currentMask || mask);
  ui.projectionEditorOpen.hidden = !Boolean(state.active?.currentMask)
    || state.projectionEditorOpen;
  ui.projectionEditorBack.hidden = !state.projectionEditorOpen;
  setProjectionStatus(label, stale);
  renderProjectionPolygon();
}

function projectionEventPoint(event) {
  const active = state.active;
  const crop = projectionDisplayCrop;
  const out = ui.projectionCanvas;
  const rect = out.getBoundingClientRect();
  if (!active?.currentMask || !crop || !rect.width || !rect.height) return null;

  const imageAspect = out.width / Math.max(1, out.height);
  const boxAspect = rect.width / Math.max(1, rect.height);
  let width = rect.width;
  let height = rect.height;
  let left = rect.left;
  let top = rect.top;
  if (imageAspect > boxAspect) {
    height = rect.width / imageAspect;
    top += (rect.height - height) * 0.5;
  } else {
    width = rect.height * imageAspect;
    left += (rect.width - width) * 0.5;
  }
  if (event.clientX < left || event.clientX > left + width
    || event.clientY < top || event.clientY > top + height) return null;

  const u = (event.clientX - left) / width;
  const v = (event.clientY - top) / height;
  const captureX = crop.x + u * crop.w;
  const captureY = crop.y + v * crop.h;
  return {
    captureX,
    captureY,
    maskX: captureX * active.maskW / capture.width,
    maskY: captureY * active.maskH / capture.height,
    contentWidth: width,
    contentHeight: height,
  };
}

function renderProjectionPolygon() {
  const active = state.active;
  if (!active?.currentMask || state.polygonPoints.length === 0 || !projectionDisplayCrop) return;
  const crop = projectionDisplayCrop;
  const out = ui.projectionCanvas;
  projectionCtx.save();
  projectionCtx.beginPath();
  for (let index = 0; index < state.polygonPoints.length; index++) {
    const point = state.polygonPoints[index];
    const captureX = point.x / active.maskW * capture.width;
    const captureY = point.y / active.maskH * capture.height;
    const x = (captureX - crop.x) * out.width / crop.w;
    const y = (captureY - crop.y) * out.height / crop.h;
    if (index === 0) projectionCtx.moveTo(x, y);
    else projectionCtx.lineTo(x, y);
  }
  projectionCtx.strokeStyle = state.editMode === 'polygon-remove' ? '#ef6b73' : '#70d7ff';
  projectionCtx.lineWidth = 2;
  projectionCtx.setLineDash([6, 4]);
  projectionCtx.stroke();
  projectionCtx.setLineDash([]);
  for (const point of state.polygonPoints) {
    const captureX = point.x / active.maskW * capture.width;
    const captureY = point.y / active.maskH * capture.height;
    const x = (captureX - crop.x) * out.width / crop.w;
    const y = (captureY - crop.y) * out.height / crop.h;
    projectionCtx.beginPath();
    projectionCtx.arc(x, y, 3, 0, Math.PI * 2);
    projectionCtx.fillStyle = '#eafffb';
    projectionCtx.fill();
  }
  projectionCtx.restore();
}

function findProjectionDisplayCrop() {
  if (projectionDisplayCrop && projectionCropRevision === viewRevision) {
    return projectionDisplayCrop;
  }
  const full = { x: 0, y: 0, w: capture.width, h: capture.height };
  const imageCrop = findRenderedContentCrop();
  if (imageCrop) {
    projectionCropRevision = viewRevision;
    return imageCrop;
  }
  const frozen = state.frozen;
  const projection = frozen?.revision === viewRevision ? frozen.projection : null;
  if (!projection?.nearestIndex?.length) {
    projectionCropRevision = viewRevision;
    return full;
  }

  const xs = [];
  const ys = [];
  const sourceScaleX = capture.width / frozen.viewW;
  const sourceScaleY = capture.height / frozen.viewH;
  for (const index of projection.nearestIndex) {
    if (index < 0 || projection.sd[index] <= 0) continue;
    xs.push(projection.sx[index] * sourceScaleX);
    ys.push(projection.sy[index] * sourceScaleY);
  }
  if (xs.length < 16) {
    projectionCropRevision = viewRevision;
    return full;
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const low = 0.004;
  const high = 0.996;
  let x1 = projectionQuantile(xs, low);
  let y1 = projectionQuantile(ys, low);
  let x2 = projectionQuantile(xs, high);
  let y2 = projectionQuantile(ys, high);
  const occupiedWidth = Math.max(1, x2 - x1);
  const occupiedHeight = Math.max(1, y2 - y1);
  const margin = Math.max(10, Math.max(occupiedWidth, occupiedHeight) * 0.09);
  x1 = Math.max(0, x1 - margin);
  y1 = Math.max(0, y1 - margin);
  x2 = Math.min(capture.width, x2 + margin);
  y2 = Math.min(capture.height, y2 + margin);
  projectionCropRevision = viewRevision;
  if ((x2 - x1) * (y2 - y1) > capture.width * capture.height * 0.86) return full;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function findRenderedContentCrop() {
  let pixels;
  try {
    pixels = captureCtx.getImageData(0, 0, capture.width, capture.height).data;
  } catch {
    return null;
  }
  const xCounts = new Uint32Array(capture.width);
  const yCounts = new Uint32Array(capture.height);
  const step = 2;
  let occupied = 0;
  for (let y = 0; y < capture.height; y += step) {
    const row = y * capture.width;
    for (let x = 0; x < capture.width; x += step) {
      const pixel = (row + x) * 4;
      if (pixels[pixel + 3] < 8
        || Math.max(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]) < 7) continue;
      xCounts[x]++;
      yCounts[y]++;
      occupied++;
    }
  }
  if (occupied < 24) return null;
  let x1 = weightedPixelQuantile(xCounts, occupied, 0.003);
  let x2 = weightedPixelQuantile(xCounts, occupied, 0.997) + step;
  let y1 = weightedPixelQuantile(yCounts, occupied, 0.003);
  let y2 = weightedPixelQuantile(yCounts, occupied, 0.997) + step;
  const occupiedWidth = Math.max(1, x2 - x1);
  const occupiedHeight = Math.max(1, y2 - y1);
  const margin = Math.max(10, Math.max(occupiedWidth, occupiedHeight) * 0.08);
  x1 = Math.max(0, x1 - margin);
  y1 = Math.max(0, y1 - margin);
  x2 = Math.min(capture.width, x2 + margin);
  y2 = Math.min(capture.height, y2 + margin);
  if ((x2 - x1) * (y2 - y1) > capture.width * capture.height * 0.9) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function weightedPixelQuantile(counts, total, fraction) {
  const target = total * fraction;
  let seen = 0;
  for (let index = 0; index < counts.length; index++) {
    seen += counts[index];
    if (seen >= target) return index;
  }
  return counts.length - 1;
}

function projectionQuantile(sorted, fraction) {
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const blend = position - low;
  return sorted[low] * (1 - blend) + sorted[high] * blend;
}

function resetProjectionPreview(label = 'waiting for scene') {
  projectionCtx.clearRect(0, 0, ui.projectionCanvas.width, ui.projectionCanvas.height);
  ui.projectionEmpty.hidden = false;
  ui.projectionMaskTools.hidden = true;
  ui.projectionEditorOpen.hidden = true;
  ui.projectionEditorBack.hidden = true;
  state.projectionEditorOpen = false;
  ui.projectionPip.dataset.editorOpen = 'false';
  ui.projectionCanvas.dataset.editing = 'false';
  setProjectionStatus(label, true);
}

function renderSelectionOutline(mask, w, h, baselineMask = null) {
  const canvas = ui.selectionOutline;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);

  for (let i = 0; i < mask.length; i++) {
    const added = Boolean(mask[i] && baselineMask && !baselineMask[i]);
    const removed = Boolean(!mask[i] && baselineMask?.[i]);
    if (!mask[i] && !removed) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const source = removed ? baselineMask : mask;
    const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1
      || !source[i - 1] || !source[i + 1] || !source[i - w] || !source[i + w];
    const p = i * 4;
    image.data[p] = removed ? 142 : added ? 112 : 255;
    image.data[p + 1] = removed ? 151 : added ? 215 : 92;
    image.data[p + 2] = removed ? 154 : added ? 255 : 43;
    image.data[p + 3] = edge ? 230 : (added || removed ? 78 : 4);
  }

  ctx.putImageData(image, 0, 0);
  canvas.hidden = false;
}

function clearSelectionOutline() {
  ui.selectionOutline.hidden = true;
  const ctx = ui.selectionOutline.getContext('2d');
  ctx.clearRect(0, 0, ui.selectionOutline.width, ui.selectionOutline.height);
}

function dismissActiveSelection({ hideInspector = true, preserveActive = false } = {}) {
  clearTimeout(activeSelectionTimer);
  if (!preserveActive) state.active = null;
  state.editMode = 'off';
  state.projectionEditorOpen = false;
  state.polygonPoints = [];
  ui.selectionOutline.dataset.editing = 'false';
  ui.projectionCanvas.dataset.editing = 'false';
  ui.projectionPip.dataset.editorOpen = 'false';
  ui.projectionEditorOpen.hidden = !Boolean(state.active?.currentMask);
  ui.projectionEditorBack.hidden = true;
  ui.brushCursor.style.display = 'none';
  clearSelectionOutline();
  if (!preserveActive) ui.projectionMaskTools.hidden = true;
  if (hideInspector) {
    ui.selectionProps.hidden = true;
    document.body.dataset.inspector = 'false';
  }
}

/**
 * Render one clean frame and copy it out, synchronously.
 *
 * This used to set a flag and wait two animation frames for the render loop to
 * service it. The waits and the loop are both driven by requestAnimationFrame,
 * so on the first encode the promise could win the race and hand SAM a 0x0
 * canvas — getImageData throws IndexSizeError, and because runEncode had no
 * catch, state.busy stayed true and every later encode and click was blocked.
 */
function captureSceneFrame(targetCanvas, targetContext) {
  const src = renderer.domElement;
  if (!src.width || !src.height) throw new Error('render target has no size');
  const scale = Math.min(1, SAM_INPUT_MAX / Math.max(src.width, src.height));
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  if (!currentViewReadback.target
    || currentViewReadback.width !== width
    || currentViewReadback.height !== height) {
    currentViewReadback.target?.dispose();
    currentViewReadback.target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    currentViewReadback.target.texture.colorSpace = renderer.outputColorSpace;
    currentViewReadback.pixels = new Uint8Array(width * height * 4);
    currentViewReadback.image = targetContext.createImageData(width, height);
    currentViewReadback.width = width;
    currentViewReadback.height = height;
  }

  // SAM must see the stable splats only — neither the orange overlay nor the
  // readiness ripple should become part of the model input.
  const hl = state.highlight?.points;
  const wasVisible = hl?.visible;
  const wasDockVisible = segmentDock.root.visible;
  const previousTarget = renderer.getRenderTarget();
  const previousClearColor = renderer.getClearColor(new THREE.Color());
  const previousClearAlpha = renderer.getClearAlpha();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousAutoClear = renderer.autoClear;
  if (hl) hl.visible = false;
  segmentDock.root.visible = false;
  state.splat?.setEncodingRipple(0);
  try {
    // Never render model input through the visible cockpit framebuffer. The
    // previous path briefly exposed an empty/intermediate Gaussian frame to
    // the user whenever selection encoding ran.
    state.splat.object3D.visible = true;
    renderer.setRenderTarget(currentViewReadback.target);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = false;
    renderer.clear(true, true, true);
    state.splat?.update(renderer, camera);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(
      currentViewReadback.target,
      0,
      0,
      width,
      height,
      currentViewReadback.pixels,
    );
    if (targetCanvas.width !== width || targetCanvas.height !== height) {
      targetCanvas.width = width;
      targetCanvas.height = height;
    }
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const sourceOffset = (height - 1 - y) * rowBytes;
      currentViewReadback.image.data.set(
        currentViewReadback.pixels.subarray(sourceOffset, sourceOffset + rowBytes),
        y * rowBytes,
      );
    }
    targetContext.putImageData(currentViewReadback.image, 0, 0);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.autoClear = previousAutoClear;
    if (hl) hl.visible = wasVisible;
    segmentDock.root.visible = wasDockVisible;
    state.splat?.setEncodingRipple(
      encodingRippleFrame.strength,
      encodingRippleFrame.phase,
      encodingRippleFrame.width,
    );
  }
}

let viewRevision = 0;
let encodeTimer = 0;
let encodeRunning = false;
let encodeQueued = false;
let modelViewEncodeRunning = false;
let pendingModelViewEncode = null;
let lastViewChangeAt = 0;
const lastDirtyCameraPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
const lastDirtyCameraQuaternion = new THREE.Quaternion();

function cameraPoseChangedMeaningfully() {
  const positionThreshold = Math.max((state.splat?.scale ?? 1) * 0.00002, 1e-6);
  const positionChanged = camera.position.distanceToSquared(lastDirtyCameraPosition)
    > positionThreshold * positionThreshold;
  const dot = Math.min(1, Math.abs(camera.quaternion.dot(lastDirtyCameraQuaternion)));
  const angleChanged = 2 * Math.acos(dot) > 0.00015;
  if (!positionChanged && !angleChanged) return false;
  lastDirtyCameraPosition.copy(camera.position);
  lastDirtyCameraQuaternion.copy(camera.quaternion);
  return true;
}

function markViewDirty({
  force = false,
  detail = 'Camera changed · preparing a matching selection projection.',
} = {}) {
  if (!state.splat) return;
  // Synthetic cameras never invalidate the cockpit projection, and cockpit
  // controls are frozen while a fixed tracking sequence is active. Ignore
  // stale control/end events instead of queuing unrelated encoding work.
  if (state.multiview.session && !force) return;
  if (!force && !cameraPoseChangedMeaningfully()) return;
  if (force) {
    lastDirtyCameraPosition.copy(camera.position);
    lastDirtyCameraQuaternion.copy(camera.quaternion);
  }

  viewRevision++;
  lastViewChangeAt = performance.now();
  state.encoded = false;
  clearObjectSuggestions();
  if (encodeRunning) encodeQueued = true;
  if (state.exploration) {
    state.pendingSelection = null;
    return;
  }

  const keptPreview = Boolean(state.active);
  dismissActiveSelection();
  if (state.pendingSelection) {
    state.pendingSelection = null;
    detail = 'Camera moved · the queued click was canceled to avoid selecting the wrong pixels.';
  } else if (keptPreview) {
    detail = 'Selection kept in 3D · updating the 2D selection view for this camera.';
  }

  setSelectionReadiness('settling', detail);
  setWork({
    key: `view-${viewRevision}`,
    state: encodeRunning ? 'queued' : 'busy',
    title: encodeRunning ? 'Latest camera view queued' : 'Waiting for camera to stop',
    detail: encodeRunning
      ? 'The older view will be discarded; selection will use the latest camera position.'
      : detail,
    steps: ['camera settled', 'capture view', 'prepare selection', 'link scene points'],
    active: 0,
  });
  setStatus(encodeRunning ? 'view queued' : 'settling…', 'busy');
  if (capture.width) setProjectionStatus('view changed · re-encoding', true);
  scheduleEncode();
}

function invalidateEncoding(detail) {
  markViewDirty({ force: true, detail });
}

function scheduleEncode(delay = null) {
  clearTimeout(encodeTimer);
  if (state.exploration) return;
  const remaining = Math.max(0, VIEW_SETTLE_MS - (performance.now() - lastViewChangeAt));
  encodeTimer = setTimeout(runEncode, delay ?? remaining);
}

async function runEncode() {
  const encoder = currentSam();
  if (!state.splat || state.exploration) return;
  const remaining = VIEW_SETTLE_MS - (performance.now() - lastViewChangeAt);
  if (remaining > 0) {
    scheduleEncode(remaining);
    return;
  }
  if (encodeRunning) {
    encodeQueued = true;
    setWork({
      key: `view-${viewRevision}`,
      state: 'queued',
      title: 'Current view queued',
      detail: 'Finishing the previous view, then switching to the latest camera position.',
      steps: ['camera settled', 'capture view', 'prepare selection', 'link scene points'],
      active: 0,
    });
    return;
  }
  if (state.busy) {
    setWork({
      key: `view-${viewRevision}`,
      state: 'queued',
      title: 'Current view queued',
      detail: `Waiting for ${state.busyReason || 'the current task'} to finish.`,
      steps: ['camera settled', 'capture view', 'prepare selection', 'link scene points'],
      active: 0,
    });
    scheduleEncode(80);
    return;
  }

  encodeRunning = true;
  encodeQueued = false;
  setBusy('view encoding');
  setStatus('encoding view…', 'busy');
  setSelectionReadiness('encoding', 'Freezing this camera view and preparing selection features.');
  const revision = viewRevision;
  const splat = state.splat;

  try {
    camera.updateMatrixWorld();
    const viewProj = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    setWork({
      key: `encode-${revision}`,
      state: 'busy',
      title: 'Capturing current view',
      detail: 'Creating the image used for click selection.',
      steps: ['camera settled', 'capture view', 'prepare selection', 'link scene points'],
      active: 1,
    });
    await nextFrame();
    if (revision !== viewRevision || splat !== state.splat) {
      throw new DOMException('Capture superseded', 'AbortError');
    }
    doCapture();
    renderProjectionPreview({ label: 'encoding view…', stale: true });
    setWork({
      key: `encode-${revision}`,
      state: 'busy',
      title: 'Linking scene points to this view',
      detail: 'Preparing selection immediately; Auto object can finish loading separately.',
      steps: ['camera settled', 'capture view', 'prepare selection', 'link scene points'],
      active: 2,
    });
    const projection = await projectSplatsAsync({
      centers: splat.centers,
      count: splat.count,
      viewProj: viewProj.elements,
      viewW: renderer.domElement.width,
      viewH: renderer.domElement.height,
      hidden: splat.getHiddenSplatsData(),
      radii: splat.radii,
      opacity: splat.opacity,
    }, (progress) => {
      updateWorkDetail('view', `Caching projected positions · ${Math.round(progress * 100)}%`);
    }, () => revision !== viewRevision || splat !== state.splat);

    state.frozen = {
      viewProj: viewProj.elements.slice(),
      viewMatrix: camera.matrixWorldInverse.elements.slice(),
      viewW: renderer.domElement.width,
      viewH: renderer.domElement.height,
      projection,
      revision,
    };
    state.encoded = true;
    setStatus('ready', 'ready');
    setSelectionReadiness('ready');
    setWork({
      key: `ready-${revision}`,
      state: 'ready',
      title: 'Ready to select',
      detail: state.selection.size
        ? `${state.selection.size.toLocaleString()} selected points remain pinned in 3D.`
        : encoder.viewRevision === revision
          ? 'Click the scene to create a selection.'
          : 'Click now; nearby edges provide a safe result while Auto object finishes.',
      steps: ['camera settled', 'capture view', 'prepare selection', 'link scene points'],
      active: 4,
    });
    renderProjectionPreview({ label: `${capture.width} × ${capture.height}`, stale: false });
    classicRegionProposer.prepare(capture, revision);
    scheduleModelViewEncoding(encoder, revision, splat, capture);
    scheduleObjectSuggestions(revision);
    flushPendingSelection();
  } catch (err) {
    if (err.name === 'AbortError' || revision !== viewRevision || splat !== state.splat) {
      state.encoded = false;
      setStatus('view changed…', 'busy');
      setSelectionReadiness('encoding', 'Discarded a stale result · waiting for the latest camera view.');
      setProjectionStatus('view changed · re-encoding', true);
      return;
    }
    console.error(err);
    setStatus(`encode failed: ${err.message}`, '');
    setSelectionReadiness('error', err.message);
    setWork({
      key: `encode-error-${revision}`,
      state: 'error',
      title: 'Selection encoding failed',
      detail: `${err.message} Move the camera to retry.`,
    });
    setProjectionStatus('encode failed', true);
  } finally {
    encodeRunning = false;
    clearBusy('view encoding');
    if (state.splat && !state.encoded && (encodeQueued || revision !== viewRevision)) {
      encodeQueued = false;
      scheduleEncode();
    }
  }
}

function scheduleModelViewEncoding(model, revision, splat, sourceCanvas) {
  if (state.exploration || !model?.ready || model.viewRevision === revision
    || revision !== viewRevision || splat !== state.splat
    || state.multiview.session) return;
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  canvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
  pendingModelViewEncode = {
    model,
    revision,
    splat,
    canvas,
  };
  if (!modelViewEncodeRunning) queueMicrotask(runPendingModelViewEncoding);
}

async function runPendingModelViewEncoding() {
  if (state.exploration || state.multiview.session) {
    pendingModelViewEncode = null;
    return;
  }
  if (modelViewEncodeRunning) return;
  modelViewEncodeRunning = true;
  try {
    while (pendingModelViewEncode) {
      if (state.multiview.session) {
        pendingModelViewEncode = null;
        break;
      }
      const job = pendingModelViewEncode;
      pendingModelViewEncode = null;
      if (!job.model.ready || job.revision !== viewRevision || job.splat !== state.splat) {
        continue;
      }
      setWork({
        key: `model-view-${job.model.id}-${job.revision}`,
        state: 'busy',
        title: 'Improving Auto object in the background',
        detail: 'Selection already works. Preparing the more accurate one-click object result for this view.',
        steps: ['basic selection ready', 'analyze view', 'Auto object ready'],
        active: 1,
      });
      try {
        await job.model.encode(job.canvas);
        if (job.revision !== viewRevision || job.splat !== state.splat) continue;
        job.model.viewRevision = job.revision;
        completeWorkLane(
          'model',
          'Auto object ready',
          'One-click object selection is ready for this camera view.',
        );
        scheduleObjectSuggestions(job.revision, 0);
      } catch (error) {
        console.warn('[selection] background Auto object preparation failed', error);
        setWork({
          key: `model-view-error-${job.model.id}-${job.revision}`,
          state: 'error',
          title: 'Auto object unavailable',
          detail: 'Basic edge, color, and radius selection still work. Move the camera or retry the model later.',
        });
      }
    }
  } finally {
    modelViewEncodeRunning = false;
    if (pendingModelViewEncode) queueMicrotask(runPendingModelViewEncoding);
  }
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// OrbitControls fires 'start' on pointerdown even when the camera never moves,
// so invalidating there threw away the encoding before the picker could use it
// and every selection click was dead. 'change' only fires on real movement.
controls.addEventListener('change', () => markViewDirty({
  detail: 'Camera changed · selection is paused until encoding catches up.',
}));
controls.addEventListener('end', () => {
  if (!state.encoded && !state.exploration) scheduleEncode();
});

// ----------------------------------------------------------- flythrough ----

/**
 * W/S move forward/back, A/D strafe, Q/E change heading, Ctrl/Space move
 * down/up, and Shift sprints. Translation moves camera and target together;
 * heading rotates the target around the camera without moving the camera.
 */
const keys = new Set();
const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
]);

addEventListener('keydown', (event) => {
  if (event.code !== 'Tab' || event.repeat || !state.splat) return;
  event.preventDefault();
  event.stopPropagation();
  document.activeElement?.blur?.();
  const enterViewfinder = !state.exploration;
  setExplorationMode(enterViewfinder);
  if (enterViewfinder) viewfinder.requestLock();
}, true);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.repeat) return;
  if (e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
  if (!MOVE_CODES.has(e.code)) return;
  // A clicked mode/navigation button retains DOM focus by default, which makes
  // Space activate it again instead of flying. Movement keys always transfer
  // control back to the viewport.
  if (document.activeElement?.matches?.('button')) document.activeElement.blur();
  keys.add(e.code);
  e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const moveStep = new THREE.Vector3();
const moveFwd = new THREE.Vector3();
const moveRight = new THREE.Vector3();
const headingOffset = new THREE.Vector3();
const headingRotation = new THREE.Quaternion();

function updateMovement(dt) {
  if (!keys.size || !state.splat || state.multiview.session) return;

  camera.getWorldDirection(moveFwd);
  moveRight.crossVectors(moveFwd, camera.up).normalize();

  moveStep.set(0, 0, 0);
  if (keys.has('KeyW')) moveStep.add(moveFwd);
  if (keys.has('KeyS')) moveStep.sub(moveFwd);
  if (keys.has('KeyD')) moveStep.add(moveRight);
  if (keys.has('KeyA')) moveStep.sub(moveRight);
  if (keys.has('Space')) moveStep.add(camera.up);
  if (keys.has('ControlLeft') || keys.has('ControlRight')) moveStep.sub(camera.up);

  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  if (moveStep.lengthSq() > 0) {
    moveStep.normalize().multiplyScalar(
      state.splat.scale * 0.35 * state.explorationSpeed * sprint * dt,
    );
    camera.position.add(moveStep);
    controls.target.add(moveStep);
  }

  const heading = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
  if (heading) {
    headingOffset.copy(controls.target).sub(camera.position);
    headingRotation.setFromAxisAngle(camera.up, heading * 1.35 * sprint * dt);
    headingOffset.applyQuaternion(headingRotation);
    controls.target.copy(camera.position).add(headingOffset);
  }

  if (moveStep.lengthSq() === 0 && heading === 0) return;
  markViewDirty({
    detail: 'Navigation in progress · selection will update when movement settles.',
  });
}

// -------------------------------------------------------------- picking ----

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.exploration) return;
  pointerDownAt = { x: e.clientX, y: e.clientY };
});

let pointerDownAt = null;

renderer.domElement.addEventListener('pointerup', async (e) => {
  if (e.button !== 0 || !pointerDownAt) return;
  const moved = Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y);
  pointerDownAt = null;
  if (moved > 4) return;              // that was an orbit, not a click
  if (!state.splat || state.multiview.session || state.exploration) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const intent = {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
    subtract: e.shiftKey,
    suggestion: hoveredObjectSuggestion,
    viewRevision,
  };

  if (!state.encoded || state.busy) {
    state.pendingSelection = intent;
    ui.encodingCursorLabel.textContent = 'queued';
    setWork({
      key: `queued-click-${viewRevision}`,
      state: 'queued',
      title: 'Selection click queued',
      detail: state.encoded
        ? `Waiting for ${state.busyReason || 'the current task'} to finish.`
        : 'It will run automatically when this exact camera view is selectable.',
      steps: state.encoded ? ['queued', 'mask', 'lift', 'grow'] : ['view', 'queued', 'mask', '3D'],
      active: state.encoded ? 0 : 1,
    });
    return;
  }

  await executeSelectionIntent(intent);
});

async function executeSelectionIntent(intent) {
  if (!state.splat || !state.encoded || state.busy) return;
  if (intent.viewRevision !== viewRevision) {
    setWork({
      key: `stale-click-${viewRevision}`,
      state: 'ready',
      title: 'Queued click canceled',
      detail: 'The camera changed before that click could be evaluated.',
    });
    return;
  }

  const px = intent.x * capture.width;
  const py = intent.y * capture.height;

  await beginSelection(px, py, intent.subtract, intent.suggestion);
}

function flushPendingSelection() {
  const intent = state.pendingSelection;
  if (!intent || !state.encoded || state.busy) return;
  state.pendingSelection = null;
  ui.encodingCursorLabel.textContent = 'encoding';
  queueMicrotask(() => executeSelectionIntent(intent));
}

async function beginSelection(px, py, subtract, detectorSuggestion = null) {
  pushSelectionActionHistory(subtract ? 'Remove selected region' : 'Select object');
  setProjectionEditorOpen(false);
  const operationBaseSelection = subtract
    ? new Set(state.selection)
    : new Set();
  const operationBaseConfidence = subtract
    ? state.confidence.slice()
    : new Float32Array(state.splat.count);
  const operationBaseProvisional = subtract
    ? new Set(state.provisional)
    : new Set();
  const operationBaseForcedProvisional = subtract
    ? new Set(state.forcedProvisional)
    : new Set();
  if (!state.selection.size) {
    state.manualExcluded.clear();
    state.gaussianCleanupUndo = null;
  }
  const usesYoloBox = isYoloSuggestion(detectorSuggestion);
  const usesClassicRegion = detectorSuggestion?.source === 'classic-fill';
  // YOLO identifies which target the user means, but its axis-aligned box is
  // not an object boundary. A point prompt lets SAM recover the full silhouette
  // even when the detector box is loose, truncated, or simply wrong.
  const prompts = [{ x: px, y: py, label: 1 }];
  clearHoveredObjectSuggestion();
  state.active = {
    point: { x: px, y: py },
    viewRevision,
    prompts,
    detectorSuggestion,
    baseSelection: operationBaseSelection,
    baseConfidence: operationBaseConfidence,
    baseProvisional: operationBaseProvisional,
    baseForcedProvisional: operationBaseForcedProvisional,
    subtract,
    replace: !subtract,
    sources: new Set(usesClassicRegion ? ['auto', 'fill'] : ['auto']),
    fusion: usesClassicRegion ? 'smart' : state.fusion,
    extent: state.extent,
    samResults: new Map(),
    manualEdits: null,
    currentMask: null,
    maskW: 0,
    maskH: 0,
    strokeUndo: null,
    requestToken: 1,
    liftCache: null,
    growCache: null,
    maskConfidence: null,
    modelConfidence: usesYoloBox ? detectorSuggestion.score : 0.82,
  };
  if (!subtract) {
    state.locked.fill(0);
    state.manualExcluded.clear();
    state.gaussianCleanupUndo = null;
  }
  setMethodUI(state.active.sources);
  setFusionUI(state.active.fusion);
  setBorderEditMode('off');
  setExtentUI(state.extent);
  ui.selectionProps.hidden = false;
  document.body.dataset.inspector = 'true';
  await runActiveSelection();
}

async function runActiveSelection() {
  const active = state.active;
  if (!active || !state.splat || !state.frozen) return;
  if (state.busy) {
    clearTimeout(activeSelectionTimer);
    activeSelectionTimer = setTimeout(runActiveSelection, 80);
    return;
  }

  setBusy('mask generation');
  const requestToken = active.requestToken;
  const t0 = performance.now();
  const usesModel = active.sources.has('auto');
  setStatus(usesModel ? 'finding object…' : 'selecting…', 'busy');
  ui.selectionResult.textContent = 'working…';
  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: usesModel ? 'Finding the object edge' : 'Building the starting area',
    detail: usesModel
      ? 'Matching your click to the object in the current view.'
      : 'Running the selection methods you enabled.',
    steps: ['find area', 'combine', 'map to 3D', 'finish'],
    active: 0,
  });
  renderProjectionPreview({
    points: usesModel ? active.prompts : null,
    point: active.point,
    label: usesModel ? 'finding object…' : 'building selection…',
  });

  try {
    const resolved = await Promise.all([...active.sources].map((sourceId) =>
      getSelectionSource(sourceId).resolve({
        active,
        capture,
        settings: state,
        model: currentSam(),
      })));
    if (state.active !== active || requestToken !== active.requestToken) return;

    setWork({
      key: `selection-${requestToken}`,
      state: 'busy',
      title: 'Combining selection methods',
      detail: `${resolved.length} method${resolved.length === 1 ? '' : 's'} · ${active.fusion}`,
      steps: ['find area', 'combine', 'map to 3D', 'finish'],
      active: 1,
    });
    const maskW = capture.width;
    const maskH = capture.height;
    const combinedMask = combineMasks(resolved, maskW, maskH, active.fusion);
    const mask = offsetMask(combinedMask, maskW, maskH, state.maskOffset);
    // Classic tools are deterministic geometry cues, not calibrated
    // probabilities. Never invent a confidence score for Color fill/Radius
    // and average it into a model score. They affect shape only according to
    // the explicitly selected fusion mode.
    const scoredCandidates = resolved.filter((candidate) =>
      candidate.confidenceKind !== 'deterministic'
      && Number.isFinite(candidate.confidence));
    const maskConfidence = scoredCandidates.length
      ? scoredCandidates.reduce((sum, candidate) => sum + candidate.confidence, 0)
        / scoredCandidates.length
      : 0.62;
    active.modelConfidence = isYoloSuggestion(active.detectorSuggestion)
      ? maskConfidence * 0.76 + active.detectorSuggestion.score * 0.24
      : maskConfidence;
    if (!active.manualEdits || active.manualEdits.length !== mask.length) {
      active.manualEdits = new Int8Array(mask.length);
      active.strokeUndo = null;
    }
    for (let i = 0; i < mask.length; i++) {
      if (active.manualEdits[i] > 0) mask[i] = 1;
      else if (active.manualEdits[i] < 0) mask[i] = 0;
    }
    active.currentMask = mask;
    active.maskW = maskW;
    active.maskH = maskH;
    active.resolvedSources = resolved;
    active.maskConfidence = buildMaskConfidence(
      mask,
      maskW,
      maskH,
      state.boundarySoftness,
    );
    applyClassicGuideConfidence(
      active.maskConfidence,
      mask,
      maskW,
      maskH,
      resolved,
      active.fusion,
    );
    active.maskConfidenceSoftness = state.boundarySoftness;
    active.liftCache = null;
    active.growCache = null;
    setBorderEditMode(state.editMode);

    await applySelectionMask(active, mask, maskW, maskH, requestToken);
    if (state.active !== active || requestToken !== active.requestToken) return;
    const elapsed = Math.round(performance.now() - t0);
    setStatus(`Ready · ${(elapsed / 1000).toFixed(elapsed < 1000 ? 2 : 1)}s`, 'ready');
    setWork({
      key: `selection-ready-${requestToken}`,
      state: 'ready',
      title: 'Selection preview ready',
      detail: `${ui.selectionResult.textContent} · ready to adjust or extract`,
      steps: ['find area', 'combine', 'map to 3D', 'finish'],
      active: 4,
    });
  } catch (err) {
    if (err.name === 'AbortError' || state.active !== active
      || requestToken !== active.requestToken) return;
    console.error(err);
    setStatus(`select failed: ${err.message}`, '');
    ui.selectionResult.textContent = 'failed';
    setWork({
      key: `selection-error-${requestToken}`,
      state: 'error',
      title: 'Selection failed',
      detail: err.message,
    });
  } finally {
    clearBusy('mask generation');
    if (state.active === active && requestToken === active.requestToken) {
      flushPendingSelection();
      scheduleAutomaticMultiview('Visible mask ready');
    }
  }
}

/**
 * Classic methods provide spatial agreement, not probabilities. In Auto-led
 * mode they leave the learned shape intact but lower certainty where their
 * deterministic region disagrees, so changing a classic control has an
 * honest, visible effect in both 3D views.
 */
function applyClassicGuideConfidence(confidence, mask, w, h, candidates, fusion) {
  if (fusion !== 'smart' || !candidates?.some((candidate) => candidate.role === 'primary')) {
    return;
  }
  const guides = candidates.filter((candidate) => candidate.role === 'guide');
  if (!guides.length) return;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (!mask[index]) continue;
      let agreements = 0;
      for (const guide of guides) {
        const sx = Math.min(guide.w - 1, Math.floor(x * guide.w / w));
        const sy = Math.min(guide.h - 1, Math.floor(y * guide.h / h));
        if (guide.mask[sy * guide.w + sx]) agreements++;
      }
      const agreement = agreements / guides.length;
      confidence[index] *= 0.68 + agreement * 0.32;
    }
  }
}

async function applySelectionMask(active, mask, maskW, maskH, requestToken = active.requestToken) {
  const { splat, frozen } = state;
  const scale = splat.scale;

  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: 'Mapping the visible side into 3D',
    detail: 'Matching the selected pixels to the scene points that produced them.',
    steps: ['find area', 'combine', 'map to 3D', 'finish'],
    active: 2,
  });
  await nextFrame();
  if (state.active !== active || requestToken !== active.requestToken) {
    throw new DOMException('Selection superseded', 'AbortError');
  }

  const slack = state.slack * scale;
  let lifted = active.liftCache;
  if (!lifted || lifted.mask !== mask || lifted.slack !== slack
    || lifted.projection !== frozen.projection) {
    const result = await liftProjectedMaskAsync({
      projection: frozen.projection,
      mask, maskW, maskH,
      absSlack: slack,
      relSlack: 0.01,
    }, (progress, seedCount) => {
      updateWorkDetail(
        'selection',
        `Mapping visible splats · ${Math.round(progress * 100)}% · ${seedCount.toLocaleString()} found`,
      );
    }, () => state.active !== active || requestToken !== active.requestToken);
    lifted = {
      ...result,
      mask,
      slack,
      projection: frozen.projection,
    };
    active.liftCache = lifted;
  }
  const { seeds, proj } = lifted;

  renderProjectionPreview({
    mask,
    maskW,
    maskH,
    points: active.sources.has('auto') ? active.prompts : null,
    point: active.point,
    proj,
    seeds,
    label: `${[...active.sources].map((id) => getSelectionSource(id).label).join(' + ')} · mask ready`,
  });
  renderSelectionOutline(mask, maskW, maskH, active.controlDiff?.baseMask);

  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: 'Finishing the visible side',
    detail: `${seeds.length.toLocaleString()} visible splats mapped`,
    steps: ['find area', 'map visible side', 'finish visible side'],
    active: 3,
  });
  await nextFrame();
  if (state.active !== active || requestToken !== active.requestToken) {
    throw new DOMException('Selection superseded', 'AbortError');
  }

  // A dense footprint-aware mask already supplies the surface. Launching a
  // neighborhood search from tens of thousands of seeds repeats the same
  // dense-cell queries and can take minutes. Only bridge sparse masks here;
  // hidden geometry is deliberately left to the multiview tracker.
  const bridgeSteps = seeds.length >= 8_000
    ? 0
    : seeds.length >= 2_000
      ? Math.min(1, state.steps)
      : Math.min(2, state.steps);
  const growRadius = Math.min(state.radius, 0.004) * scale;
  const depthBand = state.slack * scale * 8;
  let growCache = active.growCache;
  if (!growCache || growCache.lifted !== lifted || growCache.radius !== growRadius
    || growCache.steps !== bridgeSteps || growCache.depthBand !== depthBand) {
    const region = await growAsync({
      grid: state.grid,
      centers: splat.centers,
      colors: splat.colors,
      seeds,
      proj,
      mask, maskW, maskH,
      viewW: frozen.viewW,
      viewH: frozen.viewH,
      radius: growRadius,
      steps: bridgeSteps,
      depthBand,
    }, (progress, selectedCount) => {
      updateWorkDetail(
        'selection',
        `${selectedCount.toLocaleString()} splats in the object so far · mapping ${Math.round(progress * 100)}%`,
      );
    }, () => state.active !== active || requestToken !== active.requestToken);
    growCache = {
      lifted,
      radius: growRadius,
      steps: bridgeSteps,
      depthBand,
      region,
    };
    active.growCache = growCache;
  } else {
    updateWorkDetail(
      'selection',
      `${growCache.region.size.toLocaleString()} object splats reused`,
    );
  }
  if (state.active !== active || requestToken !== active.requestToken) {
    throw new DOMException('Selection superseded', 'AbortError');
  }

  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: 'Finishing the object preview',
    detail: 'Separating strong matches from parts that still need review.',
    steps: ['find area', 'visible side', 'hidden depth', 'finish'],
    active: 3,
  });
  const refined = await refineSelectionAsync({
    region: growCache.region,
    seeds,
    projection: proj,
    maskConfidence: active.maskConfidence,
    maskW,
    maskH,
    viewW: frozen.viewW,
    viewH: frozen.viewH,
    splat,
    grid: state.grid,
    baseSelection: active.baseSelection,
    baseConfidence: active.baseConfidence,
    subtract: active.subtract,
    locked: state.locked,
    minimumConfidence: state.minimumConfidence,
    confirmConfidence: state.confirmConfidence,
    modelConfidence: active.modelConfidence,
    includeNearbyRadius: state.nearbyRadius * scale,
    removeDisconnected: state.removeDisconnected,
    minimumComponentSize: state.componentSize,
    componentRadius: growRadius,
  }, (progress, label) => {
    updateWorkDetail('selection', `${label} · ${Math.round(progress * 100)}%`);
  }, () => state.active !== active || requestToken !== active.requestToken);
  if (state.active !== active || requestToken !== active.requestToken) {
    throw new DOMException('Selection superseded', 'AbortError');
  }
  for (const index of state.manualExcluded) {
    refined.selection.delete(index);
    refined.provisional.delete(index);
    refined.confidence[index] = 0;
  }

  const newlyIncluded = new Set();
  for (const index of refined.selection) {
    if (!state.selection.has(index)) newlyIncluded.add(index);
  }
  state.selection = refined.selection;
  state.confidence = refined.confidence;
  // Editing the current camera does not count as a new independent view.
  // Preserve explicit view-support holds, but reclassify ordinary evidence
  // against the live display threshold.
  state.forcedProvisional = new Set(
    [...(active.baseForcedProvisional ?? [])].filter((index) => state.selection.has(index)),
  );
  rebuildProvisionalState();
  active.lastRefinement = refined;
  showRecentlyAdded(newlyIncluded);
  publishControlDiff(active, mask);
  let maskPixels = 0;
  for (const value of mask) maskPixels += value;
  const maskPercent = (maskPixels / mask.length) * 100;
  const sourceLabel = [...active.sources]
    .map((id) => getSelectionSource(id).label)
    .join(' + ');
  const guidanceLabel = isYoloSuggestion(active.detectorSuggestion)
    ? `${active.detectorSuggestion.label} object hint`
    : active.detectorSuggestion ? 'nearby visual-region hint' : '';
  const guidedSourceLabel = guidanceLabel
    ? `${sourceLabel} · ${guidanceLabel}`
    : sourceLabel;
  const recoveryLabel = active.autoDiagnostics?.recovery === 'model-loading-edge-fallback'
    ? ' · Auto object is loading, so nearby edges were used for this click'
    : active.autoDiagnostics?.recovery === 'model-loading-radius-fallback'
      ? ' · Auto object is loading, so a safe local area was used for this click'
      : active.autoDiagnostics?.recovery === 'detector-box-guard'
        ? ' · the mask tried to leave the target box, so it was kept on this object'
        : active.autoDiagnostics?.recovery === 'detector-mismatch-edge-fallback'
          ? ' · Auto object missed this target, so only nearby edges inside its box were kept'
      : active.autoDiagnostics?.recovery === 'safe-local-radius'
        ? ' · first guess was too broad, so a safe local area was kept'
        : active.autoDiagnostics?.recovery
          ? ' · first guess was too broad, so nearby edges were kept'
          : '';
  const fusionLabel = active.sources.size > 1 && active.fusion === 'smart'
    ? ' · Auto-led: classic tools guide the shape without claiming confidence'
    : '';
  ui.selectionMeta.textContent =
    `${guidedSourceLabel}${recoveryLabel}${fusionLabel} · `
    + `${seeds.length.toLocaleString()} front-surface seeds · `
    + `${growCache.region.size.toLocaleString()} connected through the object`;
  ui.selectionMeta.title =
    `2D coverage ${maskPercent.toFixed(maskPercent < 1 ? 2 : 1)}% · `
    + `${refined.candidateCount.toLocaleString()} points evaluated`;
}

// ------------------------------------------------------------- loading -----

let sceneLoadRevision = 0;

async function loadSplat(url, filename) {
  const loadId = ++sceneLoadRevision;
  const busyReason = `scene load ${loadId}`;
  setBusy(busyReason);
  try {
    await loadSplatInner(url, filename, loadId);
  } catch (err) {
    if (err.name === 'AbortError' || loadId !== sceneLoadRevision) return;
    // Without this the promise just rejects into the void and the UI sits on
    // "loading splats…" forever, which is indistinguishable from a slow load.
    console.error(err);
    setStatus(`load failed: ${err.message}`, '');
    setProgress(null);
    ui.drop.style.display = '';
    setWork({
      key: `load-error-${loadId}`,
      state: 'error',
      title: 'Scene load failed',
      detail: err.message,
    });
  } finally {
    clearBusy(busyReason);
  }
}

async function loadSplatInner(url, filename, loadId) {
  for (const lane of ['scene', 'view', 'selection', 'multiview']) workJobs.delete(lane);
  setStatus('loading splats…', 'busy');
  setSelectionReadiness('idle');
  setProgress(0);
  ui.drop.style.display = 'none';
  setWork({
    key: `load-${loadId}`,
    state: 'busy',
    title: 'Opening scene',
    detail: filename,
    steps: ['scene file', '3D renderer', 'selection data', 'current view'],
    active: 0,
  });

  // Invalidate any SAM encode still running for the previous scene. Merely
  // clearing state.encoded is insufficient: an in-flight encode could finish
  // later and publish the old camera snapshot as current.
  viewRevision++;
  clearTimeout(encodeTimer);
  clearObjectSuggestions();

  // Tear the previous scene down completely. Leaving state.splat set would keep
  // the render loop driving a detached viewer, and the old highlight Points
  // would stay in the scene drawing markers at the previous scene's positions.
  clearDock();
  state.gaussianCleanup = false;
  objectPreview.setEditMode('view');
  state.orbitSelected.enabled = false;
  state.orbitSelected.previousTarget = null;
  state.nearbyContext.enabled = false;
  state.nearbyContext.hidden.clear();
  state.focusStack.length = 0;
  updateFocusCloud(null);
  updateFocusRefineHud();
  if (state.splat) {
    scene.remove(state.splat.object3D);
    state.splat.dispose();
    state.splat = null;
  }
  if (state.highlight) {
    scene.remove(state.highlight.points);
    state.highlight.dispose();
    state.highlight = null;
  }
  state.selection.clear();
  state.confidence = null;
  state.locked = null;
  state.provisional.clear();
  state.forcedProvisional.clear();
  state.recentlyAdded.clear();
  state.selectionHistory.length = 0;
  state.selectionActionHistory.length = 0;
  ui.selectionProps.dataset.scanning = 'false';
  state.calibratedViews = null;
  refreshMultiviewCapability();
  ui.objectPreviewHud.hidden = true;
  state.grid = null;
  state.sceneFrame = null;
  state.automaticHome = null;
  state.sceneOverview = null;
  state.homePose = null;
  state.originVisible = false;
  state.sceneQuality = {
    available: false,
    enabled: false,
    hiddenCount: 0,
    threshold: Infinity,
  };
  worldOriginMarker.visible = false;
  ui.qualityFilterToggle.hidden = true;
  ui.qualityFilterToggle.textContent = 'Clean view';
  ui.qualityFilterToggle.setAttribute('aria-pressed', 'false');
  ui.originToggle?.setAttribute('aria-pressed', 'false');
  if (ui.originToggle) ui.originToggle.textContent = 'Show origin';
  state.frozen = null;
  state.encoded = false;
  state.pendingSelection = null;
  for (const model of segmentationModels.values()) model.clearView?.();
  dismissActiveSelection();
  resetProjectionPreview('loading scene…');

  const t0 = performance.now();

  // Reading the file is ~60% of the wall clock, the bulk read ~30%, the grid the rest.
  const splat = await new SplatSource().load(url, { filename }, (f, label) => {
    if (loadId !== sceneLoadRevision) return;
    setProgress(f * 0.74);
    updateWorkDetail('scene', label ?? `Opening scene · ${Math.round(f * 100)}%`);
  });
  if (loadId !== sceneLoadRevision) {
    splat.dispose();
    throw new DOMException('Scene load superseded', 'AbortError');
  }
  scene.add(splat.object3D);

  const rawScale = splat.scale;
  const sceneFrame = analyzeSceneFrame(splat.centers, splat.count, splat.radii);
  updateWorkDetail('scene', 'Checking reconstruction geometry');
  const sceneQuality = await buildSceneQualityMask({
    radii: splat.radii,
    count: splat.count,
    frame: sceneFrame,
    isCanceled: () => loadId !== sceneLoadRevision,
  });
  if (loadId !== sceneLoadRevision) {
    splat.dispose();
    throw new DOMException('Scene load superseded', 'AbortError');
  }
  splat.setQualityHiddenSplats(sceneQuality.mask, sceneQuality.recommended);
  state.sceneQuality = {
    available: sceneQuality.hiddenCount > 0,
    enabled: sceneQuality.recommended,
    hiddenCount: sceneQuality.hiddenCount,
    threshold: sceneQuality.threshold,
  };
  ui.qualityFilterToggle.hidden = !state.sceneQuality.available;
  ui.qualityFilterToggle.setAttribute('aria-pressed', String(state.sceneQuality.enabled));
  ui.qualityFilterToggle.textContent = state.sceneQuality.enabled ? 'Clean view on' : 'Clean view';
  ui.qualityFilterToggle.title = state.sceneQuality.available
    ? `${state.sceneQuality.hiddenCount.toLocaleString()} abnormally oversized reconstruction splats can be hidden temporarily. No data is deleted.`
    : 'No oversized reconstruction splats were detected.';
  splat.rawScale = rawScale;
  splat.robustBounds = sceneFrame.bounds.clone();
  splat.scale = sceneFrame.scale;
  state.sceneFrame = sceneFrame;
  // 3DGS .ply scenes are authored Y-down, so three.js's default +Y up renders
  // them inverted. Flip if your data comes from a Y-up pipeline instead.
  camera.up.set(0, -1, 0);
  camera.near = splat.scale / 1000;   // clip planes sized to the scene, not hardcoded
  camera.far = splat.scale * 20;
  const sceneOverview = chooseHomeView({
    frame: sceneFrame,
    fov: camera.fov,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
    up: camera.up,
  });
  const automaticHome = sceneOverview;
  state.sceneOverview = cloneCameraPose(sceneOverview);
  state.automaticHome = cloneCameraPose(automaticHome);
  state.homePose = cloneCameraPose(automaticHome);
  camera.position.copy(automaticHome.position);
  camera.up.copy(automaticHome.up);
  controls.target.copy(automaticHome.target);
  camera.lookAt(automaticHome.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  controls.update();
  worldOriginMarker.scale.setScalar(Math.max(sceneFrame.scale * 0.075, 1e-5));

  state.splat = splat;
  state.confidence = new Float32Array(splat.count);
  state.locked = new Uint8Array(splat.count);

  setStatus('preparing selection…', 'busy');
  setProgress(0.74);
  setWork({
    key: `load-${loadId}`,
    state: 'busy',
    title: 'Preparing fast 3D selection',
    detail: 'Organizing scene points so selection can expand through the object.',
    steps: ['scene file', '3D renderer', 'selection data', 'current view'],
    active: 2,
  });
  await nextFrame();

  const tGrid = performance.now();
  const grid = await buildGridAsync(
    splat.centers,
    splat.count,
    splat.scale * 0.01,
    (progress, label) => {
      if (loadId !== sceneLoadRevision) return;
      setProgress(0.74 + progress * 0.24);
      const stage = {
        'measuring scene': 'Measuring scene',
        'binning splats': 'Organizing scene points',
        'linking cells': 'Linking nearby points',
        'finalizing index': 'Finishing selection data',
        'index ready': 'Selection data ready',
      }[label] ?? 'Preparing selection data';
      updateWorkDetail('scene', `${stage} · ${Math.round(progress * 100)}%`);
    },
    () => loadId !== sceneLoadRevision,
    sceneFrame.bounds,
  );
  if (loadId !== sceneLoadRevision) throw new DOMException('Scene load superseded', 'AbortError');
  state.grid = grid;
  console.log(`[splat] grid: ${Math.round(performance.now() - tGrid)} ms`);

  state.highlight = new Highlight(splat.centers);
  scene.add(state.highlight.points);

  ui.total.textContent = splat.count.toLocaleString();
  ui.count.textContent = '0';
  setProgress(null);
  console.log(`[splat] total load: ${Math.round(performance.now() - t0)} ms`);
  completeWorkLane(
    'scene',
    'Scene ready',
    `${splat.count.toLocaleString()} Gaussian points loaded`,
  );
  // Loading ends in flight/exploration mode. Projection, detector, and model
  // work starts only after the user returns to selection, using the final
  // camera pose they settled on.
  setExplorationMode(true);
  setSelectionReadiness('exploring');
  setWork({
    key: `load-${loadId}`,
    state: 'ready',
    title: 'Scene ready',
    detail: 'Explore freely. Return to selection when you have found a useful view.',
  });
}

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  loadSplat(url, f.name).finally(() => URL.revokeObjectURL(url));
});

async function autoLoadDevelopmentPly() {
  if (!import.meta.env.DEV || state.splat || sceneLoadRevision) return;
  try {
    const requestedFile = new URLSearchParams(location.search).get('demo');
    const query = requestedFile ? `?file=${encodeURIComponent(requestedFile)}` : '';
    const response = await fetch(`/__demo__/info${query}`, { cache: 'no-store' });
    if (!response.ok) return;
    const demo = await response.json();
    if (!demo?.filename || state.splat || sceneLoadRevision) return;
    setWork({
      key: 'demo-scene',
      state: 'queued',
      title: 'Loading demo scene',
      detail: `${demo.filename} · ${(demo.bytes / 1_048_576).toFixed(1)} MB`,
      steps: ['read', 'build', 'index', 'encode'],
      active: 0,
    });
    await loadSplat(`/__demo__/random.ply${query}`, demo.filename);
  } catch (error) {
    console.warn('[demo] automatic Downloads PLY load skipped', error);
  }
}

function doCapture() {
  captureSceneFrame(capture, captureCtx);
}

autoLoadDevelopmentPly();

// ------------------------------------------------------------------ UI -----

const selectionMethod = document.getElementById('selectionMethod');
const selectionSources = listSelectionSources();
for (const source of selectionSources) {
  const button = document.createElement('button');
  button.dataset.method = source.id;
  button.textContent = source.label;
  button.dataset.tip = source.description;
  button.setAttribute('aria-pressed', String(source.id === 'auto'));
  selectionMethod.appendChild(button);
}
const methodButtons = [...document.querySelectorAll('#selectionMethod button')];
const extentButtons = [...document.querySelectorAll('#extent button')];
const fusionButtons = [...document.querySelectorAll('#fusionMode button')];
const borderModeButtons = [...document.querySelectorAll(
  '#borderMode button, #samPointMode button, #polygonMode button',
)];
const finishPolygonButton = document.getElementById('finishPolygon');
const cancelPolygonButton = document.getElementById('cancelPolygon');
const modelQuality = document.getElementById('modelQuality');
const modelProviders = listSegmentationModels();
for (const provider of modelProviders) {
  const button = document.createElement('button');
  button.dataset.model = provider.id;
  button.textContent = provider.label;
  button.dataset.tip = provider.description;
  button.setAttribute('aria-pressed', String(provider.id === state.modelQuality));
  modelQuality.appendChild(button);
}
const modelButtons = [...document.querySelectorAll('#modelQuality button')];
let modelSwitchRun = 0;
let pendingModelProfile = null;

function setMethodUI(sources) {
  methodButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(sources.has(button.dataset.method)));
  });
  const panels = new Set([...sources].map((id) => getSelectionSource(id).panel));
  ui.autoProps.hidden = !panels.has('auto');
  ui.fillProps.hidden = !panels.has('fill');
  ui.radiusProps.hidden = !panels.has('radius');
  ui.fusionProps.hidden = sources.size < 2;
  document.getElementById('extent').hidden = !panels.has('auto');
}

function setExtentUI(extent) {
  extentButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.extent === extent));
  });
}

function setModelUI(model) {
  modelButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.model === model));
  });
}

function setFusionUI(fusion) {
  fusionButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.fusion === fusion));
  });
}

function setBorderEditMode(mode) {
  state.editMode = mode;
  borderModeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.edit === mode));
  });
  const editing = mode !== 'off' && Boolean(state.active?.currentMask);
  ui.projectionCanvas.dataset.editing = String(editing);
  ui.selectionOutline.dataset.editing = 'false';
  if (mode === 'off' || (mode !== 'add' && mode !== 'remove')) {
    ui.brushCursor.style.display = 'none';
  }
  if (mode === 'off') document.getElementById('projectionMaskOptions').open = false;
  if (!mode.startsWith('polygon')) cancelPolygonEdit();
}

function setProjectionEditorOpen(open) {
  const opening = Boolean(open && state.active?.currentMask);
  if (opening) {
    // Novel-view sorting/readback still happens in this browser even though
    // SAM 3.1 inference is remote. Editing must preempt that renderer work.
    stopMultiviewForSeedEdit('All-sides scan paused while you edit the visible mask');
  }
  state.projectionEditorOpen = opening;
  ui.projectionPip.dataset.editorOpen = String(state.projectionEditorOpen);
  // Do not reveal the compact Edit button under the same pointer event that
  // closes the large editor. Some browsers retarget the tail of that gesture
  // to the newly exposed control and immediately reopen it.
  ui.projectionEditorOpen.hidden = true;
  ui.projectionEditorBack.hidden = !state.projectionEditorOpen;
  if (state.projectionEditorOpen) {
    ui.multiviewStatus.textContent =
      'All-sides fill will restart after the 2D mask editor closes';
    return;
  }
  setBorderEditMode('off');
  scheduleAutomaticMultiview('Edited mask ready', 700);
  setTimeout(() => {
    if (!state.projectionEditorOpen && state.active?.currentMask) {
      ui.projectionEditorOpen.hidden = false;
    }
  }, 0);
}

function scheduleActiveSelection(delay = 80) {
  if (!state.active) return;
  markObjectPreviewUpdating('Updating object…');
  state.active.requestToken++;
  clearTimeout(activeSelectionTimer);
  activeSelectionTimer = setTimeout(() => runActiveSelection(), delay);
}

function schedule3DCompletion(delay = 60, { relift = false } = {}) {
  const active = state.active;
  if (!active?.currentMask) return;
  markObjectPreviewUpdating('Updating 3D result…');
  active.requestToken++;
  if (relift) active.liftCache = null;
  clearTimeout(activeSelectionTimer);
  activeSelectionTimer = setTimeout(() => run3DCompletion(active, active.requestToken), delay);
}

async function run3DCompletion(active, requestToken) {
  if (state.active !== active || requestToken !== active.requestToken || !active.currentMask) return;
  if (state.busy) {
    clearTimeout(activeSelectionTimer);
    activeSelectionTimer = setTimeout(() => run3DCompletion(active, requestToken), 80);
    return;
  }

  setBusy('3D completion');
  const t0 = performance.now();
  try {
    if (active.maskConfidenceSoftness !== state.boundarySoftness) {
      active.maskConfidence = buildMaskConfidence(
        active.currentMask,
        active.maskW,
        active.maskH,
        state.boundarySoftness,
      );
      applyClassicGuideConfidence(
        active.maskConfidence,
        active.currentMask,
        active.maskW,
        active.maskH,
        active.resolvedSources,
        active.fusion,
      );
      active.maskConfidenceSoftness = state.boundarySoftness;
    }
    await applySelectionMask(
      active,
      active.currentMask,
      active.maskW,
      active.maskH,
      requestToken,
    );
    if (state.active !== active || requestToken !== active.requestToken) return;
    const elapsed = Math.round(performance.now() - t0);
    setStatus(`3D updated · ${elapsed} ms`, 'ready');
    setWork({
      key: `completion-ready-${requestToken}`,
      state: 'ready',
      title: '3D completion updated',
      detail: `${ui.selectionResult.textContent} · starting mask and projection reused`,
      steps: ['cached mask', 'cached view', 'lift', 'grow'],
      active: 4,
    });
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      setWork({
        key: `completion-error-${requestToken}`,
        state: 'error',
        title: '3D completion failed',
        detail: error.message,
      });
    }
  } finally {
    clearBusy('3D completion');
    if (state.active === active && requestToken === active.requestToken) flushPendingSelection();
  }
}

methodButtons.forEach((button) => button.addEventListener('click', (event) => {
  if (!state.active) return;
  beginControlDiff('source', `${button.textContent.trim()} starting method`);
  const source = button.dataset.method;
  if (event.shiftKey) {
    if (state.active.sources.has(source) && state.active.sources.size > 1) {
      state.active.sources.delete(source);
    } else {
      state.active.sources.add(source);
    }
  } else {
    state.active.sources = new Set([source]);
  }
  setMethodUI(state.active.sources);
  scheduleActiveSelection(0);
  releaseControlDiff('source');
}));

fusionButtons.forEach((button) => button.addEventListener('click', () => {
  if (state.active) beginControlDiff('fusion', `${button.textContent.trim()} combination`);
  state.fusion = button.dataset.fusion;
  setFusionUI(state.fusion);
  if (!state.active) return;
  state.active.fusion = state.fusion;
  scheduleActiveSelection(0);
  releaseControlDiff('fusion');
}));

borderModeButtons.forEach((button) => button.addEventListener('click', () => {
  if (!state.active?.currentMask) return;
  if (button.dataset.edit !== 'off') stopMultiviewForSeedEdit();
  setBorderEditMode(button.dataset.edit);
}));

ui.projectionSeedsToggle.addEventListener('click', () => {
  state.showProjectionSeeds = !state.showProjectionSeeds;
  ui.projectionSeedsToggle.setAttribute('aria-pressed', String(state.showProjectionSeeds));
  ui.projectionSeedLegend.hidden = !state.showProjectionSeeds;
  renderEditableProjection();
});

extentButtons.forEach((button) => button.addEventListener('click', () => {
  if (state.active) beginControlDiff(
    'extent',
    `${button.textContent.trim()} object size`,
  );
  state.extent = button.dataset.extent;
  setExtentUI(state.extent);
  if (!state.active) return;
  state.active.extent = state.extent;
  scheduleActiveSelection(0);
  releaseControlDiff('extent');
}));

modelButtons.forEach((button) => button.addEventListener('click', () => {
  activateSegmentationModel(button.dataset.model);
}));

async function activateSegmentationModel(profile) {
  if (!state.active) return;
  if (profile === state.modelQuality) {
    if (pendingModelProfile && pendingModelProfile !== profile) {
      modelSwitchRun++;
      const canceled = pendingModelProfile;
      pendingModelProfile = null;
      for (const button of modelButtons) button.removeAttribute('data-loading');
      setModelUI(state.modelQuality);
      setWork({
        key: `model-canceled-${canceled}`,
        state: 'ready',
        title: `Keeping ${modelProviders.find((item) => item.id === profile)?.label ?? profile}`,
        detail: 'The current selection remains live. The other model may finish caching in the background.',
      });
    }
    return;
  }
  if (state.busy && state.busyReason !== 'mask generation'
    && state.busyReason !== '3D completion') {
    setWork({
      key: `model-queued-${profile}`,
      state: 'queued',
      title: 'Model switch queued',
      detail: `Waiting for ${state.busyReason || 'the current task'} to finish.`,
      steps: ['load', 'encode view', 'decode mask'],
      active: 0,
    });
    setTimeout(() => activateSegmentationModel(profile), 100);
    return;
  }
  const revision = viewRevision;
  const active = state.active;
  const provider = modelProviders.find((candidate) => candidate.id === profile);
  if (!provider) return;
  const switchRun = ++modelSwitchRun;
  pendingModelProfile = profile;
  for (const button of modelButtons) {
    if (button.dataset.model === profile) button.dataset.loading = 'true';
    else button.removeAttribute('data-loading');
  }
  setWork({
    key: `model-${profile}`,
    state: 'busy',
    title: segmentationModels.has(profile) ? `Reusing cached ${provider.label}` : `Loading ${provider.label}`,
    detail: segmentationModels.has(profile)
      ? 'Model weights are already in memory.'
      : 'Your current selection stays editable while this downloads once.',
    steps: ['load', 'encode view', 'decode mask'],
    active: 0,
  });

  let switched = false;
  try {
    if (!segmentationModels.has(profile)) {
      const model = createSegmentationModel(profile);
      segmentationModels.set(profile, model);
      await model.load((progress) => {
        if (switchRun !== modelSwitchRun) return;
        if (progress.status === 'progress' && progress.file?.endsWith('.onnx')) {
          updateWorkDetail('model', `Downloading model weights · ${Math.round(progress.progress)}%`);
        }
      });
    }

    if (switchRun !== modelSwitchRun || revision !== viewRevision || state.active !== active) return;
    const nextSam = segmentationModels.get(profile);
    if (nextSam.viewRevision !== viewRevision) {
      setWork({
        key: `model-${profile}`,
        state: 'busy',
        title: `Encoding view with ${provider.label}`,
        detail: 'The captured projection is reused; only this model’s features are missing.',
        steps: ['load', 'encode view', 'decode mask'],
        active: 1,
      });
      await nextSam.encode(capture);
      if (switchRun !== modelSwitchRun || revision !== viewRevision
        || state.active !== active) return;
      nextSam.viewRevision = viewRevision;
    }

    state.modelQuality = profile;
    // Keep every angle in a scan on one consistent segmentation method. A
    // method chosen here becomes the method for the next scan as well.
    state.multiview.propagationProfile = profile;
    setModelUI(profile);
    beginControlDiff('model', `${provider.label} result`);
    switched = true;
  } catch (error) {
    console.error(error);
    if (profile !== 'fast') segmentationModels.delete(profile);
    setModelUI(state.modelQuality);
    setWork({
      key: `model-error-${profile}`,
      state: 'error',
      title: 'Model unavailable',
      detail: `The current ${modelProviders.find((item) => item.id === state.modelQuality)?.label ?? 'model'} result is unchanged.`,
    });
    return;
  } finally {
    if (switchRun === modelSwitchRun) {
      pendingModelProfile = null;
      for (const button of modelButtons) button.removeAttribute('data-loading');
    }
    const modelJob = workJobs.get('model');
    if (switched && modelJob?.key === `model-${profile}`
      && (modelJob.state === 'busy' || modelJob.state === 'queued')) {
      completeWorkLane(
        'model',
        `${provider.label} ready`,
        'The model is cached and will be reused for later selections.',
      );
    }
    if (!state.encoded) scheduleEncode();
  }

  if (!switched || switchRun !== modelSwitchRun
    || state.active !== active || revision !== viewRevision) return;
  state.active.requestToken++;
  await runActiveSelection();
  releaseControlDiff('model');
}

bindSlider('fillThreshold', 'fillThresholdV', (v) => {
  state.fillThreshold = v;
  return String(v);
});
bindSlider('screenRadius', 'screenRadiusV', (v) => {
  state.screenRadius = v;
  return `${v.toFixed(1)}%`;
});
bindSlider('edgeBrush', 'edgeBrushV', (v) => {
  state.edgeBrush = v;
  return `${v.toFixed(1)}%`;
}, 'none');
bindSlider('slack', 'slackV', (v) => {
  state.slack = v / 1000;
  return `${(v / 10).toFixed(1)}%`;
}, 'lift');
bindSlider('radius', 'radiusV', (v) => {
  state.radius = v / 1000;
  return `${(v / 10).toFixed(1)}%`;
}, '3d');
bindSlider('steps', 'stepsV', (v) => {
  state.steps = v;
  return String(v);
}, '3d');
bindSlider('minimumConfidence', 'minimumConfidenceV', (v) => {
  state.minimumConfidence = v / 100;
  const label = v < 22 ? 'Forgiving' : v < 52 ? 'Balanced' : v < 76 ? 'Precise' : 'Very precise';
  return `${label} · ${v}%`;
}, 'refine');
bindSlider('confirmConfidence', 'confirmConfidenceV', (v) => {
  state.confirmConfidence = v / 100;
  return `${v}%`;
}, 'classify');
bindSlider('maskOffset', 'maskOffsetV', (v) => {
  state.maskOffset = v;
  return v === 0 ? 'no change' : `${Math.abs(v)} px ${v > 0 ? 'larger' : 'smaller'}`;
});
bindSlider('boundarySoftness', 'boundarySoftnessV', (v) => {
  state.boundarySoftness = v;
  return `${v} px`;
}, 'boundary');
bindSlider('selectionOpacity', 'selectionOpacityV', (v) => {
  state.selectionOpacity = v / 100;
  return `${v}%`;
}, 'appearance');
bindSlider('nearbyRadius', 'nearbyRadiusV', (v) => {
  state.nearbyRadius = v / 1000;
  return v ? `${(v / 10).toFixed(1)}%` : 'off';
}, 'refine');
bindSlider('componentSize', 'componentSizeV', (v) => {
  state.componentSize = v;
  return String(v);
}, 'refine');

function bindSlider(id, out, apply, updateMode = 'mask') {
  const el = document.getElementById(id);
  const label = document.getElementById(out);
  const update = (fromInput) => {
    if (fromInput && CONTROL_DIFF_COPY[id]
      && state.active?.controlDiff?.controlId !== id) {
      beginControlDiff(id);
    }
    label.textContent = apply(+el.value);
    if (!fromInput) return;
    if (updateMode === 'mask') scheduleActiveSelection();
    else if (updateMode === 'lift') schedule3DCompletion(60, { relift: true });
    else if (updateMode === '3d') schedule3DCompletion();
    else if (updateMode === 'refine') schedule3DCompletion(35);
    else if (updateMode === 'classify') {
      rebuildProvisionalState();
      renderSelectionState();
      publishControlDiff(state.active, state.active?.currentMask);
    }
    else if (updateMode === 'boundary') {
      renderSelectionState();
      schedule3DCompletion(80);
    } else if (updateMode === 'appearance') {
      renderSelectionState();
      publishControlDiff(state.active, state.active?.currentMask);
    }
  };
  el.addEventListener('pointerdown', () => {
    if (CONTROL_DIFF_COPY[id]) beginControlDiff(id);
  });
  el.addEventListener('pointerup', () => releaseControlDiff(id));
  el.addEventListener('pointercancel', () => releaseControlDiff(id));
  el.addEventListener('change', () => releaseControlDiff(id));
  el.addEventListener('input', () => update(true));
  update(false);
}

document.getElementById('removeDisconnected').addEventListener('click', (event) => {
  beginControlDiff('removeDisconnected');
  state.removeDisconnected = !state.removeDisconnected;
  event.currentTarget.setAttribute('aria-pressed', String(state.removeDisconnected));
  ui.componentSizeRow.hidden = !state.removeDisconnected;
  schedule3DCompletion(20);
  releaseControlDiff('removeDisconnected');
});

document.getElementById('lockConfirmed').addEventListener('click', () => {
  if (!state.selection.size) return;
  beginControlDiff('protection');
  pushSelectionHistory('Lock confirmed');
  for (const index of state.selection) {
    if ((state.confidence[index] ?? 1) >= state.confirmConfidence) state.locked[index] = 1;
  }
  renderSelectionState();
  publishControlDiff(state.active, state.active?.currentMask);
  releaseControlDiff('protection');
  setWork({
    key: `locked-${performance.now()}`,
    state: 'ready',
    title: 'Strong matches protected',
    detail: 'Automatic cleanup and the all-sides scan will preserve the green region.',
  });
});

document.getElementById('unlockAll').addEventListener('click', () => {
  if (!state.locked?.some((value) => value)) return;
  beginControlDiff('protection', 'Protection removed');
  pushSelectionHistory('Unlock all');
  state.locked.fill(0);
  rebuildProvisionalState();
  renderSelectionState();
  publishControlDiff(state.active, state.active?.currentMask);
  releaseControlDiff('protection');
});
document.getElementById('undoRefinement').addEventListener('click', undoLastRefinement);

let gaussianCleanupStrokeActive = false;
let gaussianCleanupStrokeRemoved = 0;
let gaussianCleanupStrokeProtected = 0;

function beginGaussianCleanupStroke(indices) {
  if (!state.gaussianCleanup || gaussianCleanupStrokeActive) return;
  gaussianCleanupStrokeActive = true;
  gaussianCleanupStrokeRemoved = 0;
  gaussianCleanupStrokeProtected = 0;
  state.gaussianCleanupUndo = captureSparseSelectionState({
    manualExcluded: true,
  });
  beginControlDiff('gaussianCleanup');
  removeGaussianCleanupIndices(indices);
}

function removeGaussianCleanupIndices(indices) {
  if (!state.gaussianCleanup || !gaussianCleanupStrokeActive) return;
  let changed = false;
  for (const index of indices) {
    if (!state.selection.has(index)) continue;
    if (state.locked?.[index]) {
      gaussianCleanupStrokeProtected++;
      continue;
    }
    state.selection.delete(index);
    state.provisional.delete(index);
    state.forcedProvisional.delete(index);
    state.recentlyAdded.delete(index);
    state.manualExcluded.add(index);
    if (state.confidence) state.confidence[index] = 0;
    gaussianCleanupStrokeRemoved++;
    changed = true;
  }
  if (!changed) return;
  renderSelectionState();
  publishControlDiff(state.active, state.active?.currentMask);
}

function undoGaussianCleanup() {
  const snapshot = state.gaussianCleanupUndo;
  if (!snapshot) return;
  restoreSparseSelectionState(snapshot);
  state.gaussianCleanupUndo = null;
  renderSelectionState();
  setWork({
    key: `gaussian-cleanup-undo-${performance.now()}`,
    state: 'ready',
    title: 'Removed splats restored',
    detail: `${state.selection.size.toLocaleString()} splats are back in the object.`,
  });
}

function finishGaussianCleanupStroke() {
  if (!gaussianCleanupStrokeActive) return;
  gaussianCleanupStrokeActive = false;
  publishControlDiff(state.active, state.active?.currentMask);
  releaseControlDiff('gaussianCleanup');
  setWork({
    key: `gaussian-cleanup-${performance.now()}`,
    state: 'ready',
    title: gaussianCleanupStrokeRemoved ? 'Unwanted splats removed' : 'No splats removed',
    detail: gaussianCleanupStrokeRemoved
      ? `${gaussianCleanupStrokeRemoved.toLocaleString()} splats removed · Undo removal is available in the hologram.`
      : gaussianCleanupStrokeProtected
        ? 'The brush touched only protected splats. Unprotect them first if they should be removable.'
        : 'Drag across visible hologram particles; the stroke can begin just outside the object.',
  });
}

function setGaussianCleanup(enabled) {
  state.gaussianCleanup = Boolean(enabled && state.selection.size);
  ui.previewCleanup.setAttribute('aria-pressed', String(state.gaussianCleanup));
  ui.startHologramCleanup.setAttribute('aria-pressed', String(state.gaussianCleanup));
  ui.startHologramCleanup.textContent = state.gaussianCleanup
    ? 'Done cleaning'
    : 'Brush stray splats';
  objectPreview.setEditMode(state.gaussianCleanup ? 'cleanup' : 'view');
  if (state.gaussianCleanup) {
    objectPreview.setSpin(false);
    document.getElementById('previewSpin').setAttribute('aria-pressed', 'false');
    ui.objectPreviewStatus.textContent = 'Brush unwanted 3D splats away';
  } else {
    renderSelectionState();
  }
}

document.getElementById('previewSpin').addEventListener('click', (event) => {
  const next = event.currentTarget.getAttribute('aria-pressed') !== 'true';
  event.currentTarget.setAttribute('aria-pressed', String(next));
  objectPreview.setSpin(next);
});
document.getElementById('previewReset').addEventListener('click', () => objectPreview.resetView());
ui.previewCleanup.addEventListener('click', () => {
  setGaussianCleanup(!state.gaussianCleanup);
});
ui.open2dMaskEditor.addEventListener('click', () => setProjectionEditorOpen(true));
ui.startHologramCleanup.addEventListener('click', () => {
  setGaussianCleanup(!state.gaussianCleanup);
});
ui.previewCleanupUndo.addEventListener('click', undoGaussianCleanup);
ui.previewOrbit.addEventListener('click', () => {
  setOrbitSelected(!state.orbitSelected.enabled);
});
ui.previewNearby.addEventListener('click', () => {
  setNearbyContext(!state.nearbyContext.enabled);
});
ui.previewRefineInside.addEventListener('click', enterFocusedRefinement);
document.getElementById('focusRefineBack').addEventListener('click', leaveFocusedRefinement);
document.getElementById('previewEdit').addEventListener('click', () => {
  if (state.activeDockSegmentId != null) {
    restoreDockSegment(state.activeDockSegmentId, { openInspector: true });
    return;
  }
  if (!state.selection.size) return;
  ui.selectionProps.hidden = false;
  document.body.dataset.inspector = 'true';
});

ui.openSelectionSetup.addEventListener('click', () => {
  ui.selectionProps.hidden = false;
  document.body.dataset.inspector = 'true';
  const advanced = document.getElementById('advancedWorkflow');
  advanced.open = true;
  advanced.querySelector('details.inspector-step').open = true;
});

ui.suggestionsToggle.addEventListener('click', () => {
  state.objectSuggestionsEnabled = !state.objectSuggestionsEnabled;
  ui.suggestionsToggle.setAttribute('aria-pressed', String(state.objectSuggestionsEnabled));
  if (!state.objectSuggestionsEnabled) {
    ui.suggestionsToggle.textContent = 'Smart object hints · off';
    clearObjectSuggestions();
    completeWorkLane('detector', 'Object hints off', 'Normal click selection remains available.');
    return;
  }
  setWork({
    key: `suggestions-${viewRevision}`,
    state: 'queued',
    title: 'Object hints enabled',
    detail: 'YOLO will scan the current settled projection without blocking selection.',
  });
  ui.suggestionsToggle.textContent = 'Smart object hints · YOLO queued';
  scheduleObjectSuggestions(viewRevision, 0);
});

// ------------------------------------------------------ multiview refine ----

const startMultiviewButton = document.getElementById('startMultiview');
const pauseMultiviewButton = document.getElementById('pauseMultiview');
const cancelMultiviewButton = document.getElementById('cancelMultiview');
let trackerCapabilityProbe = null;
let trackerCapabilityTimer = 0;
let automaticMultiviewTimer = 0;

bindSlider('multiviewCount', 'multiviewCountV', (value) => {
  state.multiview.count = value;
  updateMultiviewEstimate();
  return String(value);
}, 'none');
bindSlider('multiviewSupport', 'multiviewSupportV', (value) => {
  state.multiview.minimumViews = value;
  updateMultiviewEstimate();
  return String(value);
}, 'none');
bindSlider('multiviewConfidence', 'multiviewConfidenceV', (value) => {
  state.multiview.confidence = value / 100;
  return `${value}%`;
}, 'none');

function refreshMultiviewCapability(error = '') {
  const ready = Boolean(state.splat && state.selection.size);
  const trackerReady = state.multiview.trackerStatus === 'ready';
  const trackerPreparing = state.multiview.trackerStatus === 'waiting-checkpoint'
    || state.multiview.trackerStatus === 'loading'
    || state.multiview.trackerStatus === 'checking';
  ui.multiviewGate.dataset.ready = String(ready);
  ui.multiviewControls.hidden = !ready || !trackerReady;
  startMultiviewButton.hidden = true;
  ui.previewScan.hidden = true;
  if (ready) {
    ui.multiviewCapability.textContent = trackerReady
      ? state.multiview.session
        ? 'SAM 3 is filling the hidden sides'
        : 'Automatic all-sides fill ready'
      : trackerPreparing
        ? 'All-sides scan · temporal tracker preparing'
        : 'Tracked all-sides scan unavailable';
    ui.multiviewCapabilityDetail.textContent = trackerReady
      ? `Fast + YOLO supplies the visible seed. SAM 3.1 follows it through app-generated views on ${state.multiview.trackerDevice || 'the GPU'}; editing the 2D mask restarts the scan.`
      : trackerPreparing
        ? 'Your current-view selection works now. SAM 3.1 will begin automatically as soon as it is ready.'
        : 'SAM 3.1 temporal tracking is required. Independent per-view masks are not presented as the same feature.';
    const count = document.getElementById('multiviewCount');
    count.max = '24';
    if (+count.value > +count.max) {
      count.value = count.max;
      state.multiview.count = +count.value;
      document.getElementById('multiviewCountV').textContent = count.value;
    }
  } else {
    ui.multiviewCapability.textContent = error || (state.splat
      ? 'Select an object to track around it'
      : 'Load a scene to begin');
    ui.multiviewCapabilityDetail.textContent =
      'The app renders an ordered orbit itself; no extra photos or camera files are needed.';
  }
  updateMultiviewEstimate();
}

async function refreshTrackerCapability() {
  if (trackerCapabilityProbe) return trackerCapabilityProbe;
  clearTimeout(trackerCapabilityTimer);
  trackerCapabilityProbe = (async () => {
    try {
      const ready = await propagationProvider.probeTemporal();
      const capabilities = propagationProvider.temporal.capabilities;
      state.multiview.trackerStatus = ready
        ? 'ready'
        : capabilities?.status ?? 'unavailable';
      state.multiview.trackerDetail = capabilities?.detail ?? '';
      state.multiview.trackerDevice = capabilities?.device ?? '';
    } catch {
      // A first CUDA model load can briefly delay the capability response.
      // Keep checking instead of turning one timeout into a permanent false
      // "unavailable" label.
      state.multiview.trackerStatus = 'checking';
      state.multiview.trackerDetail = '';
    } finally {
      state.multiview.trackerCheckedAt = performance.now();
      trackerCapabilityProbe = null;
      refreshMultiviewCapability();
      if (state.multiview.trackerStatus === 'waiting-checkpoint'
        || state.multiview.trackerStatus === 'loading'
        || state.multiview.trackerStatus === 'checking') {
        trackerCapabilityTimer = setTimeout(refreshTrackerCapability, 12_000);
      } else if (state.multiview.trackerStatus === 'ready') {
        scheduleAutomaticMultiview('SAM 3 ready');
      } else {
        // The local service may be restarted after a failed model load. A
        // stale browser tab must recover without requiring a page refresh.
        trackerCapabilityTimer = setTimeout(refreshTrackerCapability, 20_000);
      }
    }
  })();
  return trackerCapabilityProbe;
}

function updateMultiviewEstimate() {
  const estimate = estimateRefinementTime({
    viewCount: state.multiview.count,
    splatCount: state.splat?.count ?? 0,
    selectionCount: state.selection.size,
    timing: state.multiview.timing,
  });
  document.getElementById('automaticEstimate').textContent = formatDuration(estimate.automaticMs);
  document.getElementById('reviewEstimate').textContent = formatDuration(estimate.reviewMs);
  document.getElementById('totalEstimate').textContent = formatDuration(estimate.totalMs);
}

function prepareTrackingSeed(seedMask, maskW, maskH, width, height) {
  if (!seedMask || !maskW || !maskH) {
    throw new Error('The visible-side mask is not ready for tracking.');
  }
  if (multiviewSeedCanvas.width !== width || multiviewSeedCanvas.height !== height) {
    multiviewSeedCanvas.width = width;
    multiviewSeedCanvas.height = height;
  }
  multiviewSeedCtx.clearRect(0, 0, width, height);
  multiviewSeedCtx.drawImage(capture, 0, 0, width, height);

  const resizedMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(maskH - 1, Math.floor(y * maskH / height));
    const sourceRow = sourceY * maskW;
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(maskW - 1, Math.floor(x * maskW / width));
      resizedMask[targetRow + x] = seedMask[sourceRow + sourceX] ? 1 : 0;
    }
  }
  return { canvas: multiviewSeedCanvas, mask: resizedMask };
}

function collectRefinementProjectionIndices(analysis) {
  const grid = state.grid;
  if (!grid?.start || !grid?.items) return null;
  // Hidden object surfaces and immediately adjacent distractors live in a
  // compact 3D neighborhood. Projecting this ROI avoids re-running millions
  // of unrelated scene points in JavaScript for every tracked angle.
  const padding = Math.max(analysis.radius * 1.25, grid.cell * 4);
  const min = analysis.robustMin.clone().addScalar(-padding);
  const max = analysis.robustMax.clone().addScalar(padding);
  const clampCell = (value, count) => Math.max(0, Math.min(count - 1, value));
  const ix0 = clampCell(Math.floor((min.x - grid.minX) / grid.cell), grid.nx);
  const iy0 = clampCell(Math.floor((min.y - grid.minY) / grid.cell), grid.ny);
  const iz0 = clampCell(Math.floor((min.z - grid.minZ) / grid.cell), grid.nz);
  const ix1 = clampCell(Math.floor((max.x - grid.minX) / grid.cell), grid.nx);
  const iy1 = clampCell(Math.floor((max.y - grid.minY) / grid.cell), grid.ny);
  const iz1 = clampCell(Math.floor((max.z - grid.minZ) / grid.cell), grid.nz);
  const indices = [];
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const cell = (iz * grid.ny + iy) * grid.nx + ix;
        for (let cursor = grid.start[cell]; cursor < grid.start[cell + 1]; cursor++) {
          const index = grid.items[cursor];
          const x = state.splat.centers[index * 3];
          const y = state.splat.centers[index * 3 + 1];
          const z = state.splat.centers[index * 3 + 2];
          if (x >= min.x && x <= max.x
            && y >= min.y && y <= max.y
            && z >= min.z && z <= max.z) indices.push(index);
        }
      }
    }
  }
  // Robust bounds intentionally ignore floaters. Preserve any explicitly
  // selected outlier as an identity anchor even when it falls outside the ROI.
  for (const index of state.selection) {
    const x = state.splat.centers[index * 3];
    const y = state.splat.centers[index * 3 + 1];
    const z = state.splat.centers[index * 3 + 2];
    if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) {
      indices.push(index);
    }
  }
  return Uint32Array.from(indices);
}

startMultiviewButton.addEventListener('click', startMultiviewRefinement);
ui.previewScan.addEventListener('click', startMultiviewRefinement);
pauseMultiviewButton.addEventListener('click', () => {
  const session = state.multiview.session;
  if (!session) return;
  session.paused = !session.paused;
  pauseMultiviewButton.textContent = session.paused ? 'Resume' : 'Pause';
  pauseMultiviewButton.setAttribute('aria-pressed', String(session.paused));
  if (!session.paused && !session.waitingReview) processNextMultiviewView(session);
});
cancelMultiviewButton.addEventListener('click', () => {
  const session = state.multiview.session;
  if (!session) return;
  session.canceled = true;
  finishMultiviewSession(session, 'Multiview refinement stopped');
});
document.getElementById('acceptMultiview').addEventListener('click', () => {
  resolveMultiviewProposal(true);
});
document.getElementById('rejectMultiview').addEventListener('click', () => {
  resolveMultiviewProposal(false);
});

async function startMultiviewRefinement() {
  if (!state.splat || !state.selection.size) return;
  if (state.projectionEditorOpen || state.editMode !== 'off') {
    ui.multiviewStatus.textContent =
      'All-sides fill is waiting for the 2D mask editor to close';
    return;
  }
  if (state.multiview.trackerStatus !== 'ready') {
    refreshTrackerCapability();
    setWork({
      key: 'multiview-tracker-required',
      state: 'queued',
      title: 'Tracked scan is not ready yet',
      detail: 'The current selection stays editable while SAM 3.1 finishes loading.',
    });
    return;
  }
  if (state.multiview.session || state.busy) {
    setWork({
      key: 'multiview-waiting',
      state: 'queued',
      title: 'Object scan waiting',
      detail: `Waiting for ${state.busyReason || 'the current operation'}.`,
    });
    return;
  }
  if (modelViewEncodeRunning
    || objectSuggestionInferenceRunning
    || refinedSuggestionInferenceRunning) {
    ui.multiviewStatus.textContent =
      'Waiting for the current target analysis to release the graphics processor…';
    setWork({
      key: 'multiview-inference-barrier',
      state: 'queued',
      title: 'Object scan queued',
      detail: 'Finishing the current target analysis before the all-sides scan starts.',
      steps: ['finish target analysis', 'render views', 'track object', 'combine'],
      active: 0,
    });
    clearTimeout(automaticMultiviewTimer);
    automaticMultiviewTimer = setTimeout(startMultiviewRefinement, 160);
    return;
  }
  setGaussianCleanup(false);
  if (state.nearbyContext.enabled) setNearbyContext(false);

  // Preserve the cockpit aspect ratio, but give the tracker's shorter axis
  // its full native 1008 samples. The old 1024×576 capture left thin vertical
  // structures with barely half of the detail SAM 3.1 can consume.
  const viewportAspect = renderer.domElement.width
    / Math.max(1, renderer.domElement.height);
  const width = viewportAspect >= 1
    ? Math.round(SAM_TRACKING_NATIVE * viewportAspect)
    : SAM_TRACKING_NATIVE;
  const height = viewportAspect >= 1
    ? SAM_TRACKING_NATIVE
    : Math.round(SAM_TRACKING_NATIVE / viewportAspect);
  const analysis = analyzeSelectedObject({
    centers: state.splat.centers,
    selection: state.selection,
    camera,
  });
  const syntheticViews = generateSyntheticOrbitViews({
    analysis,
    camera,
    count: state.multiview.count,
    width,
    height,
  });
    const synthetic = syntheticViewSet(syntheticViews, analysis);
    const views = synthetic.views;
    const projectionIndices = collectRefinementProjectionIndices(analysis);
    const session = {
    id: performance.now(),
    views,
    trackingViews: synthetic.trackingViews ?? views,
    viewSet: synthetic,
      analysis,
      projectionIndices,
      projectionIndexSpace: null,
      projectionCache: null,
      trackingCutout: null,
    index: 0,
    evidence: null,
    baseSelection: new Set(state.selection),
    // Accepted evidence only raises confidence, so the existing scene-sized
    // buffer is both the baseline and output. A second 8.8M-float clone added
    // 35 MB and produced avoidable garbage-collection stalls.
    baseConfidence: state.confidence,
    fusedConfidence: state.confidence,
    paused: false,
    canceled: false,
    waitingReview: false,
    processing: false,
    capturing: false,
    currentProposal: null,
    previousAreaByBranch: new Map(),
    providerMode: 'temporal-tracker',
    providerLabel: 'SAM 3.1 temporal tracking',
      stagedFrames: new Map(),
      stagedPoseFrames: new Map(),
    revealAttempts: new Set(),
      frameFailureRetries: new Map(),
      skippedReasons: new Map(),
      keyViewIds: new Set(views.map((view) => view.id)),
      diagnostics: {
        sessionId: null,
        captureSource: 'pending',
        cutoutSplats: 0,
        cutoutBuildMs: 0,
        renderedFrames: 0,
        reusedFrames: 0,
        frames: [],
        startedAt: performance.now(),
        stageFramesMs: 0,
      },
    };
    session.diagnostics.sessionId = session.id;
    scanDiagnostics.current = session.diagnostics;
    state.multiview.session = session;
    clearTimeout(encodeTimer);
    encodeQueued = false;
    pendingModelViewEncode = null;
    workJobs.delete('view');
    setStatus('scanning all sides', 'busy');
    scanTray.begin({
      id: session.id,
      total: session.views.length,
    });
  ui.selectionProps.dataset.scanning = 'true';
  setBusy('object scan');
  renderSelectionState();
  dismissActiveSelection({ hideInspector: false, preserveActive: true });
  state.encoded = false;
  setSelectionReadiness('idle');
  controls.enabled = false;
  startMultiviewButton.disabled = true;
  ui.previewScan.disabled = true;
  pauseMultiviewButton.disabled = false;
  pauseMultiviewButton.hidden = false;
  cancelMultiviewButton.disabled = false;
  cancelMultiviewButton.hidden = false;
  ui.multiviewProgress.style.width = '0%';
  ui.multiviewReview.hidden = true;
  const desiredProfile = state.multiview.propagationProfile;
  const readyDesired = segmentationModels.get(desiredProfile);
  state.multiview.propagationModel = readyDesired?.ready
    ? readyDesired
    : (currentSam().ready ? currentSam() : sam);
  session.providerLabel = 'SAM 3.1 temporal tracking';
  if (!await propagationProvider.probeTemporal()) {
    state.multiview.trackerStatus = 'checking';
    finishMultiviewSession(session, 'SAM 3 is reconnecting');
    refreshTrackerCapability();
    return;
  }
  setWork({
    key: `multiview-${session.id}`,
    state: 'busy',
    title: 'Preparing the object scan',
    detail: 'Building a compact offscreen copy around the object.',
    steps: ['prepare angles', 'follow object', 'map to 3D', 'review', 'combine'],
    active: 0,
  });
  const cutoutStartedAt = performance.now();
  try {
    const cutout = await state.splat.createTrackingCutout(
      session.projectionIndices,
      {
        priority: session.baseSelection,
        onProgress: (progress) => {
          updateWorkDetail(
            'multiview',
            `Preparing the object scan · ${Math.round(progress * 100)}%`,
          );
        },
        canceled: () => session.canceled || state.multiview.session !== session,
      },
    );
    if (session.canceled || state.multiview.session !== session) {
      cutout?.dispose?.();
      return;
    }
    if (!cutout) throw new Error('This scene cannot create a resident scan cutout');
    session.trackingCutout = cutout;
    // The renderer may sample a large spatial ROI to fit the scan memory
    // budget. Projection and evidence must use exactly that resident subset;
    // projecting candidates that were not rendered produces false masks and
    // wastes memory.
    session.projectionIndices = cutout.indices;
    session.projectionIndexSpace = createProjectionIndexSpace(
      state.splat.count,
      session.projectionIndices,
    );
    session.evidence = createViewEvidence(
      state.splat.count,
      session.projectionIndices,
      session.projectionIndexSpace.indexLookup,
    );
    refinementScene.add(cutout.object3D);
    session.diagnostics.captureSource = 'resident-cutout';
    session.diagnostics.cutoutSplats = cutout.count;
    session.diagnostics.memory = {
      lookupBytes: session.projectionIndexSpace.indexLookup.byteLength,
      projectionBytes: cutout.count * 4 * 4,
      evidenceBytes: cutout.count * 20,
      estimatedCutoutBytes: cutout.count * 44,
      stagedBytes: 0,
      retainedFrameBytes: 0,
    };
  } catch (error) {
    if (error.name === 'AbortError' || session.canceled) return;
    console.warn('[tracking] compact cutout failed', error);
    session.diagnostics.captureSource = 'cutout-failed';
    session.diagnostics.cutoutError = error.message;
  } finally {
    session.diagnostics.cutoutBuildMs = performance.now() - cutoutStartedAt;
  }
  if (!session.trackingCutout) {
    finishMultiviewSession(session, 'Could not prepare the offscreen object scan');
    return;
  }
  let branchFrames;
  try {
    branchFrames = await stageTemporalTrackingFrames(session);
  } catch (error) {
    if (error.name === 'AbortError' || session.canceled) return;
    console.warn('[tracking] could not stage the synthetic sequence', error);
    finishMultiviewSession(session, 'Could not prepare the tracked orbit');
    return;
  }
  const seedMask = state.active?.currentMask;
  const trackingSeed = prepareTrackingSeed(
    seedMask,
    state.active?.maskW,
    state.active?.maskH,
    width,
    height,
  );
  if (branchFrames?.size) {
    ui.multiviewStatus.textContent = 'Starting object tracking across the prepared angles…';
    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: 'Starting object tracking',
      detail: 'The complete angle sequence is ready. Initializing its shared object memory.',
      steps: ['prepare angles', 'follow object', 'map to 3D', 'review', 'combine'],
      active: 1,
    });
  }
  const temporalTracking = await propagationProvider.begin({
    seedCanvas: trackingSeed.canvas,
    seedMask: trackingSeed.mask,
    maskW: width,
    maskH: height,
    branchFrames,
    branches: [...new Set(
      views.map((view) => view.trackBranch ?? 'orbit'),
    )],
    objectId: `selection-${Math.round(session.id)}`,
  });
  if (!temporalTracking) {
    finishMultiviewSession(session, 'Could not start SAM 3.1 temporal tracking');
    refreshTrackerCapability();
    return;
  }
  // The backend now owns the complete ordered sequence. Keep only the key
  // frames used by the review UI; bridge frames must not remain resident for
  // the rest of the scan.
  session.stagedPoseFrames.clear();
  branchFrames.clear();
  session.diagnostics.memory.retainedFrameBytes = uniqueBlobBytes(
    session.stagedFrames.values(),
  );
  session.providerMode = 'temporal-tracker';
  session.trackingStaged = Boolean(branchFrames?.size);
  session.providerLabel = 'SAM 3.1 temporal tracking';
  await processNextMultiviewView(session);
}

async function processNextMultiviewView(session) {
  if (state.multiview.session !== session || session.canceled
    || session.paused || session.waitingReview || session.processing
    || session.materializing) return;
  if (session.index >= session.views.length) {
    finishMultiviewSession(session, 'Multiview refinement complete');
    return;
  }

  session.processing = true;
  const view = session.views[session.index];
  const viewNumber = session.index + 1;
  const startedAt = performance.now();
  let renderFinishedAt = startedAt;
  let inferenceFinishedAt = startedAt;
  try {
    ui.multiviewStatus.textContent =
      `Scanning angle ${viewNumber} of ${session.views.length} — rendering in the background`;
    updateMultiviewProgress(session);
    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: `Scanning angle ${viewNumber} of ${session.views.length}`,
      detail: 'Rendering this angle without moving your view.',
      steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
      active: 0,
    });
    applyViewToCamera(view, refinementCamera);
    const stagedFrame = session.stagedFrames.get(view.id);
    const rendered = stagedFrame
      ? await drawStagedTrackingFrame(stagedFrame, view)
      : await captureRefinementView(session, view, refinementCamera);
    if (session.canceled) return;
    renderFinishedAt = performance.now();

    refinementCamera.updateMatrixWorld(true);
    const viewProj = new THREE.Matrix4().multiplyMatrices(
      refinementCamera.projectionMatrix,
      refinementCamera.matrixWorldInverse,
    );
    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: `Following the object into angle ${viewNumber}`,
      detail: 'Projecting the accepted 3D object to keep the mask on the same target.',
      steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
      active: 1,
    });
    const projection = await projectSplatsAsync({
      centers: state.splat.centers,
      count: state.splat.count,
      viewProj: viewProj.elements,
      viewW: rendered.width,
      viewH: rendered.height,
      hidden: state.splat.getHiddenSplatsData(),
      radii: state.splat.radii,
      opacity: state.splat.opacity,
      indices: session.projectionIndices,
      indexSpace: session.projectionIndexSpace,
      reuse: session.projectionCache,
    }, (progress) => {
      updateWorkDetail('multiview', `Locating the object · ${Math.round(progress * 100)}%`);
    }, () => session.canceled || state.multiview.session !== session);
    session.projectionCache = projection;
    const guidance = buildProjectedSelectionGuidance({
      projection,
      // Keep identity validation anchored to the selection that started this
      // scan. Newly discovered provisional points must not move the target.
      selection: session.baseSelection,
      projectionW: rendered.width,
      projectionH: rendered.height,
      targetW: multiviewCapture.width,
      targetH: multiviewCapture.height,
      depthSlack: state.slack * state.splat.scale,
    });

    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: `Following the object into angle ${viewNumber}`,
      detail: `${session.providerLabel} is matching the same object from this side.`,
      steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
      active: 1,
    });
    const branch = view.trackBranch ?? view.source ?? 'captured';
    const propagated = await propagationProvider.propagate({
      canvas: multiviewCapture,
      guidance,
      previousAreaRatio: session.previousAreaByBranch.get(branch) ?? null,
      branch,
      view,
      onProgress: (progress) => {
        if (state.multiview.session !== session || session.canceled) return;
        const processed = progress.processedFrame ?? 0;
        const target = progress.targetFrame ?? 0;
        const total = progress.totalFrames ?? target;
        const phase = progress.phase === 'initializing'
          ? 'Starting SAM 3'
          : 'SAM 3 tracking';
        ui.multiviewStatus.textContent =
          `${phase} · frame ${processed} of ${Math.max(target, 1)} for this angle`;
        updateWorkDetail(
          'multiview',
          `${phase} · frame ${processed} / ${Math.max(target, 1)}`
          + (total > target ? ` · ${total} in this path` : ''),
        );
        scanTray.trackingProgress({ processed, target, total });
      },
    });
    if (session.canceled) return;
    inferenceFinishedAt = performance.now();
    const {
      mask,
      maskW,
      maskH,
      score,
      validation,
      provider,
    } = propagated;
    scanTray.tracked({
      id: view.id,
      label: view.label,
      mask,
      maskW,
      maskH,
      accepted: Boolean(propagated.accepted && !validation?.needsReview),
    });
    if (validation?.areaRatio > 0 && propagated.accepted) {
      session.previousAreaByBranch.set(branch, validation.areaRatio);
    }
    if (!propagated.accepted || !mask) {
      const failedProposal = {
        view,
        selected: new Set(),
        visible: guidance.visibleSelection,
        score,
        mask,
        maskW,
        maskH,
        guidance,
        provider,
        validation,
        alteredVisibility: false,
        timings: {
          renderMs: renderFinishedAt - startedAt,
          inferenceMs: inferenceFinishedAt - renderFinishedAt,
          fusionMs: 0,
        },
      };
      const fatal = validation?.fatalReasons?.length > 0 || !mask;
      if (fatal) {
        recordMultiviewSkip(
          session,
          propagated.reasons?.[0] || 'object not found',
        );
        scanTray.skipped({
          id: view.id,
          reason: 'object not found',
        });
        addViewEvidence(session.evidence, {
          selected: failedProposal.selected,
          visible: failedProposal.visible,
          score: 0,
          accepted: false,
          failed: true,
        });
        state.multiview.timing = updateTimingAverage(
          state.multiview.timing,
          failedProposal.timings,
        );
        session.index++;
        updateMultiviewProgress(session);
        ui.multiviewStatus.textContent =
          `Angle ${viewNumber} skipped — ${propagated.reasons?.[0] || 'object not found'}`;
        setWork({
          key: `multiview-${session.id}`,
          state: 'busy',
          title: `Angle ${viewNumber} skipped safely`,
          detail: 'The object was lost in this angle, so nothing from it was used.',
          steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
          active: 1,
        });
        setTimeout(() => processNextMultiviewView(session), 180);
      } else {
        session.currentProposal = failedProposal;
        showMultiviewReview(
          session,
          propagated.reasons?.[0] || 'The object could not be followed reliably in this angle.',
        );
      }
      return;
    }

    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: `Mapping angle ${viewNumber} into 3D`,
      detail: 'Checking which visible scene points consistently belong to the object.',
      steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
      active: 2,
    });
    const lifted = await liftProjectedMaskAsync({
      projection,
      mask,
      maskW,
      maskH,
      absSlack: state.slack * state.splat.scale,
      relSlack: 0.01,
    }, (progress, seedCount) => {
      updateWorkDetail(
        'multiview',
        `Mapping this side · ${Math.round(progress * 100)}% · ${seedCount.toLocaleString()} splats`,
      );
    }, () => session.canceled || state.multiview.session !== session);
    const selected = await growAsync({
      grid: state.grid,
      centers: state.splat.centers,
      colors: state.splat.colors,
      seeds: lifted.seeds,
      proj: lifted.proj,
      mask,
      maskW,
      maskH,
      viewW: rendered.width,
      viewH: rendered.height,
      // A novel view already exposes the surface we want as lift seeds. Only
      // bridge sparse raster gaps here. Dense masks are already the surface;
      // expanding every seed is redundant and can flood into its surroundings.
      radius: Math.min(state.radius, 0.004) * state.splat.scale,
      steps: lifted.seeds.length >= 8_000
        ? 0
        : lifted.seeds.length >= 2_000
          ? Math.min(1, state.steps)
          : Math.min(2, state.steps),
      depthBand: state.slack * state.splat.scale * 3,
    }, (progress, count) => {
      updateWorkDetail(
        'multiview',
        `${count.toLocaleString()} possible object points · ${Math.round(progress * 100)}%`,
      );
    }, () => session.canceled || state.multiview.session !== session);
    const visible = await collectVisibleObjectGaussians(
      projection,
      session.baseSelection,
      session,
    );
    session.currentProposal = {
      view,
      selected,
      visible,
      membershipWeights: lifted.seedWeights,
      score,
      mask,
      maskW,
      maskH,
      guidance,
      provider,
      validation,
      alteredVisibility: false,
      timings: {
        renderMs: renderFinishedAt - startedAt,
        inferenceMs: inferenceFinishedAt - renderFinishedAt,
        fusionMs: performance.now() - inferenceFinishedAt,
      },
    };
    if (!validation?.needsReview) {
      // A clean tracked mask is background work, not a review chore. Apply it
      // without mounting and immediately removing the review card; only
      // genuinely ambiguous evidence should change the panel's layout.
      session.waitingReview = true;
      await resolveMultiviewProposal(true);
      return;
    }
    showMultiviewReview(
      session,
      `${selected.size.toLocaleString()} possible object points · match quality ${Math.round(score * 100)}%`,
    );
  } catch (error) {
    if (error.name === 'AbortError' || session.canceled) return;
    console.error(error);
    const retries = session.frameFailureRetries.get(view.id) ?? 0;
    if (retries < 1) {
      session.frameFailureRetries.set(view.id, retries + 1);
      ui.multiviewStatus.textContent =
        `Angle ${viewNumber} interrupted — retrying automatically`;
      setWork({
        key: `multiview-${session.id}`,
        state: 'queued',
        title: `Retrying angle ${viewNumber}`,
        detail: 'The tracker did not return a frame. No result was applied and no review is needed.',
        steps: ['retry frame', 'follow object', 'map to 3D', 'combine'],
        active: 0,
      });
      setTimeout(() => processNextMultiviewView(session), 350);
    } else {
      addViewEvidence(session.evidence, {
        selected: new Set(),
        visible: new Set(),
        score: 0,
        accepted: false,
        failed: true,
      });
      scanTray.skipped({
        id: view.id,
        reason: 'tracker error',
      });
      recordMultiviewSkip(session, 'tracker error');
      session.index++;
      updateMultiviewProgress(session);
      updateMultiviewEstimate();
      ui.multiviewStatus.textContent =
        `Angle ${viewNumber} skipped after a tracker error — continuing automatically`;
      setWork({
        key: `multiview-${session.id}`,
        state: 'busy',
        title: `Angle ${viewNumber} skipped`,
        detail: 'The tracker failed twice, so this angle contributed no evidence. The remaining angles continue.',
        steps: ['render angle', 'follow object', 'map to 3D', 'combine'],
        active: 1,
      });
      setTimeout(() => processNextMultiviewView(session), 180);
    }
  } finally {
    session.processing = false;
  }
}

function showMultiviewReview(session, message) {
  if (state.multiview.session !== session || session.canceled) return;
  session.waitingReview = true;
  const proposal = session.currentProposal;
  drawMultiviewProposal(proposal);
  ui.multiviewReview.hidden = false;
  ui.multiviewReviewStatus.textContent = message;
  ui.multiviewAccept.textContent = proposal?.alteredVisibility
    ? 'Keep as needs checking'
    : 'Use this mask';
  ui.multiviewReject.textContent = proposal?.alteredVisibility
    ? 'Ignore reveal'
    : 'Skip angle';
  ui.multiviewStatus.textContent =
    proposal?.alteredVisibility
      ? `Review reveal view ${session.index + 1} of ${session.views.length} — possible hidden surfaces`
      : `Review angle ${session.index + 1} of ${session.views.length} — the cockpit view stayed fixed`;
  setWork({
    key: `multiview-${session.id}`,
    state: 'queued',
    title: `Review angle ${session.index + 1} of ${session.views.length}`,
    detail: message,
    steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
    active: 3,
  });
}

async function resolveMultiviewProposal(accepted) {
  const session = state.multiview.session;
  const proposal = session?.currentProposal;
  if (!session?.waitingReview || !proposal || session.materializing) return;
  session.waitingReview = false;
  ui.multiviewReview.hidden = true;

  if (accepted) {
    session.materializing = true;
    pushSelectionHistory(`Accepted multiview ${session.index + 1}`);
    addViewEvidence(session.evidence, {
      selected: proposal.selected,
      visible: proposal.visible,
      score: proposal.score,
      membershipWeights: proposal.membershipWeights,
      viewGroup: proposal.view?.evidenceGroup ?? session.index,
      accepted: true,
      alteredVisibility: proposal.alteredVisibility,
    });
    const fused = fuseViewEvidence(session.evidence, {
      baseSelection: session.baseSelection,
      baseConfidence: session.baseConfidence,
      confidenceBuffer: session.fusedConfidence,
      locked: state.locked,
      minimumViews: state.multiview.minimumViews,
      confidenceThreshold: state.multiview.confidence,
      provisionalThreshold: state.minimumConfidence,
    });
    for (const index of state.manualExcluded) {
      fused.selection.delete(index);
      fused.newlyAdded.delete(index);
      fused.provisional.delete(index);
      fused.confidence[index] = 0;
    }
    const addedCount = await materializeFusedSelection(session, fused, session.index + 1);
    scanTray.fuse({
      id: proposal.view.id,
      added: addedCount,
    });
    session.materializing = false;
    if (state.multiview.session !== session || session.canceled) return;
  } else {
    addViewEvidence(session.evidence, {
      selected: proposal.selected,
      visible: proposal.visible,
      score: proposal.score,
      membershipWeights: proposal.membershipWeights,
      viewGroup: proposal.view?.evidenceGroup ?? session.index,
      accepted: false,
      alteredVisibility: proposal.alteredVisibility,
    });
    scanTray.skipped({
      id: proposal.view.id,
      reason: 'not used',
    });
    ui.multiviewStatus.textContent = `Angle ${session.index + 1} ignored — no points added`;
  }
  state.multiview.timing = updateTimingAverage(state.multiview.timing, proposal.timings);
  session.currentProposal = null;
  session.index++;
  updateMultiviewProgress(session);
  updateMultiviewEstimate();
  if (!session.paused) setTimeout(() => processNextMultiviewView(session), 140);
}

/**
 * Reveal newly corroborated geometry as a short spatial wave instead of
 * replacing the object in one visually opaque jump. This only runs after an
 * accepted, fused view; raw one-view proposals stay in the review canvas.
 */
async function materializeFusedSelection(session, fused, viewNumber) {
  const additions = [...fused.newlyAdded].filter((index) => !state.selection.has(index));
  state.confidence = fused.confidence;
  state.forcedProvisional = new Set(fused.provisional);
  rebuildProvisionalState(fused.selection);
  state.selection = fused.selection;
  if (!additions.length) {
    renderSelectionState();
    ui.multiviewStatus.textContent =
      `Angle ${viewNumber} confirmed the current object — no new points`;
    return 0;
  }

  // Update CPU/GPU buffers once per accepted mask. The blue "fall into place"
  // shader already animates the whole delta; rebuilding all highlight and
  // preview geometry six or seven times only delayed input by seconds.
  showRecentlyAdded(additions);
  ui.multiviewStatus.textContent =
    `Angle ${viewNumber} added ${additions.length.toLocaleString()} supported points`;
  return additions.length;
}

function finishMultiviewSession(session, title) {
  if (state.multiview.session !== session) return;
  session.canceled = true;
  const evidenceSummary = {
    accepted: session.evidence?.acceptedViews ?? 0,
    rejected: session.evidence?.rejectedViews ?? 0,
    failed: session.evidence?.failedViews ?? 0,
  };
  propagationProvider.close().catch((error) => {
    console.warn('[tracking] session cleanup failed', error);
  });
  if (session.trackingCutout) {
    refinementScene.remove(session.trackingCutout.object3D);
    Promise.resolve(session.trackingCutout.dispose?.()).catch((error) => {
      console.warn('[tracking] cutout cleanup failed', error);
    });
    session.trackingCutout = null;
  }
  session.stagedFrames.clear();
  session.stagedPoseFrames.clear();
  // A cancel can arrive while WebGL is waiting on an asynchronous pixel-pack
  // fence. Dispose as soon as that bounded transfer returns, never while the
  // GPU still owns the target.
  releaseRefinementRenderBuffersWhenIdle(session);
  session.diagnostics.finishedAt = performance.now();
  session.diagnostics.durationMs =
    session.diagnostics.finishedAt - session.diagnostics.startedAt;
  session.diagnostics.outcome = title;
  scanDiagnostics.last = session.diagnostics;
  scanDiagnostics.current = null;
  state.multiview.session = null;
  lastRenderedFrameAt = 0;
  ui.selectionProps.dataset.scanning = 'false';
  clearBusy('object scan');
  controls.enabled = true;
  startMultiviewButton.disabled = false;
  ui.previewScan.disabled = false;
  pauseMultiviewButton.disabled = true;
  pauseMultiviewButton.hidden = true;
  pauseMultiviewButton.textContent = 'Pause';
  cancelMultiviewButton.disabled = true;
  cancelMultiviewButton.hidden = true;
  ui.multiviewReview.hidden = true;
  if (title.includes('complete')) {
    scanTray.finish({ label: 'All sides checked' });
  } else {
    scanTray.cancel();
  }
  ui.multiviewProgress.style.width = title.includes('complete') ? '100%' : ui.multiviewProgress.style.width;
  const skippedSummary = summarizeMultiviewSkips(session);
  ui.multiviewStatus.textContent =
    `${title} · ${evidenceSummary.accepted} used, `
    + `${evidenceSummary.rejected} rejected, ${evidenceSummary.failed} skipped`
    + (skippedSummary ? ` · ${skippedSummary}` : '');
  setWork({
    key: `multiview-finished-${session.id}`,
    state: 'ready',
    title,
    detail: `${state.selection.size.toLocaleString()} selected points · your view did not move`,
    steps: ['render angle', 'follow object', 'map to 3D', 'review', 'combine'],
    active: 5,
  });
  // Synthetic captures never move the visible cockpit camera. Keep its exact
  // frozen projection so 2D editing can immediately restart tracking instead
  // of forcing another encode and losing the editable seed.
  state.encoded = Boolean(state.frozen?.revision === viewRevision);
  setSelectionReadiness(state.encoded ? 'ready' : 'idle');
  if (state.active?.currentMask) {
    renderEditableProjection();
    ui.projectionMaskTools.hidden = false;
  } else if (!state.encoded) {
    scheduleEncode(0);
  }
  refreshMultiviewCapability();
  renderSelectionState();
  // Break references to the largest typed arrays even if a queued callback
  // still temporarily retains the session object.
  session.projectionCache = null;
  session.projectionIndices = null;
  session.projectionIndexSpace = null;
  session.evidence?.touched?.clear?.();
  session.evidence = null;
  session.baseConfidence = null;
  session.fusedConfidence = null;
}

function recordMultiviewSkip(session, reason) {
  const plainReason = String(reason || 'unknown reason')
    .replace(/[.!]+$/, '')
    .toLowerCase();
  session.skippedReasons.set(
    plainReason,
    (session.skippedReasons.get(plainReason) ?? 0) + 1,
  );
}

function summarizeMultiviewSkips(session) {
  if (!session.skippedReasons?.size) return '';
  const [reason, count] = [...session.skippedReasons.entries()]
    .sort((a, b) => b[1] - a[1])[0];
  return `${count}× ${reason}`;
}

function stopMultiviewForSeedEdit(
  title = 'Restarting from the edited 2D mask',
) {
  clearTimeout(automaticMultiviewTimer);
  const session = state.multiview.session;
  if (!session) return;
  session.canceled = true;
  finishMultiviewSession(session, title);
}

function scheduleAutomaticMultiview(reason = 'selection ready', delay = 650) {
  clearTimeout(automaticMultiviewTimer);
  const active = state.active;
  if (!active?.currentMask || !state.selection.size
    || state.multiview.trackerStatus !== 'ready'
    || state.projectionEditorOpen
    || state.editMode !== 'off') return;
  const requestToken = active.requestToken;
  automaticMultiviewTimer = setTimeout(() => {
    if (state.active !== active || active.requestToken !== requestToken
      || state.multiview.session) return;
    if (state.projectionEditorOpen || state.editMode !== 'off') {
      ui.multiviewStatus.textContent =
        'All-sides fill is waiting for the 2D mask editor to close';
      return;
    }
    if (state.busy) {
      scheduleAutomaticMultiview(reason, 120);
      return;
    }
    ui.multiviewStatus.textContent = `${reason} · starting SAM 3 all-sides fill…`;
    startMultiviewRefinement();
  }, delay);
}

function updateMultiviewProgress(session) {
  const preparationShare = session.trackingStaged ? 8 : 0;
  const viewShare = 100 - preparationShare;
  const viewProgress = session.index / Math.max(1, session.views.length);
  ui.multiviewProgress.style.width =
    `${preparationShare + viewProgress * viewShare}%`;
}

function saveCameraState() {
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    up: camera.up.clone(),
    fov: camera.fov,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
    projectionMatrix: camera.projectionMatrix.clone(),
    target: controls.target.clone(),
  };
}

function restoreCameraState(saved) {
  camera.position.copy(saved.position);
  camera.quaternion.copy(saved.quaternion);
  camera.up.copy(saved.up);
  camera.fov = saved.fov;
  camera.aspect = saved.aspect;
  camera.near = saved.near;
  camera.far = saved.far;
  camera.projectionMatrix.copy(saved.projectionMatrix);
  camera.projectionMatrixInverse.copy(saved.projectionMatrix).invert();
  controls.target.copy(saved.target);
  camera.updateMatrixWorld(true);
}

function applyViewToCamera(view, targetCamera) {
  const matrix = new THREE.Matrix4().fromArray(view.transform);
  matrix.decompose(targetCamera.position, targetCamera.quaternion, targetCamera.scale);
  const width = view.width || renderer.domElement.width;
  const height = view.height || renderer.domElement.height;
  targetCamera.aspect = width / height;
  targetCamera.near = view.near ?? camera.near;
  targetCamera.far = view.far ?? camera.far;
  if (view.fov) targetCamera.fov = view.fov;
  else if (view.flY) targetCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * view.flY)));
  else if (view.cameraAngleY) targetCamera.fov = THREE.MathUtils.radToDeg(view.cameraAngleY);
  else if (view.cameraAngleX) {
    targetCamera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(view.cameraAngleX / 2) / targetCamera.aspect),
    );
  }
  targetCamera.updateProjectionMatrix();
  targetCamera.updateMatrixWorld(true);
}

function ensureRefinementRenderTarget(width, height) {
  if (refinementReadback.target
    && refinementReadback.width === width
    && refinementReadback.height === height) {
    return refinementReadback.target;
  }
  refinementReadback.target?.dispose();
  refinementReadback.target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });
  refinementReadback.target.texture.colorSpace = renderer.outputColorSpace;
  refinementReadback.pixels = new Uint8Array(width * height * 4);
  refinementReadback.image = multiviewCaptureCtx.createImageData(width, height);
  refinementReadback.width = width;
  refinementReadback.height = height;
  return refinementReadback.target;
}

function releaseRefinementRenderBuffers() {
  refinementReadback.target?.dispose();
  refinementReadback.target = null;
  refinementReadback.pixels = null;
  refinementReadback.image = null;
  refinementReadback.width = 0;
  refinementReadback.height = 0;
  for (const canvas of [
    multiviewCapture,
    multiviewSeedCanvas,
    multiviewMaskCanvas,
  ]) {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function releaseRefinementRenderBuffersWhenIdle(session) {
  if (session.capturing) {
    setTimeout(() => releaseRefinementRenderBuffersWhenIdle(session), 16);
    return;
  }
  releaseRefinementRenderBuffers();
}

async function stageTemporalTrackingFrames(session) {
  const trackedViews = session.trackingViews.filter((view) => view.trackBranch);
  const branchFrames = new Map();
  const stageStartedAt = performance.now();
  let stagedBytes = 0;
  for (let index = 0; index < trackedViews.length; index++) {
    if (state.multiview.session !== session || session.canceled) {
      throw new DOMException('Tracking preparation superseded', 'AbortError');
    }
    const view = trackedViews[index];
    ui.multiviewStatus.textContent =
      `Rendering view ${index + 1} of ${trackedViews.length}`;
    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: `Rendering views · ${index + 1} of ${trackedViews.length}`,
      detail: 'Building the complete ordered image sequence before object tracking begins.',
      steps: ['prepare angles', 'follow object', 'map to 3D', 'review', 'combine'],
      active: 0,
    });
    const poseKey = view.transform
      .map((value) => Number(value).toFixed(5))
      .join(',');
    let blob = session.stagedPoseFrames.get(poseKey);
    let capture = null;
    let encodeMs = 0;
    const reused = Boolean(blob);
    if (!blob) {
      applyViewToCamera(view, refinementCamera);
      capture = await captureRefinementView(session, view, refinementCamera);
      const encodeStartedAt = performance.now();
      blob = await canvasToBlob(multiviewCapture, 'image/jpeg', 0.86);
      encodeMs = performance.now() - encodeStartedAt;
      stagedBytes += blob.size;
      session.diagnostics.memory.stagedBytes = stagedBytes;
      if (stagedBytes > MAX_STAGED_TRACKING_BYTES) {
        throw new RangeError(
          `The prepared view sequence exceeded the ${Math.round(
            MAX_STAGED_TRACKING_BYTES / 1_048_576,
          )} MB safety budget.`,
        );
      }
      session.stagedPoseFrames.set(poseKey, blob);
    }
    if (session.keyViewIds.has(view.id)) {
      if (capture) {
        scanTray.rendered({
          id: view.id,
          label: view.label,
          canvas: multiviewCapture,
        });
      } else {
        const bitmap = await createImageBitmap(blob);
        try {
          scanTray.rendered({
            id: view.id,
            label: view.label,
            canvas: bitmap,
          });
        } finally {
          bitmap.close();
        }
      }
    }
    session.diagnostics.frames.push({
      id: view.id,
      label: view.label,
      reused,
      sortMs: capture?.timings.sortMs ?? 0,
      renderMs: capture?.timings.renderMs ?? 0,
      readbackMs: capture?.timings.readbackMs ?? 0,
      imageCopyMs: capture?.timings.imageCopyMs ?? 0,
      encodeMs,
      totalMs: (capture?.timings.totalMs ?? 0) + encodeMs,
    });
    if (reused) session.diagnostics.reusedFrames++;
    else session.diagnostics.renderedFrames++;
    if (session.keyViewIds.has(view.id)) {
      session.stagedFrames.set(view.id, blob);
    }
    if (!branchFrames.has(view.trackBranch)) branchFrames.set(view.trackBranch, []);
    branchFrames.get(view.trackBranch).push({ view, blob });
    ui.multiviewProgress.style.width =
      `${(index + 1) / trackedViews.length * 35}%`;
    // Give pointer/editor input a frame in which to cancel before starting
    // another expensive splat sort.
    await yieldInteractiveFrame(session);
  }
  session.diagnostics.stageFramesMs = performance.now() - stageStartedAt;
  session.diagnostics.totals = summarizeCaptureTimings(session.diagnostics.frames);
  console.info('[tracking] synthetic views ready', {
    source: session.diagnostics.captureSource,
    cutoutSplats: session.diagnostics.cutoutSplats,
    cutoutBuildMs: Math.round(session.diagnostics.cutoutBuildMs),
    frames: session.diagnostics.frames.length,
    uniqueRenders: session.diagnostics.renderedFrames,
    reused: session.diagnostics.reusedFrames,
    stageFramesMs: Math.round(session.diagnostics.stageFramesMs),
    totals: session.diagnostics.totals,
  });
  return branchFrames;
}

function uniqueBlobBytes(blobs) {
  const unique = new Set();
  let bytes = 0;
  for (const blob of blobs) {
    if (!blob || unique.has(blob)) continue;
    unique.add(blob);
    bytes += blob.size ?? 0;
  }
  return bytes;
}

function summarizeCaptureTimings(frames) {
  const total = {
    sortMs: 0,
    renderMs: 0,
    readbackMs: 0,
    imageCopyMs: 0,
    encodeMs: 0,
    totalMs: 0,
  };
  for (const frame of frames) {
    for (const key of Object.keys(total)) total[key] += frame[key] || 0;
  }
  for (const key of Object.keys(total)) total[key] = Math.round(total[key] * 10) / 10;
  return total;
}

async function yieldInteractiveFrame(session) {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (state.multiview.session !== session || session.canceled) {
    throw new DOMException('Tracking preparation superseded', 'AbortError');
  }
}

async function drawStagedTrackingFrame(blob, view) {
  const width = Math.max(1, Math.round(view.width || 768));
  const height = Math.max(1, Math.round(view.height || 512));
  if (multiviewCapture.width !== width || multiviewCapture.height !== height) {
    multiviewCapture.width = width;
    multiviewCapture.height = height;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    multiviewCaptureCtx.clearRect(0, 0, width, height);
    multiviewCaptureCtx.drawImage(bitmap, 0, 0, width, height);
  } finally {
    bitmap.close();
  }
  return { width, height };
}

/**
 * Render one synthetic camera with the standard Three.js render-target flow.
 * The resident cutout owns its own Gaussian sorter; the cockpit scene and its
 * depth order are untouched. Pixel transfer uses Three.js' asynchronous
 * WebGL2 readback when available, allowing normal frames to render while the
 * GPU copy completes.
 */
async function captureRefinementView(session, view, targetCamera) {
  const width = Math.max(1, Math.round(view.width || multiviewCapture.width || 768));
  const height = Math.max(1, Math.round(view.height || multiviewCapture.height || 512));
  const target = ensureRefinementRenderTarget(width, height);
  const previousTarget = renderer.getRenderTarget();
  const previousClearColor = renderer.getClearColor(new THREE.Color());
  const previousClearAlpha = renderer.getClearAlpha();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousAutoClear = renderer.autoClear;
  const captureSource = session.trackingCutout;
  const captureScene = refinementScene;
  if (!captureSource) {
    throw new Error('Synthetic capture requires a resident Gaussian cutout');
  }
  const timings = {
    sortMs: 0,
    renderMs: 0,
    readbackMs: 0,
    imageCopyMs: 0,
    totalMs: 0,
  };
  const captureStartedAt = performance.now();
  let rendererStateRestored = false;
  session.capturing = true;
  const restoreRendererState = () => {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.autoClear = previousAutoClear;
    rendererStateRestored = true;
  };

  try {
    const sortStartedAt = performance.now();
    await captureSource.prepareView(renderer, targetCamera);
    timings.sortMs = performance.now() - sortStartedAt;
    if (session.canceled || state.multiview.session !== session) {
      throw new DOMException('View capture superseded', 'AbortError');
    }

    const renderStartedAt = performance.now();
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    // DropInViewer updates itself from its onBeforeRender callback. Calling
    // update() here as well would ask its sorter to inspect the same camera
    // twice for every synthetic frame.
    renderer.render(captureScene, targetCamera);
    timings.renderMs = performance.now() - renderStartedAt;

    const readbackStartedAt = performance.now();
    const asyncReadback = typeof renderer.readRenderTargetPixelsAsync === 'function';
    const readback = asyncReadback
      ? renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
        refinementReadback.pixels,
      )
      : null;
    if (!asyncReadback) {
      renderer.readRenderTargetPixels(
        target,
        0,
        0,
        width,
        height,
        refinementReadback.pixels,
      );
    }
    // Restore the visible framebuffer before awaiting the GPU fence. This is
    // what keeps requestAnimationFrame free to draw the cockpit meanwhile.
    restoreRendererState();
    if (readback) await readback;
    timings.readbackMs = performance.now() - readbackStartedAt;
    if (session.canceled || state.multiview.session !== session) {
      throw new DOMException('View capture superseded', 'AbortError');
    }

    const copyStartedAt = performance.now();
    if (multiviewCapture.width !== width || multiviewCapture.height !== height) {
      multiviewCapture.width = width;
      multiviewCapture.height = height;
    }
    const image = refinementReadback.image;
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const sourceOffset = (height - 1 - y) * rowBytes;
      image.data.set(
        refinementReadback.pixels.subarray(sourceOffset, sourceOffset + rowBytes),
        y * rowBytes,
      );
    }
    multiviewCaptureCtx.putImageData(image, 0, 0);
    timings.imageCopyMs = performance.now() - copyStartedAt;
  } finally {
    if (!rendererStateRestored) restoreRendererState();
    session.capturing = false;
  }
  timings.totalMs = performance.now() - captureStartedAt;
  return { width, height, timings };
}

function projectSelectionCentroid(width, height) {
  if (!state.selection.size) return null;
  const centre = new THREE.Vector3();
  for (const index of state.selection) {
    centre.x += state.splat.centers[index * 3];
    centre.y += state.splat.centers[index * 3 + 1];
    centre.z += state.splat.centers[index * 3 + 2];
  }
  centre.multiplyScalar(1 / state.selection.size).project(camera);
  if (centre.z < -1 || centre.z > 1 || Math.abs(centre.x) > 1 || Math.abs(centre.y) > 1) return null;
  return {
    x: (centre.x * 0.5 + 0.5) * width,
    y: (-centre.y * 0.5 + 0.5) * height,
  };
}

async function collectVisibleObjectGaussians(projection, objectSelection, session) {
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const index of objectSelection) {
    point.fromArray(state.splat.centers, index * 3);
    bounds.expandByPoint(point);
  }
  bounds.expandByScalar(Math.max(bounds.getSize(point).length() * 0.2, state.splat.scale * 0.002));
  const visible = new Set();
  const { sx, sy, sd, depth, tw, tile } = projection;
  const candidates = projection.activeIndices ?? session.projectionIndices;
  const candidateCount = candidates?.length ?? state.splat.count;
  for (let start = 0; start < candidateCount; start += 200_000) {
    const end = Math.min(candidateCount, start + 200_000);
    for (let ordinal = start; ordinal < end; ordinal++) {
      const index = candidates ? candidates[ordinal] : ordinal;
      const slot = projectionSlot(projection, index);
      if (slot < 0 || sd[slot] <= 0) continue;
      point.fromArray(state.splat.centers, index * 3);
      if (!bounds.containsPoint(point)) continue;
      const depthIndex = ((sy[slot] / tile) | 0) * tw + ((sx[slot] / tile) | 0);
      const nearest = depth[depthIndex];
      if (sd[slot] <= nearest + state.slack * state.splat.scale + nearest * 0.01) {
        visible.add(index);
      }
    }
    if (session.canceled) throw new DOMException('Multiview visibility superseded', 'AbortError');
    await yieldInteractiveFrame(session);
  }
  return visible;
}

/**
 * A heavily blocked angle can still contain useful evidence behind unrelated
 * foreground geometry. Render one visibly-labelled diagnostic version with a
 * conservative foreground shell hidden, then decode it independently. The
 * resulting evidence is always marked alteredVisibility, so it can enter the
 * object only as provisional and never counts as an independent confirming
 * view.
 */
async function tryOccluderRevealPass({
  session,
  view,
  viewNumber,
  intactProjection,
  startedAt,
  trigger,
}) {
  if (session.revealAttempts.has(view.id)) return false;
  session.revealAttempts.add(view.id);

  const reveal = findOccluderRevealCandidates({
    projection: intactProjection,
    centers: state.splat.centers,
    selection: state.selection,
    locked: state.locked,
    protectedIndices: state.recentlyAdded,
    absSlack: state.slack * state.splat.scale,
    aggression: 0.38 + 0.18 * (
      session.index / Math.max(1, session.views.length - 1)
    ),
  });
  if (!reveal.safe || !reveal.candidates.size) return false;

  const hiddenCount = reveal.candidates.size;
  ui.multiviewStatus.textContent =
    `Angle ${viewNumber} is blocked — checking behind the foreground`;
  setWork({
    key: `multiview-${session.id}`,
    state: 'busy',
    title: `Checking behind the obstruction`,
    detail: `${hiddenCount.toLocaleString()} unrelated foreground points are hidden in this diagnostic view only.`,
    steps: ['render angle', 'reveal hidden area', 'map to 3D', 'review', 'combine'],
    active: 1,
  });

  state.splat.setTemporaryHiddenSplats(reveal.candidates);
  let revealRenderFinishedAt = performance.now();
  let revealInferenceFinishedAt = revealRenderFinishedAt;
  try {
    const rendered = await captureRefinementView(session, view, refinementCamera);
    revealRenderFinishedAt = performance.now();
    if (session.canceled || state.multiview.session !== session) {
      throw new DOMException('Reveal view superseded', 'AbortError');
    }

    refinementCamera.updateMatrixWorld(true);
    const viewProj = new THREE.Matrix4().multiplyMatrices(
      refinementCamera.projectionMatrix,
      refinementCamera.matrixWorldInverse,
    );
    const projection = await projectSplatsAsync({
      centers: state.splat.centers,
      count: state.splat.count,
      viewProj: viewProj.elements,
      viewW: rendered.width,
      viewH: rendered.height,
      hidden: state.splat.getHiddenSplatsData(),
      radii: state.splat.radii,
      opacity: state.splat.opacity,
      indices: session.projectionIndices,
      indexSpace: session.projectionIndexSpace,
      reuse: session.projectionCache,
    }, (progress) => {
      updateWorkDetail(
        'multiview',
        `Checking the revealed surface · ${Math.round(progress * 100)}%`,
      );
    }, () => session.canceled || state.multiview.session !== session);
    session.projectionCache = projection;
    const guidance = buildProjectedSelectionGuidance({
      projection,
      selection: state.selection,
      projectionW: rendered.width,
      projectionH: rendered.height,
      targetW: multiviewCapture.width,
      targetH: multiviewCapture.height,
      depthSlack: state.slack * state.splat.scale,
    });
    if (!guidance.positive.length) return false;

    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: 'Checking the revealed surface',
      detail: 'Matching it to the selected object. Any new points remain “needs checking”.',
      steps: ['render angle', 'reveal hidden area', 'map to 3D', 'review', 'combine'],
      active: 1,
    });
    const branch = view.trackBranch ?? view.source ?? 'captured';
    const propagated = await propagationProvider.propagateFallback({
      canvas: multiviewCapture,
      guidance,
      previousAreaRatio: null,
      branch,
      view,
    });
    revealInferenceFinishedAt = performance.now();
    if (!propagated.accepted || !propagated.mask) return false;

    setWork({
      key: `multiview-${session.id}`,
      state: 'busy',
      title: 'Mapping possible hidden surfaces',
      detail: 'These points need confirmation from an ordinary view before they become final.',
      steps: ['render angle', 'reveal hidden area', 'map to 3D', 'review', 'combine'],
      active: 2,
    });
    const {
      mask,
      maskW,
      maskH,
      score,
      validation,
      provider,
    } = propagated;
    scanTray.tracked({
      id: view.id,
      label: `${view.label} · revealed`,
      mask,
      maskW,
      maskH,
      accepted: false,
    });
    const lifted = await liftProjectedMaskAsync({
      projection,
      mask,
      maskW,
      maskH,
      absSlack: state.slack * state.splat.scale,
      relSlack: 0.01,
    }, (progress, seedCount) => {
      updateWorkDetail(
        'multiview',
        `Mapping revealed splats · ${Math.round(progress * 100)}% · ${seedCount.toLocaleString()} found`,
      );
    }, () => session.canceled || state.multiview.session !== session);
    const selected = await growAsync({
      grid: state.grid,
      centers: state.splat.centers,
      colors: state.splat.colors,
      seeds: lifted.seeds,
      proj: lifted.proj,
      mask,
      maskW,
      maskH,
      viewW: rendered.width,
      viewH: rendered.height,
      radius: Math.min(state.radius, 0.004) * state.splat.scale,
      steps: Math.min(2, state.steps),
      depthBand: state.slack * state.splat.scale * 3,
    }, (progress, count) => {
      updateWorkDetail(
        'multiview',
        `${count.toLocaleString()} possible hidden points · ${Math.round(progress * 100)}%`,
      );
    }, () => session.canceled || state.multiview.session !== session);
    const visible = await collectVisibleObjectGaussians(
      projection,
      session.baseSelection,
      session,
    );
    session.currentProposal = {
      view,
      selected,
      visible,
      membershipWeights: lifted.seedWeights,
      score,
      mask,
      maskW,
      maskH,
      guidance,
      provider,
      validation,
      alteredVisibility: true,
      reveal: {
        hiddenCount,
        occludedRatio: reveal.occludedRatio,
        trigger,
      },
      timings: {
        renderMs: revealRenderFinishedAt - startedAt,
        inferenceMs: revealInferenceFinishedAt - revealRenderFinishedAt,
        fusionMs: performance.now() - revealInferenceFinishedAt,
      },
    };
    showMultiviewReview(
      session,
      `${selected.size.toLocaleString()} possible hidden points · foreground temporarily removed. `
        + 'Keep them as “needs checking” or ignore this reveal.',
    );
    return true;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    console.warn('[multiview] diagnostic reveal failed safely', error);
    return false;
  } finally {
    state.splat.clearTemporaryHiddenSplats();
  }
}

function drawMultiviewProposal(proposal) {
  const canvas = ui.multiviewCanvas;
  canvas.width = multiviewCapture.width;
  canvas.height = multiviewCapture.height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(multiviewCapture, 0, 0);
  if (proposal?.mask) {
    multiviewMaskCanvas.width = proposal.maskW;
    multiviewMaskCanvas.height = proposal.maskH;
    const image = multiviewMaskCtx.createImageData(proposal.maskW, proposal.maskH);
    for (let i = 0; i < proposal.mask.length; i++) {
      if (!proposal.mask[i]) continue;
      const pixel = i * 4;
      image.data[pixel] = 112;
      image.data[pixel + 1] = 215;
      image.data[pixel + 2] = 255;
      image.data[pixel + 3] = 105;
    }
    multiviewMaskCtx.putImageData(image, 0, 0);
    context.drawImage(multiviewMaskCanvas, 0, 0, canvas.width, canvas.height);
  }
  for (const point of proposal?.guidance?.positive ?? []) {
    context.strokeStyle = '#f5ffff';
    context.fillStyle = '#58d6a8';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  for (const point of proposal?.guidance?.negative ?? []) {
    context.strokeStyle = '#ff5c2b';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(point.x - 4, point.y - 4);
    context.lineTo(point.x + 4, point.y + 4);
    context.moveTo(point.x + 4, point.y - 4);
    context.lineTo(point.x - 4, point.y + 4);
    context.stroke();
  }
  if (proposal?.alteredVisibility) {
    const label = `REVEAL VIEW · ${proposal.reveal?.hiddenCount?.toLocaleString?.() ?? 0} FOREGROUND POINTS HIDDEN`;
    context.save();
    context.fillStyle = 'rgba(4, 10, 14, 0.84)';
    context.fillRect(0, 0, canvas.width, 28);
    context.fillStyle = '#ffbd61';
    context.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';
    context.fillText(label, 10, 14);
    context.restore();
  }
}

refreshMultiviewCapability();
refreshTrackerCapability();

let borderDrawing = false;
let lastBorderPoint = null;

ui.projectionCanvas.addEventListener('pointerdown', async (event) => {
  const active = state.active;
  if (event.button !== 0 || state.editMode === 'off' || !active?.currentMask) return;
  const point = projectionEventPoint(event);
  if (!point) return;
  stopMultiviewForSeedEdit();

  if (state.editMode === 'positive' || state.editMode === 'negative') {
    beginControlDiff('samPrompt');
    if (!active.sources.has('auto')) {
      active.sources = new Set(['auto']);
      setMethodUI(active.sources);
    }
    active.prompts.push({
      x: point.captureX,
      y: point.captureY,
      label: state.editMode === 'positive' ? 1 : 0,
    });
    active.requestToken++;
    await runActiveSelection();
    releaseControlDiff('samPrompt');
    event.preventDefault();
    return;
  }

  if (state.editMode.startsWith('polygon')) {
    state.polygonPoints.push({ x: point.maskX, y: point.maskY });
    finishPolygonButton.disabled = state.polygonPoints.length < 3;
    cancelPolygonButton.disabled = false;
    renderEditableProjection();
    event.preventDefault();
    return;
  }

  borderDrawing = true;
  lastBorderPoint = null;
  beginControlDiff('border');
  active.strokeUndo = active.manualEdits.slice();
  ui.projectionCanvas.setPointerCapture(event.pointerId);
  paintBorderAt(event);
  event.preventDefault();
});

ui.projectionCanvas.addEventListener('pointermove', (event) => {
  updateBrushCursor(event);
  if (!borderDrawing) return;
  paintBorderAt(event);
});
ui.projectionCanvas.addEventListener('pointerenter', updateBrushCursor);
ui.projectionCanvas.addEventListener('pointerleave', () => {
  if (!borderDrawing) ui.brushCursor.style.display = 'none';
});

ui.projectionCanvas.addEventListener('pointerup', finishBorderStroke);
ui.projectionCanvas.addEventListener('pointercancel', finishBorderStroke);
ui.projectionEditorOpen.addEventListener('click', () => setProjectionEditorOpen(true));
ui.projectionPip.addEventListener('click', (event) => {
  if (!event.target.closest('#projectionEditorBack')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setProjectionEditorOpen(false);
}, true);
ui.projectionCanvas.addEventListener('dblclick', (event) => {
  if (!state.editMode.startsWith('polygon')) return;
  event.preventDefault();
  finishPolygonEdit();
});

function paintBorderAt(event) {
  const active = state.active;
  if (!active?.currentMask) return;
  const projectionPoint = projectionEventPoint(event);
  if (!projectionPoint) return;
  const point = { x: projectionPoint.maskX, y: projectionPoint.maskY };
  const radius = Math.max(1, Math.min(active.maskW, active.maskH) * state.edgeBrush / 200);
  const distance = lastBorderPoint
    ? Math.hypot(point.x - lastBorderPoint.x, point.y - lastBorderPoint.y)
    : 0;
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.45)));

  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const x = lastBorderPoint ? THREE.MathUtils.lerp(lastBorderPoint.x, point.x, t) : point.x;
    const y = lastBorderPoint ? THREE.MathUtils.lerp(lastBorderPoint.y, point.y, t) : point.y;
    paintMask(
      active.currentMask,
      active.manualEdits,
      active.maskW,
      active.maskH,
      x,
      y,
      radius,
      event.altKey ? state.editMode === 'remove' : state.editMode === 'add',
    );
  }
  lastBorderPoint = point;
  renderSelectionOutline(active.currentMask, active.maskW, active.maskH);
  renderEditableProjection();
}

function updateBrushCursor(event) {
  if (state.editMode !== 'add' && state.editMode !== 'remove') return;
  const point = projectionEventPoint(event);
  if (!point) {
    ui.brushCursor.style.display = 'none';
    return;
  }
  const diameter = Math.min(point.contentWidth, point.contentHeight) * state.edgeBrush / 100;
  ui.brushCursor.style.width = `${diameter}px`;
  ui.brushCursor.style.height = `${diameter}px`;
  ui.brushCursor.style.left = `${event.clientX}px`;
  ui.brushCursor.style.top = `${event.clientY}px`;
  ui.brushCursor.style.display = 'block';
}

function finishBorderStroke(event) {
  if (!borderDrawing) return;
  borderDrawing = false;
  lastBorderPoint = null;
  if (ui.projectionCanvas.hasPointerCapture(event.pointerId)) {
    ui.projectionCanvas.releasePointerCapture(event.pointerId);
  }
  const active = state.active;
  if (!active?.currentMask) return;
  const requestToken = ++active.requestToken;
  active.maskConfidence = buildMaskConfidence(
    active.currentMask,
    active.maskW,
    active.maskH,
    state.boundarySoftness,
  );
  applyClassicGuideConfidence(
    active.maskConfidence,
    active.currentMask,
    active.maskW,
    active.maskH,
    active.resolvedSources,
    active.fusion,
  );
  active.maskConfidenceSoftness = state.boundarySoftness;
  active.liftCache = null;
  active.growCache = null;
  setStatus('updating 3D…', 'busy');
  setBusy('border update');
  releaseControlDiff('border');
  requestAnimationFrame(async () => {
    try {
      if (state.active !== active || requestToken !== active.requestToken) {
        setStatus(state.encoded ? 'ready' : 'view changed', state.encoded ? 'ready' : '');
        return;
      }
      await applySelectionMask(
        active,
        active.currentMask,
        active.maskW,
        active.maskH,
        requestToken,
      );
      if (state.active !== active || requestToken !== active.requestToken) return;
      setStatus('border updated', 'ready');
      setWork({
        key: `border-ready-${requestToken}`,
        state: 'ready',
        title: 'Border edit applied',
        detail: `${ui.selectionResult.textContent} · selection remains editable`,
        steps: ['paint', 'lift', 'grow'],
        active: 3,
      });
      scheduleAutomaticMultiview('2D mask edited');
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        setWork({
          key: `border-error-${requestToken}`,
          state: 'error',
          title: 'Border update failed',
          detail: error.message,
        });
      }
    } finally {
      clearBusy('border update');
      flushPendingSelection();
    }
  });
}

document.getElementById('undoStroke').addEventListener('click', undoLastBorderStroke);

function undoLastBorderStroke() {
  const active = state.active;
  if (!active?.strokeUndo) return;
  active.manualEdits = active.strokeUndo;
  active.strokeUndo = null;
  scheduleActiveSelection(0);
}

document.getElementById('resetBorder').addEventListener('click', () => {
  const active = state.active;
  if (!active?.manualEdits) return;
  active.manualEdits.fill(0);
  active.strokeUndo = null;
  scheduleActiveSelection(0);
});

addEventListener('keydown', (event) => {
  if (!state.active || event.target?.closest?.('input, textarea, button')) return;
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
    event.preventDefault();
    undoLastBorderStroke();
  } else if (event.code === 'KeyB') {
    setBorderEditMode('add');
  } else if (event.code === 'KeyX' && state.editMode !== 'off') {
    setBorderEditMode(state.editMode === 'add' ? 'remove' : 'add');
  } else if (event.code === 'Escape') {
    event.preventDefault();
    undoSelectionPreview();
  } else if (event.code === 'Enter') {
    keepSelectionPreview();
  }
});

document.getElementById('closeProps').addEventListener('click', () => {
  ui.selectionProps.hidden = true;
  document.body.dataset.inspector = 'false';
});

document.getElementById('keepPreview').addEventListener('click', keepSelectionPreview);
document.getElementById('undoPreview').addEventListener('click', undoSelectionPreview);

function keepSelectionPreview() {
  const count = state.selection.size;
  if (!count || !state.splat) return;
  setGaussianCleanup(false);
  setNearbyContext(false);
  setOrbitSelected(false);
  const segment = createDockSegment();
  state.dockedSegments.push(segment);
  renderDockSegment(segment);
  // Docking finishes every nested isolation level. The refined subset becomes
  // cargo; the unselected remainder returns to the source scene.
  state.focusStack.length = 0;
  updateFocusCloud(null);
  updateFocusRefineHud();
  updateDockVisibilityMask();

  state.selection = new Set();
  state.confidence = new Float32Array(state.splat.count);
  state.locked = new Uint8Array(state.splat.count);
  state.provisional.clear();
  state.forcedProvisional.clear();
  state.recentlyAdded.clear();
  state.activeDockSegmentId = null;
  state.highlight?.clearGhost();
  dismissActiveSelection();
  renderSelectionState();
  setWork({
    key: `selection-docked-${segment.id}`,
    state: 'ready',
    title: `${segment.name} extracted to dock`,
    detail: `${count.toLocaleString()} splats were removed from the source scene and stored as a live miniature.`,
  });
}

function renderEditableProjection() {
  const active = state.active;
  if (!active?.currentMask) return;
  ui.projectionEditorOpen.hidden = state.projectionEditorOpen;
  ui.projectionEditorBack.hidden = !state.projectionEditorOpen;
  renderProjectionPreview({
    mask: active.currentMask,
    maskW: active.maskW,
    maskH: active.maskH,
    points: active.sources.has('auto') ? active.prompts : null,
    point: active.point,
    proj: active.liftCache?.proj,
    seeds: active.liftCache?.seeds,
    label: `${active.maskW} × ${active.maskH} · editing 2D mask`,
  });
}

function cancelPolygonEdit() {
  state.polygonPoints = [];
  if (finishPolygonButton) finishPolygonButton.disabled = true;
  if (cancelPolygonButton) cancelPolygonButton.disabled = true;
}

function finishPolygonEdit() {
  const active = state.active;
  if (!active?.currentMask || state.polygonPoints.length < 3
    || !state.editMode.startsWith('polygon')) return;
  stopMultiviewForSeedEdit();
  beginControlDiff('polygon');
  active.strokeUndo = active.manualEdits.slice();

  const polygonCanvas = document.createElement('canvas');
  polygonCanvas.width = active.maskW;
  polygonCanvas.height = active.maskH;
  const context = polygonCanvas.getContext('2d', { willReadFrequently: true });
  context.beginPath();
  context.moveTo(state.polygonPoints[0].x, state.polygonPoints[0].y);
  for (let index = 1; index < state.polygonPoints.length; index++) {
    context.lineTo(state.polygonPoints[index].x, state.polygonPoints[index].y);
  }
  context.closePath();
  context.fillStyle = '#fff';
  context.fill();
  const pixels = context.getImageData(0, 0, active.maskW, active.maskH).data;
  const value = state.editMode === 'polygon-remove' ? -1 : 1;
  for (let index = 0; index < active.manualEdits.length; index++) {
    if (pixels[index * 4 + 3]) active.manualEdits[index] = value;
  }
  cancelPolygonEdit();
  active.requestToken++;
  scheduleActiveSelection(0);
  releaseControlDiff('polygon');
}

finishPolygonButton.addEventListener('click', finishPolygonEdit);
cancelPolygonButton.addEventListener('click', () => {
  cancelPolygonEdit();
  renderEditableProjection();
});

function undoSelectionPreview() {
  stopMultiviewForSeedEdit();
  const snapshot = state.selectionActionHistory.pop();
  if (!snapshot) return;
  restoreSparseSelectionState(snapshot);
  state.recentlyAdded.clear();
  state.gaussianCleanupUndo = null;
  state.editMode = 'off';
  state.projectionEditorOpen = false;
  ui.projectionPip.dataset.editorOpen = 'false';
  ui.projectionCanvas.dataset.editing = 'false';
  ui.projectionEditorBack.hidden = true;
  clearSelectionOutline();
  renderSelectionState();
  if (state.active?.currentMask) {
    setMethodUI(state.active.sources);
    setFusionUI(state.active.fusion);
    setExtentUI(state.active.extent);
    ui.selectionProps.hidden = false;
    document.body.dataset.inspector = 'true';
    ui.projectionMaskTools.hidden = false;
    ui.projectionEditorOpen.hidden = false;
    renderEditableProjection();
  } else {
    ui.projectionMaskTools.hidden = true;
    ui.projectionEditorOpen.hidden = true;
    ui.selectionProps.hidden = true;
    document.body.dataset.inspector = 'false';
    if (capture.width) {
      renderProjectionPreview({
        label: state.encoded ? `${capture.width} × ${capture.height}` : 'view changed · re-encoding',
        stale: !state.encoded,
      });
    }
  }
  setWork({
    key: `selection-undone-${performance.now()}`,
    state: 'ready',
    title: 'Selection undone',
    detail: state.selection.size
      ? `${state.selection.size.toLocaleString()} splats restored from the previous selection step.`
      : 'The selection was canceled.',
  });
}

document.getElementById('clear').addEventListener('click', () => {
  pushSelectionHistory('Clear selection');
  setGaussianCleanup(false);
  setNearbyContext(false);
  setOrbitSelected(false);
  state.selection.clear();
  state.confidence?.fill(0);
  state.locked?.fill(0);
  state.provisional.clear();
  state.forcedProvisional.clear();
  state.recentlyAdded.clear();
  dismissActiveSelection();
  renderSelectionState();
  setWork({
    key: 'selection-cleared',
    state: 'ready',
    title: 'Selection cleared',
    detail: state.encoded ? 'The current camera view remains cached and ready.' : 'Waiting for the camera view.',
  });
  if (capture.width) {
    renderProjectionPreview({
      label: state.encoded ? `${capture.width} × ${capture.height}` : 'view changed · re-encoding',
      stale: !state.encoded,
    });
  }
});

document.getElementById('export').addEventListener('click', () => {
  const ids = Int32Array.from(state.selection).sort();
  const blob = new Blob([ids.buffer], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'selection.i32';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

// Handy from the devtools console: __app.state.splat, __app.camera.position, …
window.__app = {
  state,
  scene,
  camera,
  renderer,
  controls,
  objectDetector,
  segmentDock,
  get objectSuggestions() { return objectSuggestions; },
};

// Native title text complements the styled keyboard/mouse tooltips and makes
// every explained control discoverable on browsers that suppress pseudo tips.
document.querySelectorAll('[data-tip]').forEach((element) => {
  element.title = element.dataset.tip;
});

// ------------------------------------------------------------ main loop ----

let lastFrameAt = performance.now();
let lastRenderedFrameAt = 0;
let lastCockpitRenderedAt = 0;
let controlsInteracting = false;

controls.addEventListener('start', () => {
  controlsInteracting = true;
});
controls.addEventListener('end', () => {
  controlsInteracting = false;
});

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);   // clamp after tab-out
  lastFrameAt = now;

  updateWorkElapsed(now);
  updateMovement(dt);
  const controlsChanged = controls.update();

  // The old loop repainted the full Gaussian scene at display refresh rate
  // even when neither camera nor scene changed. On hybrid laptops that can pin
  // the Intel display GPU at 100%. Keep navigation at display speed, animate
  // the hologram smoothly at 30 fps, and let a completely idle scene rest.
  const navigating = controlsInteracting
    || viewfinder.locked
    || controlsChanged
    || keys.size > 0;
  const frameInterval = document.hidden
    ? 250
    : navigating
      ? 1000 / 60
      : state.selection.size || state.busy || state.multiview.session
        ? 1000 / 30
        : 100;
  if (now - lastRenderedFrameAt < frameInterval) return;
  lastRenderedFrameAt = now;

  updateEncodingRipple(now);
  state.highlight?.animate(now);
  segmentDock.animate(now);

  // The hologram needs a smooth small overlay, but a static multi-million
  // Gaussian cockpit does not need to be updated and redrawn at 30 fps merely
  // because the backend is tracking. Render it on movement, on selection
  // changes, or at a low resting cadence; the cutout has an independent sorter.
  const cockpitInterval = document.hidden
    ? 500
    : navigating
      ? 1000 / 60
      : state.recentlyAdded.size
        ? 1000 / 30
        : state.multiview.session
          ? 100
          : state.selection.size
            ? 1000 / 15
            : 100;
  if (now - lastCockpitRenderedAt >= cockpitInterval) {
    lastCockpitRenderedAt = now;
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.getSize(rendererLogicalSize);
    renderer.setViewport(0, 0, rendererLogicalSize.x, rendererLogicalSize.y);
    // The source cloud is always the cockpit background. Docking/focus uses
    // the per-Gaussian hidden mask; no workflow may hide the whole renderer.
    if (state.splat) state.splat.object3D.visible = true;
    state.splat?.update(renderer, camera);
    renderer.render(scene, camera);
  }
  objectPreview.render(now);
  hudEffects.render(now);
});
