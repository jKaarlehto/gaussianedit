import assert from 'node:assert/strict';
import {
  BUFFER_PREVIEW_IDS,
  createBufferPreviewStore,
} from '../bufferPreviewStore.js';

const revision1 = Object.freeze({ tuple: Object.freeze([4, 7, 2, 1]), key: '4:7:2:1' });
const revision2 = Object.freeze({ tuple: Object.freeze([4, 7, 2, 2]), key: '4:7:2:2' });
const staleRevision = Object.freeze({ tuple: Object.freeze([4, 7, 1, 9]), key: '4:7:1:9' });
const payload = { width: 320, height: 180, close() {} };
const store = createBufferPreviewStore();

const activeObject = store.publish({
  bufferId: BUFFER_PREVIEW_IDS.OBJECT,
  revision: revision1,
  status: 'READY',
  counts: { selected: 120, total: 120, multiviewAdded: 0 },
  displayMode: 'main',
  render: {
    source: { kind: 'selected-gaussians', workspace: 'object' },
    payload,
  },
});
assert.ok(activeObject);
assert.equal(activeObject.counts.selected, 120);

// Activating Scene does not consume or reset the 3D preview; its postcard can
// read the exact current revision and non-empty count immediately.
const objectCardFromScene = store.read(BUFFER_PREVIEW_IDS.OBJECT);
assert.equal(objectCardFromScene, activeObject);
assert.equal(objectCardFromScene.revision.key, revision1.key);
assert.equal(objectCardFromScene.status, 'READY');
assert.equal(objectCardFromScene.counts.total, 120);
assert.equal(objectCardFromScene.render.payload, payload);

const afterTrayAddition = store.addCounts(
  BUFFER_PREVIEW_IDS.OBJECT,
  revision1,
  { multiviewAdded: 8, total: 8 },
  { displayMode: 'postcard' },
);
assert.equal(afterTrayAddition.counts.multiviewAdded, 8);
assert.equal(afterTrayAddition.counts.total, 128);
assert.equal(afterTrayAddition.counts.selected, 120);
assert.equal(afterTrayAddition.render.payload, payload);

// A later absolute update for the same revision cannot lower materialized
// counts while an all-sides tray is still adding evidence.
const nonRegressing = store.publish({
  bufferId: BUFFER_PREVIEW_IDS.OBJECT,
  revision: revision1,
  status: 'LIVE',
  counts: { total: 124, multiviewAdded: 4 },
  displayMode: 'postcard',
});
assert.equal(nonRegressing.counts.total, 128);
assert.equal(nonRegressing.counts.multiviewAdded, 8);

const nextRevisionAddition = store.addCounts(
  BUFFER_PREVIEW_IDS.OBJECT,
  revision2,
  { multiviewAdded: 2, total: 2 },
);
assert.equal(nextRevisionAddition.revision.key, revision2.key);
assert.equal(nextRevisionAddition.counts.total, 130);
assert.equal(nextRevisionAddition.counts.multiviewAdded, 10);

const staleOverwrite = store.publish({
  bufferId: BUFFER_PREVIEW_IDS.OBJECT,
  revision: staleRevision,
  status: 'EMPTY',
  counts: {},
  displayMode: 'postcard',
});
assert.equal(staleOverwrite, null);
assert.equal(store.read(BUFFER_PREVIEW_IDS.OBJECT), nextRevisionAddition);
assert.equal(store.read(BUFFER_PREVIEW_IDS.OBJECT).counts.total, 130);

const selectedCannotBeEmpty = store.publish({
  bufferId: BUFFER_PREVIEW_IDS.MASK,
  revision: revision1,
  status: 'EMPTY',
  counts: { selected: 1 },
  displayMode: 'mask',
});
assert.equal(selectedCannotBeEmpty.status, 'READY');

assert.equal(Object.isFrozen(selectedCannotBeEmpty), true);
assert.equal(Object.isFrozen(selectedCannotBeEmpty.revision), true);
assert.equal(Object.isFrozen(selectedCannotBeEmpty.revision.tuple), true);
assert.equal(Object.isFrozen(selectedCannotBeEmpty.counts), true);
assert.throws(() => {
  selectedCannotBeEmpty.counts.selected = 0;
}, TypeError);

let closed = 0;
const disposable = { byteLength: 16, close() { closed++; } };
store.publish({
  bufferId: BUFFER_PREVIEW_IDS.SCENE,
  revision: revision1,
  status: 'READY',
  counts: { frames: 1 },
  render: { source: 'capture', payload: disposable },
});
store.publish({
  bufferId: BUFFER_PREVIEW_IDS.SCENE,
  revision: revision2,
  status: 'READY',
  counts: { frames: 1 },
  render: { source: 'capture', payload: { byteLength: 16, close() {} } },
});
assert.equal(closed, 1);

let rejectedClosed = 0;
const boundedStore = createBufferPreviewStore({ maxPayloadBytes: 8 });
assert.equal(boundedStore.publish({
  bufferId: BUFFER_PREVIEW_IDS.SCENE,
  revision: revision1,
  status: 'READY',
  counts: { frames: 1 },
  render: {
    source: 'oversized',
    payload: { byteLength: 9, close() { rejectedClosed++; } },
  },
}), null);
assert.equal(rejectedClosed, 1);
assert.equal(boundedStore.read(BUFFER_PREVIEW_IDS.SCENE), null);

boundedStore.dispose();
store.dispose();

console.log('bounded immutable workspace buffer previews: ok');
