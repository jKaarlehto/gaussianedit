import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';

import {
  analyzeRgbaFrame,
  assertOverlayAfterCockpit,
  beginVisibleFrameTransaction,
  inspectCaptureDimensions,
  markCockpitRendered,
} from '../renderContracts.js';
import {
  deriveSyntheticClipPlanes,
  generateSyntheticOrbitViews,
  inspectSyntheticClipPlanes,
} from '../syntheticViews.js';

const transaction = beginVisibleFrameTransaction(1);
assert.throws(
  () => assertOverlayAfterCockpit(transaction, 'hologram'),
  /cannot draw before the cockpit framebuffer/,
);
markCockpitRendered(transaction);
assert.doesNotThrow(() => assertOverlayAfterCockpit(transaction, 'hologram'));

const [mainSource, splatSource, htmlSource] = await Promise.all([
  readFile(new URL('../main.js', import.meta.url), 'utf8'),
  readFile(new URL('../splatSource.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);
const animationLoop = mainSource.slice(mainSource.lastIndexOf('renderer.setAnimationLoop'));
const cockpitRenderAt = animationLoop.indexOf('renderer.render(scene, camera)');
const cockpitMarkedAt = animationLoop.indexOf('markCockpitRendered(visibleFrame)');
const previewAt = animationLoop.indexOf("renderGuardedOverlay('object-preview'");
const hudAt = animationLoop.indexOf("renderGuardedOverlay('hud-effects'");
assert.ok(cockpitRenderAt >= 0);
assert.ok(cockpitRenderAt < cockpitMarkedAt);
assert.ok(cockpitMarkedAt < hudAt);
assert.ok(hudAt < previewAt, 'bounded 3D preview must occlude the full-canvas Scene HUD');
assert.match(
  mainSource,
  /workspaceController\.active === 'object'[\s\S]{0,180}!state\.objectSuggestionsEnabled/,
  '3D Object workspace must reject targeting hit-tests',
);
assert.match(
  mainSource,
  /const suppressed = workspaceController\.active === 'object'[\s\S]{0,100}workspaceController\.active === 'mask'[\s\S]{0,100}Boolean\(pendingTargetReplacement\)/,
  'persistent YOLO HUD must be hidden from isolated 3D surfaces',
);
assert.doesNotMatch(
  mainSource,
  /const suppressed = workspaceController\.active === 'object' \|\| Boolean\(state\.active\)/,
  'a frozen Scene target retains its current-frame scanner',
);
const suggestionHoverStart = mainSource.indexOf('function updateObjectSuggestionHover');
const suggestionHoverEnd = mainSource.indexOf(
  "\nrenderer.domElement.addEventListener('pointermove'",
  suggestionHoverStart,
);
const suggestionHoverBody = mainSource.slice(suggestionHoverStart, suggestionHoverEnd);
assert.match(
  suggestionHoverBody,
  /const lockedTarget = Boolean\(state\.active\?\.currentMask\)[\s\S]*return \(!lockedTarget \|\| isYoloSuggestion\(suggestion\)\)/,
  'locked Scene targets retain interactive current-frame YOLO hints',
);
assert.match(
  mainSource,
  /const showTargetingOverlays = workspaceController\.active !== 'mask'/,
  'the 2D mask editor suppresses targeting overlays',
);
assert.match(
  htmlSource,
  /body\[data-workspace="object"\] #objectHintHud,[\s\S]*?#selectionOutline \{[\s\S]*?display:\s*none !important/,
);
assert.match(mainSource, /captureRenderer = new THREE\.WebGLRenderer/);
assert.match(mainSource, /captureFailureProbe = diagnosticProbe/);
assert.doesNotMatch(
  mainSource,
  /session\.useFallbackCapture/,
  'diagnostic Points must never become scan evidence',
);
assert.match(splatSource, /ignoreDevicePixelRatio: true/);

assert.equal(inspectCaptureDimensions({
  logicalWidth: 832,
  logicalHeight: 468,
  drawingBufferWidth: 832,
  drawingBufferHeight: 468,
  targetWidth: 832,
  targetHeight: 468,
}).exact, true);
assert.equal(inspectCaptureDimensions({
  logicalWidth: 1280,
  logicalHeight: 720,
  drawingBufferWidth: 1920,
  drawingBufferHeight: 1080,
  targetWidth: 832,
  targetHeight: 468,
}).exact, false);

const sparseFrame = new Uint8Array(64 * 64 * 4);
for (let pixel = 0; pixel < 64 * 64; pixel++) sparseFrame[pixel * 4 + 3] = 255;
const isolatedPixel = (17 * 64 + 23) * 4;
sparseFrame[isolatedPixel] = 19;
sparseFrame[isolatedPixel + 1] = 31;
sparseFrame[isolatedPixel + 2] = 47;
const sparseAnalysis = analyzeRgbaFrame(sparseFrame, 64, 64);
assert.equal(sparseAnalysis.black, false);
assert.equal(sparseAnalysis.nonzeroRgbPixels, 1);
assert.deepEqual(sparseAnalysis.contentBounds, {
  x: 23,
  y: 17,
  width: 1,
  height: 1,
});

const blackFrame = new Uint8Array(8 * 8 * 4);
for (let pixel = 0; pixel < 8 * 8; pixel++) blackFrame[pixel * 4 + 3] = 255;
assert.equal(analyzeRgbaFrame(blackFrame, 8, 8).black, true);

for (const radius of [1e-5, 0.01, 1, 100]) {
  const distance = radius * 2.05;
  const clip = deriveSyntheticClipPlanes({
    cameraDistance: distance,
    objectRadius: radius,
    contextRadius: radius * 4,
  });
  const inspection = inspectSyntheticClipPlanes({
    cameraDistance: distance,
    objectRadius: radius,
    near: clip.near,
    far: clip.far,
  });
  assert.equal(inspection.valid, true, `clip planes should contain radius ${radius}`);
  assert.ok(clip.near < distance - radius);
  assert.ok(clip.far > distance + radius);
}

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 500);
camera.position.set(0, 0, 0.015);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);
const analysis = {
  centre: new THREE.Vector3(),
  radius: 0.01,
  robustMin: new THREE.Vector3(-0.01, -0.01, -0.01),
  robustMax: new THREE.Vector3(0.01, 0.01, 0.01),
  viewDirection: new THREE.Vector3(0, 0, 1),
  worldUp: new THREE.Vector3(0, 1, 0),
};
const views = generateSyntheticOrbitViews({
  analysis,
  camera,
  count: 4,
  width: 832,
  height: 468,
});
for (const view of views.trackingViews) {
  const position = new THREE.Vector3().setFromMatrixPosition(
    new THREE.Matrix4().fromArray(view.transform),
  );
  const inspection = inspectSyntheticClipPlanes({
    cameraDistance: position.distanceTo(analysis.centre),
    objectRadius: view.objectRadius,
    near: view.near,
    far: view.far,
  });
  assert.equal(inspection.valid, true, `${view.id} should contain the selected object`);
}

console.log('render contracts: ok');
