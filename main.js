import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { SplatSource } from './splatSource.js';
import {
  createSegmentationModel,
  listSegmentationModels,
} from './segmentationModels.js';
import {
  getSelectionSource,
  listSelectionSources,
} from './selectionSources.js';
import { projectSplatsAsync, liftProjectedMask } from './lift.js';
import { buildGridAsync, growAsync } from './grow.js';
import { Highlight } from './highlight.js';
import { combineMasks, paintMask } from './maskTools.js';

const SAM_INPUT_MAX = 1024; // longest side handed to the encoder
const VIEW_SETTLE_MS = 280;

// ---------------------------------------------------------------- scene ----

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.id = 'viewport';
renderer.domElement.dataset.selectionState = 'idle';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 500);
camera.position.set(0, 0, 4);

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
  count: document.getElementById('count'),
  total: document.getElementById('total'),
  drop: document.getElementById('drop'),
  bar: document.getElementById('bar'),
  workPanel: document.getElementById('workPanel'),
  workTitle: document.getElementById('workTitle'),
  workDetail: document.getElementById('workDetail'),
  workElapsed: document.getElementById('workElapsed'),
  workSteps: document.getElementById('workSteps'),
  projectionPip: document.getElementById('projectionPip'),
  projectionCanvas: document.getElementById('projectionCanvas'),
  projectionStatus: document.getElementById('projectionStatus'),
  projectionEmpty: document.getElementById('projectionEmpty'),
  selectionOutline: document.getElementById('selectionOutline'),
  brushCursor: document.getElementById('brushCursor'),
  encodingCue: document.getElementById('encodingCue'),
  encodingCueTitle: document.getElementById('encodingCueTitle'),
  encodingCueDetail: document.getElementById('encodingCueDetail'),
  encodingCursor: document.getElementById('encodingCursor'),
  encodingCursorLabel: document.getElementById('encodingCursorLabel'),
  selectionProps: document.getElementById('selectionProps'),
  selectionResult: document.getElementById('selectionResult'),
  selectionMeta: document.getElementById('selectionMeta'),
  autoProps: document.getElementById('autoProps'),
  fillProps: document.getElementById('fillProps'),
  radiusProps: document.getElementById('radiusProps'),
  fusionProps: document.getElementById('fusionProps'),
};

const state = {
  splat: null,
  grid: null,
  highlight: null,
  selection: new Set(),
  active: null,      // latest editable selection operation
  extent: 'suggested',
  fillThreshold: 18,
  screenRadius: 5,
  modelQuality: 'fast',
  fusion: 'smart',
  editMode: 'off',
  edgeBrush: 2,
  frozen: null,      // camera snapshot taken at encode time
  encoded: false,
  busy: false,
  busyReason: '',
  pendingSelection: null,
  slack: 0.006,      // fraction of scene diagonal
  radius: 0.008,
  steps: 24,
};
let activeSelectionTimer = 0;
let encodingCursorInside = false;
let encodingRippleStartedAt = 0;
let encodingRippleFrame = { strength: 0, phase: 0, width: 0 };
let workKey = 'idle';
let workStartedAt = 0;
let workLastPaintAt = 0;

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

function setProgress(f) {
  ui.bar.hidden = f == null;
  if (f != null) ui.bar.firstElementChild.style.width = `${Math.min(1, Math.max(0, f)) * 100}%`;
}

function setWork({
  key,
  state: workState = 'busy',
  title,
  detail = '',
  steps = [],
  active = -1,
}) {
  const changed = key !== workKey;
  if (changed) {
    workKey = key;
    workStartedAt = performance.now();
  }
  ui.workPanel.dataset.state = workState;
  ui.workTitle.textContent = title;
  ui.workDetail.textContent = detail;
  if (changed || (workState !== 'busy' && workState !== 'queued')) {
    ui.workElapsed.textContent = workState === 'busy' || workState === 'queued'
      ? '0.0 s'
      : '';
  }

  ui.workSteps.replaceChildren(...steps.map((label, index) => {
    const step = document.createElement('span');
    step.textContent = label;
    step.dataset.state = index < active ? 'done' : index === active ? 'active' : 'pending';
    return step;
  }));
  ui.workSteps.hidden = steps.length === 0;
}

function updateWorkElapsed(now) {
  const workState = ui.workPanel.dataset.state;
  if ((workState !== 'busy' && workState !== 'queued') || now - workLastPaintAt < 150) return;
  workLastPaintAt = now;
  ui.workElapsed.textContent = `${((now - workStartedAt) / 1000).toFixed(1)} s`;
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
  const unavailable = mode === 'encoding' || mode === 'error';
  ui.encodingCue.hidden = !unavailable;
  ui.encodingCue.dataset.state = mode;
  ui.encodingCueTitle.textContent = mode === 'error'
    ? 'Selection view unavailable'
    : 'Encoding selection view';
  ui.encodingCueDetail.textContent = detail || (mode === 'error'
    ? 'Move the camera to retry.'
    : 'Selection will be ready when this view is frozen.');
  if (mode === 'encoding' && previousMode !== 'encoding') {
    encodingRippleStartedAt = performance.now();
  }
  if (mode !== 'encoding') {
    encodingRippleFrame = { strength: 0, phase: 0, width: 0 };
    state.splat?.setEncodingRipple(0);
  }
  if (!state.pendingSelection) ui.encodingCursorLabel.textContent = 'encoding';
  if (!unavailable || !encodingCursorInside) ui.encodingCursor.style.display = 'none';
}

renderer.domElement.addEventListener('pointerenter', (event) => {
  encodingCursorInside = true;
  updateEncodingCursor(event);
});
renderer.domElement.addEventListener('pointermove', updateEncodingCursor);
renderer.domElement.addEventListener('pointerleave', () => {
  encodingCursorInside = false;
  ui.encodingCursor.style.display = 'none';
});

function updateEncodingCursor(event) {
  if (renderer.domElement.dataset.selectionState !== 'encoding') return;
  ui.encodingCursor.style.left = `${event.clientX}px`;
  ui.encodingCursor.style.top = `${event.clientY}px`;
  ui.encodingCursor.style.display = 'block';
}

function updateEncodingRipple(now) {
  const splat = state.splat;
  if (!splat || renderer.domElement.dataset.selectionState !== 'encoding') return;

  // A quick 900 ms ripple followed by 2.1 seconds of rest is noticeable
  // without making a long encode look perpetually unstable.
  const cycleMs = (now - encodingRippleStartedAt) % 3000;
  if (cycleMs >= 900) {
    encodingRippleFrame = { strength: 0, phase: 0, width: 0 };
    splat.setEncodingRipple(0);
    return;
  }

  const progress = cycleMs / 900;
  const ease = Math.sin(progress * Math.PI);
  const width = splat.scale * 0.10;
  encodingRippleFrame = {
    strength: splat.scale * 0.006 * ease,
    phase: splat.scale * 0.62 * progress,
    width,
  };
  splat.setEncodingRipple(
    encodingRippleFrame.strength,
    encodingRippleFrame.phase,
    encodingRippleFrame.width,
  );
}

// ------------------------------------------------------------------ SAM ----

const sam = createSegmentationModel('fast');
const segmentationModels = new Map([['fast', sam]]);

function currentSam() {
  return segmentationModels.get(state.modelQuality) ?? sam;
}

setWork({
  key: 'startup-model',
  state: 'busy',
  title: 'Preparing automatic selection',
  detail: 'Checking the browser cache for SlimSAM.',
  steps: ['model', 'scene', 'view'],
  active: 0,
});
sam.load((p) => {
  if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
    setStatus(`model ${Math.round(p.progress)}%`, 'busy');
    setWork({
      key: 'startup-model',
      state: 'busy',
      title: 'Preparing automatic selection',
      detail: `SlimSAM model · ${Math.round(p.progress)}%`,
      steps: ['model', 'scene', 'view'],
      active: 0,
    });
  }
}).then(() => {
  setStatus(`${sam.family} · ${sam.device}`, 'ready');
  // A scene dropped while the model was still downloading never got encoded —
  // runEncode bailed on !sam.ready and nothing rescheduled it.
  if (state.splat) invalidateEncoding('Model ready · encoding the current camera view.');
  else {
    setWork({
      key: 'waiting-scene',
      state: 'ready',
      title: 'Selection model cached',
      detail: 'Drop a splat file to begin.',
      steps: ['model', 'scene', 'view'],
      active: 1,
    });
  }
}).catch((e) => {
  console.error(e);
  setStatus('model failed', '');
  setWork({
    key: 'startup-model-error',
    state: 'error',
    title: 'Automatic model failed to load',
    detail: e.message,
  });
});

// --------------------------------------------------------- view capture ----

const capture = document.createElement('canvas');
const captureCtx = capture.getContext('2d', { willReadFrequently: true });
const projectionCtx = ui.projectionCanvas.getContext('2d');
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');

function setProjectionStatus(text, stale = false) {
  ui.projectionStatus.textContent = text;
  ui.projectionPip.dataset.stale = String(stale);
}

/**
 * Show the exact frozen image used by SAM. Optional overlays make the
 * 2D -> 3D lift visible: orange is the decoded mask, green dots are the
 * front-surface splat centres accepted as lift seeds.
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

  const out = ui.projectionCanvas;
  if (out.width !== capture.width || out.height !== capture.height) {
    out.width = capture.width;
    out.height = capture.height;
  }
  projectionCtx.clearRect(0, 0, out.width, out.height);
  projectionCtx.drawImage(capture, 0, 0);

  if (mask && maskW > 0 && maskH > 0) {
    if (maskCanvas.width !== maskW || maskCanvas.height !== maskH) {
      maskCanvas.width = maskW;
      maskCanvas.height = maskH;
    }
    const pixels = maskCtx.createImageData(maskW, maskH);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (!mask[i]) continue;
      pixels.data[p] = 255;
      pixels.data[p + 1] = 92;
      pixels.data[p + 2] = 43;
      pixels.data[p + 3] = 104;
    }
    maskCtx.putImageData(pixels, 0, 0);
    projectionCtx.drawImage(maskCanvas, 0, 0, out.width, out.height);
  }

  if (proj && seeds?.length && state.frozen) {
    const sx = out.width / state.frozen.viewW;
    const sy = out.height / state.frozen.viewH;
    // Dense scenes can produce tens of thousands of seeds. A representative
    // sample keeps this diagnostic overlay cheap and legible.
    const stride = Math.max(1, Math.ceil(seeds.length / 5000));
    projectionCtx.fillStyle = 'rgba(88, 214, 168, 0.9)';
    for (let n = 0; n < seeds.length; n += stride) {
      const i = seeds[n];
      projectionCtx.fillRect(proj.sx[i] * sx - 1, proj.sy[i] * sy - 1, 2, 2);
    }
  }

  const markers = points ?? (point ? [{ ...point, label: 1 }] : []);
  for (const marker of markers) {
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
  setProjectionStatus(label, stale);
}

function resetProjectionPreview(label = 'waiting for scene') {
  projectionCtx.clearRect(0, 0, ui.projectionCanvas.width, ui.projectionCanvas.height);
  ui.projectionEmpty.hidden = false;
  setProjectionStatus(label, true);
}

function renderSelectionOutline(mask, w, h) {
  const canvas = ui.selectionOutline;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1
      || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w];
    const p = i * 4;
    image.data[p] = 255;
    image.data[p + 1] = 92;
    image.data[p + 2] = 43;
    image.data[p + 3] = edge ? 255 : 22;
  }

  ctx.putImageData(image, 0, 0);
  canvas.hidden = false;
}

function clearSelectionOutline() {
  ui.selectionOutline.hidden = true;
  const ctx = ui.selectionOutline.getContext('2d');
  ctx.clearRect(0, 0, ui.selectionOutline.width, ui.selectionOutline.height);
}

function dismissActiveSelection({ hideInspector = true } = {}) {
  clearTimeout(activeSelectionTimer);
  state.active = null;
  state.editMode = 'off';
  ui.selectionOutline.dataset.editing = 'false';
  ui.brushCursor.style.display = 'none';
  clearSelectionOutline();
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
function doCapture() {
  const src = renderer.domElement;
  if (!src.width || !src.height) throw new Error('render target has no size');

  // SAM must see the stable splats only — neither the orange overlay nor the
  // readiness ripple should become part of the model input.
  const hl = state.highlight?.points;
  const wasVisible = hl?.visible;
  if (hl) hl.visible = false;
  state.splat?.setEncodingRipple(0);
  try {
    state.splat?.update(renderer, camera);
    renderer.render(scene, camera);

    const s = Math.min(1, SAM_INPUT_MAX / Math.max(src.width, src.height));
    const w = Math.round(src.width * s);
    const h = Math.round(src.height * s);
    if (capture.width !== w || capture.height !== h) {
      capture.width = w;
      capture.height = h;
    }
    captureCtx.drawImage(src, 0, 0, w, h);
  } finally {
    if (hl) hl.visible = wasVisible;
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
  if (!force && !cameraPoseChangedMeaningfully()) return;
  if (force) {
    lastDirtyCameraPosition.copy(camera.position);
    lastDirtyCameraQuaternion.copy(camera.quaternion);
  }

  viewRevision++;
  lastViewChangeAt = performance.now();
  state.encoded = false;
  if (encodeRunning) encodeQueued = true;

  const keptPreview = Boolean(state.active);
  dismissActiveSelection();
  if (state.pendingSelection) {
    state.pendingSelection = null;
    detail = 'Camera moved · the queued click was canceled to avoid selecting the wrong pixels.';
  } else if (keptPreview) {
    detail = 'Selection kept in 3D · updating the 2D selection view for this camera.';
  }

  setSelectionReadiness('encoding', detail);
  setWork({
    key: `view-${viewRevision}`,
    state: encodeRunning ? 'queued' : 'busy',
    title: encodeRunning ? 'New camera view queued' : 'Waiting for camera to settle',
    detail: encodeRunning
      ? 'The current GPU pass will be discarded; only the newest view will be published.'
      : detail,
    steps: ['settle', 'capture', 'encode', 'map splats'],
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
  const remaining = Math.max(0, VIEW_SETTLE_MS - (performance.now() - lastViewChangeAt));
  encodeTimer = setTimeout(runEncode, delay ?? remaining);
}

async function runEncode() {
  const encoder = currentSam();
  if (!state.splat) return;
  if (!encoder.ready) {
    setSelectionReadiness('encoding', 'Waiting for the segmentation model.');
    setWork({
      key: 'waiting-model',
      state: 'busy',
      title: 'Waiting for segmentation model',
      detail: 'The scene is responsive; selection encoding starts when the model is cached.',
      steps: ['model', 'capture', 'encode', 'map splats'],
      active: 0,
    });
    return;
  }
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
      title: 'Latest camera view queued',
      detail: 'Finishing and discarding the older GPU pass first.',
      steps: ['settle', 'capture', 'encode', 'map splats'],
      active: 0,
    });
    return;
  }
  if (state.busy) {
    setWork({
      key: `view-${viewRevision}`,
      state: 'queued',
      title: 'Selection-view update queued',
      detail: `Waiting for ${state.busyReason || 'the current task'} to finish.`,
      steps: ['settle', 'capture', 'encode', 'map splats'],
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
      title: 'Capturing selection projection',
      detail: 'Rendering a clean frame without selection overlays.',
      steps: ['settle', 'capture', 'encode', 'map splats'],
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
      title: 'Encoding visual features',
      detail: 'The GPU pass is running. Camera movement will discard this result.',
      steps: ['settle', 'capture', 'encode', 'map splats'],
      active: 2,
    });
    await encoder.encode(capture);

    // Encoding is asynchronous. If the camera moved while SAM was working,
    // its embeddings and the current viewport no longer correspond. Keep
    // picking disabled and immediately queue the current view.
    if (revision !== viewRevision || splat !== state.splat) {
      throw new DOMException('Encode superseded', 'AbortError');
    }

    setWork({
      key: `encode-${revision}`,
      state: 'busy',
      title: 'Mapping splats to the frozen view',
      detail: 'This projection is cached and reused for every selection in this view.',
      steps: ['settle', 'capture', 'encode', 'map splats'],
      active: 3,
    });
    const projection = await projectSplatsAsync({
      centers: splat.centers,
      count: splat.count,
      viewProj: viewProj.elements,
      viewW: renderer.domElement.width,
      viewH: renderer.domElement.height,
    }, (progress) => {
      ui.workDetail.textContent = `Caching projected positions · ${Math.round(progress * 100)}%`;
    }, () => revision !== viewRevision || splat !== state.splat);

    state.frozen = {
      viewProj: viewProj.elements.slice(),
      viewW: renderer.domElement.width,
      viewH: renderer.domElement.height,
      projection,
      revision,
    };
    encoder.viewRevision = revision;
    state.encoded = true;
    setStatus('ready', 'ready');
    setSelectionReadiness('ready');
    setWork({
      key: `ready-${revision}`,
      state: 'ready',
      title: 'Selection ready',
      detail: state.selection.size
        ? `${state.selection.size.toLocaleString()} selected splats remain pinned in 3D.`
        : 'Click the scene to create a selection.',
      steps: ['settle', 'capture', 'encode', 'map splats'],
      active: 4,
    });
    renderProjectionPreview({ label: `${capture.width} × ${capture.height}`, stale: false });
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
    if (state.splat && !state.encoded && currentSam().ready
      && (encodeQueued || revision !== viewRevision)) {
      encodeQueued = false;
      scheduleEncode();
    }
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
  if (!state.encoded) scheduleEncode();
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

addEventListener('keydown', (e) => {
  if (e.metaKey || e.repeat) return;
  if (e.target?.closest?.('input, textarea, button')) return;
  if (!MOVE_CODES.has(e.code)) return;
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();   // don't scroll the page
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const moveStep = new THREE.Vector3();
const moveFwd = new THREE.Vector3();
const moveRight = new THREE.Vector3();
const headingOffset = new THREE.Vector3();
const headingRotation = new THREE.Quaternion();

function updateMovement(dt) {
  if (!keys.size || !state.splat) return;

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
    moveStep.normalize().multiplyScalar(state.splat.scale * 0.35 * sprint * dt);
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
  if (e.button !== 0) return;
  pointerDownAt = { x: e.clientX, y: e.clientY };
});

let pointerDownAt = null;

renderer.domElement.addEventListener('pointerup', async (e) => {
  if (e.button !== 0 || !pointerDownAt) return;
  const moved = Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y);
  pointerDownAt = null;
  if (moved > 4) return;              // that was an orbit, not a click
  if (!state.splat) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const intent = {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
    subtract: e.shiftKey,
    refineLabel: e.altKey ? 0 : (e.ctrlKey || e.metaKey ? 1 : null),
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

  // Alt-click is a negative SAM prompt for the current auto selection. A
  // normal unmodified click always starts a fresh automatic segmentation.
  const refineLabel = intent.refineLabel;
  if (refineLabel != null && state.active?.sources.has('auto')) {
    state.active.prompts.push({ x: px, y: py, label: refineLabel });
    state.active.requestToken++;
    await runActiveSelection();
    return;
  }

  await beginSelection(px, py, intent.subtract);
}

function flushPendingSelection() {
  const intent = state.pendingSelection;
  if (!intent || !state.encoded || state.busy) return;
  state.pendingSelection = null;
  ui.encodingCursorLabel.textContent = 'encoding';
  queueMicrotask(() => executeSelectionIntent(intent));
}

async function beginSelection(px, py, subtract) {
  state.active = {
    point: { x: px, y: py },
    prompts: [{ x: px, y: py, label: 1 }],
    baseSelection: new Set(state.selection),
    subtract,
    sources: new Set(['auto']),
    fusion: state.fusion,
    extent: state.extent,
    samResults: new Map(),
    manualEdits: null,
    currentMask: null,
    maskW: 0,
    maskH: 0,
    strokeUndo: null,
    requestToken: 1,
    liftCache: null,
  };
  setMethodUI(state.active.sources);
  setFusionUI(state.fusion);
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
  setStatus(usesModel ? 'segmenting…' : 'selecting…', 'busy');
  ui.selectionResult.textContent = 'working…';
  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: usesModel ? 'Generating object mask' : 'Building starting mask',
    detail: usesModel
      ? 'Using cached view features; only the prompt decoder is running.'
      : 'Running the selected deterministic mask tools.',
    steps: ['mask', 'combine', 'lift', 'grow'],
    active: 0,
  });
  renderProjectionPreview({
    points: usesModel ? active.prompts : null,
    point: active.point,
    label: usesModel ? 'segmenting…' : 'building mask…',
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
      title: 'Combining mask evidence',
      detail: `${resolved.length} source${resolved.length === 1 ? '' : 's'} · ${active.fusion}`,
      steps: ['mask', 'combine', 'lift', 'grow'],
      active: 1,
    });
    const maskW = capture.width;
    const maskH = capture.height;
    const mask = combineMasks(resolved, maskW, maskH, active.fusion);
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
    active.liftCache = null;
    setBorderEditMode(state.editMode);

    await applySelectionMask(active, mask, maskW, maskH, requestToken);
    if (state.active !== active || requestToken !== active.requestToken) return;
    const elapsed = Math.round(performance.now() - t0);
    setStatus(`${elapsed} ms`, 'ready');
    setWork({
      key: `selection-ready-${requestToken}`,
      state: 'ready',
      title: 'Selection preview ready',
      detail: `${ui.selectionResult.textContent} · cached projection reused`,
      steps: ['mask', 'combine', 'lift', 'grow'],
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
    }
  }
}

async function applySelectionMask(active, mask, maskW, maskH, requestToken = active.requestToken) {
  const { splat, frozen } = state;
  const scale = splat.scale;

  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: 'Lifting mask into visible splats',
    detail: 'Testing the mask against the cached camera projection and depth surface.',
    steps: ['mask', 'combine', 'lift', 'grow'],
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
    const result = liftProjectedMask({
      projection: frozen.projection,
      mask, maskW, maskH,
      absSlack: slack,
      relSlack: 0.01,
    });
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
    label: `${[...active.sources].map((id) => getSelectionSource(id).label).join(' + ')} · `
      + `${seeds.length.toLocaleString()} visible splats`,
  });
  renderSelectionOutline(mask, maskW, maskH);

  setWork({
    key: `selection-${requestToken}`,
    state: 'busy',
    title: 'Completing selection through 3D',
    detail: `${seeds.length.toLocaleString()} visible seeds · growing through connected splats`,
    steps: ['mask', 'combine', 'lift', 'grow'],
    active: 3,
  });
  await nextFrame();
  if (state.active !== active || requestToken !== active.requestToken) {
    throw new DOMException('Selection superseded', 'AbortError');
  }

  const region = await growAsync({
    grid: state.grid,
    centers: splat.centers,
    colors: splat.colors,
    seeds,
    proj,
    mask, maskW, maskH,
    viewW: frozen.viewW,
    viewH: frozen.viewH,
    radius: state.radius * scale,
    steps: state.steps,
    depthBand: state.slack * scale * 8,
  }, (progress, selectedCount) => {
    ui.workDetail.textContent =
      `${selectedCount.toLocaleString()} splats reached · ${Math.round(progress * 100)}%`;
  }, () => state.active !== active || requestToken !== active.requestToken);
  if (state.active !== active || requestToken !== active.requestToken) {
    throw new DOMException('Selection superseded', 'AbortError');
  }

  const nextSelection = new Set(active.baseSelection);
  if (active.subtract) for (const i of region) nextSelection.delete(i);
  else for (const i of region) nextSelection.add(i);
  state.selection = nextSelection;

  state.highlight.set(state.selection);
  ui.count.textContent = state.selection.size.toLocaleString();
  ui.selectionResult.textContent = `${region.size.toLocaleString()} splats`;
  let maskPixels = 0;
  for (const value of mask) maskPixels += value;
  const maskPercent = (maskPixels / mask.length) * 100;
  const sourceLabel = [...active.sources]
    .map((id) => getSelectionSource(id).label)
    .join(' + ');
  ui.selectionMeta.textContent =
    `${sourceLabel} · 2D mask ${maskPercent.toFixed(maskPercent < 1 ? 2 : 1)}% · `
    + `${seeds.length.toLocaleString()} visible seeds · `
    + `${region.size.toLocaleString()} after 3D completion`;
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
  setStatus('loading splats…', 'busy');
  setSelectionReadiness('idle');
  setProgress(0);
  ui.drop.style.display = 'none';
  setWork({
    key: `load-${loadId}`,
    state: 'busy',
    title: 'Loading splat scene',
    detail: filename,
    steps: ['read', 'build', 'index', 'encode'],
    active: 0,
  });

  // Invalidate any SAM encode still running for the previous scene. Merely
  // clearing state.encoded is insufficient: an in-flight encode could finish
  // later and publish the old camera snapshot as current.
  viewRevision++;
  clearTimeout(encodeTimer);

  // Tear the previous scene down completely. Leaving state.splat set would keep
  // the render loop driving a detached viewer, and the old highlight Points
  // would stay in the scene drawing markers at the previous scene's positions.
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
  state.grid = null;
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
    setProgress(f * 0.9);
    if (label) setStatus(label, 'busy');
    ui.workDetail.textContent = label ?? `Reading scene · ${Math.round(f * 100)}%`;
  });
  if (loadId !== sceneLoadRevision) {
    splat.dispose();
    throw new DOMException('Scene load superseded', 'AbortError');
  }
  scene.add(splat.object3D);

  const centre = splat.bounds.getCenter(new THREE.Vector3());
  controls.target.copy(centre);
  // 3DGS .ply scenes are authored Y-down, so three.js's default +Y up renders
  // them inverted. Flip if your data comes from a Y-up pipeline instead.
  camera.up.set(0, -1, 0);
  camera.position.copy(centre).add(new THREE.Vector3(0, 0, splat.scale * 0.7));
  camera.near = splat.scale / 1000;   // clip planes sized to the scene, not hardcoded
  camera.far = splat.scale * 20;
  camera.updateProjectionMatrix();
  controls.update();

  state.splat = splat;

  setStatus('indexing…', 'busy');
  setProgress(0.95);
  setWork({
    key: `load-${loadId}`,
    state: 'busy',
    title: 'Building responsive 3D index',
    detail: 'Indexing in chunks; navigation remains responsive.',
    steps: ['read', 'build', 'index', 'encode'],
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
      setProgress(0.9 + progress * 0.08);
      ui.workDetail.textContent = `${label} · ${Math.round(progress * 100)}%`;
    },
    () => loadId !== sceneLoadRevision,
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
  setSelectionReadiness('encoding', 'Scene loaded · preparing the first selectable projection.');
  setWork({
    key: `load-${loadId}`,
    state: 'busy',
    title: 'Preparing first selection view',
    detail: 'The scene is loaded; only the frozen selection projection remains.',
    steps: ['read', 'build', 'index', 'encode'],
    active: 3,
  });
  invalidateEncoding('Scene loaded · preparing the first selectable projection.');
}

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  loadSplat(url, f.name).finally(() => URL.revokeObjectURL(url));
});

// Drop a file in the browser, or point this at your own asset:
// loadSplat('/assets/scene.ksplat');

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
const borderModeButtons = [...document.querySelectorAll('#borderMode button')];
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

function setMethodUI(sources) {
  methodButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(sources.has(button.dataset.method)));
  });
  const panels = new Set([...sources].map((id) => getSelectionSource(id).panel));
  ui.autoProps.hidden = !panels.has('auto');
  ui.fillProps.hidden = !panels.has('fill');
  ui.radiusProps.hidden = !panels.has('radius');
  ui.fusionProps.hidden = sources.size < 2;
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
  ui.selectionOutline.dataset.editing = String(mode !== 'off' && Boolean(state.active?.currentMask));
  if (mode === 'off') ui.brushCursor.style.display = 'none';
}

function scheduleActiveSelection(delay = 80) {
  if (!state.active) return;
  state.active.requestToken++;
  clearTimeout(activeSelectionTimer);
  activeSelectionTimer = setTimeout(() => runActiveSelection(), delay);
}

function schedule3DCompletion(delay = 60, { relift = false } = {}) {
  const active = state.active;
  if (!active?.currentMask) return;
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

methodButtons.forEach((button) => button.addEventListener('click', () => {
  if (!state.active) return;
  const source = button.dataset.method;
  if (state.active.sources.has(source) && state.active.sources.size > 1) {
    state.active.sources.delete(source);
  } else {
    state.active.sources.add(source);
  }
  setMethodUI(state.active.sources);
  scheduleActiveSelection(0);
}));

fusionButtons.forEach((button) => button.addEventListener('click', () => {
  state.fusion = button.dataset.fusion;
  setFusionUI(state.fusion);
  if (!state.active) return;
  state.active.fusion = state.fusion;
  scheduleActiveSelection(0);
}));

borderModeButtons.forEach((button) => button.addEventListener('click', () => {
  if (!state.active?.currentMask) return;
  setBorderEditMode(button.dataset.edit);
}));

extentButtons.forEach((button) => button.addEventListener('click', () => {
  state.extent = button.dataset.extent;
  setExtentUI(state.extent);
  if (!state.active) return;
  state.active.extent = state.extent;
  scheduleActiveSelection(0);
}));

modelButtons.forEach((button) => button.addEventListener('click', () => {
  activateSegmentationModel(button.dataset.model);
}));

async function activateSegmentationModel(profile) {
  if (!state.active || profile === state.modelQuality) return;
  if (state.busy) {
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
  const provider = modelProviders.find((candidate) => candidate.id === profile);
  if (!provider) return;
  setBusy(`loading ${provider.label}`);
  setStatus(`loading ${provider.label}…`, 'busy');
  ui.selectionResult.textContent = 'loading model…';
  setWork({
    key: `model-${profile}`,
    state: 'busy',
    title: segmentationModels.has(profile) ? `Reusing cached ${provider.label}` : `Loading ${provider.label}`,
    detail: segmentationModels.has(profile)
      ? 'Model weights are already in memory.'
      : 'This happens once; the browser cache is reused on later sessions.',
    steps: ['load', 'encode view', 'decode mask'],
    active: 0,
  });

  try {
    if (!segmentationModels.has(profile)) {
      const model = createSegmentationModel(profile);
      segmentationModels.set(profile, model);
      await model.load((progress) => {
        if (progress.status === 'progress' && progress.file?.endsWith('.onnx')) {
          setStatus(`${provider.label} ${Math.round(progress.progress)}%`, 'busy');
          ui.workDetail.textContent = `Downloading model weights · ${Math.round(progress.progress)}%`;
        }
      });
    }

    if (revision !== viewRevision || !state.active) return;
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
      if (revision !== viewRevision || !state.active) return;
      nextSam.viewRevision = viewRevision;
    }

    state.modelQuality = profile;
    setModelUI(profile);
  } catch (error) {
    console.error(error);
    if (profile !== 'fast') segmentationModels.delete(profile);
    setStatus('model switch failed', '');
    ui.selectionResult.textContent = 'model unavailable';
    setWork({
      key: `model-error-${profile}`,
      state: 'error',
      title: 'Model unavailable',
      detail: error.message,
    });
    return;
  } finally {
    clearBusy(`loading ${provider.label}`);
    if (!state.encoded) scheduleEncode();
  }

  if (!state.active || revision !== viewRevision) return;
  state.active.requestToken++;
  await runActiveSelection();
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

function bindSlider(id, out, apply, updateMode = 'mask') {
  const el = document.getElementById(id);
  const label = document.getElementById(out);
  const update = (fromInput) => {
    label.textContent = apply(+el.value);
    if (!fromInput) return;
    if (updateMode === 'mask') scheduleActiveSelection();
    else if (updateMode === 'lift') schedule3DCompletion(60, { relift: true });
    else if (updateMode === '3d') schedule3DCompletion();
  };
  el.addEventListener('input', () => update(true));
  update(false);
}

let borderDrawing = false;
let lastBorderPoint = null;

ui.selectionOutline.addEventListener('pointerdown', (event) => {
  const active = state.active;
  if (event.button !== 0 || state.editMode === 'off' || !active?.currentMask) return;
  borderDrawing = true;
  lastBorderPoint = null;
  active.strokeUndo = active.manualEdits.slice();
  ui.selectionOutline.setPointerCapture(event.pointerId);
  paintBorderAt(event);
  event.preventDefault();
});

ui.selectionOutline.addEventListener('pointermove', (event) => {
  updateBrushCursor(event);
  if (!borderDrawing) return;
  paintBorderAt(event);
});
ui.selectionOutline.addEventListener('pointerenter', updateBrushCursor);
ui.selectionOutline.addEventListener('pointerleave', () => {
  if (!borderDrawing) ui.brushCursor.style.display = 'none';
});

ui.selectionOutline.addEventListener('pointerup', finishBorderStroke);
ui.selectionOutline.addEventListener('pointercancel', finishBorderStroke);

function paintBorderAt(event) {
  const active = state.active;
  if (!active?.currentMask) return;
  const rect = ui.selectionOutline.getBoundingClientRect();
  const point = {
    x: ((event.clientX - rect.left) / rect.width) * active.maskW,
    y: ((event.clientY - rect.top) / rect.height) * active.maskH,
  };
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
}

function updateBrushCursor(event) {
  if (state.editMode === 'off') return;
  const diameter = Math.min(innerWidth, innerHeight) * state.edgeBrush / 100;
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
  if (ui.selectionOutline.hasPointerCapture(event.pointerId)) {
    ui.selectionOutline.releasePointerCapture(event.pointerId);
  }
  const active = state.active;
  if (!active?.currentMask) return;
  const requestToken = ++active.requestToken;
  active.liftCache = null;
  setStatus('updating 3D…', 'busy');
  setBusy('border update');
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
    setBorderEditMode('off');
  } else if (event.code === 'Enter') {
    keepSelectionPreview();
  }
});

document.getElementById('closeProps').addEventListener('click', () => {
  keepSelectionPreview();
});

document.getElementById('keepPreview').addEventListener('click', keepSelectionPreview);
document.getElementById('undoPreview').addEventListener('click', undoSelectionPreview);

function keepSelectionPreview() {
  const count = state.selection.size;
  dismissActiveSelection();
  setWork({
    key: `selection-kept-${count}`,
    state: 'ready',
    title: 'Selection kept in 3D',
    detail: `${count.toLocaleString()} splats stay highlighted while you navigate and re-encode views.`,
  });
}

function undoSelectionPreview() {
  const active = state.active;
  if (!active) return;
  state.selection = new Set(active.baseSelection);
  state.highlight?.set(state.selection);
  ui.count.textContent = state.selection.size.toLocaleString();
  dismissActiveSelection();
  setWork({
    key: `selection-undone-${state.selection.size}`,
    state: 'ready',
    title: 'Selection preview undone',
    detail: `${state.selection.size.toLocaleString()} previously selected splats restored.`,
  });
  if (capture.width) {
    renderProjectionPreview({
      label: state.encoded ? `${capture.width} × ${capture.height}` : 'view changed · re-encoding',
      stale: !state.encoded,
    });
  }
}

document.getElementById('clear').addEventListener('click', () => {
  state.selection.clear();
  dismissActiveSelection();
  state.highlight?.set(state.selection);
  ui.count.textContent = '0';
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

document.getElementById('isolate').addEventListener('click', () => {
  if (!state.splat) return;
  state.splat.object3D.visible = !state.splat.object3D.visible;
  state.highlight.material.size = state.splat.object3D.visible ? 2.5 : 3.5;
  document.getElementById('isolate').setAttribute(
    'aria-pressed',
    String(!state.splat.object3D.visible),
  );
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
window.__app = { state, scene, camera, renderer, controls };

// Native title text complements the styled keyboard/mouse tooltips and makes
// every explained control discoverable on browsers that suppress pseudo tips.
document.querySelectorAll('[data-tip]').forEach((element) => {
  element.title = element.dataset.tip;
});

// ------------------------------------------------------------ main loop ----

let lastFrameAt = performance.now();

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);   // clamp after tab-out
  lastFrameAt = now;

  updateWorkElapsed(now);
  updateMovement(dt);
  controls.update();
  updateEncodingRipple(now);
  state.splat?.update(renderer, camera);

  renderer.render(scene, camera);
});
