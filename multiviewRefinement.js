/**
 * Calibrated-view parsing and visibility-aware vote fusion are kept separate
 * from the 2D model. A SAM tracker, per-frame prompt decoder, or remote service
 * can all satisfy the same proposal contract.
 */

import {
  compactLookupSlot,
  createCompactIndexLookup,
} from './compactIndexLookup.js';

export function parseCalibratedViewSet(json, filename = 'camera metadata') {
  if (!json || typeof json !== 'object') throw new Error('Camera metadata must be a JSON object.');
  const sourceFrames = Array.isArray(json.frames) ? json.frames
    : Array.isArray(json.cameras) ? json.cameras : null;
  if (!sourceFrames?.length) {
    throw new Error('No calibrated frames found. Expected a transforms.json-style frames array.');
  }

  const shared = {
    width: json.w ?? json.width ?? null,
    height: json.h ?? json.height ?? null,
    flX: json.fl_x ?? null,
    flY: json.fl_y ?? null,
    cx: json.cx ?? null,
    cy: json.cy ?? null,
    cameraAngleX: json.camera_angle_x ?? null,
    cameraAngleY: json.camera_angle_y ?? null,
  };
  const views = sourceFrames.map((frame, index) => {
    const matrix = frame.transform_matrix ?? frame.transform ?? frame.camera_to_world;
    const flat = Array.isArray(matrix?.[0]) ? matrix.flat() : matrix;
    if (!Array.isArray(flat) || flat.length !== 16 || flat.some((value) => !Number.isFinite(value))) {
      throw new Error(`Frame ${index + 1} does not contain a valid 4×4 camera transform.`);
    }
    return {
      id: frame.id ?? frame.file_path ?? frame.path ?? `view-${index + 1}`,
      label: frame.label ?? `View ${index + 1}`,
      transform: flat.map(Number),
      width: frame.w ?? frame.width ?? shared.width,
      height: frame.h ?? frame.height ?? shared.height,
      flX: frame.fl_x ?? shared.flX,
      flY: frame.fl_y ?? shared.flY,
      cx: frame.cx ?? shared.cx,
      cy: frame.cy ?? shared.cy,
      cameraAngleX: frame.camera_angle_x ?? shared.cameraAngleX,
      cameraAngleY: frame.camera_angle_y ?? shared.cameraAngleY,
      imagePath: frame.file_path ?? frame.path ?? null,
    };
  });

  if (views.length < 2) {
    throw new Error('Multiview refinement requires at least two calibrated camera poses.');
  }
  const distinct = new Set(views.map((view) => view.transform.map((v) => v.toFixed(5)).join(',')));
  if (distinct.size < 2) throw new Error('The metadata contains only one distinct camera pose.');
  return {
    id: `${filename}:${views.length}`,
    filename,
    type: 'calibrated-multiview',
    views,
  };
}

export function chooseRefinementViews(viewSet, requestedCount, currentPosition = null) {
  const count = Math.min(viewSet.views.length, Math.max(2, requestedCount));
  if (!currentPosition || viewSet.views.length <= count) return viewSet.views.slice(0, count);

  // Favor a broad baseline: greedily choose poses farthest from the current
  // camera and then from already-selected poses.
  const remaining = viewSet.views.map((view) => ({
    view,
    position: [view.transform[12], view.transform[13], view.transform[14]],
  }));
  const chosen = [];
  while (chosen.length < count && remaining.length) {
    let bestIndex = 0;
    let bestDistance = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const targets = chosen.length ? chosen.map((entry) => entry.position) : [currentPosition];
      const nearest = Math.min(...targets.map((target) => distance3(remaining[i].position, target)));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = i;
      }
    }
    chosen.push(remaining.splice(bestIndex, 1)[0]);
  }
  return chosen.map((entry) => entry.view);
}

export function createViewEvidence(
  splatCount,
  activeIndices = null,
  sharedIndexLookup = null,
) {
  const localCount = activeIndices?.length ?? splatCount;
  const globalIndices = activeIndices
    ? (activeIndices instanceof Uint32Array
      ? activeIndices
      : Uint32Array.from(activeIndices))
    : null;
  if (globalIndices) {
    for (let slot = 0; slot < globalIndices.length; slot++) {
      if (globalIndices[slot] >= splatCount) {
        throw new RangeError(
          `Evidence Gaussian id ${globalIndices[slot]} is outside scene count ${splatCount}`,
        );
      }
    }
  }
  const indexLookup = globalIndices
    ? (sharedIndexLookup ?? createCompactIndexLookup(globalIndices))
    : null;
  return {
    support: new Float32Array(localCount),
    observations: new Float32Array(localCount),
    conflict: new Float32Array(localCount),
    // One bit per broad camera sector. Closely spaced frames from one
    // temporal track are correlated and must not masquerade as several
    // independent confirmations.
    supportGroups: new Uint32Array(localCount),
    independentSupportViews: new Uint16Array(localCount),
    alteredSupportViews: new Uint16Array(localCount),
    globalIndices,
    indexLookup,
    // Fusion only revisits Gaussians that have actually appeared in a tracked
    // proposal. Scanning every splat in a multi-million-point scene after
    // each view made progress get slower as the scan continued.
    touched: new Set(),
    acceptedViews: 0,
    rejectedViews: 0,
    failedViews: 0,
  };
}

export function addViewEvidence(evidence, {
  selected,
  visible = selected,
  score = 0.8,
  membershipWeights = null,
  viewGroup = 0,
  accepted = true,
  alteredVisibility = false,
  failed = false,
}) {
  if (failed) {
    evidence.failedViews++;
    return;
  }
  if (!accepted) {
    evidence.rejectedViews++;
    // A user rejection is negative evidence for this proposal, not a permanent
    // blacklist. Later independent views may still recover the same Gaussian.
    for (const index of selected) {
      const slot = evidenceSlot(evidence, index);
      if (slot < 0) continue;
      evidence.touched.add(slot);
      evidence.observations[slot] += 1;
      evidence.conflict[slot] += 1;
    }
    return;
  }
  evidence.acceptedViews++;
  const boundedScore = Math.max(0.05, Math.min(1, score));
  const groupBit = 1 << normalizeGroup(viewGroup);
  const observed = new Set(visible);
  for (const index of selected) observed.add(index);
  for (const index of observed) {
    const slot = evidenceSlot(evidence, index);
    if (slot < 0) continue;
    evidence.touched.add(slot);
    evidence.observations[slot] += 1;
  }
  for (const index of selected) {
    const slot = evidenceSlot(evidence, index);
    if (slot < 0) continue;
    // Tracker quality and footprint agreement are distinct indicators. The
    // former caps the view; the latter describes this Gaussian specifically.
    const membership = Math.max(
      0.18,
      Math.min(1, membershipWeights?.get?.(index) ?? 0.54),
    );
    evidence.support[slot] += boundedScore * (0.38 + membership * 0.62);
    if (alteredVisibility) {
      if (evidence.alteredSupportViews[slot] < 65_535) {
        evidence.alteredSupportViews[slot]++;
      }
    } else if (evidence.independentSupportViews[slot] < 65_535) {
      evidence.independentSupportViews[slot]++;
      evidence.supportGroups[slot] |= groupBit;
    }
  }
  for (const index of visible) {
    if (selected.has(index)) continue;
    const slot = evidenceSlot(evidence, index);
    if (slot >= 0) evidence.conflict[slot] += 1;
  }
}

export function fuseViewEvidence(evidence, {
  baseSelection,
  baseConfidence,
  locked,
  confidenceBuffer = null,
  minimumViews = 2,
  confidenceThreshold = 0.64,
  provisionalThreshold = 0.28,
}) {
  const selection = new Set(baseSelection);
  const confidence = confidenceBuffer ?? baseConfidence.slice();
  const provisional = new Set();
  const newlyAdded = new Set();

  for (const slot of evidence.touched) {
    const index = evidence.globalIndices?.[slot] ?? slot;
    const observations = evidence.observations[slot];
    if (!observations || !evidence.support[slot]) continue;
    const score = evidence.support[slot] / observations;
    const independentGroups = popcount32(evidence.supportGroups[slot]);
    const enoughViews = independentGroups >= minimumViews;
    if (score < provisionalThreshold && !locked?.[index]) continue;
    if (!selection.has(index)) newlyAdded.add(index);
    selection.add(index);
    confidence[index] = Math.max(baseConfidence[index], score);
    if (!enoughViews || score < confidenceThreshold) provisional.add(index);
  }

  for (const index of selection) {
    if (!locked?.[index] && confidence[index] < confidenceThreshold) provisional.add(index);
  }
  return { selection, confidence, provisional, newlyAdded };
}

function evidenceSlot(evidence, globalIndex) {
  return compactLookupSlot(evidence.indexLookup, globalIndex);
}

function normalizeGroup(group) {
  const numeric = Number.isFinite(+group) ? Math.round(+group) : 0;
  return ((numeric % 31) + 31) % 31;
}

function popcount32(value) {
  let bits = value >>> 0;
  bits -= (bits >>> 1) & 0x55555555;
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function estimateRefinementTime({
  viewCount,
  splatCount,
  selectionCount,
  timing = {},
  ambiguousRate = 0.28,
}) {
  const renderMs = timing.renderMs ?? Math.max(45, splatCount / 22_000);
  // Official SAM 3.1 multiplex tracking takes several seconds per synthetic
  // frame on the current RTX 5090 laptop. Start honestly, then replace this
  // estimate with the measured rolling average after the first view.
  const inferenceMs = timing.inferenceMs ?? 4_200;
  const fusionMs = timing.fusionMs ?? Math.max(24, splatCount / 45_000);
  const perViewMs = renderMs + inferenceMs + fusionMs;
  const automaticMs = perViewMs * viewCount;
  const ambiguity = Math.max(0.08, Math.min(0.85, ambiguousRate));
  const reviewViews = Math.max(1, Math.round(viewCount * ambiguity));
  const selectionComplexity = Math.min(2.2, 0.75 + selectionCount / Math.max(1, splatCount) * 6);
  const reviewMs = reviewViews * 8_000 * selectionComplexity;
  return {
    automaticMs,
    reviewMs,
    totalMs: automaticMs + reviewMs,
    perViewMs,
    reviewViews,
  };
}

export function updateTimingAverage(timing, sample) {
  const weight = timing.samples ? 0.25 : 1;
  return {
    renderMs: mix(timing.renderMs, sample.renderMs, weight),
    inferenceMs: mix(timing.inferenceMs, sample.inferenceMs, weight),
    fusionMs: mix(timing.fusionMs, sample.fusionMs, weight),
    samples: (timing.samples ?? 0) + 1,
  };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
}

function mix(previous, next, weight) {
  if (!Number.isFinite(previous)) return next;
  return previous * (1 - weight) + next * weight;
}

function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
