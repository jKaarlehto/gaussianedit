import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OBJECT_PREVIEW_FRAME_PADDING,
  advanceObjectPreviewSpin,
  createObjectPreviewMotionState,
  objectPreviewFitDistance,
  outwardOnlyFit,
  setObjectPreviewHover,
} from '../objectPreview.js';

const motion = createObjectPreviewMotionState();
advanceObjectPreviewSpin(motion, 1000);
const beforeHover = advanceObjectPreviewSpin(motion, 1100);
const cardOwner = Symbol('workspace-card');
setObjectPreviewHover(motion, cardOwner, true);
assert.equal(advanceObjectPreviewSpin(motion, 1300), beforeHover);
assert.equal(advanceObjectPreviewSpin(motion, 1500), beforeHover);
motion.userYaw = 0.7;
setObjectPreviewHover(motion, cardOwner, false);
const afterHover = advanceObjectPreviewSpin(motion, 1600);
assert.ok(afterHover > beforeHover);
assert.equal(motion.userYaw, 0.7, 'user orbit survives hover handoff');
assert.equal(
  motion.paused,
  false,
  'promoting or hiding a hovered card releases its shared hover owner',
);

const fit = objectPreviewFitDistance({ fovDegrees: 34, aspect: 16 / 9 });
assert.ok(fit > 3.9, '1.25x framing padding moves the preview modestly outward');
assert.equal(OBJECT_PREVIEW_FRAME_PADDING, 1.25);
assert.equal(outwardOnlyFit(fit, fit * 0.8), fit, 'automatic fit never zooms inward');
assert.equal(outwardOnlyFit(fit, fit * 1.2), fit * 1.2, 'automatic fit may expand');

const root = new URL('../', import.meta.url);
const main = readFileSync(new URL('main.js', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');
assert.match(main, /const objectPreviewMotion = createObjectPreviewMotionState\(\)/);
assert.match(main, /motionState:\s*objectPreviewMotion/g);
assert.match(
  main,
  /workspaceController\.active === 'object'[\s\S]{0,100}workspaceController\.active === 'mask'[\s\S]*?clearHoveredObjectSuggestion\(\)/,
);
assert.match(
  main,
  /const suppressed = workspaceController\.active === 'object'[\s\S]{0,100}workspaceController\.active === 'mask'[\s\S]{0,100}Boolean\(pendingTargetReplacement\)/,
);
assert.doesNotMatch(
  main,
  /const suppressed = workspaceController\.active === 'object' \|\| Boolean\(state\.active\)/,
);
assert.match(
  main,
  /if \(transition\.changed\) \{\s*objectPreview\.releaseHover\(\);\s*objectCardPreview\.releaseHover\(\);/,
);
assert.match(
  main,
  /const transition = workspaceController\.activateScene\(\);[\s\S]{0,140}objectPreview\.releaseHover\(\);[\s\S]{0,80}objectCardPreview\.releaseHover\(\);/,
);
assert.match(
  main,
  /const lockedTarget = Boolean\(state\.active\?\.currentMask\)[\s\S]{0,500}currentSelectionAlignment\(state\.active\)\.ok/,
);
assert.match(
  main,
  /const matches = objectSuggestionRevision === suggestionRevision[\s\S]{0,260}!lockedTarget \|\| isYoloSuggestion\(suggestion\)/,
);
assert.match(
  html,
  /body\[data-workspace="object"\] #objectHintHud,[\s\S]*?#selectionOutline \{[\s\S]*?display:\s*none !important/,
);
assert.doesNotMatch(
  main,
  /automaticYaw\s*=\s*this\.spin[\s\S]{0,100}Math\.sin/,
  'hover must not reset an absolute clock-based sine to zero',
);

console.log('object preview motion/framing contract ok');
