import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  confirmVisibleObject,
  consumeVisibleObjectStart,
  createVisibleObjectGate,
  createVisibleObjectRevision,
  invalidateVisibleObjectGate,
  isVisibleObjectConfirmed,
  publishVisibleObjectCandidate,
  resetVisibleObjectStart,
} from '../visibleObjectGate.js';

function revision(overrides = {}) {
  return createVisibleObjectRevision({
    frameId: 'selection-frame:4:9',
    frameRevision: 9,
    sceneRevision: 4,
    maskRevision: 2,
    selectionRevision: 3,
    requestToken: 6,
    selectionCount: 25_266,
    ...overrides,
  });
}

const current = revision();
let gate = publishVisibleObjectCandidate(createVisibleObjectGate(), current);

// No automatic or manual tracking start is authorized before confirmation.
assert.equal(consumeVisibleObjectStart(gate, current).started, false);

assert.equal(isVisibleObjectConfirmed(gate, current), false);

// A confirmation for an older mask revision is rejected.
const stale = revision({ maskRevision: 1 });
assert.equal(confirmVisibleObject(gate, stale).accepted, false);
assert.equal(isVisibleObjectConfirmed(gate, current), false);

const confirmation = confirmVisibleObject(gate, current);
assert.equal(confirmation.accepted, true);
gate = confirmation.gate;
assert.equal(isVisibleObjectConfirmed(gate, current), true);

// The exact current revision starts once and only once.
const firstStart = consumeVisibleObjectStart(gate, current);
assert.equal(firstStart.started, true);
gate = firstStart.gate;
assert.equal(consumeVisibleObjectStart(gate, current).started, false);
gate = resetVisibleObjectStart(gate, current);
assert.equal(consumeVisibleObjectStart(gate, current).started, true);
gate = firstStart.gate;
assert.equal(resetVisibleObjectStart(gate, stale), gate);

// Any edit invalidation returns to the unconfirmed gate.
gate = invalidateVisibleObjectGate(gate);
assert.equal(isVisibleObjectConfirmed(gate, current), false);
assert.equal(consumeVisibleObjectStart(gate, current).started, false);

// Publishing a new edit revision still requires a fresh confirmation.
const edited = revision({
  maskRevision: 3,
  selectionRevision: 4,
  requestToken: 7,
  selectionCount: 25_411,
});
gate = publishVisibleObjectCandidate(gate, edited);
assert.equal(confirmVisibleObject(gate, current).accepted, false);
assert.equal(consumeVisibleObjectStart(gate, edited).started, false);

const root = new URL('../', import.meta.url);
const main = readFileSync(new URL('main.js', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');

assert.match(html, /id="visibleObjectGate"[^>]*role="group"/);
assert.match(html, /id="visibleObjectGateTitle"[^>]*>Target acquired</);
assert.match(html, /id="confirmVisibleObject"[^>]*>Use object</);
assert.match(html, /id="editVisibleObjectMask"[^>]*>Edit mask</);
assert.match(html, /id="selectionAlignmentGate"[^>]*role="alert"/);
assert.match(html, /Selection alignment changed<\/b> — return to its captured view/);
assert.match(html, /id="recaptureTarget"[^>]*>Return to captured view</);
assert.match(main, /active\.selectionRevision\+\+;\s*publishVisibleObjectConfirmation\(active\)/);
assert.match(main, /active\?\.confirmedScanRevisionKey === revision\?\.key/);
assert.match(
  main,
  /function acceptVisibleObjectConfirmation\(\) \{[\s\S]*?currentSelectionAlignment\(active\)[\s\S]*?if \(!alignment\.ok\)/,
);
assert.match(
  main,
  /async function startMultiviewRefinement\(\) \{[\s\S]*?currentSelectionAlignment\(active\)[\s\S]*?if \(!alignment\.ok\)/,
);
assert.match(main, /function enforceSelectionAlignmentContainment\(\)/);
assert.match(main, /function currentSelectionFrameParity\(/);
assert.match(main, /function assertCurrentSelectionFrameParity\(/);
assert.match(
  main,
  /function renderSelectionOutline[\s\S]*?if \(!currentSelectionAlignment\(\)\.ok\)[\s\S]*?canvas\.hidden = true/,
);
assert.match(
  main,
  /function returnToCapturedTargetView[\s\S]*?capturedWorld\.decompose[\s\S]*?renderSelectionOutline/,
);
const returnBody = main.match(
  /function returnToCapturedTargetView\(\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
const preflightAt = returnBody.indexOf('currentSelectionReturnPreflight(active)');
assert.ok(preflightAt >= 0);
for (const mutation of [
  'capturedWorld.decompose(camera.position',
  'camera.projectionMatrix.fromArray',
  'controls.target.copy',
]) {
  assert.ok(
    preflightAt < returnBody.indexOf(mutation),
    `return preflight must precede ${mutation}`,
  );
}
assert.doesNotMatch(main, /function recaptureCurrentTarget/);
assert.match(main, /ui\.confirmVisibleObject\.disabled = true/);
assert.match(main, /ui\.selectionOutline\.hidden = true/);
assert.match(main, /scanTray\.begin\(\{[\s\S]*?pending:\s*true/);
assert.match(main, /scheduleAutomaticMultiview\('Visible object confirmed', 0\)/);
assert.match(main, /automaticMultiviewTimer = setTimeout\(startMultiviewRefinement, 750\)/);
assert.match(main, /exposeConfirmedScanFailure\([\s\S]*?'Retry scan'/);
assert.match(
  main,
  /function scheduleAutomaticMultiview[\s\S]*?isVisibleObjectConfirmed\(active\.visibleObjectGate, revision\)/,
);
assert.match(
  main,
  /async function startMultiviewRefinement[\s\S]*?consumeVisibleObjectStart\(active\.visibleObjectGate, revision\)/,
);
assert.doesNotMatch(
  main,
  /finally \{\s*clearBusy\('mask generation'\);[\s\S]{0,220}scheduleAutomaticMultiview/,
);

console.log('visible 3D object confirmation gate: ok');
