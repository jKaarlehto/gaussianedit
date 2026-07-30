import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  captureBoxToProjection,
  planSelectionEditorCapture,
  projectionClientPointToMask,
  projectionOverlayIsCurrent,
  projectionTargetingOverlaysVisible,
  SELECTION_EDITOR_CAPTURE_BYTE_BUDGET,
  SELECTION_EDITOR_CAPTURE_LONG_EDGE,
  SELECTION_FRAME_CANVAS_COLOR_SPACE,
} from '../projectionBuffer.js';

assert.equal(SELECTION_FRAME_CANVAS_COLOR_SPACE, 'srgb');
assert.deepEqual(captureBoxToProjection(
  { x1: 120, y1: 70, x2: 320, y2: 170 },
  { x: 20, y: 20, w: 400, h: 200 },
  800,
  400,
), { x1: 200, y1: 100, x2: 600, y2: 300 });
assert.equal(projectionOverlayIsCurrent({
  suggestionRevision: 7,
  frameRevision: 7,
  sameFrame: true,
}), true);
assert.equal(projectionOverlayIsCurrent({
  suggestionRevision: 6,
  frameRevision: 7,
  sameFrame: true,
}), false);
const capturePlan = planSelectionEditorCapture({ width: 3840, height: 2160 });
assert.deepEqual(
  [capturePlan.width, capturePlan.height],
  [2048, 1152],
  'the editor uses the highest physical 16:9 capture allowed by its long-edge cap',
);
assert.equal(capturePlan.longEdgeCap, SELECTION_EDITOR_CAPTURE_LONG_EDGE);
assert.equal(capturePlan.byteBudget, SELECTION_EDITOR_CAPTURE_BYTE_BUDGET);
assert.equal(capturePlan.rgbaBytes, 2048 * 1152 * 4);
assert.ok(capturePlan.estimatedBytes <= capturePlan.byteBudget);
const budgetLimited = planSelectionEditorCapture({ width: 2560, height: 1600 });
assert.ok(budgetLimited.estimatedBytes <= SELECTION_EDITOR_CAPTURE_BYTE_BUDGET);
assert.ok(Math.max(budgetLimited.width, budgetLimited.height)
  <= SELECTION_EDITOR_CAPTURE_LONG_EDGE);
assert.deepEqual(projectionClientPointToMask({
  clientX: 500,
  clientY: 300,
  rect: { left: 100, top: 100, width: 800, height: 400 },
  output: { width: 1600, height: 800 },
  crop: { x: 224, y: 104, w: 1600, h: 800 },
  capture: { width: 2048, height: 1152 },
  mask: { width: 1024, height: 576 },
}), {
  captureX: 1024,
  captureY: 504,
  maskX: 512,
  maskY: 252,
  contentWidth: 800,
  contentHeight: 400,
});
for (const mode of [
  'add', 'remove', 'positive', 'negative', 'polygon-add', 'polygon-remove',
]) {
  assert.equal(projectionTargetingOverlaysVisible(mode), false, `${mode} hides target guides`);
}
assert.equal(projectionTargetingOverlaysVisible('off'), true);
assert.equal(projectionOverlayIsCurrent({
  suggestionRevision: 7,
  frameRevision: 7,
  sameFrame: false,
}), false);

const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
assert.match(main, /captureCtx = capture\.getContext\('2d', \{[\s\S]*?colorSpace: SELECTION_FRAME_CANVAS_COLOR_SPACE/);
assert.match(main, /projectionCtx = ui\.projectionCanvas\.getContext\('2d', \{[\s\S]*?SELECTION_FRAME_CANVAS_COLOR_SPACE/);
assert.match(
  main,
  /currentViewReadback\.target\.texture\.colorSpace = visibleOutputState\.outputColorSpace/,
);
assert.match(main, /renderer\.toneMapping = visibleOutputState\.toneMapping/);
assert.match(main, /projectionCtx\.drawImage\(\s*capture,/);
assert.match(main, /if \(showTargetingOverlays\) \{\s*renderProjectionSuggestions\(projectionCtx, crop, out\)/);
assert.match(main, /const capturePlan = planSelectionEditorCapture\(/);
assert.match(main, /captureDiagnostics: currentViewReadback\.plan/);
assert.match(main, /projectionClientPointToMask\(\{/);
assert.doesNotMatch(main, /renderProjectionSuggestions[\s\S]{0,1200}renderer\.render/);

console.log('selection-frame 2D color and overlay contract: ok');
