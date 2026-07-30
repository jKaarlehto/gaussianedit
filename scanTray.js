const THUMBNAIL_WIDTH = 132;
const THUMBNAIL_HEIGHT = 76;

/**
 * A compact, truthful view of the background 3D pipeline.
 *
 * Cards are created only from real rendered views. Their mask layer appears
 * only after the tracker returns one, and particles fly toward the hologram
 * only when that proposal is actually fused into the Gaussian selection.
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
    this.total = 0;
    this.completed = 0;
    this.renderedCount = 0;
    this.sessionId = null;
    this.hideTimer = 0;
    this.particleLayer = document.createElement('div');
    this.particleLayer.className = 'scan-particle-layer';
    document.body.append(this.particleLayer);
  }

  begin({ id, total }) {
    clearTimeout(this.hideTimer);
    this.sessionId = id;
    this.total = Math.max(1, total || 1);
    this.completed = 0;
    this.renderedCount = 0;
    this.cards.clear();
    this.track.replaceChildren();
    this.root.hidden = false;
    this.root.dataset.state = 'rendering';
    this._setStatus('Generating views', 0);
  }

  rendered({ id, label, canvas }) {
    if (!this.sessionId || !canvas) return;
    const card = this._card(id, label);
    drawCover(card.image, canvas);
    if (!card.rendered) {
      card.rendered = true;
      this.renderedCount++;
    }
    card.element.dataset.state = 'rendered';
    card.stage.textContent = 'view ready';
    this.root.dataset.state = 'rendering';
    this._setStatus('Generating views', this.renderedCount);
    card.element.scrollIntoView({ block: 'nearest', inline: 'end' });
  }

  tracked({ id, label, mask, maskW, maskH, accepted = true }) {
    const card = this._card(id, label);
    drawMask(card.mask, mask, maskW, maskH, accepted);
    card.element.dataset.state = accepted ? 'tracked' : 'uncertain';
    card.stage.textContent = accepted ? 'object followed' : 'check needed';
    card.maskData = { mask, maskW, maskH };
    this.root.dataset.state = accepted ? 'tracking' : 'review';
    this._setStatus(accepted ? 'Following the object' : 'One view needs a check', this.completed);
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
    if (!card) return;
    card.element.dataset.state = 'fusing';
    card.stage.textContent = added
      ? `+${Number(added).toLocaleString()} splats`
      : 'checked';
    this.completed++;
    this.root.dataset.state = 'fusing';
    this._setStatus('Fusing into 3D', this.completed);
    this._emitMaskParticles(card);
    setTimeout(() => {
      card.element.remove();
      this.cards.delete(String(id));
    }, 1050);
  }

  skipped({ id, reason = 'not used' }) {
    const card = this.cards.get(String(id));
    if (!card) return;
    card.element.dataset.state = 'skipped';
    card.stage.textContent = reason;
    this.completed++;
    this._setStatus('Checking remaining views', this.completed);
    setTimeout(() => {
      card.element.remove();
      this.cards.delete(String(id));
    }, 850);
  }

  finish({ label = 'All sides checked' } = {}) {
    this.root.dataset.state = 'complete';
    this._setStatus(label, this.total);
    this.hideTimer = setTimeout(() => {
      if (this.cards.size) return;
      this.root.hidden = true;
      this.sessionId = null;
    }, 1450);
  }

  cancel() {
    clearTimeout(this.hideTimer);
    this.root.hidden = true;
    this.root.dataset.state = 'idle';
    this.track.replaceChildren();
    this.cards.clear();
    this.sessionId = null;
  }

  _card(id, label = 'View') {
    const key = String(id);
    if (this.cards.has(key)) return this.cards.get(key);
    const element = document.createElement('article');
    element.className = 'scan-view-card';
    element.dataset.state = 'waiting';
    const image = document.createElement('canvas');
    const mask = document.createElement('canvas');
    image.width = mask.width = THUMBNAIL_WIDTH;
    image.height = mask.height = THUMBNAIL_HEIGHT;
    image.className = 'scan-view-image';
    mask.className = 'scan-view-mask';
    const caption = document.createElement('div');
    const name = document.createElement('b');
    const stage = document.createElement('span');
    name.textContent = conciseLabel(label);
    stage.textContent = 'waiting';
    caption.append(name, stage);
    element.append(image, mask, caption);
    this.track.append(element);
    const card = {
      element,
      image,
      mask,
      stage,
      maskData: null,
      rendered: false,
    };
    this.cards.set(key, card);
    return card;
  }

  _setStatus(label, complete) {
    this.status.textContent = `${label} · ${Math.min(this.total, complete)} / ${this.total}`;
  }

  _emitMaskParticles(card) {
    const target = this.getFusionTarget?.();
    const source = card.mask.getBoundingClientRect();
    if (!target?.width || !source.width || !card.maskData?.mask) return;
    const { mask, maskW, maskH } = card.maskData;
    const selected = [];
    const stride = Math.max(1, Math.floor(mask.length / 900));
    for (let index = 0; index < mask.length; index += stride) {
      if (mask[index]) selected.push(index);
    }
    if (!selected.length) return;
    const count = Math.min(30, selected.length);
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
      const delay = ordinal * 12;
      particle.animate([
        { transform: 'translate3d(0,0,0) scale(.7)', opacity: 0 },
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 0.86, offset: 0.16 },
        {
          transform: `translate3d(${destinationX - startX}px,${destinationY - startY}px,0) scale(.35)`,
          opacity: 0,
        },
      ], {
        duration: 760 + pseudo(ordinal + 9) * 260,
        delay,
        easing: 'cubic-bezier(.22,.72,.25,1)',
        fill: 'forwards',
      }).finished.finally(() => particle.remove());
    }
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
  const source = new OffscreenCanvas(width, height);
  const sourceContext = source.getContext('2d');
  const image = sourceContext.createImageData(width, height);
  const color = accepted ? [112, 215, 255] : [242, 193, 78];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const pixel = index * 4;
    image.data[pixel] = color[0];
    image.data[pixel + 1] = color[1];
    image.data[pixel + 2] = color[2];
    image.data[pixel + 3] = 172;
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

function pseudo(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
