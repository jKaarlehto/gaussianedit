const THUMBNAIL_WIDTH = 132;
const THUMBNAIL_HEIGHT = 76;
const RGB_LEAD_MS = 180;
const MASK_SETTLE_MS = 320;
const FLASH_MS = 260;
const SKIP_HOLD_MS = 360;
const COMPLETE_HOLD_MS = 900;

/**
 * A compact, truthful view of the background 3D pipeline.
 *
 * Rendered views are retained in a FIFO data queue, but only the active view
 * is mounted. Its real RGB capture appears first, followed by the real tracked
 * mask. Accepted masks flash twice and transfer only after fuse() confirms
 * that the proposal was incorporated into the Gaussian selection.
 */
export class ScanTray {
  constructor(root, {
    getFusionTarget = () => null,
  } = {}) {
    this.root = root;
    this.track = root.querySelector('[data-scan-track]');
    this.status = root.querySelector('[data-scan-status]');
    this.getFusionTarget = getFusionTarget;
    this.cards = new Map();
    this.queue = [];
    this.active = null;
    this.total = 0;
    this.completed = 0;
    this.renderedCount = 0;
    this.sessionId = null;
    this.finishLabel = null;
    this.hideTimer = 0;
    this.timers = new Set();
    this.particleLayer = document.createElement('div');
    this.particleLayer.className = 'scan-particle-layer';
    document.body.append(this.particleLayer);
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  }

  begin({ id, total }) {
    this._clearTimers();
    this.sessionId = id;
    this.total = Math.max(1, total || 1);
    this.completed = 0;
    this.renderedCount = 0;
    this.finishLabel = null;
    this.cards.clear();
    this.queue.length = 0;
    this.active = null;
    this.track.replaceChildren();
    this.particleLayer.replaceChildren();
    this.root.hidden = false;
    this.root.dataset.state = 'rendering';
    this._setStatus('Generating views', 0);
  }

  rendered({ id, label, canvas }) {
    if (!this.sessionId || !canvas) return;
    const card = this._entry(id, label);
    if (!card.image) {
      card.image = document.createElement('canvas');
      card.image.width = THUMBNAIL_WIDTH;
      card.image.height = THUMBNAIL_HEIGHT;
      card.image.className = 'scan-view-image';
      this.renderedCount++;
      this.queue.push(card);
    }
    drawCover(card.image, canvas);
    card.rendered = true;
    this.root.dataset.state = 'rendering';
    this._setStatus('Generating views', this.renderedCount);
    this._activateNext();
  }

  tracked({ id, label, mask, maskW, maskH, accepted = true }) {
    const card = this._entry(id, label);
    card.maskData = copyMask(mask, maskW, maskH);
    card.trackerAccepted = accepted;
    if (card === this.active) this._revealMask(card);
  }

  trackingProgress({ processed = 0, target = 0, total = this.total } = {}) {
    this.root.dataset.state = 'tracking';
    const current = Math.max(0, Math.min(total, processed));
    const destination = Math.max(current, Math.min(total, target || total));
    this.status.textContent = destination < total
      ? `SAM 3 · frame ${current} / ${destination} now · ${total} in this path`
      : `SAM 3 · frame ${current} / ${total}`;
  }

  fuse({ id, added = 0 }) {
    const card = this.cards.get(String(id));
    if (!card || card.outcome) return;
    card.outcome = 'fused';
    card.added = added;
    this.completed++;
    this._advanceActive(card);
  }

  skipped({ id, reason = 'not used' }) {
    const card = this.cards.get(String(id));
    if (!card || card.outcome) return;
    card.outcome = 'skipped';
    card.skipReason = reason;
    this.completed++;
    this._advanceActive(card);
  }

  finish({ label = 'All sides checked' } = {}) {
    this.finishLabel = label;
    this._finishIfDrained();
  }

  cancel() {
    this._clearTimers();
    this.root.hidden = true;
    this.root.dataset.state = 'idle';
    this.track.replaceChildren();
    this.particleLayer.replaceChildren();
    this.cards.clear();
    this.queue.length = 0;
    this.active = null;
    this.sessionId = null;
    this.finishLabel = null;
  }

  _entry(id, label = 'View') {
    const key = String(id);
    let card = this.cards.get(key);
    if (card) {
      card.label = conciseLabel(label || card.label);
      return card;
    }
    card = {
      id: key,
      label: conciseLabel(label),
      image: null,
      mask: null,
      maskFrame: null,
      maskData: null,
      trackerAccepted: false,
      rendered: false,
      outcome: null,
      added: 0,
      skipReason: '',
      activatedAt: 0,
      revealPromise: null,
      advancing: false,
      element: null,
      stage: null,
    };
    this.cards.set(key, card);
    return card;
  }

  _activateNext() {
    if (this.active) return;
    const card = this.queue.shift();
    if (!card) {
      this._finishIfDrained();
      return;
    }
    this.active = card;
    card.activatedAt = performance.now();

    const element = document.createElement('article');
    element.className = 'scan-view-card';
    element.dataset.state = 'rendered';

    const pair = document.createElement('div');
    pair.className = 'scan-view-pair';
    const imageFrame = document.createElement('div');
    imageFrame.className = 'scan-view-frame scan-view-rgb';
    imageFrame.append(card.image);
    pair.append(imageFrame);

    const caption = document.createElement('div');
    caption.className = 'scan-view-caption';
    const name = document.createElement('b');
    const stage = document.createElement('span');
    name.textContent = card.label;
    stage.textContent = 'view ready';
    caption.append(name, stage);
    element.append(pair, caption);
    card.element = element;
    card.pair = pair;
    card.stage = stage;
    this.track.replaceChildren(element);
    this.root.dataset.state = 'rendering';
    this._setStatus('View ready', this.completed);

    if (card.maskData) this._revealMask(card);
    this._advanceActive(card);
  }

  _revealMask(card) {
    if (card !== this.active || !card.element || !card.maskData) {
      return Promise.resolve();
    }
    if (card.revealPromise) return card.revealPromise;

    card.revealPromise = (async () => {
      const elapsed = performance.now() - card.activatedAt;
      await this._delay(Math.max(0, this._duration(RGB_LEAD_MS) - elapsed));
      if (card !== this.active || !card.element) return;

      const mask = document.createElement('canvas');
      mask.width = THUMBNAIL_WIDTH;
      mask.height = THUMBNAIL_HEIGHT;
      mask.className = 'scan-view-mask';
      drawMask(
        mask,
        card.maskData.mask,
        card.maskData.maskW,
        card.maskData.maskH,
        card.trackerAccepted,
      );
      const maskFrame = document.createElement('div');
      maskFrame.className = 'scan-view-frame scan-view-mask-frame';
      maskFrame.append(mask);
      card.mask = mask;
      card.maskFrame = maskFrame;
      card.pair.append(maskFrame);
      card.element.dataset.state = card.trackerAccepted ? 'tracked' : 'uncertain';
      card.stage.textContent = card.trackerAccepted ? 'mask ready' : 'check needed';
      this.root.dataset.state = card.trackerAccepted ? 'tracking' : 'review';
      this._setStatus(
        card.trackerAccepted ? 'Following the object' : 'One view needs a check',
        this.completed,
      );
      await this._delay(this._duration(MASK_SETTLE_MS));
    })();
    card.revealPromise.finally(() => this._advanceActive(card));
    return card.revealPromise;
  }

  async _advanceActive(card) {
    if (card !== this.active || card.advancing || !card.outcome) return;
    if (card.outcome === 'fused' && !card.maskData) return;
    card.advancing = true;
    if (card.maskData) await this._revealMask(card);
    if (card !== this.active || !card.element) return;

    if (card.outcome === 'fused') {
      card.element.dataset.state = 'accepted';
      card.stage.textContent = card.added
        ? `+${Number(card.added).toLocaleString()} splats`
        : 'accepted';
      this.root.dataset.state = 'fusing';
      this._setStatus('Accepted mask', this.completed);
      await this._flashAcceptedMask(card);
      if (card !== this.active || !card.element) return;
      card.element.dataset.state = 'fusing';
      card.stage.textContent = 'transferring';
      this._setStatus('Fusing into 3D', this.completed);
      await this._emitMaskParticles(card);
    } else {
      card.element.dataset.state = 'skipped';
      card.stage.textContent = card.skipReason;
      this._setStatus('Checking remaining views', this.completed);
      await this._delay(this._duration(SKIP_HOLD_MS));
    }

    if (card !== this.active) return;
    card.element.remove();
    this.cards.delete(card.id);
    this.active = null;
    this._activateNext();
  }

  async _flashAcceptedMask(card) {
    if (!card.maskFrame) return;
    const animation = card.maskFrame.animate([
      { opacity: 0.72, filter: 'brightness(1)' },
      { opacity: 1, filter: 'brightness(1.8) drop-shadow(0 0 9px #70d7ff)' },
      { opacity: 0.72, filter: 'brightness(1)' },
    ], {
      duration: this._duration(FLASH_MS),
      iterations: 2,
      easing: 'ease-in-out',
    });
    await animation.finished.catch(() => {});
  }

  async _emitMaskParticles(card) {
    const target = this.getFusionTarget?.();
    const source = card.mask?.getBoundingClientRect();
    if (!target?.width || !source?.width || !card.maskData?.mask) return;
    const { mask, maskW, maskH } = card.maskData;
    const selected = [];
    const stride = Math.max(1, Math.floor(mask.length / 900));
    for (let index = 0; index < mask.length; index += stride) {
      if (mask[index]) selected.push(index);
    }
    if (!selected.length) return;

    const reduced = this.reduceMotion?.matches;
    const count = Math.min(reduced ? 12 : 30, selected.length);
    const transfers = [];
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const index = selected[Math.floor(ordinal * selected.length / count)];
      const x = index % maskW;
      const y = Math.floor(index / maskW);
      const startX = source.left + (x + 0.5) / maskW * source.width;
      const startY = source.top + (y + 0.5) / maskH * source.height;
      const destinationX = target.left + target.width * (0.38 + pseudo(ordinal * 2) * 0.24);
      const destinationY = target.top + target.height * (0.34 + pseudo(ordinal * 2 + 1) * 0.34);
      const particle = document.createElement('i');
      particle.style.left = `${startX}px`;
      particle.style.top = `${startY}px`;
      this.particleLayer.append(particle);
      const delay = ordinal * (reduced ? 3 : 12);
      const animation = particle.animate([
        { transform: 'translate3d(0,0,0) scale(.7)', opacity: 0 },
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 0.86, offset: 0.16 },
        {
          transform: `translate3d(${destinationX - startX}px,${destinationY - startY}px,0) scale(.35)`,
          opacity: 0,
        },
      ], {
        duration: reduced ? 180 : 760 + pseudo(ordinal + 9) * 260,
        delay,
        easing: 'cubic-bezier(.22,.72,.25,1)',
        fill: 'forwards',
      });
      transfers.push(animation.finished.catch(() => {}).finally(() => particle.remove()));
    }
    await Promise.all(transfers);
  }

  _setStatus(label, complete) {
    this.status.textContent = `${label} · ${Math.min(this.total, complete)} / ${this.total}`;
  }

  _finishIfDrained() {
    if (!this.finishLabel || this.active || this.queue.length) return;
    this.root.dataset.state = 'complete';
    this._setStatus(this.finishLabel, this.total);
    clearTimeout(this.hideTimer);
    this.hideTimer = this._setTimer(() => {
      if (this.active || this.queue.length) return;
      this.root.hidden = true;
      this.sessionId = null;
      this.finishLabel = null;
    }, this._duration(COMPLETE_HOLD_MS));
  }

  _duration(milliseconds) {
    return this.reduceMotion?.matches ? Math.min(milliseconds, 90) : milliseconds;
  }

  _delay(milliseconds) {
    return new Promise((resolve) => {
      this._setTimer(resolve, milliseconds);
    });
  }

  _setTimer(callback, milliseconds) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  _clearTimers() {
    clearTimeout(this.hideTimer);
    this.hideTimer = 0;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

function drawCover(target, source) {
  const context = target.getContext('2d');
  context.clearRect(0, 0, target.width, target.height);
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  context.drawImage(
    source,
    (target.width - width) * 0.5,
    (target.height - height) * 0.5,
    width,
    height,
  );
}

function drawMask(target, mask, width, height, accepted) {
  const context = target.getContext('2d');
  context.clearRect(0, 0, target.width, target.height);
  if (!mask?.length || !width || !height) return;
  const source = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const sourceContext = source.getContext('2d');
  const image = sourceContext.createImageData(width, height);
  const color = accepted ? [112, 215, 255] : [242, 193, 78];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const pixel = index * 4;
    image.data[pixel] = color[0];
    image.data[pixel + 1] = color[1];
    image.data[pixel + 2] = color[2];
    image.data[pixel + 3] = 196;
  }
  sourceContext.putImageData(image, 0, 0);
  context.drawImage(source, 0, 0, target.width, target.height);
}

function copyMask(mask, maskW, maskH) {
  if (!mask?.length || !maskW || !maskH) return null;
  return {
    mask: typeof mask.slice === 'function' ? mask.slice() : Uint8Array.from(mask),
    maskW,
    maskH,
  };
}

function conciseLabel(label) {
  return String(label || 'View')
    .replace(/\btracking bridge\b/i, 'bridge')
    .replace(/\bscan\b/i, 'side')
    .slice(0, 22);
}

function pseudo(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
