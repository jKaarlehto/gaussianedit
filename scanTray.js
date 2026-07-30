const THUMBNAIL_WIDTH = 132;
const THUMBNAIL_HEIGHT = 76;
const DEFAULT_VIEW_HOLD_MS = 480;
const DEFAULT_MASK_HOLD_MS = 620;
const DEFAULT_SKIP_HOLD_MS = 360;

/**
 * Stable FIFO visualization for the synthetic-view pipeline.
 *
 * Public lifecycle:
 *   begin -> rendered -> tracked -> fuse|skipped -> finish
 *
 * A rendered view is appended exactly once. Later calls mutate that same card;
 * cards are never rebuilt. A fused item must reach the head of the queue, show
 * its tracked mask for a short hold, complete its particle transfer, and only
 * then leave the tray.
 *
 * Events dispatched from `root`:
 *   scan-tray:stage
 *   scan-tray:rendered
 *   scan-tray:tracked
 *   scan-tray:pair-overlap
 *   scan-tray:mask-flash
 *   scan-tray:transfer-start
 *   scan-tray:transfer-complete
 *   scan-tray:removed
 */
export class ScanTray {
  constructor(root, {
    getFusionTarget = () => null,
    viewHoldMs = DEFAULT_VIEW_HOLD_MS,
    maskHoldMs = DEFAULT_MASK_HOLD_MS,
    skipHoldMs = DEFAULT_SKIP_HOLD_MS,
  } = {}) {
    if (!root) throw new Error('ScanTray requires a root element.');
    this.root = root;
    this.track = root.querySelector('[data-scan-track]');
    this.status = root.querySelector('[data-scan-status]');
    this.getFusionTarget = getFusionTarget;
    this.viewHoldMs = Math.max(0, viewHoldMs);
    this.maskHoldMs = Math.max(0, maskHoldMs);
    this.skipHoldMs = Math.max(0, skipHoldMs);
    this.records = new Map();
    this.order = [];
    this.total = 0;
    this.completed = 0;
    this.renderedCount = 0;
    this.sessionId = null;
    this.finishRequested = false;
    this.transferActive = false;
    this.generation = 0;
    this.hideTimer = 0;
    this.drainTimer = 0;
    this.revealTimer = 0;
    this.statusText = '';
    this.particleLayer = findOrCreateParticleLayer();
  }

  begin({ id, total }) {
    this._clearTimers();
    this.generation++;
    this.sessionId = id;
    this.total = Math.max(1, Number(total) || 1);
    this.completed = 0;
    this.renderedCount = 0;
    this.finishRequested = false;
    this.transferActive = false;
    this.records.clear();
    this.order.length = 0;
    this.track.replaceChildren();
    this.particleLayer.replaceChildren();
    this.root.hidden = false;
    this._setState('rendering');
    this.root.dataset.stage = 'views';
    this._setStatus('Generating views', 0);
  }

  rendered({ id, label, canvas }) {
    if (!this.sessionId || !canvas) return;
    const record = this._record(id, label);
    if (!record.rendered) {
      record.frame = createThumbnail(canvas);
      record.rendered = true;
      record.renderedAt = performance.now();
      record.queued = true;
      this.order.push(record.id);
      this.renderedCount++;
    }
    this._setState('rendering');
    this._setStatus('Generating views', this.renderedCount);
    this._presentHead();
    this._dispatch('scan-tray:rendered', record);
    this._drain();
  }

  tracked({ id, label, mask, maskW, maskH, accepted = true }) {
    if (!this.sessionId) return;
    const record = this.records.get(String(id));
    // The tray visualizes real rendered frames only. Never manufacture an
    // empty card when an inference callback arrives out of order.
    if (!record?.rendered) return;
    if (label) record.label = label;
    record.maskData = { mask, maskW, maskH };
    record.accepted = Boolean(accepted);
    record.tracked = true;
    record.trackedAt = performance.now();
    this._applyVisualState(record);
    this._setState(record.accepted ? 'tracking' : 'review');
    this._setStatus(record.accepted ? 'Following the object' : 'One view needs a check', this.completed);
    this._dispatch('scan-tray:tracked', record);
    this._scheduleMaskReveal(record);
    this._drain();
  }

  trackingProgress({ processed = 0, target = 0, total = this.total } = {}) {
    if (!this.sessionId) return;
    this._setState('tracking');
    const current = Math.max(0, Math.min(total, processed));
    const destination = Math.max(current, Math.min(total, target || total));
    this._writeStatus(destination < total
      ? `SAM 3 · frame ${current} / ${destination} now · ${total} in this path`
      : `SAM 3 · frame ${current} / ${total}`);
  }

  fuse({ id, added = 0 }) {
    if (!this.sessionId) return;
    const record = this.records.get(String(id));
    if (!record?.rendered) return;
    record.added = Math.max(0, Number(added) || 0);
    record.terminal = 'fuse';
    record.terminalAt = performance.now();
    this._countCompleted(record);
    this._applyVisualState(record);
    this._setState('fusing');
    this._setStatus('Updating the 3D object', this.completed);
    this._drain();
  }

  skipped({ id, reason = 'not used' }) {
    if (!this.sessionId) return;
    const record = this.records.get(String(id));
    if (!record?.rendered) return;
    record.reason = reason;
    record.terminal = 'skip';
    record.terminalAt = performance.now();
    this._countCompleted(record);
    this._applyVisualState(record);
    this._setStatus('Checking remaining views', this.completed);
    this._drain();
  }

  finish({ label = 'All sides checked' } = {}) {
    this.finishRequested = true;
    this.finishLabel = label;
    this._maybeFinish();
  }

  cancel() {
    this._clearTimers();
    this.generation++;
    this.root.hidden = true;
    this._setState('idle');
    this.track.replaceChildren();
    this.particleLayer.replaceChildren();
    this.records.clear();
    this.order.length = 0;
    this.sessionId = null;
    this.finishRequested = false;
    this.transferActive = false;
  }

  destroy() {
    this.cancel();
    this.particleLayer.remove();
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      total: this.total,
      rendered: this.renderedCount,
      completed: this.completed,
      queued: this.order
        .map((key) => this.records.get(key))
        .filter(Boolean)
        .map((record) => ({
          id: record.id,
          rendered: record.rendered,
          tracked: record.tracked,
          terminal: record.terminal,
          transferring: record.transferring,
          presented: Boolean(record.element),
          maskVisible: record.maskVisible,
        })),
    };
  }

  _record(id, label = 'View') {
    const key = String(id);
    let record = this.records.get(key);
    if (record) {
      if (label) record.label = label;
      return record;
    }
    record = {
      id: key,
      label,
      element: null,
      sourceCard: null,
      maskCard: null,
      image: null,
      maskImage: null,
      mask: null,
      viewStage: null,
      maskStage: null,
      maskData: null,
      frame: null,
      rendered: false,
      queued: false,
      tracked: false,
      maskVisible: false,
      accepted: true,
      terminal: null,
      counted: false,
      transferring: false,
      removed: false,
      added: 0,
      reason: '',
      renderedAt: 0,
      trackedAt: 0,
      presentedAt: 0,
      maskShownAt: 0,
      terminalAt: 0,
    };
    this.records.set(key, record);
    return record;
  }

  _mount(record) {
    // Hard UI invariant: the tray is one FIFO transaction, never a gallery.
    // Waiting records retain only their 132x76 snapshot and mask data.
    if (this.track.childElementCount || this._mountedRecord()) return;
    const element = document.createElement('section');
    element.className = 'scan-view-pair';
    element.dataset.state = 'rendered';

    const sourceCard = document.createElement('article');
    sourceCard.className = 'scan-view-card scan-view-source';
    const image = document.createElement('canvas');
    image.width = THUMBNAIL_WIDTH;
    image.height = THUMBNAIL_HEIGHT;
    image.className = 'scan-view-image';
    const viewCaption = document.createElement('div');
    const viewName = document.createElement('b');
    const viewStage = document.createElement('span');
    viewName.textContent = conciseLabel(record.label);
    viewStage.textContent = 'view';
    viewCaption.append(viewName, viewStage);
    sourceCard.append(image, viewCaption);

    const maskCard = document.createElement('article');
    maskCard.className = 'scan-view-card scan-view-result';
    maskCard.hidden = true;
    const maskImage = document.createElement('canvas');
    const mask = document.createElement('canvas');
    maskImage.width = mask.width = THUMBNAIL_WIDTH;
    maskImage.height = mask.height = THUMBNAIL_HEIGHT;
    maskImage.className = 'scan-view-image';
    mask.className = 'scan-view-mask';
    const maskCaption = document.createElement('div');
    const maskName = document.createElement('b');
    const maskStage = document.createElement('span');
    maskName.textContent = conciseLabel(record.label);
    maskStage.textContent = 'mask';
    maskCaption.append(maskName, maskStage);
    maskCard.append(maskImage, mask, maskCaption);

    element.append(sourceCard, maskCard);
    this.track.append(element);
    record.element = element;
    record.sourceCard = sourceCard;
    record.maskCard = maskCard;
    record.image = image;
    record.maskImage = maskImage;
    record.mask = mask;
    record.viewStage = viewStage;
    record.maskStage = maskStage;
    record.presentedAt = performance.now();
    drawCover(image, record.frame);
    drawCover(maskImage, record.frame);
    if (record.maskData) {
      const { mask: data, maskW, maskH } = record.maskData;
      drawMask(mask, data, maskW, maskH, record.accepted);
    }
    this._applyVisualState(record);
    this._setStage('view', record);
    this._scheduleMaskReveal(record);
  }

  _applyVisualState(record) {
    if (!record.element) return;
    let state = 'rendered';
    let viewStage = 'view';
    let maskStage = 'mask';
    if (record.terminal === 'skip') {
      state = 'skipped';
      maskStage = record.reason || 'not used';
    } else if (record.transferring) {
      state = 'transferring';
      maskStage = record.added
        ? `adding ${record.added.toLocaleString()}`
        : 'updating 3D';
    } else if (record.terminal === 'fuse') {
      state = 'transfer-ready';
      maskStage = record.added
        ? `+${record.added.toLocaleString()} ready`
        : 'ready to add';
    } else if (record.tracked && record.maskVisible) {
      state = record.accepted ? 'tracked' : 'uncertain';
      maskStage = record.accepted ? 'mask ready' : 'check needed';
    }
    if (record.element.dataset.state !== state) record.element.dataset.state = state;
    if (record.viewStage.textContent !== viewStage) record.viewStage.textContent = viewStage;
    if (record.maskStage.textContent !== maskStage) record.maskStage.textContent = maskStage;
  }

  _countCompleted(record) {
    if (record.counted) return;
    record.counted = true;
    this.completed++;
  }

  _head() {
    while (this.order.length) {
      const record = this.records.get(this.order[0]);
      if (record && !record.removed) return record;
      this.order.shift();
    }
    return null;
  }

  _mountedRecord() {
    const record = this._head();
    return record?.element?.isConnected === false ? null : record?.element ? record : null;
  }

  _presentHead() {
    const record = this._head();
    if (!record?.rendered || record.element || this.track.childElementCount) return;
    this._mount(record);
  }

  _scheduleMaskReveal(record) {
    if (record !== this._head() || !record.element || !record.tracked || record.maskVisible) return;
    clearTimeout(this.revealTimer);
    const remaining = Math.max(
      0,
      this.viewHoldMs - (performance.now() - record.presentedAt),
    );
    const generation = this.generation;
    this.revealTimer = setTimeout(() => {
      this.revealTimer = 0;
      if (generation !== this.generation || record !== this._head()) return;
      this._revealMask(record);
    }, remaining);
  }

  _revealMask(record) {
    if (!record.element || !record.maskData || record.maskVisible) return;
    const { mask, maskW, maskH } = record.maskData;
    drawMask(record.mask, mask, maskW, maskH, record.accepted);
    record.maskVisible = true;
    record.maskShownAt = performance.now();
    record.maskCard.hidden = false;
    this._applyVisualState(record);
    this._setStage('mask', record);
    this._drain();
  }

  _drain() {
    clearTimeout(this.drainTimer);
    this.drainTimer = 0;
    if (this.transferActive) return;
    const record = this._head();
    if (!record?.terminal || !record.element) {
      this._maybeFinish();
      return;
    }
    if (record.terminal === 'fuse' && (
      !record.tracked
      || !record.maskData?.mask
      || !record.maskVisible
    )) {
      this._scheduleMaskReveal(record);
      return;
    }
    const holdMs = record.terminal === 'fuse' ? this.maskHoldMs : this.skipHoldMs;
    const shownAt = record.terminal === 'fuse'
      ? record.maskShownAt
      : record.terminalAt;
    const remaining = Math.max(0, holdMs - (performance.now() - shownAt));
    if (remaining > 0) {
      const generation = this.generation;
      this.drainTimer = setTimeout(() => {
        if (generation === this.generation) this._drain();
      }, remaining);
      return;
    }
    void this._releaseHead(record);
  }

  async _releaseHead(record) {
    const generation = this.generation;
    this.transferActive = true;
    record.transferring = true;
    this._applyVisualState(record);

    if (record.terminal === 'fuse') {
      this._setStage('overlap', record);
      this._dispatch('scan-tray:pair-overlap', record, { phase: 'start' });
      await animatePairOverlap(record);
      if (generation !== this.generation) return;
      this._dispatch('scan-tray:pair-overlap', record, { phase: 'complete' });

      this._setStage('confirm', record);
      this._dispatch('scan-tray:mask-flash', record, { phase: 'start', flashes: 2 });
      await flashMaskTwice(record.mask);
      if (generation !== this.generation) return;
      this._dispatch('scan-tray:mask-flash', record, { phase: 'complete', flashes: 2 });

      this._setStage('transfer', record);
      const geometry = this._transferGeometry(record);
      this._dispatch('scan-tray:transfer-start', record, geometry);
      await Promise.all([
        this._emitMaskParticles(record, geometry),
        animateCardRelease(record.element, 880),
      ]);
      if (generation !== this.generation) return;
      this._dispatch('scan-tray:transfer-complete', record, geometry);
    } else {
      await animateCardRelease(record.element, 280, true);
      if (generation !== this.generation) return;
    }

    record.removed = true;
    record.element.remove();
    record.element = null;
    record.frame = null;
    record.maskData = null;
    this.records.delete(record.id);
    if (this.order[0] === record.id) this.order.shift();
    this.transferActive = false;
    this._dispatch('scan-tray:removed', record);
    const next = this._head();
    if (next) this._presentHead();
    this._drain();
  }

  _setStatus(label, complete) {
    this._writeStatus(`${label} · ${Math.min(this.total, complete)} / ${this.total}`);
  }

  _writeStatus(next) {
    if (this.statusText === next) return;
    this.statusText = next;
    this.status.textContent = next;
  }

  _setState(next) {
    if (this.root.dataset.state !== next) this.root.dataset.state = next;
  }

  _transferGeometry(record) {
    const source = record.maskCard?.getBoundingClientRect();
    const targetValue = this.getFusionTarget?.();
    const target = targetValue?.getBoundingClientRect
      ? targetValue.getBoundingClientRect()
      : targetValue;
    return {
      source: usableRect(source) ? source : null,
      target: usableRect(target) ? target : null,
    };
  }

  async _emitMaskParticles(record, geometry) {
    const { source, target } = geometry;
    const data = record.maskData;
    if (!source || !target || !data?.mask?.length || !data.maskW || !data.maskH) return;
    const { mask, maskW, maskH } = data;
    const selected = [];
    const stride = Math.max(1, Math.floor(mask.length / 1000));
    for (let index = 0; index < mask.length; index += stride) {
      if (mask[index]) selected.push(index);
    }
    if (!selected.length) return;

    const count = Math.min(36, selected.length);
    const completions = [];
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const index = selected[Math.floor(ordinal * selected.length / count)];
      const x = index % maskW;
      const y = Math.floor(index / maskW);
      const startX = source.left + (x + 0.5) / maskW * source.width;
      const startY = source.top + (y + 0.5) / maskH * source.height;
      const destinationX = target.left + target.width * (0.36 + pseudo(ordinal * 2) * 0.28);
      const destinationY = target.top + target.height * (0.31 + pseudo(ordinal * 2 + 1) * 0.38);
      const particle = document.createElement('i');
      particle.style.left = `${startX}px`;
      particle.style.top = `${startY}px`;
      this.particleLayer.append(particle);
      const delay = ordinal * 10;
      const animation = particle.animate([
        { transform: 'translate3d(0,0,0) scale(.65)', opacity: 0 },
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 0.9, offset: 0.14 },
        {
          transform: `translate3d(${destinationX - startX}px,${destinationY - startY}px,0) scale(.3)`,
          opacity: 0,
        },
      ], {
        duration: 690 + pseudo(ordinal + 9) * 210,
        delay,
        easing: 'cubic-bezier(.22,.72,.25,1)',
        fill: 'forwards',
      });
      completions.push(animation.finished.catch(() => {}).finally(() => particle.remove()));
    }
    await Promise.all(completions);
  }

  _dispatch(type, record, geometry = {}) {
    this.root.dispatchEvent(new CustomEvent(type, {
      bubbles: true,
      detail: {
        sessionId: this.sessionId,
        id: record.id,
        label: record.label,
        added: record.added,
        accepted: record.accepted,
        sourceRect: plainRect(geometry.source),
        targetRect: plainRect(geometry.target),
        phase: geometry.phase ?? null,
        flashes: geometry.flashes ?? null,
      },
    }));
  }

  _setStage(stage, record) {
    if (this.root.dataset.stage === stage && this.root.dataset.viewId === record.id) return;
    this.root.dataset.stage = stage;
    this.root.dataset.viewId = record.id;
    this._dispatch('scan-tray:stage', record, { phase: stage });
  }

  _maybeFinish() {
    if (!this.finishRequested || this.transferActive || this._head()) return;
    this._setState('complete');
    this._setStatus(this.finishLabel || 'All sides checked', this.total);
    clearTimeout(this.hideTimer);
    const generation = this.generation;
    this.hideTimer = setTimeout(() => {
      if (generation !== this.generation || this._head()) return;
      this.root.hidden = true;
      this.sessionId = null;
    }, 1200);
  }

  _clearTimers() {
    clearTimeout(this.hideTimer);
    clearTimeout(this.drainTimer);
    clearTimeout(this.revealTimer);
    this.hideTimer = 0;
    this.drainTimer = 0;
    this.revealTimer = 0;
  }
}

function findOrCreateParticleLayer() {
  const existing = document.querySelector('[data-scan-particle-layer]');
  if (existing) return existing;
  const layer = document.createElement('div');
  layer.className = 'scan-particle-layer';
  layer.dataset.scanParticleLayer = '';
  document.body.append(layer);
  return layer;
}

async function animatePairOverlap(record) {
  if (!record.sourceCard?.animate || !record.maskCard?.animate) return;
  record.element.dataset.choreography = 'overlap';
  const duration = 460;
  const sourceAnimation = record.sourceCard.animate([
    { transform: 'translate3d(0,0,0)', filter: 'brightness(1)' },
    { transform: 'translate3d(24px,0,0)', filter: 'brightness(.78)' },
  ], {
    duration,
    easing: 'cubic-bezier(.2,.72,.25,1)',
    fill: 'forwards',
  });
  const maskAnimation = record.maskCard.animate([
    { transform: 'translate3d(0,0,0)', filter: 'brightness(1)' },
    { transform: 'translate3d(-24px,0,0)', filter: 'brightness(1.16)' },
  ], {
    duration,
    easing: 'cubic-bezier(.2,.72,.25,1)',
    fill: 'forwards',
  });
  await Promise.all([
    sourceAnimation.finished.catch(() => {}),
    maskAnimation.finished.catch(() => {}),
  ]);
}

async function flashMaskTwice(mask) {
  if (!mask?.animate) return;
  const animation = mask.animate([
    { opacity: 0.72, filter: 'drop-shadow(0 0 3px #70d7ff)' },
    { opacity: 1, filter: 'brightness(1.9) drop-shadow(0 0 9px #a9f8ff)', offset: 0.14 },
    { opacity: 0.72, filter: 'drop-shadow(0 0 3px #70d7ff)', offset: 0.29 },
    { opacity: 1, filter: 'brightness(1.9) drop-shadow(0 0 9px #a9f8ff)', offset: 0.43 },
    { opacity: 0.72, filter: 'drop-shadow(0 0 3px #70d7ff)', offset: 0.58 },
    { opacity: 0.84, filter: 'drop-shadow(0 0 4px #70d7ff)' },
  ], {
    duration: 680,
    easing: 'ease-in-out',
    fill: 'forwards',
  });
  await animation.finished.catch(() => {});
}

function animateCardRelease(element, duration, skipped = false) {
  if (!element?.animate) return Promise.resolve();
  const animation = element.animate(skipped ? [
    { opacity: 0.35, transform: 'translate3d(0,0,0)' },
    { opacity: 0, transform: 'translate3d(-8px,0,0)' },
  ] : [
    { opacity: 1, transform: 'translate3d(0,0,0)', filter: 'brightness(1)' },
    { opacity: 0.96, transform: 'translate3d(0,2px,0)', filter: 'brightness(1.4)', offset: 0.24 },
    { opacity: 0, transform: 'translate3d(0,8px,0)', filter: 'brightness(.7)' },
  ], {
    duration,
    easing: 'cubic-bezier(.22,.72,.25,1)',
    fill: 'forwards',
  });
  return animation.finished.catch(() => {});
}

function drawCover(target, source) {
  if (!target || !source?.width || !source?.height) return;
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

function createThumbnail(source) {
  const thumbnail = document.createElement('canvas');
  thumbnail.width = THUMBNAIL_WIDTH;
  thumbnail.height = THUMBNAIL_HEIGHT;
  drawCover(thumbnail, source);
  return thumbnail;
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
    image.data[pixel + 3] = 186;
  }
  sourceContext.putImageData(image, 0, 0);
  context.drawImage(source, 0, 0, target.width, target.height);
}

function conciseLabel(label) {
  return String(label || 'View')
    .replace(/\btracking bridge\b/i, 'bridge')
    .replace(/\bscan\b/i, 'side')
    .slice(0, 22);
}

function usableRect(rect) {
  return Boolean(rect?.width > 0 && rect?.height > 0);
}

function plainRect(rect) {
  return rect ? {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  } : null;
}

function pseudo(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
