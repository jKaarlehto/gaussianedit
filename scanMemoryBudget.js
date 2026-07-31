import { estimateCompactLookupBytes } from './compactIndexLookup.js';

const MIB = 1024 * 1024;
const TILE_SIZE = 4;

export const DEFAULT_SCAN_MEMORY_LIMITS = Object.freeze({
  peakBytes: 224 * MIB,
  baseOverheadBytes: 12 * MIB,
  maxLongEdge: 1280,
  minLongEdge: 512,
  maxPixelsPerView: 1_200_000,
  maxViews: 8,
  minViews: 4,
  maxCutoutSplats: 360_000,
  minCutoutSplats: 24_000,
  maxProjectionSplats: 360_000,
  maxEvidenceSplats: 360_000,
  cutoutBytesPerSplat: 104,
  projectionBytesPerSplat: 16,
  evidenceBytesPerSplat: 44,
  selectionCopyBytesPerSplat: 36,
  stagedBytesPerPixelPerView: 10,
  activeCaptureBytesPerPixel: 20,
});

/**
 * Conservative peak estimate. It includes resident Gaussian data and sorting
 * auxiliaries, compact global-id lookup, all projection arrays, three depth
 * layers, three nearest-id layers, evidence arrays plus touched-id overhead,
 * staged RGB/mask/encoded frames, and one active render/readback transaction.
 */
export function estimateScanPeakBytes({
  width,
  height,
  viewCount,
  trackingViewCount = viewCount,
  cutoutSplats,
  projectionSplats = cutoutSplats,
  evidenceSplats = projectionSplats,
  selectionSplats = 0,
  limits = DEFAULT_SCAN_MEMORY_LIMITS,
} = {}) {
  const normalized = normalizeEstimateInput({
    width,
    height,
    viewCount,
    trackingViewCount,
    cutoutSplats,
    projectionSplats,
    evidenceSplats,
    selectionSplats,
  });
  const config = normalizeLimits(limits);
  const pixels = normalized.width * normalized.height;
  const tiles = Math.ceil(normalized.width / TILE_SIZE)
    * Math.ceil(normalized.height / TILE_SIZE);
  const lookupBytes = normalized.projectionSplats
    ? estimateCompactLookupBytes(normalized.projectionSplats)
    : 0;
  const breakdown = Object.freeze({
    base: config.baseOverheadBytes,
    cutout: normalized.cutoutSplats * config.cutoutBytesPerSplat,
    projectionIndices: normalized.projectionSplats
      * Uint32Array.BYTES_PER_ELEMENT,
    projectionLookup: lookupBytes,
    projection: normalized.projectionSplats
      * config.projectionBytesPerSplat,
    projectionTiles: tiles * 6 * Uint32Array.BYTES_PER_ELEMENT,
    evidence: normalized.evidenceSplats * config.evidenceBytesPerSplat,
    selectionCopies: normalized.selectionSplats
      * config.selectionCopyBytesPerSplat,
    stagedFrames: pixels * normalized.trackingViewCount
      * config.stagedBytesPerPixelPerView,
    activeCapture: pixels * config.activeCaptureBytesPerPixel,
    maskIntegral: (normalized.width + 1) * (normalized.height + 1)
      * Uint32Array.BYTES_PER_ELEMENT,
  });
  const peakBytes = Object.values(breakdown)
    .reduce((total, bytes) => total + bytes, 0);
  return Object.freeze({
    ...normalized,
    pixels,
    tiles,
    peakBytes,
    breakdown,
  });
}

/**
 * Plan a scan before allocating any large buffer.
 *
 * Degradation is deterministic: enforce component caps, reduce capture
 * resolution, reduce view count, then shrink the resident cutout. If the
 * declared minimum useful scan still exceeds the peak budget, reject it.
 */
export function planScanMemory({
  width,
  height,
  viewCount,
  trackingViewCount = viewCount,
  cutoutSplats,
  selectionSplats = 0,
  limits = DEFAULT_SCAN_MEMORY_LIMITS,
} = {}) {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  assertPositiveInteger(viewCount, 'viewCount');
  assertPositiveInteger(trackingViewCount, 'trackingViewCount');
  assertPositiveInteger(cutoutSplats, 'cutoutSplats');
  assertNonNegativeInteger(selectionSplats, 'selectionSplats');
  if (!Number.isSafeInteger(width * height)) {
    throw new RangeError('width × height exceeds the safe pixel range');
  }
  const config = normalizeLimits(limits);
  const decisions = [];

  let dimensions = fitDimensions(width, height, {
    longEdgeCap: config.maxLongEdge,
    pixelCap: config.maxPixelsPerView,
  });
  if (dimensions.width !== width || dimensions.height !== height) {
    decisions.push('reduce-resolution-to-component-cap');
  }
  let views = Math.min(viewCount, config.maxViews);
  if (views !== viewCount) decisions.push('reduce-view-count-to-component-cap');
  let splats = Math.min(
    cutoutSplats,
    config.maxCutoutSplats,
    config.maxProjectionSplats,
    config.maxEvidenceSplats,
  );
  if (splats !== cutoutSplats) decisions.push('reduce-cutout-to-component-cap');

  const estimate = () => estimateScanPeakBytes({
    width: dimensions.width,
    height: dimensions.height,
    viewCount: views,
    trackingViewCount,
    cutoutSplats: splats,
    projectionSplats: splats,
    evidenceSplats: splats,
    selectionSplats,
    limits: config,
  });
  let reservation = estimate();

  if (reservation.peakBytes > config.peakBytes) {
    const minimumDimensions = fitDimensions(width, height, {
      longEdgeCap: Math.min(config.minLongEdge, Math.max(width, height)),
      pixelCap: Number.MAX_SAFE_INTEGER,
    });
    const minimumPixels = minimumDimensions.width * minimumDimensions.height;
    const fixedWithoutPixelBuffers = reservation.peakBytes
      - reservation.pixels * (
        trackingViewCount * config.stagedBytesPerPixelPerView
        + config.activeCaptureBytesPerPixel
      )
      - reservation.breakdown.maskIntegral;
    const pixelBytes = trackingViewCount * config.stagedBytesPerPixelPerView
      + config.activeCaptureBytesPerPixel
      + Uint32Array.BYTES_PER_ELEMENT;
    const affordablePixels = Math.floor(
      (config.peakBytes - fixedWithoutPixelBuffers) / Math.max(1, pixelBytes),
    );
    if (affordablePixels < reservation.pixels) {
      dimensions = fitDimensions(width, height, {
        longEdgeCap: dimensions.longEdge,
        pixelCap: Math.max(minimumPixels, affordablePixels),
      });
      decisions.push('reduce-resolution-for-peak-budget');
      reservation = estimate();
    }
  }

  while (reservation.peakBytes > config.peakBytes && views > config.minViews) {
    views--;
    reservation = estimate();
  }
  if (views < Math.min(viewCount, config.maxViews)) {
    decisions.push('reduce-view-count-for-peak-budget');
  }

  if (reservation.peakBytes > config.peakBytes
    && splats > config.minCutoutSplats) {
    let low = config.minCutoutSplats;
    let high = splats;
    let best = -1;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      const candidateReservation = estimateScanPeakBytes({
        width: dimensions.width,
        height: dimensions.height,
        viewCount: views,
        trackingViewCount,
        cutoutSplats: candidate,
        projectionSplats: candidate,
        evidenceSplats: candidate,
        selectionSplats,
        limits: config,
      });
      if (candidateReservation.peakBytes <= config.peakBytes) {
        best = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }
    splats = best >= 0 ? best : config.minCutoutSplats;
    decisions.push('reduce-cutout-for-peak-budget');
    reservation = estimate();
  }

  if (reservation.peakBytes > config.peakBytes
    || views < config.minViews
    || (cutoutSplats > 0 && splats < config.minCutoutSplats)) {
    return Object.freeze({
      status: 'rejected',
      action: 'fail-closed',
      reason: 'minimum useful scan exceeds the declared peak memory budget',
      decisions: Object.freeze([...decisions, 'fail-closed']),
      width: dimensions.width,
      height: dimensions.height,
      viewCount: views,
      cutoutSplats: splats,
      reservation,
      limits: config,
    });
  }

  return Object.freeze({
    status: decisions.length ? 'reduced' : 'ok',
    action: decisions.at(-1) ?? 'use-requested-plan',
    reason: '',
    decisions: Object.freeze(decisions),
    width: dimensions.width,
    height: dimensions.height,
    viewCount: views,
    cutoutSplats: splats,
    reservation,
    limits: config,
  });
}

/**
 * Runtime reservation ledger for scan-owned allocations. This does not guess
 * browser memory; it enforces the explicit peak selected by the planner.
 */
export class ScanMemoryLedger {
  constructor(capacityBytes) {
    assertPositiveInteger(capacityBytes, 'capacityBytes');
    this.capacityBytes = capacityBytes;
    this.usedBytes = 0;
    this.peakBytes = 0;
    this.nextToken = 1;
    this.reservations = new Map();
  }

  tryReserve(label, bytes) {
    if (typeof label !== 'string' || !label.trim()) {
      throw new TypeError('Reservation label must be a non-empty string');
    }
    assertNonNegativeInteger(bytes, 'bytes');
    const availableBytes = this.capacityBytes - this.usedBytes;
    if (bytes > availableBytes) {
      return Object.freeze({
        ok: false,
        label,
        requestedBytes: bytes,
        availableBytes,
      });
    }
    const token = this.nextToken++;
    this.reservations.set(token, { label, bytes });
    this.usedBytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.usedBytes);
    return Object.freeze({
      ok: true,
      token,
      label,
      bytes,
      usedBytes: this.usedBytes,
      availableBytes: this.capacityBytes - this.usedBytes,
    });
  }

  release(token) {
    const reservation = this.reservations.get(token);
    if (!reservation) return false;
    this.reservations.delete(token);
    this.usedBytes -= reservation.bytes;
    return true;
  }

  snapshot() {
    return Object.freeze({
      capacityBytes: this.capacityBytes,
      usedBytes: this.usedBytes,
      availableBytes: this.capacityBytes - this.usedBytes,
      peakBytes: this.peakBytes,
      reservations: Object.freeze([...this.reservations.entries()].map(
        ([token, value]) => Object.freeze({ token, ...value }),
      )),
    });
  }
}

function normalizeEstimateInput(values) {
  for (const name of ['width', 'height', 'viewCount', 'trackingViewCount']) {
    assertPositiveInteger(values[name], name);
  }
  for (const name of [
    'cutoutSplats',
    'projectionSplats',
    'evidenceSplats',
    'selectionSplats',
  ]) {
    assertNonNegativeInteger(values[name], name);
  }
  if (values.projectionSplats > values.cutoutSplats) {
    throw new RangeError('projectionSplats cannot exceed the resident cutout');
  }
  if (values.evidenceSplats > values.projectionSplats) {
    throw new RangeError('evidenceSplats cannot exceed projected splats');
  }
  return Object.freeze({ ...values });
}

function normalizeLimits(limits) {
  const config = { ...DEFAULT_SCAN_MEMORY_LIMITS, ...(limits ?? {}) };
  for (const name of [
    'peakBytes',
    'baseOverheadBytes',
    'maxLongEdge',
    'minLongEdge',
    'maxPixelsPerView',
    'maxViews',
    'minViews',
    'maxCutoutSplats',
    'minCutoutSplats',
    'maxProjectionSplats',
    'maxEvidenceSplats',
    'cutoutBytesPerSplat',
    'projectionBytesPerSplat',
    'evidenceBytesPerSplat',
    'selectionCopyBytesPerSplat',
    'stagedBytesPerPixelPerView',
    'activeCaptureBytesPerPixel',
  ]) assertPositiveInteger(config[name], `limits.${name}`);
  if (config.minLongEdge > config.maxLongEdge
    || config.minViews > config.maxViews
    || config.minCutoutSplats > config.maxCutoutSplats
    || config.maxProjectionSplats > config.maxCutoutSplats
    || config.maxEvidenceSplats > config.maxProjectionSplats) {
    throw new RangeError('Scan memory minimums and component caps are inconsistent');
  }
  return Object.freeze(config);
}

function fitDimensions(width, height, { longEdgeCap, pixelCap }) {
  const pixels = width * height;
  const scale = Math.min(
    1,
    longEdgeCap / Math.max(width, height),
    Math.sqrt(pixelCap / pixels),
  );
  const plannedWidth = Math.max(1, Math.floor(width * scale));
  const plannedHeight = Math.max(1, Math.floor(height * scale));
  return Object.freeze({
    width: plannedWidth,
    height: plannedHeight,
    longEdge: Math.max(plannedWidth, plannedHeight),
    scale,
  });
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
