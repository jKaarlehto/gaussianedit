import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('./orchestration-board.ps1', import.meta.url), 'utf8');
const config = JSON.parse(fs.readFileSync(new URL('../.codex/orchestration/config.json', import.meta.url), 'utf8'));
const scheduledPrompt = fs.readFileSync(new URL('../SCHEDULED_DISPATCH_PROMPT.md', import.meta.url), 'utf8');
const kickoffPrompt = fs.readFileSync(new URL('../ORCHESTRATION_KICKOFF_PROMPT.md', import.meta.url), 'utf8');
const agentGuide = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const pluginManifest = JSON.parse(fs.readFileSync(new URL('../.agents/plugins/plugins/gaussianedit-orchestration/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
const pluginApp = JSON.parse(fs.readFileSync(new URL('../.agents/plugins/plugins/gaussianedit-orchestration/.app.json', import.meta.url), 'utf8'));
const marketplace = JSON.parse(fs.readFileSync(new URL('../.agents/plugins/marketplace.json', import.meta.url), 'utf8'));
const dispatchSkill = fs.readFileSync(new URL('../.agents/plugins/plugins/gaussianedit-orchestration/skills/dispatch-cloud-work/SKILL.md', import.meta.url), 'utf8');

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

assert.equal(pluginManifest.name, 'gaussianedit-orchestration');
assert.equal(pluginManifest.skills, './skills/');
assert.equal(pluginManifest.apps, './.app.json');
assert.equal(typeof pluginApp.apps['gaussianedit-orchestration'].id, 'string');
const marketplaceEntry = marketplace.plugins.find(({ name }) => name === pluginManifest.name);
assert.equal(marketplaceEntry?.source?.path, './plugins/gaussianedit-orchestration');
assert.equal(marketplaceEntry?.policy?.installation, 'AVAILABLE');
assert.equal(marketplaceEntry?.policy?.authentication, 'ON_INSTALL');
assert.match(dispatchSkill, /draft PR/);
assert.match(dispatchSkill, /github-pr:<number>:comment:<id>/);
assert.match(dispatchSkill, /DISPATCH_UNSUPPORTED/);
assert.match(dispatchSkill, /Do not require the GitHub-triggered cloud chat[\s\S]*worker lease/);
assert.doesNotMatch(dispatchSkill, /native Codex cloud task-creation tool/i);

for (const content of [scheduledPrompt, dispatchSkill]) {
  assert.match(content, /GaussianEdit Orchestration/);
  assert.match(content, /GitHub/);
  assert.match(content, /@codex/);
  assert.match(content, /idempoten/i);
  assert.match(content, /draft (?:PR|pull request)/i);
  assert.match(content, /staging/);
  assert.match(content, /DISPATCH_UNSUPPORTED/);
  assert.match(content, /SYSTEM/);
  assert.match(content, /PRODUCT/);
  assert.match(content, /priority(?:,)? then age/);
  assert.match(content, /new\s+queued job/i);
  assert.match(content, /expired lease/i);
  assert.match(content, /clean\s+pushed\s+immutable\s+handoff/i);
  assert.match(content, /Passing tests are not a dispatch prerequisite/i);
  assert.doesNotMatch(content, /native Codex cloud task-creation action/i);
  for (const action of ['orchestration_status', 'dispatch_claim', 'dispatch_result', 'search_prs', 'get_pr_info', 'fetch_issue_comments', 'create_pull_request', 'add_comment_to_issue']) {
    assert.match(content, new RegExp(`\\b${action}\\b`), `missing documented connector action ${action}`);
  }
}

assert.match(scheduledPrompt, /github-pr:<number>:comment:<id>/);
assert.match(scheduledPrompt, /Do not claim or promise a live local worker lease/);
assert.match(kickoffPrompt, /npm run dev/);
assert.match(kickoffPrompt, /Microsoft Edge/);
assert.match(kickoffPrompt, /do not default them to Luna or\s+the cheapest model/);
assert.match(agentGuide, /get_development_framework/);
assert.match(agentGuide, /orchestration_status/);
assert.match(agentGuide, /gaussianedit-orchestration-framework/);
assert.match(agentGuide, /Only one agent may own `main\.js`/);

console.log('orchestration board wrapper contract: pass');
