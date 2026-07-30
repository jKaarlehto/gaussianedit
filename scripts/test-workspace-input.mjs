import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allowsInput,
  cycleWorkspace,
  resolveWorkspace,
  workspaceAvailability,
  workspaceInputOwner,
  WorkspaceController,
} from '../workspaceState.js';

const empty = workspaceAvailability({ scene: true });
assert.equal(cycleWorkspace('scene', empty), 'mask');
assert.equal(resolveWorkspace('scene', 'mask', empty), 'mask');
assert.equal(resolveWorkspace('scene', 'object', empty), 'object');

const ready = workspaceAvailability({ scene: true, mask: true, object: true });
assert.equal(cycleWorkspace('scene', ready), 'mask');
assert.equal(cycleWorkspace('mask', ready), 'object');
assert.equal(cycleWorkspace('object', ready), 'scene');
assert.equal(cycleWorkspace('scene', ready, true), 'object');
assert.equal(resolveWorkspace('scene', 'object', ready), 'object');

const flight = workspaceInputOwner('scene', { flying: true });
const frozen = workspaceInputOwner('scene', { flying: false });
const mask = workspaceInputOwner('mask');
const object = workspaceInputOwner('object');
assert.equal(allowsInput(flight, 'flight-keys'), true);
assert.equal(allowsInput(flight, 'object-drag'), false);
assert.equal(allowsInput(frozen, 'target-click'), true);
assert.equal(allowsInput(frozen, 'orbit-drag'), true);
assert.equal(allowsInput(frozen, 'orbit-wheel'), true);
assert.equal(allowsInput(frozen, 'flight-keys'), false);
assert.equal(allowsInput(mask, 'mask-pointer'), true);
assert.equal(allowsInput(mask, 'pointer-lock'), false);
assert.equal(allowsInput(object, 'object-drag'), true);
assert.equal(allowsInput(object, 'object-wheel'), true);
assert.equal(allowsInput(object, 'flight-keys'), false);

const controller = new WorkspaceController();
const context = {
  sceneLoaded: true,
  frameReady: true,
  maskReady: true,
  maskWidth: 832,
  maskHeight: 512,
  selectionCount: 25_266,
  hasDraft: true,
  sceneFlying: false,
};
let derived = controller.derive(context);
assert.equal(derived.mainWorkspace, 'scene');
assert.deepEqual(derived.postcardIds, ['mask', 'object']);
assert.equal(derived.postcardIds.includes(derived.active), false);
assert.equal(derived.postcardIds.length, 2);
assert.equal(derived.drawerOwner, 'camera');
assert.equal(derived.inputOwner, 'scene-selection');
assert.equal(controller.next(context), 'mask');

controller.activate('mask', context);
derived = controller.derive(context);
assert.deepEqual(derived.postcardIds, ['object', 'scene']);
assert.equal(derived.drawerOwner, 'mask');
assert.equal(derived.inputOwner, 'mask-editor');
assert.equal(controller.next(context), 'object');
assert.equal(controller.next(context, true), 'scene');

controller.activate('object', context);
derived = controller.derive(context);
assert.deepEqual(derived.postcardIds, ['scene', 'mask']);
assert.equal(derived.drawerOwner, 'object');
assert.equal(derived.inputOwner, 'object-orbit');
assert.equal(controller.next(context), 'scene');

let transition = controller.returnPrevious(context);
assert.equal(transition.active, 'mask');
transition = controller.returnPrevious(context);
assert.equal(transition.active, 'scene');

const emptyController = new WorkspaceController();
emptyController.activate('mask', { sceneLoaded: true });
assert.equal(emptyController.active, 'mask');
assert.equal(emptyController.derive({ sceneLoaded: true }).available.mask, false);
emptyController.activate('object', { sceneLoaded: true });
assert.equal(emptyController.active, 'object');

const root = new URL('../', import.meta.url);
const main = readFileSync(new URL('main.js', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');
const highlight = readFileSync(new URL('highlight.js', root), 'utf8');
assert.match(html, /id="sceneFlightToggle"[\s\S]*?>Explore scene</);
assert.match(html, /id="exploreSelectionContext"[^>]*aria-pressed="true"/);
assert.match(
  main,
  /if \(state\.active\) \{[\s\S]{0,420}authoritative SelectionFrame[\s\S]{0,220}return;/,
);
const targetOrbitBody = main.match(
  /function syncTargetOrbitControls\(active = state\.active\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.match(targetOrbitBody, /analyzeSelectedObject\(\{/);
assert.match(targetOrbitBody, /active\.sceneOrbitCentre = analysis\.centre\.clone\(\)/);
assert.match(targetOrbitBody, /controls\.target\.copy\(active\.sceneOrbitCentre\)/);
assert.match(targetOrbitBody, /controls\.enablePan = false/);
assert.doesNotMatch(
  targetOrbitBody,
  /controls\.update\(\)/,
  'installing the selected-object pivot must not alter the frozen camera pose',
);
assert.match(
  main,
  /sceneOrbitPivotSet: false,\s*sceneOrbitCentre: null,\s*targetControlsActivated: false/,
);
assert.match(
  main,
  /controls\.addEventListener\('change', \(\) => \{\s*if \(state\.active\?\.sceneOrbitPivotSet\) \{\s*state\.active\.targetControlsActivated = true;/,
);
assert.match(
  main,
  /const deferTargetControls = Boolean\([\s\S]{0,180}!state\.active\.targetControlsActivated[\s\S]{0,120}const controlsChanged = deferTargetControls \? false : controls\.update\(\)/,
);
assert.match(
  main,
  /if \(!preserveActive\) \{\s*state\.active = null;\s*controls\.enablePan = true;/,
);
const returnToCapturedBody = main.match(
  /function returnToCapturedTargetView\(\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.match(returnToCapturedBody, /controls\.target\.copy\(active\.sceneOrbitCentre\)/);
assert.match(returnToCapturedBody, /controls\.enablePan = false/);
assert.doesNotMatch(
  returnToCapturedBody,
  /controls\.update\(\)/,
  'returning to the captured pose must not let OrbitControls perturb it',
);
assert.match(
  main,
  /if \(state\.active\) \{[\s\S]{0,520}enforceSelectionAlignmentContainment\(\);[\s\S]{0,120}return;/,
);
const containmentBody = main.match(
  /function enforceSelectionAlignmentContainment\(\) \{([\s\S]*?)\n\}/,
)?.[1] ?? '';
assert.match(containmentBody, /ui\.selectionOutline\.hidden = true/);
assert.match(containmentBody, /ui\.visibleObjectGate\.hidden = true/);
assert.doesNotMatch(
  containmentBody,
  /state\.highlight|highlight\.(?:visible|clear|set)/,
  'departing the capture pose hides screen-space raster without dropping the 3D highlight',
);
assert.match(
  main,
  /if \(workspaceController\.active === 'scene'\) \{[\s\S]*?renderer\.render\(scene, camera\)/,
);
assert.match(main, /renderGuardedOverlay\('hud-effects', hudEffects, now, visibleFrame\)/);
assert.match(main, /state\.active \? 'Unlock and fly' : 'Explore scene'/);
assert.match(
  main,
  /if \(next === 'scene' && state\.sceneFlying && !state\.exploration\)[\s\S]*?setExplorationMode\(true, \{ activateWorkspace: false \}\)/,
);
assert.match(main, /syncExploreSelectionContext\(\)/);
assert.match(highlight, /setContextAppearance\(enabled = false\)/);
assert.match(highlight, /new THREE\.Color\(0x83a8ad\)/);

console.log('workspace order and exclusive input ownership: ok');
