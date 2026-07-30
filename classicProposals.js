import { colorFillMask } from './maskTools.js';

const MAX_SIDE = 512;
const MAX_CACHE_ENTRIES = 80;

/**
 * Lightweight hover proposals for scenes whose contents are outside YOLO's
 * vocabulary. It runs the same edge-aware color fill as the manual tool on a
 * half-resolution cached projection, then returns a box and a sampled border.
 */
export class ClassicRegionProposer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.revision = -1;
    this.cache = new Map();
  }

  prepare(sourceCanvas, revision) {
    const scale = Math.min(1, MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height));
    this.canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
    this.canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
    this.context.drawImage(sourceCanvas, 0, 0, this.canvas.width, this.canvas.height);
    this.sourceWidth = sourceCanvas.width;
    this.sourceHeight = sourceCanvas.height;
    this.scaleX = this.canvas.width / sourceCanvas.width;
    this.scaleY = this.canvas.height / sourceCanvas.height;
    this.revision = revision;
    this.cache.clear();
  }

  clear() {
    this.revision = -1;
    this.cache.clear();
  }

  propose(sourceX, sourceY, {
    threshold = 13,
  } = {}) {
    if (this.revision < 0 || !this.canvas.width) return null;
    const x = Math.max(0, Math.min(this.canvas.width - 1, sourceX * this.scaleX));
    const y = Math.max(0, Math.min(this.canvas.height - 1, sourceY * this.scaleY));
    const key = `${Math.floor(x / 10)}:${Math.floor(y / 10)}:${threshold}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const pixel = this.context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const luminance = pixel[0] * 0.21 + pixel[1] * 0.72 + pixel[2] * 0.07;
    if (pixel[3] < 8 || luminance < 7) {
      this._cache(key, null);
      return null;
    }

    const mask = colorFillMask(this.canvas, x, y, threshold);
    const region = measureMask(mask, this.canvas.width, this.canvas.height);
    const total = this.canvas.width * this.canvas.height;
    if (region.count < 24 || region.count > total * 0.72) {
      this._cache(key, null);
      return null;
    }

    const pad = 3;
    const box = {
      x1: Math.max(0, region.minX - pad) / this.scaleX,
      y1: Math.max(0, region.minY - pad) / this.scaleY,
      x2: Math.min(this.canvas.width, region.maxX + pad + 1) / this.scaleX,
      y2: Math.min(this.canvas.height, region.maxY + pad + 1) / this.scaleY,
    };
    const proposal = {
      id: `classic:${this.revision}:${key}`,
      label: 'visual region',
      // Deterministic flood fills have no calibrated probability. This value
      // may be used only to rank visual proposals against one another.
      rank: region.count / Math.max(1, total),
      box,
      area: (box.x2 - box.x1) * (box.y2 - box.y1),
      source: 'classic-fill',
      outline: sampleOutline(
        mask,
        this.canvas.width,
        this.canvas.height,
        this.scaleX,
        this.scaleY,
        region,
      ),
    };
    this._cache(key, proposal);
    return proposal;
  }

  _cache(key, value) {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }
}

function measureMask(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i / width) | 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    count++;
  }
  return { minX, minY, maxX, maxY, count };
}

function sampleOutline(mask, width, height, scaleX, scaleY, region) {
  const boundary = [];
  for (let y = Math.max(1, region.minY); y <= Math.min(height - 2, region.maxY); y++) {
    for (let x = Math.max(1, region.minX); x <= Math.min(width - 2, region.maxX); x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width]) continue;
      boundary.push([x, y]);
    }
  }
  const stride = Math.max(1, Math.ceil(boundary.length / 720));
  const centerX = (region.minX + region.maxX) * 0.5;
  const centerY = (region.minY + region.maxY) * 0.5;
  return boundary
    .filter((_, index) => index % stride === 0)
    .sort((a, b) =>
      Math.atan2(a[1] - centerY, a[0] - centerX)
      - Math.atan2(b[1] - centerY, b[0] - centerX))
    .flatMap(([x, y]) => [
      x / scaleX,
      y / scaleY,
      (x + 1.35) / scaleX,
      y / scaleY,
    ]);
}
