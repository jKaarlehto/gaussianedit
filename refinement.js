import { projectionSlot } from './lift.js';

const YIELD_EVERY = 1400;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function cellCoords(index, grid) {
  const x = index % grid.nx;
  const yz = (index / grid.nx) | 0;
  return [x, yz % grid.ny, (yz / grid.ny) | 0];
}

function cellIndexForPoint(centers, index, grid) {
  const x = Math.max(0, Math.min(
    grid.nx - 1,
    ((centers[index * 3] - grid.minX) / grid.cell) | 0,
  ));
  const y = Math.max(0, Math.min(
    grid.ny - 1,
    ((centers[index * 3 + 1] - grid.minY) / grid.cell) | 0,
  ));
  const z = Math.max(0, Math.min(
    grid.nz - 1,
    ((centers[index * 3 + 2] - grid.minZ) / grid.cell) | 0,
  ));
  return (z * grid.ny + y) * grid.nx + x;
}

function forEachNearby(index, centers, grid, radius, visit) {
  const centreCell = cellIndexForPoint(centers, index, grid);
  const [ix, iy, iz] = cellCoords(centreCell, grid);
  const reach = Math.max(1, Math.ceil(radius / grid.cell));
  const radius2 = radius * radius;
  const px = centers[index * 3];
  const py = centers[index * 3 + 1];
  const pz = centers[index * 3 + 2];

  for (let dz = -reach; dz <= reach; dz++) {
    const z = iz + dz;
    if (z < 0 || z >= grid.nz) continue;
    for (let dy = -reach; dy <= reach; dy++) {
      const y = iy + dy;
      if (y < 0 || y >= grid.ny) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const x = ix + dx;
        if (x < 0 || x >= grid.nx) continue;
        const cellIndex = (z * grid.ny + y) * grid.nx + x;
        for (let k = grid.start[cellIndex]; k < grid.start[cellIndex + 1]; k++) {
          const candidate = grid.items[k];
          if (candidate === index) continue;
          const ex = centers[candidate * 3] - px;
          const ey = centers[candidate * 3 + 1] - py;
          const ez = centers[candidate * 3 + 2] - pz;
          const distance2 = ex * ex + ey * ey + ez * ez;
          if (distance2 <= radius2) visit(candidate, Math.sqrt(distance2));
        }
      }
    }
  }
}

/**
 * Applies confidence gates and optional 3D cleanup after the mask-constrained
 * grow. This is deliberately model-agnostic: SAM, classic fill, YOLO proposals,
 * and future feature fields all produce the same confidence-aware result.
 */
export async function refineSelectionAsync({
  region,
  seeds,
  projection,
  maskConfidence,
  maskW,
  maskH,
  viewW,
  viewH,
  splat,
  grid,
  baseSelection,
  baseConfidence,
  subtract = false,
  locked,
  minimumConfidence = 0.34,
  confirmConfidence = 0.72,
  modelConfidence = 0.82,
  includeNearbyRadius = 0,
  removeDisconnected = false,
  minimumComponentSize = 24,
  componentRadius,
}, onProgress = () => {}, shouldCancel = () => false) {
  const selection = new Set(baseSelection);
  const confidence = baseConfidence?.slice?.() ?? new Float32Array(splat.count);
  const seedSet = new Set(seeds);
  const candidates = new Map();
  const maskScaleX = maskW / viewW;
  const maskScaleY = maskH / viewH;
  let processed = 0;

  for (const index of region) {
    const opacity = (splat.opacity?.[index] ?? 255) / 255;
    let boundary = 1;
    if (seedSet.has(index) && maskConfidence) {
      const slot = projectionSlot(projection, index);
      if (slot < 0) continue;
      const x = Math.max(0, Math.min(maskW - 1, (projection.sx[slot] * maskScaleX) | 0));
      const y = Math.max(0, Math.min(maskH - 1, (projection.sy[slot] * maskScaleY) | 0));
      boundary = maskConfidence[y * maskW + x] || 0.45;
    }
    const source = seedSet.has(index)
      ? 0.74 + modelConfidence * 0.22
      : 0.46 + modelConfidence * 0.3;
    candidates.set(index, clamp01(source * (0.72 + opacity * 0.28) * boundary));
    if (++processed % 80_000 === 0) {
      if (shouldCancel()) throw new DOMException('Refinement superseded', 'AbortError');
      onProgress(0.16 * processed / Math.max(1, region.size), 'scoring mask evidence');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (!subtract && includeNearbyRadius > 0 && candidates.size) {
    const sources = [...candidates.keys()];
    for (let offset = 0; offset < sources.length; offset += YIELD_EVERY) {
      const end = Math.min(sources.length, offset + YIELD_EVERY);
      for (let n = offset; n < end; n++) {
        const sourceIndex = sources[n];
        forEachNearby(sourceIndex, splat.centers, grid, includeNearbyRadius, (candidate, distance) => {
          if (candidates.has(candidate) || selection.has(candidate)) return;
          const opacity = (splat.opacity?.[candidate] ?? 255) / 255;
          const proximity = 1 - distance / includeNearbyRadius;
          const score = clamp01(0.22 + proximity * 0.34 + opacity * 0.14);
          if (score >= minimumConfidence) candidates.set(candidate, score);
        });
      }
      if (shouldCancel()) throw new DOMException('Refinement superseded', 'AbortError');
      onProgress(0.16 + 0.22 * end / sources.length, 'checking nearby unassigned splats');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const candidateSelection = new Set();
  for (const [index, score] of candidates) {
    if (score >= minimumConfidence || locked?.[index]) candidateSelection.add(index);
  }

  let filtered = candidateSelection;
  if (!subtract && removeDisconnected && candidateSelection.size > 1 && minimumComponentSize > 1) {
    filtered = await removeSmallComponents({
      selection: candidateSelection,
      centers: splat.centers,
      grid,
      radius: Math.max(componentRadius, grid.cell),
      minimumSize: minimumComponentSize,
      locked,
      onProgress: (value) => onProgress(0.38 + value * 0.3, 'removing disconnected fragments'),
      shouldCancel,
    });
  }

  const recentlyAdded = new Set();
  if (subtract) {
    for (const index of filtered) {
      if (locked?.[index]) continue;
      selection.delete(index);
      confidence[index] = 0;
    }
  } else {
    for (const index of filtered) {
      if (!selection.has(index)) recentlyAdded.add(index);
      selection.add(index);
      confidence[index] = Math.max(confidence[index], candidates.get(index) ?? minimumConfidence);
    }
  }
  // Locked Gaussians are already members of the active selection. Iterating
  // the entire 8–10M lock bitmap made a small visible-side lift scale with the
  // whole scene for no semantic benefit.
  for (const index of selection) {
    if (!locked?.[index]) continue;
    confidence[index] = Math.max(confidence[index], confirmConfidence);
  }

  const provisional = new Set();
  let confirmedCount = 0;
  for (const index of selection) {
    if (locked?.[index] || confidence[index] >= confirmConfidence) confirmedCount++;
    else provisional.add(index);
  }
  onProgress(1, 'refinement ready');
  return {
    selection,
    confidence,
    provisional,
    recentlyAdded,
    confirmedCount,
    candidateCount: candidates.size,
  };
}

async function removeSmallComponents({
  selection,
  centers,
  grid,
  radius,
  minimumSize,
  locked,
  onProgress,
  shouldCancel,
}) {
  const visited = new Uint8Array(centers.length / 3);
  const kept = new Set();
  const all = [...selection];

  for (let start = 0; start < all.length; start++) {
    const seed = all[start];
    if (visited[seed]) continue;
    const queue = [seed];
    const component = [];
    let head = 0;
    let containsLock = false;
    visited[seed] = 1;

    while (head < queue.length) {
      const index = queue[head++];
      component.push(index);
      containsLock ||= Boolean(locked?.[index]);
      forEachNearby(index, centers, grid, radius, (candidate) => {
        if (!selection.has(candidate) || visited[candidate]) return;
        visited[candidate] = 1;
        queue.push(candidate);
      });
      if (head % YIELD_EVERY === 0) {
        if (shouldCancel()) throw new DOMException('Component cleanup superseded', 'AbortError');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (containsLock || component.length >= minimumSize) {
      for (const index of component) kept.add(index);
    }
    if (start % YIELD_EVERY === 0) {
      onProgress(start / all.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress(1);
  return kept;
}

export function selectionStats(
  selection,
  confidence,
  locked,
  confirmThreshold,
  forcedProvisional = null,
) {
  let confirmed = 0;
  let provisional = 0;
  let lockedCount = 0;
  for (const index of selection) {
    if (locked?.[index]) lockedCount++;
    if (locked?.[index]
      || (!forcedProvisional?.has?.(index)
        && (confidence?.[index] ?? 1) >= confirmThreshold)) confirmed++;
    else provisional++;
  }
  return {
    total: selection.size,
    confirmed,
    provisional,
    locked: lockedCount,
  };
}
