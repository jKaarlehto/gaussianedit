import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { updateTargetingSources } from '../targetingState.js';

assert.deepEqual([...updateTargetingSources(new Set(['auto']), 'fill')], ['fill']);
assert.deepEqual(
  [...updateTargetingSources(new Set(['auto']), 'fill', true)].sort(),
  ['auto', 'fill'],
);
assert.deepEqual(
  [...updateTargetingSources(new Set(['auto', 'fill']), 'auto', true)],
  ['fill'],
);
assert.deepEqual(
  [...updateTargetingSources(new Set(['radius']), 'radius', true)],
  ['radius'],
  'Shift must not leave targeting with no configured source',
);

const [html, main] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../main.js', import.meta.url), 'utf8'),
]);

const generalStart = html.indexOf('<div id="ui">');
const generalEnd = html.indexOf('<aside id="projectionPip"');
const general = html.slice(generalStart, generalEnd);
const inspectorStart = html.indexOf('<aside id="selectionProps"');
const inspectorEnd = html.indexOf('<aside id="focusRefineHud"');
const inspector = html.slice(inspectorStart, inspectorEnd);

for (const id of [
  'selectionMethod',
  'targetingMethodHint',
  'suggestionsToggle',
  'preselectionOptions',
  'autoProps',
  'fillProps',
  'radiusProps',
  'fusionProps',
  'selectionOutput',
]) {
  assert.doesNotMatch(general, new RegExp(`id="${id}"`));
  assert.match(inspector, new RegExp(`id="${id}"`));
}

assert.match(inspector, /data-extent="tight"[^>]*>Item<\/button>/s);
assert.match(inspector, /data-extent="suggested"[^>]*>Region<\/button>/s);
assert.match(inspector, /data-extent="broad"[^>]*>Whole<\/button>/s);
assert.match(inspector, /not a true item\/region\/whole hierarchy/);
assert.match(main, /configuredSources: new Set\(\['auto'\]\)/);
assert.match(main, /sources: new Set\(state\.configuredSources\)/);
assert.doesNotMatch(
  main,
  /methodButtons\.forEach[\s\S]{0,160}if \(!state\.active\) return/,
  'pre-click targeting buttons must not return before updating configured state',
);
assert.match(main, /ui\.selectionProps\.hidden = false;[\s\S]*ui\.targetingSetup\.open = true;/);

console.log('targeting panel placement and pre-click state: ok');
