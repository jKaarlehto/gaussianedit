import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESCAPE_ACTIONS, resolveEscapeAction } from '../workspaceEscape.js';

assert.equal(resolveEscapeAction({
  hasBlockingLayer: true,
  hasTransient: true,
  workspace: 'object',
  sceneExploring: true,
}), ESCAPE_ACTIONS.CLOSE_LAYER);
assert.equal(resolveEscapeAction({
  hasTransient: true,
  workspace: 'mask',
}), ESCAPE_ACTIONS.CANCEL_TRANSIENT);
assert.equal(resolveEscapeAction({ workspace: 'mask' }), ESCAPE_ACTIONS.RETURN_WORKSPACE);
assert.equal(resolveEscapeAction({ workspace: 'object' }), ESCAPE_ACTIONS.RETURN_WORKSPACE);
assert.equal(resolveEscapeAction({
  workspace: 'scene',
  sceneExploring: true,
}), ESCAPE_ACTIONS.FREEZE_SCENE);
assert.equal(resolveEscapeAction({ workspace: 'scene' }), ESCAPE_ACTIONS.NONE);

const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const handler = main.match(
  /function handleWorkspaceEscape\(event\) \{([\s\S]*?)\n\}\n\naddEventListener\('keydown', handleWorkspaceEscape/,
)?.[1] ?? '';
assert.match(handler, /event\.preventDefault\(\)/);
assert.match(handler, /event\.stopImmediatePropagation\(\)/);
assert.match(handler, /topEscapeLayer/);
assert.match(handler, /cancelTransientWorkspaceState/);
assert.match(handler, /returnPrevious:\s*true/);
assert.match(handler, /setExplorationMode\(false\)/);
assert.doesNotMatch(
  handler,
  /dismissActiveSelection|undoSelectionPreview|stopMultiview|keepSelectionPreview|dock|clear/i,
);

console.log('central layered Escape behavior: ok');
