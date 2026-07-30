/**
 * Deterministic 2D selection tools. They deliberately return the same binary
 * mask shape as SAM, so every selection method shares the 2D -> 3D lift.
 */

/**
 * Contiguous "magic wand" fill from a canvas pixel.
 *
 * threshold is 0..100. The distance is weighted toward green/luminance, which
 * is more perceptually useful than comparing RGB channels independently.
 */
export function colorFillMask(canvas, x, y, threshold = 18) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pixels = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  if (!w || !h) return mask;

  const sx = Math.max(0, Math.min(w - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(y)));
  const seed = (sy * w + sx) * 4;
  const sr = pixels[seed];
  const sg = pixels[seed + 1];
  const sb = pixels[seed + 2];

  // 0 remains useful for near-exact flat-color fills, while the top end can
  // cross noisy splat gradients. Compare squared distances in the hot loop.
  const limit = 6 + Math.max(0, Math.min(100, threshold)) * 2.5;
  const limit2 = limit * limit;
  const edgeLimit = 10 + limit * 0.6;
  const edgeLimit2 = edgeLimit * edgeLimit;
  const queued = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const start = sy * w + sx;
  queue[tail++] = start;
  queued[start] = 1;

  while (head < tail) {
    const i = queue[head++];
    const p = i * 4;
    const dr = pixels[p] - sr;
    const dg = pixels[p + 1] - sg;
    const db = pixels[p + 2] - sb;
    const distance2 = (2 * dr * dr + 4 * dg * dg + 3 * db * db) / 9;
    if (distance2 > limit2) continue;

    mask[i] = 1;
    const px = i % w;
    const py = (i / w) | 0;
    if (px > 0) enqueue(i - 1, p);
    if (px + 1 < w) enqueue(i + 1, p);
    if (py > 0) enqueue(i - w, p);
    if (py + 1 < h) enqueue(i + w, p);
  }

  return mask;

  function enqueue(i, fromPixel) {
    if (queued[i]) return;
    const p = i * 4;
    const dr = pixels[p] - pixels[fromPixel];
    const dg = pixels[p + 1] - pixels[fromPixel + 1];
    const db = pixels[p + 2] - pixels[fromPixel + 2];
    const localDistance2 = (2 * dr * dr + 4 * dg * dg + 3 * db * db) / 9;
    if (localDistance2 > edgeLimit2) return;
    queued[i] = 1;
    queue[tail++] = i;
  }
}

/** A simple circular screen-space selection, useful when semantics are wrong. */
export function radiusMask(w, h, x, y, radiusPercent = 5) {
  const mask = new Uint8Array(w * h);
  const r = Math.max(2, Math.min(w, h) * radiusPercent / 100);
  const r2 = r * r;
  const minX = Math.max(0, Math.floor(x - r));
  const maxX = Math.min(w - 1, Math.ceil(x + r));
  const minY = Math.max(0, Math.floor(y - r));
  const maxY = Math.min(h - 1, Math.ceil(y + r));

  for (let py = minY; py <= maxY; py++) {
    const dy2 = (py - y) ** 2;
    for (let px = minX; px <= maxX; px++) {
      if ((px - x) ** 2 + dy2 <= r2) mask[py * w + px] = 1;
    }
  }
  return mask;
}

/** Paint a circular add/remove stroke into both the resolved mask and edit map. */
export function paintMask(mask, edits, w, h, x, y, radius, add) {
  const r = Math.max(1, radius);
  const r2 = r * r;
  const minX = Math.max(0, Math.floor(x - r));
  const maxX = Math.min(w - 1, Math.ceil(x + r));
  const minY = Math.max(0, Math.floor(y - r));
  const maxY = Math.min(h - 1, Math.ceil(y + r));
  const value = add ? 1 : 0;
  const edit = add ? 1 : -1;

  for (let py = minY; py <= maxY; py++) {
    const dy2 = (py - y) ** 2;
    for (let px = minX; px <= maxX; px++) {
      if ((px - x) ** 2 + dy2 > r2) continue;
      const i = py * w + px;
      mask[i] = value;
      edits[i] = edit;
    }
  }
}

/** Combine differently-sized provider masks into one target-resolution mask. */
export function combineMasks(candidates, w, h, mode = 'smart') {
  if (!candidates.length) throw new Error('At least one starting-mask source is required.');
  const mask = new Uint8Array(w * h);
  const primary = mode === 'smart'
    ? candidates.find((candidate) => candidate.role === 'primary')
    : null;
  const required = mode === 'union' ? 1
    : mode === 'intersection' ? candidates.length
      : Math.floor(candidates.length / 2) + 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (primary) {
        const sx = Math.min(primary.w - 1, Math.floor(x * primary.w / w));
        const sy = Math.min(primary.h - 1, Math.floor(y * primary.h / h));
        mask[y * w + x] = primary.mask[sy * primary.w + sx] ? 1 : 0;
        continue;
      }
      let votes = 0;
      for (const candidate of candidates) {
        const sx = Math.min(candidate.w - 1, Math.floor(x * candidate.w / w));
        const sy = Math.min(candidate.h - 1, Math.floor(y * candidate.h / h));
        votes += candidate.mask[sy * candidate.w + sx] ? 1 : 0;
      }
      mask[y * w + x] = votes >= required ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Expand (positive pixels) or contract (negative pixels) a binary mask.
 * Repeated 8-neighbour morphology is predictable for an interactive slider
 * and preserves manually painted edits after the provider masks are combined.
 */
export function offsetMask(source, w, h, pixels = 0) {
  const passes = Math.min(24, Math.abs(Math.round(pixels)));
  if (!passes) return source.slice();
  const expand = pixels > 0;
  let current = source.slice();

  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice();
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const index = y * w + x;
        if (expand ? current[index] : !current[index]) continue;
        let neighbour = expand ? 0 : 1;
        for (let ny = y0; ny <= y1; ny++) {
          const row = ny * w;
          for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
            if (expand && current[row + nx]) neighbour = 1;
            if (!expand && !current[row + nx]) neighbour = 0;
          }
        }
        next[index] = neighbour;
      }
    }
    current = next;
  }
  return current;
}

/**
 * Confidence falls toward the inside of a mask boundary. The binary mask
 * remains authoritative; this field only controls provisional/confirmed
 * styling and thresholding after splats are lifted.
 */
export function buildMaskConfidence(mask, w, h, softnessPixels = 0) {
  const confidence = new Float32Array(mask.length);
  const passes = Math.min(18, Math.max(0, Math.round(softnessPixels)));
  if (!passes) {
    for (let i = 0; i < mask.length; i++) confidence[i] = mask[i];
    return confidence;
  }

  let current = mask.slice();
  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice();
    const boundaryConfidence = 0.48 + 0.47 * ((pass + 1) / passes);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const index = y * w + x;
        if (!current[index]) continue;
        let boundary = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        if (!boundary) {
          boundary = !current[index - 1] || !current[index + 1]
            || !current[index - w] || !current[index + w];
        }
        if (!boundary) continue;
        next[index] = 0;
        confidence[index] = Math.max(confidence[index], boundaryConfidence);
      }
    }
    current = next;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i]) confidence[i] = 1;
  }
  return confidence;
}
