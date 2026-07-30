import assert from 'node:assert/strict';
import { positionRetargetHud } from '../retargetHud.js';

const normal = positionRetargetHud({
  candidate: { left: 300, top: 180, right: 460, bottom: 360 },
  hudWidth: 244,
  hudHeight: 38,
  viewportWidth: 1280,
  viewportHeight: 720,
});
assert.equal(normal.overlapsCandidate, false);
assert.ok(normal.left >= 12 && normal.top >= 12);
assert.ok(normal.left + normal.width <= 1268);
assert.ok(normal.top + normal.height <= 708);

const narrow = positionRetargetHud({
  candidate: { left: 42, top: 100, right: 278, bottom: 420 },
  hudWidth: 420,
  hudHeight: 64,
  viewportWidth: 320,
  viewportHeight: 480,
});
assert.equal(narrow.width, 296);
assert.ok(narrow.left >= 12 && narrow.top >= 12);
assert.ok(narrow.left + narrow.width <= 308);
assert.ok(narrow.top + narrow.height <= 468);

console.log('retarget HUD layout contract ok');
