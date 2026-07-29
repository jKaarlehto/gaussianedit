/**
 * 2D mask -> 3D splat indices.
 *
 * The trick is to go forward, not backward. Rather than rendering a
 * splat-id buffer (which is genuinely ill-defined for alpha-blended
 * Gaussians — a pixel is a weighted sum of dozens of them), we project
 * every splat centre through the exact camera matrix that produced the
 * image SAM segmented, and ask two questions:
 *
 *   1. does it land inside the mask?
 *   2. is it on the visible surface, or hidden behind it?
 *
 * (2) needs a depth reference. We build a coarse tile-min-depth buffer
 * in the same pass — cheap, renderer-agnostic, and good enough because
 * the tolerance is a slider. See README for the exact-depth upgrade.
 */

const TILE = 4; // px per depth tile

/**
 * Project all splats once for a frozen camera view. The resulting arrays and
 * tile-depth surface are reusable for every mask, model hypothesis, border
 * stroke, and 3D-completion slider change made against that view.
 */
export function projectSplats({ centers, count, viewProj, viewW, viewH }) {
  const tw = Math.ceil(viewW / TILE);
  const th = Math.ceil(viewH / TILE);
  const depth = new Float32Array(tw * th).fill(Infinity);

  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const sd = new Float32Array(count);

  const m = viewProj;
  const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
  const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
  const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14];
  const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];

  // Pass 1 — project, and record the nearest splat per tile.
  for (let i = 0; i < count; i++) {
    const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (w <= 1e-6) { sd[i] = -1; continue; }

    const cx = m0 * x + m4 * y + m8 * z + m12;
    const cy = m1 * x + m5 * y + m9 * z + m13;
    const cz = m2 * x + m6 * y + m10 * z + m14;
    const inv = 1 / w;
    const ndcZ = cz * inv;
    if (ndcZ < -1 || ndcZ > 1) { sd[i] = -1; continue; }

    const px = (cx * inv * 0.5 + 0.5) * viewW;
    const py = (1 - (cy * inv * 0.5 + 0.5)) * viewH;
    if (px < 0 || py < 0 || px >= viewW || py >= viewH) { sd[i] = -1; continue; }

    sx[i] = px; sy[i] = py; sd[i] = w; // for a perspective camera, clip w == view depth

    const t = ((py / TILE) | 0) * tw + ((px / TILE) | 0);
    if (w < depth[t]) depth[t] = w;
  }

  return { sx, sy, sd, depth, tw, th, tile: TILE, count, viewW, viewH };
}

/** Chunked projection used by the interactive encoder readiness pipeline. */
export async function projectSplatsAsync(
  { centers, count, viewProj, viewW, viewH },
  onProgress = () => {},
  shouldCancel = () => false,
) {
  const CHUNK = 200_000;
  const tw = Math.ceil(viewW / TILE);
  const th = Math.ceil(viewH / TILE);
  const depth = new Float32Array(tw * th).fill(Infinity);
  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const sd = new Float32Array(count);

  const m = viewProj;
  const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
  const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
  const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14];
  const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];

  for (let i0 = 0; i0 < count; i0 += CHUNK) {
    const i1 = Math.min(count, i0 + CHUNK);
    for (let i = i0; i < i1; i++) {
      const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
      const w = m3 * x + m7 * y + m11 * z + m15;
      if (w <= 1e-6) { sd[i] = -1; continue; }

      const cx = m0 * x + m4 * y + m8 * z + m12;
      const cy = m1 * x + m5 * y + m9 * z + m13;
      const cz = m2 * x + m6 * y + m10 * z + m14;
      const inv = 1 / w;
      const ndcZ = cz * inv;
      if (ndcZ < -1 || ndcZ > 1) { sd[i] = -1; continue; }

      const px = (cx * inv * 0.5 + 0.5) * viewW;
      const py = (1 - (cy * inv * 0.5 + 0.5)) * viewH;
      if (px < 0 || py < 0 || px >= viewW || py >= viewH) {
        sd[i] = -1;
        continue;
      }

      sx[i] = px; sy[i] = py; sd[i] = w;
      const tileIndex = ((py / TILE) | 0) * tw + ((px / TILE) | 0);
      if (w < depth[tileIndex]) depth[tileIndex] = w;
    }

    if (shouldCancel()) throw new DOMException('Projection superseded', 'AbortError');
    onProgress(i1 / count);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { sx, sy, sd, depth, tw, th, tile: TILE, count, viewW, viewH };
}

/**
 * Test one mask against a cached projection. This is the only lift work that
 * needs to repeat while the frozen camera stays unchanged.
 */
export function liftProjectedMask({
  projection,
  mask, maskW, maskH,
  absSlack, relSlack = 0.01,
}) {
  const {
    sx, sy, sd, depth, tw, tile, count, viewW, viewH,
  } = projection;
  const mx = maskW / viewW;
  const my = maskH / viewH;
  const seeds = [];
  let dsum = 0;

  for (let i = 0; i < count; i++) {
    const d = sd[i];
    if (d <= 0) continue;

    const u = (sx[i] * mx) | 0;
    const v = (sy[i] * my) | 0;
    if (!mask[v * maskW + u]) continue;

    const t = ((sy[i] / tile) | 0) * tw + ((sx[i] / tile) | 0);
    const near = depth[t];
    if (d > near + absSlack + near * relSlack) continue; // behind the front surface

    seeds.push(i);
    dsum += d;
  }

  return {
    seeds,
    meanDepth: seeds.length ? dsum / seeds.length : 0,
    proj: projection,
  };
}

/** Compatibility wrapper for callers that do not retain a frozen projection. */
export function liftMask({
  centers, count, viewProj, viewW, viewH,
  mask, maskW, maskH,
  absSlack, relSlack = 0.01,
}) {
  const projection = projectSplats({ centers, count, viewProj, viewW, viewH });
  return liftProjectedMask({ projection, mask, maskW, maskH, absSlack, relSlack });
}

/** Point-in-mask test for an already-projected splat. */
export function inMask(i, proj, mask, maskW, maskH, viewW, viewH) {
  if (proj.sd[i] <= 0) return false;
  const u = ((proj.sx[i] * maskW) / viewW) | 0;
  const v = ((proj.sy[i] * maskH) / viewH) | 0;
  return mask[v * maskW + u] === 1;
}
