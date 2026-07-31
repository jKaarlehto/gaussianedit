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

import {
  compactLookupSlot,
  createCompactIndexLookup,
  createCompactIndexLookupAsync,
} from './compactIndexLookup.js';

const TILE = 4; // px per depth tile

/**
 * Build one stable global->ROI lookup and reuse it across every synthetic
 * projection and evidence accumulator in a scan. Zero means "outside ROI";
 * stored slots are one-based so local slot zero remains representable.
 */
export function createProjectionIndexSpace(count, indices = null, options = {}) {
  if (!indices) return {
    globalIndices: null,
    indexLookup: null,
    localCount: count,
  };
  const globalIndices = indices instanceof Uint32Array
    ? indices
    : Uint32Array.from(indices);
  validateProjectionIndices(count, globalIndices);
  const indexLookup = createCompactIndexLookup(globalIndices, options);
  return {
    globalIndices,
    indexLookup,
    localCount: globalIndices.length,
  };
}

/**
 * Cancellable variant for building a large resident-cutout lookup without
 * monopolizing the main thread. The allocation is still rejected up front
 * when its explicit entry or byte budget would be exceeded.
 */
export async function createProjectionIndexSpaceAsync(
  count,
  indices = null,
  onProgress = () => {},
  shouldCancel = () => false,
  options = {},
) {
  if (!indices) return {
    globalIndices: null,
    indexLookup: null,
    localCount: count,
  };
  const globalIndices = indices instanceof Uint32Array
    ? indices
    : Uint32Array.from(indices);
  await validateProjectionIndicesAsync(
    count,
    globalIndices,
    (progress) => onProgress(progress * 0.2),
    shouldCancel,
    options,
  );
  const indexLookup = await createCompactIndexLookupAsync(
    globalIndices,
    (progress) => onProgress(0.2 + progress * 0.8),
    shouldCancel,
    options,
  );
  return {
    globalIndices,
    indexLookup,
    localCount: globalIndices.length,
  };
}

/** Resolve a scene-global Gaussian id to this projection's compact slot. */
export function projectionSlot(projection, globalIndex) {
  return compactLookupSlot(projection.indexLookup, globalIndex);
}

/**
 * Project all splats once for a frozen camera view. The resulting arrays and
 * tile-depth surface are reusable for every mask, model hypothesis, border
 * stroke, and 3D-completion slider change made against that view.
 */
export function projectSplats({
  centers,
  count,
  viewProj,
  viewW,
  viewH,
  hidden = null,
  radii = null,
  opacity = null,
}) {
  const tw = Math.ceil(viewW / TILE);
  const th = Math.ceil(viewH / TILE);
  const depth = new Float32Array(tw * th).fill(Infinity);
  const nearestIndex = new Int32Array(tw * th).fill(-1);
  const depth2 = new Float32Array(tw * th).fill(Infinity);
  const depth3 = new Float32Array(tw * th).fill(Infinity);
  const nearestIndex2 = new Int32Array(tw * th).fill(-1);
  const nearestIndex3 = new Int32Array(tw * th).fill(-1);

  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const sd = new Float32Array(count);
  const sr = new Float32Array(count);

  const m = viewProj;
  const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
  const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
  const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14];
  const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];
  const pixelsPerWorldAtUnitDepth = Math.max(
    Math.hypot(m0, m4, m8) * viewW * 0.5,
    Math.hypot(m1, m5, m9) * viewH * 0.5,
  );

  // Pass 1 — project, and record the nearest splat per tile.
  for (let i = 0; i < count; i++) {
    if (hidden?.[i]) { sd[i] = -1; continue; }
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
    const radiusPixels = radii ? radii[i] * pixelsPerWorldAtUnitDepth / w : 0;
    sr[i] = Math.max(0, radiusPixels);

    if (!opacity || opacity[i] >= 12) {
      const tx = (px / TILE) | 0;
      const ty = (py / TILE) | 0;
      const reach = radiusPixels > TILE * 0.65
        ? Math.min(3, Math.ceil(radiusPixels / TILE))
        : 0;
      const footprint = radiusPixels + TILE * 0.72;
      const footprint2 = footprint * footprint;
      for (let dy = -reach; dy <= reach; dy++) {
        const tileY = ty + dy;
        if (tileY < 0 || tileY >= th) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const tileX = tx + dx;
          if (tileX < 0 || tileX >= tw) continue;
          if (reach) {
            const centreX = (tileX + 0.5) * TILE;
            const centreY = (tileY + 0.5) * TILE;
            if ((centreX - px) ** 2 + (centreY - py) ** 2 > footprint2) continue;
          }
          const t = tileY * tw + tileX;
          if (w < depth[t]) {
            depth3[t] = depth2[t];
            nearestIndex3[t] = nearestIndex2[t];
            depth2[t] = depth[t];
            nearestIndex2[t] = nearestIndex[t];
            depth[t] = w;
            nearestIndex[t] = i;
          } else if (w < depth2[t]) {
            depth3[t] = depth2[t];
            nearestIndex3[t] = nearestIndex2[t];
            depth2[t] = w;
            nearestIndex2[t] = i;
          } else if (w < depth3[t]) {
            depth3[t] = w;
            nearestIndex3[t] = i;
          }
        }
      }
    }
  }

  return {
    sx,
    sy,
    sd,
    sr,
    depth,
    nearestIndex,
    depth2,
    depth3,
    nearestIndex2,
    nearestIndex3,
    tw,
    th,
    tile: TILE,
    count,
    viewW,
    viewH,
  };
}

/** Chunked projection used by the interactive encoder readiness pipeline. */
export async function projectSplatsAsync(
  {
    centers,
    count,
    viewProj,
    viewW,
    viewH,
    hidden = null,
    radii = null,
    opacity = null,
    indices = null,
    indexSpace = null,
    reuse = null,
  },
  onProgress = () => {},
  shouldCancel = () => false,
) {
  const CHUNK = 200_000;
  const tw = Math.ceil(viewW / TILE);
  const th = Math.ceil(viewH / TILE);
  const activeIndices = indexSpace?.globalIndices ?? indices ?? null;
  const indexLookup = indexSpace?.indexLookup ?? null;
  const workCount = activeIndices?.length ?? count;
  const reusable = reuse?.count === count
    && reuse.tw === tw
    && reuse.th === th
    && reuse.activeIndices === activeIndices
    && reuse.indexLookup === indexLookup;
  const depth = reusable ? reuse.depth : new Float32Array(tw * th);
  const nearestIndex = reusable ? reuse.nearestIndex : new Int32Array(tw * th);
  const depth2 = reusable ? reuse.depth2 : new Float32Array(tw * th);
  const depth3 = reusable ? reuse.depth3 : new Float32Array(tw * th);
  const nearestIndex2 = reusable ? reuse.nearestIndex2 : new Int32Array(tw * th);
  const nearestIndex3 = reusable ? reuse.nearestIndex3 : new Int32Array(tw * th);
  const sx = reusable ? reuse.sx : new Float32Array(workCount);
  const sy = reusable ? reuse.sy : new Float32Array(workCount);
  const sd = reusable ? reuse.sd : new Float32Array(workCount);
  const sr = reusable ? reuse.sr : new Float32Array(workCount);
  depth.fill(Infinity);
  depth2.fill(Infinity);
  depth3.fill(Infinity);
  nearestIndex.fill(-1);
  nearestIndex2.fill(-1);
  nearestIndex3.fill(-1);
  sd.fill(-1);

  const m = viewProj;
  const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
  const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
  const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14];
  const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];
  const pixelsPerWorldAtUnitDepth = Math.max(
    Math.hypot(m0, m4, m8) * viewW * 0.5,
    Math.hypot(m1, m5, m9) * viewH * 0.5,
  );

  for (let i0 = 0; i0 < workCount; i0 += CHUNK) {
    const i1 = Math.min(workCount, i0 + CHUNK);
    for (let ordinal = i0; ordinal < i1; ordinal++) {
      const i = activeIndices ? activeIndices[ordinal] : ordinal;
      const slot = activeIndices ? ordinal : i;
      if (hidden?.[i]) { sd[slot] = -1; continue; }
      const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
      const w = m3 * x + m7 * y + m11 * z + m15;
      if (w <= 1e-6) { sd[slot] = -1; continue; }

      const cx = m0 * x + m4 * y + m8 * z + m12;
      const cy = m1 * x + m5 * y + m9 * z + m13;
      const cz = m2 * x + m6 * y + m10 * z + m14;
      const inv = 1 / w;
      const ndcZ = cz * inv;
      if (ndcZ < -1 || ndcZ > 1) { sd[slot] = -1; continue; }

      const px = (cx * inv * 0.5 + 0.5) * viewW;
      const py = (1 - (cy * inv * 0.5 + 0.5)) * viewH;
      if (px < 0 || py < 0 || px >= viewW || py >= viewH) {
        sd[slot] = -1;
        continue;
      }

      sx[slot] = px; sy[slot] = py; sd[slot] = w;
      const radiusPixels = radii ? radii[i] * pixelsPerWorldAtUnitDepth / w : 0;
      sr[slot] = Math.max(0, radiusPixels);
      if (!opacity || opacity[i] >= 12) {
        const tx = (px / TILE) | 0;
        const ty = (py / TILE) | 0;
        const reach = radiusPixels > TILE * 0.65
          ? Math.min(3, Math.ceil(radiusPixels / TILE))
          : 0;
        const footprint = radiusPixels + TILE * 0.72;
        const footprint2 = footprint * footprint;
        for (let dy = -reach; dy <= reach; dy++) {
          const tileY = ty + dy;
          if (tileY < 0 || tileY >= th) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const tileX = tx + dx;
            if (tileX < 0 || tileX >= tw) continue;
            if (reach) {
              const centreX = (tileX + 0.5) * TILE;
              const centreY = (tileY + 0.5) * TILE;
              if ((centreX - px) ** 2 + (centreY - py) ** 2 > footprint2) continue;
            }
            const tileIndex = tileY * tw + tileX;
            if (w < depth[tileIndex]) {
              depth3[tileIndex] = depth2[tileIndex];
              nearestIndex3[tileIndex] = nearestIndex2[tileIndex];
              depth2[tileIndex] = depth[tileIndex];
              nearestIndex2[tileIndex] = nearestIndex[tileIndex];
              depth[tileIndex] = w;
              nearestIndex[tileIndex] = i;
            } else if (w < depth2[tileIndex]) {
              depth3[tileIndex] = depth2[tileIndex];
              nearestIndex3[tileIndex] = nearestIndex2[tileIndex];
              depth2[tileIndex] = w;
              nearestIndex2[tileIndex] = i;
            } else if (w < depth3[tileIndex]) {
              depth3[tileIndex] = w;
              nearestIndex3[tileIndex] = i;
            }
          }
        }
      }
    }

    if (shouldCancel()) throw new DOMException('Projection superseded', 'AbortError');
    onProgress(i1 / Math.max(1, workCount));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    sx,
    sy,
    sd,
    sr,
    depth,
    nearestIndex,
    depth2,
    depth3,
    nearestIndex2,
    nearestIndex3,
    tw,
    th,
    tile: TILE,
    count,
    viewW,
    viewH,
    activeIndices,
    indexLookup,
    projectedCount: workCount,
  };
}

/**
 * Find a conservative foreground shell that blocks the already-selected
 * object from a novel view. The returned Gaussians are suitable only for a
 * clearly labelled diagnostic render:
 *
 * - selected and locked Gaussians are never hidden;
 * - geometry inside an expanded object AABB is protected;
 * - only the front portion of a genuinely occluded selection tile is hidden;
 * - an unexpectedly large hide set is rejected rather than punching a huge
 *   hole through the scene.
 */
export function findOccluderRevealCandidates({
  projection,
  centers,
  selection,
  locked = null,
  protectedIndices = null,
  absSlack = 0,
  relSlack = 0.01,
  aggression = 0.46,
  minimumOccludedRatio = 0.16,
  maximumFraction = 0.08,
  maximumCount = 60_000,
}) {
  const {
    sx,
    sy,
    sd,
    depth,
    tw,
    th,
    tile,
    count,
  } = projection;
  const tileCount = tw * th;
  const selectedDepth = new Float32Array(tileCount).fill(Infinity);
  const occludedTiles = new Uint8Array(tileCount);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let projectedSelection = 0;

  for (const index of selection) {
    const x = centers[index * 3];
    const y = centers[index * 3 + 1];
    const z = centers[index * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;

    const slot = projectionSlot(projection, index);
    if (slot < 0) continue;
    const d = sd[slot];
    if (d <= 0) continue;
    projectedSelection++;
    const t = ((sy[slot] / tile) | 0) * tw + ((sx[slot] / tile) | 0);
    if (d < selectedDepth[t]) selectedDepth[t] = d;
  }

  let selectionTiles = 0;
  let occludedTileCount = 0;
  for (let t = 0; t < tileCount; t++) {
    const selected = selectedDepth[t];
    if (!Number.isFinite(selected)) continue;
    selectionTiles++;
    const nearest = depth[t];
    if (Number.isFinite(nearest)
      && selected > nearest + absSlack + nearest * relSlack) {
      occludedTiles[t] = 1;
      occludedTileCount++;
    }
  }

  const occludedRatio = occludedTileCount / Math.max(1, selectionTiles);
  if (!projectedSelection || occludedRatio < minimumOccludedRatio) {
    return {
      candidates: new Set(),
      occludedRatio,
      selectionTiles,
      occludedTiles: occludedTileCount,
      projectedSelection,
      safe: false,
      reason: projectedSelection
        ? 'The object is not blocked enough to justify an altered view.'
        : 'The object does not project into this view.',
    };
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const protect = Math.max(diagonal * 0.06, absSlack * 2);
  minX -= protect;
  minY -= protect;
  minZ -= protect;
  maxX += protect;
  maxY += protect;
  maxZ += protect;

  const limit = Math.max(1, Math.min(
    maximumCount,
    Math.floor((projection.projectedCount ?? count) * maximumFraction),
  ));
  const candidates = new Set();
  const boundedAggression = Math.max(0.18, Math.min(0.72, aggression));
  const activeIndices = projection.activeIndices;
  const candidateCount = activeIndices?.length ?? count;
  for (let ordinal = 0; ordinal < candidateCount; ordinal++) {
    const index = activeIndices ? activeIndices[ordinal] : ordinal;
    const slot = activeIndices ? ordinal : index;
    const d = sd[slot];
    if (d <= 0 || selection.has(index) || locked?.[index]
      || protectedIndices?.has?.(index)) continue;
    const t = ((sy[slot] / tile) | 0) * tw + ((sx[slot] / tile) | 0);
    if (!occludedTiles[t]) continue;
    const nearest = depth[t];
    const targetDepth = selectedDepth[t];
    const revealDepth = nearest + (targetDepth - nearest) * boundedAggression;
    if (d > revealDepth) continue;

    const x = centers[index * 3];
    const y = centers[index * 3 + 1];
    const z = centers[index * 3 + 2];
    if (x >= minX && x <= maxX
      && y >= minY && y <= maxY
      && z >= minZ && z <= maxZ) continue;

    candidates.add(index);
    if (candidates.size > limit) {
      return {
        candidates: new Set(),
        occludedRatio,
        selectionTiles,
        occludedTiles: occludedTileCount,
        projectedSelection,
        safe: false,
        reason: 'Too much foreground would need to be hidden safely.',
      };
    }
  }

  return {
    candidates,
    occludedRatio,
    selectionTiles,
    occludedTiles: occludedTileCount,
    projectedSelection,
    safe: candidates.size > 0,
    reason: candidates.size
      ? ''
      : 'No unrelated foreground shell could be isolated safely.',
  };
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
    sd, depth, tw, th, tile, count, viewW, viewH,
  } = projection;
  const seeds = [];
  const seedWeights = new Map();
  let dsum = 0;
  const maskIntegral = buildMaskIntegral(mask, maskW, maskH);
  const candidates = collectMaskTileCandidates(
    projection,
    maskW,
    maskH,
    maskIntegral,
  );
  const candidateCount = candidates.length;
  for (let ordinal = 0; ordinal < candidateCount; ordinal++) {
    const i = candidates[ordinal];
    const slot = projectionSlot(projection, i);
    if (slot < 0) continue;
    const d = sd[slot];
    if (d <= 0) continue;

    const hit = projectedFootprintMaskCoverage(
      i,
      projection,
      mask,
      maskW,
      maskH,
      viewW,
      viewH,
      maskIntegral,
    );
    if (!hit) continue;

    const tileX = Math.max(0, Math.min(tw - 1, (hit.x / tile) | 0));
    const tileY = Math.max(0, Math.min(th - 1, (hit.y / tile) | 0));
    const t = tileY * tw + tileX;
    const near = depth[t];
    if (Number.isFinite(near)
      && d > near + absSlack + near * relSlack) continue; // behind the front surface

    seeds.push(i);
    seedWeights.set(i, hit.coverage);
    dsum += d;
  }

  return {
    seeds,
    // Per-splat footprint agreement is intentionally separate from the
    // tracker/model score. Fusion can use both without pretending they are
    // the same kind of confidence.
    seedWeights,
    meanDepth: seeds.length ? dsum / seeds.length : 0,
    proj: projection,
  };
}

/**
 * Cancellable, frame-friendly lift for interactive selection and novel views.
 * The mathematical result matches liftProjectedMask(), but footprint tests are
 * split into bounded chunks so a single browser thread never presents as a
 * frozen application on multi-million-splat scenes.
 */
export async function liftProjectedMaskAsync(
  {
    projection,
    mask,
    maskW,
    maskH,
    absSlack,
    relSlack = 0.01,
  },
  onProgress = () => {},
  shouldCancel = () => false,
) {
  const {
    sd, depth, tw, tile, count, viewW, viewH,
  } = projection;
  const seeds = [];
  const seedWeights = new Map();
  let dsum = 0;
  const maskIntegral = buildMaskIntegral(mask, maskW, maskH);
  const candidates = collectMaskTileCandidates(
    projection,
    maskW,
    maskH,
    maskIntegral,
  );
  const candidateCount = candidates.length;
  const chunk = 48_000;

  for (let start = 0; start < candidateCount; start += chunk) {
    const end = Math.min(candidateCount, start + chunk);
    for (let ordinal = start; ordinal < end; ordinal++) {
      const index = candidates[ordinal];
      const slot = projectionSlot(projection, index);
      if (slot < 0) continue;
      const splatDepth = sd[slot];
      if (splatDepth <= 0) continue;
      const hit = projectedFootprintMaskCoverage(
        index,
        projection,
        mask,
        maskW,
        maskH,
        viewW,
        viewH,
        maskIntegral,
      );
      if (!hit) continue;
      const tileX = Math.max(0, Math.min(tw - 1, (hit.x / tile) | 0));
      const tileY = Math.max(0, Math.min(
        projection.th - 1,
        (hit.y / tile) | 0,
      ));
      const nearest = depth[tileY * tw + tileX];
      if (Number.isFinite(nearest)
        && splatDepth > nearest + absSlack + nearest * relSlack) continue;
      seeds.push(index);
      seedWeights.set(index, hit.coverage);
      dsum += splatDepth;
    }
    if (shouldCancel()) throw new DOMException('Mask lift superseded', 'AbortError');
    onProgress(end / Math.max(1, candidateCount), seeds.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    seeds,
    seedWeights,
    meanDepth: seeds.length ? dsum / seeds.length : 0,
    proj: projection,
  };
}

function collectMaskTileCandidates(projection, maskW, maskH, maskIntegral) {
  const {
    tw,
    th,
    tile,
    viewW,
    viewH,
    nearestIndex,
    nearestIndex2,
    nearestIndex3,
  } = projection;
  const found = new Set();
  const layers = [nearestIndex, nearestIndex2, nearestIndex3].filter(Boolean);
  const integralStride = maskW + 1;
  for (let tileY = 0; tileY < th; tileY++) {
    const y1 = Math.max(0, Math.floor(tileY * tile / viewH * maskH));
    const y2 = Math.min(
      maskH,
      Math.max(y1 + 1, Math.ceil((tileY + 1) * tile / viewH * maskH)),
    );
    for (let tileX = 0; tileX < tw; tileX++) {
      const x1 = Math.max(0, Math.floor(tileX * tile / viewW * maskW));
      const x2 = Math.min(
        maskW,
        Math.max(x1 + 1, Math.ceil((tileX + 1) * tile / viewW * maskW)),
      );
      if (!integralRectSum(
        maskIntegral,
        integralStride,
        x1,
        y1,
        x2,
        y2,
      )) continue;
      const tileIndex = tileY * tw + tileX;
      for (const indices of layers) {
        const index = indices[tileIndex];
        if (index >= 0) found.add(index);
      }
    }
  }
  return Int32Array.from(found);
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
  return Boolean(projectedFootprintMaskHit(
    i,
    proj,
    mask,
    maskW,
    maskH,
    viewW,
    viewH,
  ));
}

/**
 * Return a representative view-space point where a projected splat overlaps
 * the mask. The parser currently exposes a conservative scalar radius rather
 * than the exact anisotropic renderer contribution, so two sampled rings are
 * an honest improvement over origin-only picking without claiming pixel-exact
 * contribution weights.
 */
function projectedFootprintMaskHit(
  i,
  proj,
  mask,
  maskW,
  maskH,
  viewW,
  viewH,
) {
  const slot = projectionSlot(proj, i);
  if (slot < 0 || proj.sd[slot] <= 0) return null;
  const centreX = proj.sx[slot];
  const centreY = proj.sy[slot];
  const scaleX = maskW / viewW;
  const scaleY = maskH / viewH;
  const contains = (x, y) => {
    const u = Math.floor(x * scaleX);
    const v = Math.floor(y * scaleY);
    return u >= 0 && u < maskW && v >= 0 && v < maskH
      && mask[v * maskW + u] === 1;
  };
  if (contains(centreX, centreY)) return { x: centreX, y: centreY };

  const radius = proj.sr?.[slot] ?? 0;
  if (radius < 1.5) return null;
  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [-0.7071, 0.7071],
    [0.7071, -0.7071], [-0.7071, -0.7071],
  ];
  for (const ring of [0.48, 0.86]) {
    const distance = radius * ring;
    for (const [dx, dy] of directions) {
      const x = centreX + dx * distance;
      const y = centreY + dy * distance;
      if (contains(x, y)) return { x, y };
    }
  }
  return null;
}

/**
 * Estimate how much of one projected Gaussian footprint lies inside the
 * edited mask. The old centre-only test made a large visible splat appear
 * impossible to paint unless the brush crossed its origin. A summed-area
 * rejection keeps the all-splat pass cheap, while Gaussian-weighted samples
 * provide a stable overlap value for lifting and later evidence fusion.
 *
 * This remains a conservative renderer-independent approximation. The exact
 * upgrade is an alpha×transmittance contributor buffer from the splat
 * rasterizer; callers can keep the same seedWeights contract when that lands.
 */
function projectedFootprintMaskCoverage(
  i,
  proj,
  mask,
  maskW,
  maskH,
  viewW,
  viewH,
  integral,
) {
  const slot = projectionSlot(proj, i);
  if (slot < 0 || proj.sd[slot] <= 0) return null;
  const centreX = proj.sx[slot];
  const centreY = proj.sy[slot];
  const scaleX = maskW / viewW;
  const scaleY = maskH / viewH;
  const radius = Math.max(0, proj.sr?.[slot] ?? 0);
  const radiusX = Math.max(0.65, radius * scaleX);
  const radiusY = Math.max(0.65, radius * scaleY);
  const centreU = centreX * scaleX;
  const centreV = centreY * scaleY;

  if (radius < 1.5) {
    const u = Math.floor(centreU);
    const v = Math.floor(centreV);
    if (u < 0 || u >= maskW || v < 0 || v >= maskH
      || !mask[v * maskW + u]) return null;
    return { x: centreX, y: centreY, coverage: 1 };
  }

  const x1 = Math.max(0, Math.floor(centreU - radiusX));
  const y1 = Math.max(0, Math.floor(centreV - radiusY));
  const x2 = Math.min(maskW, Math.ceil(centreU + radiusX) + 1);
  const y2 = Math.min(maskH, Math.ceil(centreV + radiusY) + 1);
  const occupied = integralRectSum(integral, maskW + 1, x1, y1, x2, y2);
  if (!occupied) return null;

  // Centre plus two rings. The weights approximate a radial Gaussian, so a
  // mask grazing the faint tail cannot dominate a view while still remaining
  // selectable when that is the only visible contribution.
  const samples = [
    [0, 0, 1],
    [0.48, 0, 0.58], [-0.48, 0, 0.58],
    [0, 0.48, 0.58], [0, -0.48, 0.58],
    [0.339, 0.339, 0.58], [-0.339, 0.339, 0.58],
    [0.339, -0.339, 0.58], [-0.339, -0.339, 0.58],
    [0.86, 0, 0.18], [-0.86, 0, 0.18],
    [0, 0.86, 0.18], [0, -0.86, 0.18],
    [0.608, 0.608, 0.18], [-0.608, 0.608, 0.18],
    [0.608, -0.608, 0.18], [-0.608, -0.608, 0.18],
  ];
  let insideWeight = 0;
  let totalWeight = 0;
  let representative = null;
  for (const [dx, dy, weight] of samples) {
    const u = Math.floor(centreU + dx * radiusX);
    const v = Math.floor(centreV + dy * radiusY);
    totalWeight += weight;
    if (u < 0 || u >= maskW || v < 0 || v >= maskH
      || !mask[v * maskW + u]) continue;
    insideWeight += weight;
    if (!representative || weight > representative.weight) {
      representative = {
        x: (u + 0.5) / scaleX,
        y: (v + 0.5) / scaleY,
        weight,
      };
    }
  }

  // Very large splats can intersect a thin hand-painted mask between sample
  // points. Preserve that real overlap with a small, explicitly weak weight.
  const rectangleArea = Math.max(1, (x2 - x1) * (y2 - y1));
  const rectangleCoverage = occupied / rectangleArea;
  const coverage = Math.max(
    insideWeight / Math.max(1e-6, totalWeight),
    Math.min(0.16, rectangleCoverage * 0.42),
  );
  if (coverage < 0.018) return null;
  return {
    x: representative?.x ?? centreX,
    y: representative?.y ?? centreY,
    coverage,
  };
}

function buildMaskIntegral(mask, width, height) {
  const stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    const source = y * width;
    const target = (y + 1) * stride;
    const previous = y * stride;
    for (let x = 0; x < width; x++) {
      row += mask[source + x] ? 1 : 0;
      integral[target + x + 1] = integral[previous + x + 1] + row;
    }
  }
  return integral;
}

function integralRectSum(integral, stride, x1, y1, x2, y2) {
  return integral[y2 * stride + x2]
    - integral[y1 * stride + x2]
    - integral[y2 * stride + x1]
    + integral[y1 * stride + x1];
}

function validateProjectionIndices(count, indices) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff) {
    throw new RangeError('Projection scene count must be an unsigned 32-bit integer');
  }
  for (let slot = 0; slot < indices.length; slot++) {
    if (indices[slot] >= count) {
      throw new RangeError(
        `Projection Gaussian id ${indices[slot]} is outside scene count ${count}`,
      );
    }
  }
}

async function validateProjectionIndicesAsync(
  count,
  indices,
  onProgress,
  shouldCancel,
  {
    chunkSize = 32_000,
    yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = {},
) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff) {
    throw new RangeError('Projection scene count must be an unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive integer');
  }
  for (let start = 0; start < indices.length; start += chunkSize) {
    if (shouldCancel()) {
      throw new DOMException('Projection index validation superseded', 'AbortError');
    }
    const end = Math.min(indices.length, start + chunkSize);
    for (let slot = start; slot < end; slot++) {
      if (indices[slot] >= count) {
        throw new RangeError(
          `Projection Gaussian id ${indices[slot]} is outside scene count ${count}`,
        );
      }
    }
    onProgress(end / Math.max(1, indices.length));
    if (end < indices.length) await yieldTask();
  }
}
