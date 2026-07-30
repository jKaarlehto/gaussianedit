import assert from 'node:assert/strict';

import {
  assertSelectionFrame,
  capturePointToCrop,
  capturePointToMask,
  clientPointToCapture,
  createSelectionFrame,
  cropPointToCapture,
  framebufferPointToCapture,
  selectionFrameMatches,
  selectionAlignmentStatus,
  selectionReturnPreflight,
  viewMatricesMatch,
} from '../selectionFrame.js';

const identity = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

const frame = createSelectionFrame({
  viewRevision: 7,
  sceneRevision: 3,
  viewMatrix: identity,
  projectionMatrix: identity,
  viewProjectionMatrix: identity,
  framebuffer: { width: 1600, height: 900 },
  capture: { width: 1024, height: 576 },
  cssViewport: { left: 50, top: 20, width: 800, height: 450 },
  crop: { x: 112, y: 38, width: 800, height: 500 },
  colorTransform: {
    outputColorSpace: 'srgb',
    toneMapping: 'aces',
    toneMappingExposure: 1.2,
  },
});

assert(Object.isFrozen(frame));
assert(Object.isFrozen(frame.camera.viewMatrix));
assert.equal(frame.cssToCapture.x, 1.28);
assert.equal(frame.framebufferToCapture.y, 0.64);
assert.deepEqual(
  clientPointToCapture(frame, 450, 245),
  { x: 512, y: 288 },
);
assert.deepEqual(
  clientPointToCapture(frame, 550, 345, {
    left: 150,
    top: 120,
    width: 800,
    height: 450,
  }),
  { x: 512, y: 288 },
);
assert.equal(clientPointToCapture(frame, 450, 245, {
  left: 50,
  top: 20,
  width: 801,
  height: 450,
}), null);
assert.deepEqual(capturePointToCrop(frame, 512, 288), {
  x: 0.5,
  y: 0.5,
});
assert.deepEqual(cropPointToCapture(frame, 0.5, 0.5), {
  x: 512,
  y: 288,
});
assert.deepEqual(capturePointToMask(frame, 512, 288, 256, 144), {
  x: 128,
  y: 72,
});
assert.deepEqual(framebufferPointToCapture(frame, 800, 450), {
  x: 512,
  y: 288,
});
assert.equal(viewMatricesMatch(identity, identity.slice()), true);
const movedView = identity.slice();
movedView[12] = 0.02;
assert.equal(viewMatricesMatch(identity, movedView), false);
assert(selectionFrameMatches(frame, {
  viewRevision: 7,
  sceneRevision: 3,
  framebufferWidth: 1600,
  framebufferHeight: 900,
}));
assert.throws(
  () => assertSelectionFrame(frame, { viewRevision: 8, sceneRevision: 3 }),
  (error) => error.name === 'AbortError',
);

const aligned = {
  frame,
  viewRevision: 7,
  sceneRevision: 3,
  framebuffer: { width: 1600, height: 900 },
  viewport: { left: 50, top: 20, width: 800, height: 450 },
  viewMatrix: identity,
  projectionMatrix: identity,
  crop: { x: 112, y: 38, w: 800, h: 500 },
  mask: { width: 1024, height: 576 },
  overlay: {
    width: 1024,
    height: 576,
    clientRect: { left: 50, top: 20, width: 800, height: 450 },
  },
};
assert.deepEqual(selectionAlignmentStatus(aligned), { ok: true, reason: null });
assert.equal(selectionAlignmentStatus({
  ...aligned,
  viewport: { left: 50, top: 20, width: 801, height: 450 },
}).reason, 'css-viewport');
assert.equal(selectionAlignmentStatus({
  ...aligned,
  overlay: {
    ...aligned.overlay,
    clientRect: { left: 0, top: 0, width: 800, height: 450 },
  },
}).reason, 'overlay-css-transform');
assert.equal(selectionAlignmentStatus({
  ...aligned,
  mask: { width: 2048, height: 1152 },
  overlay: { ...aligned.overlay, width: 2048, height: 1152 },
}).reason, 'mask-capture-size');
const movedAlignmentView = [...identity];
movedAlignmentView[12] = 0.02;
assert.equal(selectionAlignmentStatus({
  ...aligned,
  viewMatrix: movedAlignmentView,
}).reason, 'camera-matrix');

const cameraState = {
  position: [4, 5, 6],
  projection: [...identity],
  controlsTarget: [1, 2, 3],
};
const beforeRejectedReturn = structuredClone(cameraState);
const viewportMismatch = selectionReturnPreflight({
  ...aligned,
  viewport: { left: 50, top: 20, width: 801, height: 450 },
});
if (viewportMismatch.ok) {
  cameraState.position[0] = 99;
  cameraState.projection[0] = 99;
  cameraState.controlsTarget[0] = 99;
}
assert.equal(viewportMismatch.reason, 'css-viewport');
assert.deepEqual(
  cameraState,
  beforeRejectedReturn,
  'viewport mismatch must cause zero camera, projection, or controls mutation',
);

console.log('immutable selection frame coordinate contract: ok');
