import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const main = readFileSync(new URL('main.js', root), 'utf8');
const objectPreview = readFileSync(new URL('objectPreview.js', root), 'utf8');

assert.doesNotMatch(html, /id="modeToggle"|id="viewfinderMode"|id="selectionMode"/);
assert.doesNotMatch(html, />\s*Mode and camera\s*</i);
assert.doesNotMatch(html, /id="sceneCameraControls"[\s\S]{0,120}<h3>Camera<\/h3>/);
assert.match(html, /id="workspaceStack"[^>]*aria-label="Live workspace postcards"/);
assert.match(html, /id="scenePostcardCanvas"/);
assert.match(html, /id="projectionCanvas"/);
assert.match(html, /id="objectPreviewCanvas"/);
assert.match(html, /id="objectPreviewStatus">EMPTY</);
assert.doesNotMatch(html, /select an object to inspect it/i);
assert.doesNotMatch(html, /no encoded view yet/i);
assert.match(html, /#workspaceStack \{[\s\S]*?flex-direction: column/);
assert.doesNotMatch(html, /#workspaceStack \{[\s\S]{0,180}grid-template-columns:\s*repeat\(3/);
assert.equal((html.match(/class="workspace-card"/g) ?? []).length, 3);
assert.match(html, /\.workspace-card\[data-deck="true"\][\s\S]*?width:\s*100%;\s*height:\s*auto;\s*aspect-ratio:\s*16\s*\/\s*9/);
assert.match(
  html,
  /#workspaceStack > #sceneWorkspaceCard\[data-deck="true"\],[\s\S]*?#workspaceStack > #objectWorkspaceCard\[data-deck="true"\][\s\S]*?width:\s*100%;\s*height:\s*auto;\s*aspect-ratio:\s*16\s*\/\s*9/,
);
assert.match(html, /\.workspace-card\[data-deck="true"\] \+ \.workspace-card\[data-deck="true"\]/);
assert.match(html, /#workspaceStack \{[\s\S]*?gap:\s*10px/);
assert.match(html, /\.workspace-card\[data-deck="true"\][\s\S]*?padding:\s*12px/);
assert.match(
  html,
  /\.workspace-card\[data-deck="true"\] \+ \.workspace-card\[data-deck="true"\] \{[\s\S]*?margin-top:\s*0/,
);
assert.doesNotMatch(html, /margin-top:\s*-\d/);
assert.doesNotMatch(html, /repeating-linear-gradient\(180deg, #70d7ff22/);
assert.match(html, /\.workspace-card\[data-deck="true"\] button[\s\S]*?display:\s*none/);
const cardHoverRule = html.match(
  /#workspaceStack > \.workspace-card\[data-deck="true"\]:hover,[\s\S]*?\n\s*\}/,
)?.[0] ?? '';
assert.match(cardHoverRule, /border-color:/);
assert.doesNotMatch(
  cardHoverRule,
  /transform\s*:|translate/,
  'live WebGL card hover must not move its DOM/scissor bounds',
);
assert.doesNotMatch(
  html,
  /transition:\s*transform[^;]*;/,
  'preview card transitions must not animate renderer bounds',
);
assert.match(main, /ui\.workspaceMainHost\.append\(ui\.projectionPip, ui\.objectPreviewHud\)/);
assert.match(main, /workspace\.postcardIds\.forEach\(\(postcardId, index\) =>/);
assert.match(main, /card\.dataset\.deck = 'true'/);
assert.doesNotMatch(main, /ui\.workspaceMainHost\.append\(activeCard\)/);
assert.doesNotMatch(main, /ui\.workspaceCardParking\.append\(activeCard\)/);
assert.match(html, /\.workspace-card\[data-deck="false"\] \{\s*display:\s*none/);
assert.doesNotMatch(main, /sceneDecisionControlHost|sceneDecisionControls/);
assert.match(
  main,
  /ui\.objectWorkspaceControlHost\.append\(ui\.objectPreviewHud\.querySelector\('#objectPreviewControls'\)\)/,
);
assert.match(main, /ui\.maskWorkspaceControlHost\.append\(ui\.projectionMaskTools\)/);
assert.match(main, /ui\.open2dMaskEditor\.addEventListener\('click', \(\) => setWorkspace\('mask'\)\)/);
assert.doesNotMatch(
  main,
  /active\.maskH = maskH;\s*if \(workspaceController\.active === 'scene'\) setWorkspace\('mask'\)/,
);
assert.match(
  html,
  /body\[data-workspace="mask"\] #visibleSelectionStep[\s\S]*?display:\s*none !important/,
);
assert.match(
  html,
  /body\[data-workspace="mask"\] #projectionPip\[data-editor-open="true"\][\s\S]*?border:\s*0[\s\S]*?background:\s*#020608/,
);
assert.match(
  main,
  /if \(workspaceController\.active === 'scene'\)[\s\S]*?renderer\.render\(scene, camera\)[\s\S]*?else \{[\s\S]*?renderer\.clear\(true, true, true\)/,
);
assert.match(
  main,
  /if \(workspaceController\.active !== 'scene' \|\| now - lastScenePostcardAt < 400\) return/,
);
assert.match(main, /workspaceController\.active === 'scene'[\s\S]*?!state\.projectionEditorOpen/);
assert.match(main, /projectSelectionCentroid\([\s\S]*?state\.active\?\.frame/);
assert.match(main, /frame\.camera\.viewProjectionMatrix/);
assert.match(main, /ui\.confirmVisibleObject\.addEventListener\('click', acceptVisibleObjectConfirmation\)/);
assert.match(main, /ui\.editVisibleObjectMask\.addEventListener\('click', \(\) => setWorkspace\('mask'\)\)/);
assert.match(main, /updateScenePostcard\(now\)/);
assert.match(
  main,
  /const next = workspaceController\.next\(workspaceContext\(\), event\.shiftKey\)/,
);
assert.match(main, /workspace\.postcardIds\.forEach\(\(postcardId, index\) =>/);
assert.doesNotMatch(main, /state\.workspace/);
assert.match(main, /currentInputOwner\(\) !== 'scene-flight'/);
assert.match(main, /currentInputOwner\(\) !== 'scene-selection'/);
assert.match(main, /cameraFromSelectionFrame\(active\.frame\)/);
assert.match(main, /camera: scanSourceCamera/);
assert.match(html, /scrollbar-width:\s*none/);
assert.match(html, /::-webkit-scrollbar/);
assert.match(
  html,
  /body\[data-workspace="scene"\] #selectionProps > :not\(header\):not\(#sceneCameraControls\)/,
);
assert.match(html, /body\[data-workspace="mask"\] #objectWorkspaceControls/);
const projectionBlock = html.slice(
  html.indexOf('<aside id="projectionPip"'),
  html.indexOf('<div id="workspaceMainHost"'),
);
const objectBlock = html.slice(
  html.indexOf('<aside id="objectPreviewHud"'),
  html.indexOf('<aside id="changeDiffHud"'),
);
assert.doesNotMatch(projectionBlock, /<(?:header|footer)\b/);
assert.doesNotMatch(objectBlock, /<(?:header|footer)\b/);
assert.match(projectionBlock, /<b>2D mask<\/b>/i);
assert.match(objectBlock, /<b[^>]*>3D object<\/b>/i);
assert.doesNotMatch(
  `${projectionBlock}${objectBlock}`,
  /<b[^>]*>\s*(?:evidence|(?:01|02|03)\s*·)/i,
);
assert.match(
  html,
  /#projectionPip > \.buffer-card-label \{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*space-between[\s\S]*?background:\s*#020304/,
);
assert.match(
  html,
  /#objectPreviewHud > \.buffer-card-label \{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*space-between[\s\S]*?background:\s*#020304/,
);
assert.match(
  html,
  /#workspaceStack > #maskWorkspaceCard\[data-deck="true"\],\s*#workspaceStack > #objectWorkspaceCard\[data-deck="true"\] \{[\s\S]*?grid-template-rows:\s*25px minmax\(0, 1fr\);[\s\S]*?padding:\s*12px;[\s\S]*?border-radius:\s*4px/,
);
assert.match(
  html,
  /#workspaceStack > #maskWorkspaceCard\[data-deck="true"\] > \.buffer-card-label,\s*#workspaceStack > #objectWorkspaceCard\[data-deck="true"\] > \.buffer-card-label \{[\s\S]*?height:\s*25px;[\s\S]*?padding:\s*0 8px;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*space-between/,
);
assert.match(
  html,
  /#workspaceStack > #maskWorkspaceCard\[data-deck="true"\] > \.buffer-card-viewport,\s*#workspaceStack > #objectWorkspaceCard\[data-deck="true"\] > \.buffer-card-viewport \{[\s\S]*?height:\s*auto;[\s\S]*?border-radius:\s*0 0 3px 3px/,
);
assert.match(html, /id="maskWorkspaceCardCanvas"/);
assert.match(html, /id="objectWorkspaceCardCanvas"/);
assert.match(main, /const objectCardPreview = new ObjectPreview/);
assert.match(main, /objectPreview\.render\(now\);\s*objectCardPreview\.render\(now\)/);
assert.match(main, /objectCardHasValidPreview/);
assert.match(
  html,
  /#workspaceStack > #objectWorkspaceCard\[data-deck="true"\][\s\S]*?contain:\s*layout paint/,
);
assert.match(
  html,
  /#objectWorkspaceCardCanvas \{[\s\S]*?position:\s*absolute;\s*inset:\s*0;[\s\S]*?contain:\s*strict/,
);
assert.match(
  objectPreview,
  /closest\('\.buffer-card-viewport'\)[\s\S]*?clippedLeft = Math\.max\(target\.left, clip\.left, canvas\.left\)/,
);
assert.doesNotMatch(
  html,
  /data-object-display="gaussians"|actual Gaussian rendering is not connected yet/i,
  'the 3D Object rail must not advertise a disabled renderer mode',
);
assert.match(main, /const objectDisplayMode = 'confidence'/);
assert.ok(
  html.indexOf('id="visibleObjectGate"') < html.indexOf('id="selectionProps"'),
  'confirmation HUD must remain viewport-level, never inside the right drawer',
);
assert.match(
  html,
  /#ui \{[\s\S]*?background:\s*#11161b;[\s\S]*?backdrop-filter:\s*none;[\s\S]*?opacity:\s*1/,
);
assert.match(
  html,
  /body\[data-exploration="true"\] #ui \{[\s\S]*?background:\s*#11161b;[\s\S]*?backdrop-filter:\s*none;[\s\S]*?opacity:\s*1/,
);

console.log('live vertical workspace postcard layout: ok');
