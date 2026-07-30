import assert from 'node:assert/strict';

import {
  createProjectionIndexSpace,
  liftProjectedMask,
  projectSplatsAsync,
  projectionSlot,
} from '../lift.js';
import {
  addViewEvidence,
  createViewEvidence,
  fuseViewEvidence,
} from '../multiviewRefinement.js';

const count = 5;
const centers = new Float32Array([
  -0.9, 0, 0,
  -0.4, 0, 0,
  0, 0, 0,
  0.4, 0, 0,
  0.8, 0, 0,
]);
const indices = new Uint32Array([1, 4]);
const indexSpace = createProjectionIndexSpace(count, indices);
const projection = await projectSplatsAsync({
  centers,
  count,
  viewProj: new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]),
  viewW: 64,
  viewH: 64,
  opacity: new Uint8Array(count).fill(255),
  indices,
  indexSpace,
});

assert.equal(projection.sx.length, indices.length);
assert.equal(projection.sy.length, indices.length);
assert.equal(projection.sd.length, indices.length);
assert.equal(projection.sr.length, indices.length);
assert.equal(projectionSlot(projection, 1), 0);
assert.equal(projectionSlot(projection, 4), 1);
assert.equal(projectionSlot(projection, 3), -1);
assert.deepEqual(
  new Set([...projection.nearestIndex].filter((index) => index >= 0)),
  new Set([1, 4]),
);

const mask = new Uint8Array(64 * 64).fill(1);
const lifted = liftProjectedMask({
  projection,
  mask,
  maskW: 64,
  maskH: 64,
  absSlack: 0,
});
assert.deepEqual(new Set(lifted.seeds), new Set([1, 4]));

const evidence = createViewEvidence(count, indices, indexSpace.indexLookup);
addViewEvidence(evidence, {
  selected: new Set([4]),
  visible: new Set([1, 4]),
  score: 0.9,
  viewGroup: 0,
});
const confidence = new Float32Array(count);
const fused = fuseViewEvidence(evidence, {
  baseSelection: new Set([1]),
  baseConfidence: confidence,
  confidenceBuffer: confidence,
  minimumViews: 1,
  provisionalThreshold: 0.1,
});
assert.deepEqual(fused.selection, new Set([1, 4]));
assert.ok(confidence[4] > 0);
assert.equal(confidence[0], 0);

console.log('compact ROI projection and evidence: ok');
