/**
 * The mask only ever tells you about the visible shell. A wall tile has a
 * back and a thickness; SAM never saw those splats.
 *
 * So we flood fill in 3D from the visible seeds, but constrained by the
 * mask's own view frustum: a neighbour is accepted only if it still
 * projects inside the mask and sits within a depth band of the seed
 * surface. That lets the selection eat backwards through the object
 * without leaking sideways onto the neighbouring tile.
 *
 * This is a heuristic, and it is the weakest link in the pipeline. It
 * cannot know that the far side of an opaque wall belongs to the same
 * object — nothing at click-time can. See README > "Going 3D-complete".
 */

import { inMask, projectionSlot } from './lift.js';

/** CSR-style uniform grid. Built once at load; O(n) and allocation-free per query. */
export function buildGrid(centers, count, cell) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const nCells = nx * ny * nz;

  const cellOf = new Int32Array(count);
  const counts = new Int32Array(nCells + 1);

  for (let i = 0; i < count; i++) {
    const ix = Math.min(nx - 1, ((centers[i * 3] - minX) / cell) | 0);
    const iy = Math.min(ny - 1, ((centers[i * 3 + 1] - minY) / cell) | 0);
    const iz = Math.min(nz - 1, ((centers[i * 3 + 2] - minZ) / cell) | 0);
    const c = (iz * ny + iy) * nx + ix;
    cellOf[i] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];

  const items = new Int32Array(count);
  const cursor = counts.slice(0, nCells);
  for (let i = 0; i < count; i++) items[cursor[cellOf[i]]++] = i;

  return { nx, ny, nz, cell, minX, minY, minZ, start: counts, items };
}

/**
 * Responsive version of buildGrid(). It yields between bounded chunks so the
 * progress UI, renderer, and cancellation checks continue to run on large
 * scenes instead of presenting a frozen tab.
 */
export async function buildGridAsync(
  centers,
  count,
  cell,
  onProgress = () => {},
  shouldCancel = () => false,
  domain = null,
) {
  const CHUNK = 100_000;
  const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));
  const check = () => {
    if (shouldCancel()) throw new DOMException('Grid build superseded', 'AbortError');
  };

  let minX = domain?.min?.x ?? Infinity;
  let minY = domain?.min?.y ?? Infinity;
  let minZ = domain?.min?.z ?? Infinity;
  let maxX = domain?.max?.x ?? -Infinity;
  let maxY = domain?.max?.y ?? -Infinity;
  let maxZ = domain?.max?.z ?? -Infinity;
  if (!domain) {
    for (let i0 = 0; i0 < count; i0 += CHUNK) {
      const i1 = Math.min(count, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      check();
      onProgress(0.2 * i1 / count, 'measuring scene');
      await yieldTask();
    }
  } else {
    onProgress(0.2, 'measuring scene');
  }

  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const nCells = nx * ny * nz;
  if (!Number.isSafeInteger(nCells) || nCells > 100_000_000) {
    throw new Error('Scene index is too large; use robust scene bounds.');
  }
  const cellOf = new Int32Array(count);
  cellOf.fill(-1);
  const counts = new Int32Array(nCells + 1);
  let includedCount = 0;

  for (let i0 = 0; i0 < count; i0 += CHUNK) {
    const i1 = Math.min(count, i0 + CHUNK);
    for (let i = i0; i < i1; i++) {
      const x = centers[i * 3];
      const y = centers[i * 3 + 1];
      const z = centers[i * 3 + 2];
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) {
        continue;
      }
      const ix = Math.min(nx - 1, ((x - minX) / cell) | 0);
      const iy = Math.min(ny - 1, ((y - minY) / cell) | 0);
      const iz = Math.min(nz - 1, ((z - minZ) / cell) | 0);
      const c = (iz * ny + iy) * nx + ix;
      cellOf[i] = c;
      counts[c + 1]++;
      includedCount++;
    }
    check();
    onProgress(0.2 + 0.3 * i1 / count, 'binning splats');
    await yieldTask();
  }

  for (let c0 = 0; c0 < nCells; c0 += CHUNK) {
    const c1 = Math.min(nCells, c0 + CHUNK);
    for (let c = c0; c < c1; c++) counts[c + 1] += counts[c];
    check();
    onProgress(0.5 + 0.15 * c1 / nCells, 'linking cells');
    await yieldTask();
  }

  const items = new Int32Array(includedCount);
  const cursor = counts.slice(0, nCells);
  for (let i0 = 0; i0 < count; i0 += CHUNK) {
    const i1 = Math.min(count, i0 + CHUNK);
    for (let i = i0; i < i1; i++) {
      const cellIndex = cellOf[i];
      if (cellIndex >= 0) items[cursor[cellIndex]++] = i;
    }
    check();
    onProgress(0.65 + 0.35 * i1 / count, 'finalizing index');
    await yieldTask();
  }

  onProgress(1, 'index ready');
  return {
    nx,
    ny,
    nz,
    cell,
    minX,
    minY,
    minZ,
    start: counts,
    items,
    cellOf,
    includedCount,
  };
}

export function grow({
  grid, centers, colors, seeds,
  proj, mask, maskW, maskH, viewW, viewH,
  radius, steps, depthBand, colorTol = 60,
}) {
  const count = centers.length / 3;
  const visited = new Uint8Array(proj.projectedCount ?? count);
  const selected = [];
  for (const seed of seeds) {
    const slot = projectionSlot(proj, seed);
    if (slot < 0 || visited[slot]) continue;
    visited[slot] = 1;
    selected.push(seed);
  }
  if (steps <= 0 || radius <= 0) return new Set(selected);

  const { nx, ny, nz, cell, minX, minY, minZ, start, items } = grid;
  const r2 = radius * radius;
  const cellReach = Math.max(1, Math.ceil(radius / cell));

  let frontier = selected.slice();
  let depthMin = Infinity, depthMax = -Infinity;
  for (const s of seeds) {
    const slot = projectionSlot(proj, s);
    if (slot < 0) continue;
    const d = proj.sd[slot];
    if (d < depthMin) depthMin = d;
    if (d > depthMax) depthMax = d;
  }
  const near = depthMin - depthBand;
  const far = depthMax + depthBand;

  for (let step = 0; step < steps && frontier.length; step++) {
    const next = [];

    for (const s of frontier) {
      if (grid.cellOf?.[s] < 0) continue;
      const px = centers[s * 3], py = centers[s * 3 + 1], pz = centers[s * 3 + 2];
      const sr = colors ? colors[s * 3] : 0;
      const sg = colors ? colors[s * 3 + 1] : 0;
      const sb = colors ? colors[s * 3 + 2] : 0;

      const ix = Math.min(nx - 1, ((px - minX) / cell) | 0);
      const iy = Math.min(ny - 1, ((py - minY) / cell) | 0);
      const iz = Math.min(nz - 1, ((pz - minZ) / cell) | 0);

      for (let dz = -cellReach; dz <= cellReach; dz++) {
        const cz = iz + dz; if (cz < 0 || cz >= nz) continue;
        for (let dy = -cellReach; dy <= cellReach; dy++) {
          const cy = iy + dy; if (cy < 0 || cy >= ny) continue;
          for (let dx = -cellReach; dx <= cellReach; dx++) {
            const cx = ix + dx; if (cx < 0 || cx >= nx) continue;

            const c = (cz * ny + cy) * nx + cx;
            for (let k = start[c]; k < start[c + 1]; k++) {
              const j = items[k];
              const slot = projectionSlot(proj, j);
              if (slot < 0 || visited[slot]) continue;

              const ex = centers[j * 3] - px;
              const ey = centers[j * 3 + 1] - py;
              const ez = centers[j * 3 + 2] - pz;
              if (ex * ex + ey * ey + ez * ez > r2) continue;

              const d = proj.sd[slot];
              if (d <= 0 || d < near || d > far) continue;
              if (!inMask(j, proj, mask, maskW, maskH, viewW, viewH)) continue;

              if (colors) {
                const cr = Math.abs(colors[j * 3] - sr)
                  + Math.abs(colors[j * 3 + 1] - sg)
                  + Math.abs(colors[j * 3 + 2] - sb);
                if (cr > colorTol * 3) continue;
              }

              visited[slot] = 1;
              selected.push(j);
              next.push(j);
            }
          }
        }
      }
    }
    frontier = next;
  }

  return new Set(selected);
}

/**
 * Cancellable/yielding version used by the interactive selection pipeline.
 * The algorithm matches grow(), but large frontiers are split across tasks.
 */
export async function growAsync({
  grid, centers, colors, seeds,
  proj, mask, maskW, maskH, viewW, viewH,
  radius, steps, depthBand, colorTol = 60,
}, onProgress = () => {}, shouldCancel = () => false) {
  const count = centers.length / 3;
  const visited = new Uint8Array(proj.projectedCount ?? count);
  const selected = [];
  for (const seed of seeds) {
    const slot = projectionSlot(proj, seed);
    if (slot < 0 || visited[slot]) continue;
    visited[slot] = 1;
    selected.push(seed);
  }
  if (steps <= 0 || radius <= 0) return new Set(selected);

  const { nx, ny, nz, cell, minX, minY, minZ, start, items } = grid;
  const r2 = radius * radius;
  const cellReach = Math.max(1, Math.ceil(radius / cell));
  let frontier = selected.slice();
  let depthMin = Infinity, depthMax = -Infinity;
  for (const seed of seeds) {
    const slot = projectionSlot(proj, seed);
    if (slot < 0) continue;
    const depth = proj.sd[slot];
    if (depth < depthMin) depthMin = depth;
    if (depth > depthMax) depthMax = depth;
  }
  const near = depthMin - depthBand;
  const far = depthMax + depthBand;
  const FRONTIER_CHUNK = 1500;

  for (let step = 0; step < steps && frontier.length; step++) {
    const next = [];
    for (let s0 = 0; s0 < frontier.length; s0 += FRONTIER_CHUNK) {
      const s1 = Math.min(frontier.length, s0 + FRONTIER_CHUNK);
      for (let si = s0; si < s1; si++) {
        const source = frontier[si];
        if (grid.cellOf?.[source] < 0) continue;
        const px = centers[source * 3];
        const py = centers[source * 3 + 1];
        const pz = centers[source * 3 + 2];
        const sr = colors ? colors[source * 3] : 0;
        const sg = colors ? colors[source * 3 + 1] : 0;
        const sb = colors ? colors[source * 3 + 2] : 0;
        const ix = Math.min(nx - 1, ((px - minX) / cell) | 0);
        const iy = Math.min(ny - 1, ((py - minY) / cell) | 0);
        const iz = Math.min(nz - 1, ((pz - minZ) / cell) | 0);

        for (let dz = -cellReach; dz <= cellReach; dz++) {
          const cz = iz + dz; if (cz < 0 || cz >= nz) continue;
          for (let dy = -cellReach; dy <= cellReach; dy++) {
            const cy = iy + dy; if (cy < 0 || cy >= ny) continue;
            for (let dx = -cellReach; dx <= cellReach; dx++) {
              const cx = ix + dx; if (cx < 0 || cx >= nx) continue;
              const cellIndex = (cz * ny + cy) * nx + cx;
              for (let k = start[cellIndex]; k < start[cellIndex + 1]; k++) {
                const candidate = items[k];
                const slot = projectionSlot(proj, candidate);
                if (slot < 0 || visited[slot]) continue;

                const ex = centers[candidate * 3] - px;
                const ey = centers[candidate * 3 + 1] - py;
                const ez = centers[candidate * 3 + 2] - pz;
                if (ex * ex + ey * ey + ez * ez > r2) continue;

                const depth = proj.sd[slot];
                if (depth <= 0 || depth < near || depth > far) continue;
                if (!inMask(candidate, proj, mask, maskW, maskH, viewW, viewH)) continue;

                if (colors) {
                  const colorDistance = Math.abs(colors[candidate * 3] - sr)
                    + Math.abs(colors[candidate * 3 + 1] - sg)
                    + Math.abs(colors[candidate * 3 + 2] - sb);
                  if (colorDistance > colorTol * 3) continue;
                }

                visited[slot] = 1;
                selected.push(candidate);
                next.push(candidate);
              }
            }
          }
        }
      }

      if (shouldCancel()) throw new DOMException('3D completion superseded', 'AbortError');
      const withinStep = frontier.length ? s1 / frontier.length : 1;
      onProgress((step + withinStep) / steps, selected.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    frontier = next;
  }

  onProgress(1, selected.length);
  return new Set(selected);
}
