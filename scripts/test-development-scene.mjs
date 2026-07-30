import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const config = readFileSync(new URL('vite.config.js', root), 'utf8');
const client = readFileSync(new URL('main.js', root), 'utf8');
const expected = join(homedir(), 'Downloads', 'blender livingroom', 'scene.ply');

assert.equal(
  existsSync(expected),
  true,
  `development scene must be readable at ${expected}`,
);
assert.match(
  config,
  /const developmentDefault = join\(\s*downloads,\s*'blender livingroom',\s*'scene\.ply',\s*\)/,
);
assert.match(config, /existsSync\(developmentDefault\)\s*\?\s*developmentDefault/);
assert.match(config, /development default is missing:/);
assert.match(client, /fetch\(`\/__demo__\/info/);
assert.match(client, /loadSplat\(`\/__demo__\/random\.ply/);
assert.doesNotMatch(client, /C:[\\/]+Users[\\/]+JuhanaKaarlehto/i);

console.log('development scene route: ok');
