import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../main.js', import.meta.url), 'utf8'),
]);

assert.doesNotMatch(
  main,
  /Mouse look · click to freeze this view/,
  'movement legend must not be written into the permanent General hint',
);
assert.match(
  main,
  /Click scene to fly · W A S D move · Q E turn · Tab cycles workspaces/,
);
assert.match(main, /showViewfinderCue\('Click to freeze view', 1500\)/);
assert.match(main, /showViewfinderCue\('Click scene to continue flying'\)/);
assert.match(html, /body\[data-exploration="true"\] #viewfinderCue/);
assert.match(html, /#viewfinderCue\[data-visible="true"\]/);
assert.match(html, /id="viewfinderCue" data-visible="false"/);

console.log('viewfinder cue contract: ok');
