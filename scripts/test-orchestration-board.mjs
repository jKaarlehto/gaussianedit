import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('./orchestration-board.ps1', import.meta.url), 'utf8');
const config = JSON.parse(fs.readFileSync(new URL('../.codex/orchestration/config.json', import.meta.url), 'utf8'));

for (const route of [
  'status',
  'sync',
  'publishJob',
  'claimWork',
  'renewWork',
  'releaseWork',
  'claim',
  'dispatchResult',
]) {
  assert.equal(typeof config.protocol.routes[route], 'string', `missing configured route ${route}`);
  assert.match(script, new RegExp(`Invoke-BoardRequest (?:GET|POST) "${route}"`));
}

assert.match(script, /function Resolve-BoardUri/);
assert.match(script, /Get-ProtocolRoute \$RouteName/);
assert.doesNotMatch(script, /Invoke-BoardRequest POST "jobs\//);
assert.match(script, /dashboard\.lastSeq -eq \(\[int\]\$meta\.nextSeq - 1\)/);

const syncBlock = script.slice(script.indexOf('"sync" {'), script.indexOf('"publish" {'));
assert.match(syncBlock, /Export-LocalBoard[\s\S]*dashboard\.json/);
assert.match(syncBlock, /Set-TaskCategories \$body/);
assert.match(script, /Product means work on the GaussianEdit 3D editor/);
assert.match(script, /candidate-feedback-\|candidate-workflow-/);
assert.match(script, /connector-\|orchestration-/);
assert.match(script, /\$category = if \(\$systemTask -or \$systemFiles\) \{ 'system' \} else \{ 'product' \}/);

assert.match(script, /"idea" \{/);
assert.match(script, /IDEA\|role=\$Role\|priority=\$IdeaPriority\|evidence=\$Evidence\|proposal=\$Proposal/);
assert.match(script, /not jobs, claims, handoffs, or dispatch authority/);
assert.match(script, /\[\\r\\n\|\]/);

console.log('orchestration board wrapper contract: pass');
