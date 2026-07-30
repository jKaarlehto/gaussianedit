import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const main = readFileSync(new URL('main.js', root), 'utf8');

assert.doesNotMatch(html, /Shift<\/kbd>\+click removes|Shift\+click removes/i);
assert.match(main, /if \(e\.shiftKey\) \{[\s\S]*?One object at a time/);
assert.match(main, /if \(intent\.subtract\) \{[\s\S]*?Scene Shift-click ignored/);
assert.match(
  main,
  /if \(state\.active\?\.currentMask\) \{[\s\S]*?clickHitsCurrentSelection[\s\S]*?refocusCurrentSceneTarget\(\)[\s\S]*?proposeTargetReplacement\(e\)/,
);
assert.match(html, /id="newTargetGate"[^>]*role="group"/);
assert.match(html, /id="newTargetGateTitle">Switch target\?</i);
assert.match(html, /id="replaceTarget"[^>]*>Replace</);
assert.match(html, /id="cancelReplaceTarget"[^>]*>Cancel</);
const refocus = main.match(
  /function refocusCurrentSceneTarget\(\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.doesNotMatch(refocus, /controls\.target\.copy|controls\.update/);
assert.doesNotMatch(refocus, /state\.selection\.(?:add|delete|clear)|currentMask\s*=/);
const propose = main.match(
  /async function proposeTargetReplacement\(event\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.match(propose, /isYoloSuggestion\(suggestion\)/);
assert.match(propose, /captureSparseSelectionState\(\{/);
assert.match(propose, /status:\s*'previewing'/);
assert.match(propose, /await beginSelection\(/);
assert.match(propose, /recordHistory:\s*false/);
assert.match(propose, /transaction\.status = 'decision'/);
assert.match(propose, /ui\.newTargetGate\.hidden = false/);
assert.doesNotMatch(propose, /state\.selection\.(?:add|delete|clear)|currentMask\s*=/);
const replace = main.match(
  /function replaceTargetFromProposal\(\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.match(replace, /transaction\.status !== 'decision'/);
assert.match(replace, /candidateRevision\?\.key !== transaction\.candidateRevisionKey/);
assert.doesNotMatch(replace, /state\.selection\.clear\(\)|dismissActiveSelection\(\)|markViewDirty/);
const cancel = main.match(
  /function cancelTargetReplacement\(\{ restore = true \} = \{\}\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.match(cancel, /restoreSparseSelectionState\(transaction\.original\)/);
assert.match(cancel, /renderSelectionOutline\(/);
assert.doesNotMatch(cancel, /dismissActiveSelection/);
assert.match(main, /!pendingTargetReplacement[\s\S]*?workspaceController\.active === 'scene'/);
assert.match(main, /pendingTargetReplacement\?\.candidateActive === active/);
assert.match(main, /confirmedSelectionIds = Int32Array\.from\(state\.selection\)/);
assert.match(main, /selectionMatchesConfirmedSnapshot\(active\)/);
assert.match(html, /Shift\+click a targeting mode to combine it with the current one/);

console.log('single-object Scene click contract: ok');
