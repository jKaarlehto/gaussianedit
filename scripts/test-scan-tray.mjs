import assert from 'node:assert/strict';
import { ScanTray } from '../scanTray.js';

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
    this.width = 0;
    this.height = 0;
    this.isConnected = false;
    this.listeners = new Map();
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
    return {
      clearRect() {},
      drawImage() {},
      createImageData: (width, height) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData() {},
    };
  }

  animate() {
    return { finished: Promise.resolve() };
  }

  getBoundingClientRect() {
    return { left: 10, top: 20, width: 132, height: 76 };
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
for (const type of [
  'scan-tray:pair-overlap',
  'scan-tray:mask-flash',
  'scan-tray:transfer-start',
  'scan-tray:transfer-complete',
  'scan-tray:removed',
]) {
  root.addEventListener(type, (event) => events.push(`${type}:${event.detail.phase ?? ''}`));
}

const tray = new ScanTray(root, {
  getFusionTarget: () => ({ left: 500, top: 100, width: 220, height: 160 }),
  viewHoldMs: 0,
  maskHoldMs: 0,
  skipHoldMs: 0,
});
const frame = Object.assign(new FakeElement('canvas'), { width: 640, height: 360 });
const mask = new Uint8Array([0, 1, 1, 0]);

tray.begin({ id: 'scan-1', total: 2 });
tray.rendered({ id: 'view-1', label: 'Right side', canvas: frame });
tray.rendered({ id: 'view-2', label: 'Left side', canvas: frame });

assert.equal(track.childElementCount, 1, 'only the FIFO head may be mounted');
assert.deepEqual(
  tray.snapshot().queued.map(({ id, presented }) => [id, presented]),
  [['view-1', true], ['view-2', false]],
  'waiting views stay as data records rather than hidden DOM cards',
);
assert.equal(track.children[0].children[1].hidden, true, 'RGB view appears before its mask');

tray.tracked({
  id: 'view-1',
  label: 'Right side',
  mask,
  maskW: 2,
  maskH: 2,
});
await waitFor(() => tray.snapshot().queued[0]?.maskVisible);
assert.equal(track.childElementCount, 1, 'revealing the mask does not rebuild the tray');
assert.equal(track.children[0].children[1].hidden, false, 'real mask appears beside RGB');

tray.fuse({ id: 'view-1', added: 42 });
await waitFor(() => tray.snapshot().queued[0]?.id === 'view-2');
assert.equal(track.childElementCount, 1, 'next FIFO item replaces the completed item one-for-one');
assert.deepEqual(
  tray.snapshot().queued.map(({ id, presented }) => [id, presented]),
  [['view-2', true]],
);

assert.deepEqual(events, [
  'scan-tray:pair-overlap:start',
  'scan-tray:pair-overlap:complete',
  'scan-tray:mask-flash:start',
  'scan-tray:mask-flash:complete',
  'scan-tray:transfer-start:',
  'scan-tray:transfer-complete:',
  'scan-tray:removed:',
], 'the visible choreography stays ordered');

console.log('scan tray FIFO test passed');

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for scan tray transition.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
