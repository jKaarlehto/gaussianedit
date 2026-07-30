import assert from 'node:assert/strict';
import { computePairOverlap, ScanTray } from '../scanTray.js';

const animationCalls = [];

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
  }

  clearRect(x, y, width, height) {
    const x2 = Math.min(this.canvas.width, x + width);
    const y2 = Math.min(this.canvas.height, y + height);
    for (let row = Math.max(0, y); row < y2; row++) {
      for (let column = Math.max(0, x); column < x2; column++) {
        const index = (row * this.canvas.width + column) * 4;
        this.canvas.pixels.fill(0, index, index + 4);
      }
    }
  }

  createImageData(width, height) {
    return {
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    };
  }

  getImageData(x, y, width, height) {
    this.canvas.readbackCalls++;
    const image = this.createImageData(width, height);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const sourceX = x + column;
        const sourceY = y + row;
        if (
          sourceX < 0
          || sourceY < 0
          || sourceX >= this.canvas.width
          || sourceY >= this.canvas.height
        ) continue;
        const sourceIndex = (sourceY * this.canvas.width + sourceX) * 4;
        const targetIndex = (row * width + column) * 4;
        image.data.set(
          this.canvas.pixels.subarray(sourceIndex, sourceIndex + 4),
          targetIndex,
        );
      }
    }
    return image;
  }

  putImageData(image, x, y) {
    const width = image.width ?? Math.round(Math.sqrt(image.data.length / 4));
    const height = image.height ?? image.data.length / 4 / width;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const targetX = x + column;
        const targetY = y + row;
        if (
          targetX < 0
          || targetY < 0
          || targetX >= this.canvas.width
          || targetY >= this.canvas.height
        ) continue;
        const sourceIndex = (row * width + column) * 4;
        const targetIndex = (targetY * this.canvas.width + targetX) * 4;
        this.canvas.pixels.set(
          image.data.subarray(sourceIndex, sourceIndex + 4),
          targetIndex,
        );
      }
    }
  }

  drawImage(source, dx, dy, drawWidth = source.width, drawHeight = source.height) {
    const sourcePixels = source.pixels
      ?? source.getContext?.('2d')?.getImageData(0, 0, source.width, source.height).data;
    if (!sourcePixels) throw new Error('Fake drawImage source has no pixels.');
    for (let y = 0; y < this.canvas.height; y++) {
      if (y < dy || y >= dy + drawHeight) continue;
      const sourceY = Math.min(
        source.height - 1,
        Math.max(0, Math.floor((y - dy) / drawHeight * source.height)),
      );
      for (let x = 0; x < this.canvas.width; x++) {
        if (x < dx || x >= dx + drawWidth) continue;
        const sourceX = Math.min(
          source.width - 1,
          Math.max(0, Math.floor((x - dx) / drawWidth * source.width)),
        );
        const sourceIndex = (sourceY * source.width + sourceX) * 4;
        const targetIndex = (y * this.canvas.width + x) * 4;
        this.canvas.pixels.set(
          sourcePixels.subarray(sourceIndex, sourceIndex + 4),
          targetIndex,
        );
      }
    }
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.className = '';
    this.textContent = '';
    this._width = 0;
    this._height = 0;
    this.pixels = new Uint8ClampedArray();
    this.context = null;
    this.readbackCalls = 0;
    this.isConnected = false;
    this.listeners = new Map();
  }

  set width(value) {
    this._width = Math.max(0, Math.floor(Number(value) || 0));
    this._resizePixels();
  }

  get width() {
    return this._width;
  }

  set height(value) {
    this._height = Math.max(0, Math.floor(Number(value) || 0));
    this._resizePixels();
  }

  get height() {
    return this._height;
  }

  _resizePixels() {
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
  }

  get childElementCount() {
    return this.children.length;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentElement = null;
      child.isConnected = false;
    }
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
    this.isConnected = false;
  }

  getContext() {
    this.context ??= new FakeCanvasContext(this);
    return this.context;
  }

  animate(keyframes, options) {
    animationCalls.push({ element: this, keyframes, options });
    return { finished: Promise.resolve() };
  }

  getBoundingClientRect() {
    return this.rect ?? { left: 10, top: 20, width: 132, height: 76 };
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class FakeRoot extends FakeElement {
  constructor(track, status) {
    super('aside');
    this.isConnected = true;
    this.track = track;
    this.status = status;
    track.isConnected = true;
    status.isConnected = true;
  }

  querySelector(selector) {
    if (selector === '[data-scan-track]') return this.track;
    if (selector === '[data-scan-status]') return this.status;
    return null;
  }
}

globalThis.CustomEvent = class {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

const body = new FakeElement('body');
body.isConnected = true;
globalThis.document = {
  body,
  querySelector: () => null,
  createElement: (tagName) => new FakeElement(tagName),
};

const track = new FakeElement('div');
const status = new FakeElement('span');
const root = new FakeRoot(track, status);
const events = [];
const mountedCounts = [];
const overlapEvents = [];
for (const type of [
  'scan-tray:stage',
  'scan-tray:pair-overlap',
  'scan-tray:mask-flash',
  'scan-tray:transfer-start',
  'scan-tray:transfer-complete',
  'scan-tray:removed',
]) {
  root.addEventListener(type, (event) => {
    events.push(`${type}:${event.detail.phase ?? ''}`);
    mountedCounts.push(track.childElementCount);
    if (type === 'scan-tray:pair-overlap') overlapEvents.push(event.detail);
  });
}

const tray = new ScanTray(root, {
  getFusionTarget: () => ({ left: 500, top: 100, width: 220, height: 160 }),
  viewHoldMs: 0,
  maskHoldMs: 0,
  skipHoldMs: 0,
});
const frame = makeRgbFrame(132, 76, [24, 96, 180, 255]);
const nextFrame = makeRgbFrame(132, 76, [180, 70, 32, 255]);
const mask = new Uint8Array([0, 1, 1, 0]);

tray.begin({ id: 'scan-1', total: 2 });
tray.rendered({ id: 'view-1', label: 'Right side', canvas: frame });
tray.rendered({ id: 'view-2', label: 'Left side', canvas: nextFrame });

assert.equal(track.childElementCount, 1, 'only the FIFO head may be mounted');
assert.deepEqual(
  tray.snapshot().queued.map(({ id, presented }) => [id, presented]),
  [['view-1', true], ['view-2', false]],
  'waiting views stay as data records rather than hidden DOM cards',
);
const firstPair = track.children[0];
const sourceCard = firstPair.children[0];
const maskCard = firstPair.children[1];
const sourceCanvas = sourceCard.children[0];
const maskCanvas = maskCard.children[1];
sourceCard.rect = { left: 10, top: 20, width: 132, height: 76 };
maskCard.rect = { left: 154, top: 20, width: 132, height: 76 };
assert.equal(maskCard.hidden, true, 'RGB view appears alone before its mask');
assert.deepEqual(
  [...pixelAt(sourceCanvas, 40, 20)],
  [24, 96, 180, 255],
  'rendered() snapshots the exact non-black staged RGB pixels',
);
assert.equal(
  frame.readbackCalls,
  0,
  'thumbnail snapshot never reads or allocates the native frame pixel buffer',
);
assert.equal(
  sourceCanvas.pixels.byteLength,
  132 * 76 * 4,
  'the mounted RGB evidence stays bounded to the fixed thumbnail size',
);
frame.pixels.fill(0);
assert.deepEqual(
  [...pixelAt(sourceCanvas, 40, 20)],
  [24, 96, 180, 255],
  'the tray snapshot is independent from later source-canvas reuse',
);
assert.deepEqual(
  sourceCard.children[1].children.map((child) => child.textContent),
  ['view'],
  'the RGB caption stays plain',
);
assert.deepEqual(
  maskCard.children[2].children.map((child) => child.textContent),
  ['mask'],
  'the mask caption stays plain',
);

assert.throws(
  () => tray.tracked({
    id: 'view-1',
    mask: new Uint8Array(3),
    maskW: 2,
    maskH: 2,
  }),
  /exact dimensions/,
  'tracked() rejects a partial or placeholder mask',
);

tray.tracked({
  id: 'view-1',
  label: 'Right side',
  mask,
  maskW: 2,
  maskH: 2,
  accepted: false,
});
mask.fill(0);
await waitFor(() => tray.snapshot().queued[0]?.maskVisible);
assert.equal(track.childElementCount, 1, 'revealing the mask does not rebuild the tray');
assert.equal(maskCard.hidden, false, 'the propagated mask appears beside its RGB view');
assert.equal(pixelAt(maskCanvas, 20, 12)[3], 0, 'mask pixel 0 remains transparent');
assert.deepEqual(
  [...pixelAt(maskCanvas, 110, 12)],
  [112, 215, 255, 186],
  'top-right propagated mask pixel maps to the top-right thumbnail quadrant',
);
assert.deepEqual(
  [...pixelAt(maskCanvas, 20, 64)],
  [112, 215, 255, 186],
  'bottom-left propagated mask pixel maps to the bottom-left thumbnail quadrant',
);
assert.equal(pixelAt(maskCanvas, 110, 64)[3], 0, 'bottom-right mask pixel 0 remains transparent');

tray.fuse({ id: 'view-1', added: 42 });
await waitFor(() => tray.snapshot().queued[0]?.id === 'view-2');
assert.equal(track.childElementCount, 1, 'next FIFO item replaces the completed item one-for-one');
assert.deepEqual(
  tray.snapshot().queued.map(({ id, presented }) => [id, presented]),
  [['view-2', true]],
);
assert.deepEqual(
  [...pixelAt(maskCanvas, 110, 12)],
  [112, 215, 255, 186],
  'acceptance recolors the same real mask before its flashes',
);

assert.deepEqual(events, [
  'scan-tray:stage:view',
  'scan-tray:stage:mask',
  'scan-tray:stage:overlap',
  'scan-tray:pair-overlap:start',
  'scan-tray:pair-overlap:complete',
  'scan-tray:stage:confirm',
  'scan-tray:mask-flash:start',
  'scan-tray:mask-flash:complete',
  'scan-tray:stage:transfer',
  'scan-tray:transfer-start:',
  'scan-tray:transfer-complete:',
  'scan-tray:removed:',
  'scan-tray:stage:view',
], 'RGB, mask, overlap, flashes, transfer, removal, and next RGB stay ordered');
assert.ok(
  mountedCounts.every((count) => count <= 1),
  'no event observes more than one mounted FIFO item',
);
assert.deepEqual(
  overlapEvents.map(({ phase, overlap }) => ({ phase, overlap })),
  [
    {
      phase: 'start',
      overlap: { sourceX: 72, sourceY: 0, maskX: -72, maskY: 0 },
    },
    {
      phase: 'complete',
      overlap: { sourceX: 72, sourceY: 0, maskX: -72, maskY: 0 },
    },
  ],
  'measured card centers land on the same point before flashes begin',
);
assert.deepEqual(
  computePairOverlap(null, null, 104, 16),
  { sourceX: 60, sourceY: 0, maskX: -60, maskY: 0 },
  'zero-layout environments use card width plus gap as a safe overlap fallback',
);

const flash = animationCalls.find(({ element }) => element === maskCanvas);
assert.ok(flash, 'accepted mask receives a visible flash animation');
assert.equal(
  flash.keyframes.filter(({ filter = '' }) => filter.includes('brightness(1.9)')).length,
  2,
  'accepted mask has exactly two flash peaks',
);
const sourceOverlap = animationCalls.find(({ element }) => element === sourceCard);
const maskOverlap = animationCalls.find(({ element }) => element === maskCard);
assert.equal(sourceOverlap.keyframes.at(-1).transform, 'translate3d(72px,0px,0)');
assert.equal(maskOverlap.keyframes.at(-1).transform, 'translate3d(-72px,0px,0)');

console.log('scan tray FIFO, RGB snapshot, and exact mask mapping tests passed');

function makeRgbFrame(width, height, rgba) {
  const canvas = new FakeElement('canvas');
  canvas.width = width;
  canvas.height = height;
  for (let index = 0; index < width * height; index++) {
    canvas.pixels.set(rgba, index * 4);
  }
  return canvas;
}

function pixelAt(canvas, x, y) {
  const index = (y * canvas.width + x) * 4;
  return canvas.pixels.subarray(index, index + 4);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for scan tray transition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
