import { projectionSlot } from './lift.js';

/**
 * Cross-view prompt propagation and proposal validation.
 *
 * The provider contract is intentionally independent of the click-selection
 * UI. A future temporal SAM 3 backend can implement the same `propagate`
 * method while this browser fallback uses projected 3D evidence to prompt each
 * view independently and truthfully reports that mode.
 */

export class ProjectedPromptPropagationProvider {
  constructor(getModel) {
    this.getModel = getModel;
    this.id = 'projected-prompt-propagation';
    this.label = '3D-guided SAM propagation';
    this.mode = 'per-view-guided';
  }

  async propagate({
    canvas,
    guidance,
    previousAreaRatio = null,
  }) {
    const model = this.getModel();
    if (!model?.ready) throw new Error('The propagation model is not ready.');
    if (!guidance?.positive?.length) {
      return {
        accepted: false,
        needsReview: true,
        failure: 'object-not-visible',
        reasons: ['No selected Gaussians are visible from this angle.'],
        mask: null,
        maskW: canvas.width,
        maskH: canvas.height,
        score: 0,
        validation: null,
        provider: providerMetadata(model, this),
      };
    }

    await model.encode(canvas);
    const decoded = await model.decodePoints([
      ...guidance.positive.map((point) => ({ ...point, label: 1 })),
      ...guidance.negative.map((point) => ({ ...point, label: 0 })),
    ]);

    let best = null;
    for (let index = 0; index < decoded.masks.length; index++) {
      const validation = validatePropagatedMask({
        mask: decoded.masks[index],
        w: decoded.w,
        h: decoded.h,
        score: decoded.scores[index] ?? 0,
        guidance,
        previousAreaRatio,
      });
      const candidate = {
        index,
        mask: decoded.masks[index],
        score: decoded.scores[index] ?? 0,
        validation,
      };
      if (!best || candidate.validation.rank > best.validation.rank) best = candidate;
    }
    if (!best) throw new Error('The segmentation model returned no mask candidates.');

    return {
      accepted: best.validation.fatalReasons.length === 0,
      needsReview: best.validation.needsReview,
      failure: best.validation.fatalReasons[0]?.code ?? null,
      reasons: [
        ...best.validation.fatalReasons.map((reason) => reason.message),
        ...best.validation.warnings.map((warning) => warning.message),
      ],
      mask: best.mask,
      maskW: decoded.w,
      maskH: decoded.h,
      score: best.validation.confidence,
      rawModelScore: best.score,
      validation: best.validation,
      provider: providerMetadata(model, this),
    };
  }
}

/**
 * Client for a stateful SAM 3/SAM 2 video-predictor service.
 *
 * The official tracker runtimes are Python/PyTorch today, so the browser sends
 * an ordered synthetic-frame sequence to a small local/remote service rather
 * than pretending that repeated image decoding is temporal tracking.
 *
 * Expected API:
 *   GET    {endpoint}/capabilities
 *   POST   {endpoint}/sessions          FormData(seed frame, seed mask RLE)
 *   POST   {endpoint}/sessions/:id/frames
 *   DELETE {endpoint}/sessions/:id
 */
export class TemporalSamTrackingProvider {
  constructor({ endpoint = '/api/sam-tracking', timeoutMs = 3_000 } = {}) {
    this.id = 'temporal-sam-tracking';
    this.label = 'SAM temporal tracking';
    this.mode = 'temporal-tracker';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
    this.capabilities = null;
    this.lifecycle = null;
    this.lifecycleRevision = 0;
  }

  async probe() {
    const response = await fetchWithTimeout(
      `${this.endpoint}/capabilities`,
      { headers: { accept: 'application/json' } },
      this.timeoutMs,
    );
    if (!response.ok) return false;
    const capabilities = await response.json();
    this.capabilities = capabilities;
    if (!capabilities?.temporalTracking) return false;
    return true;
  }

  async begin({
    seedCanvas,
    seedMask,
    maskW,
    maskH,
    branches,
    branchFrames = null,
    objectId = 'selection-1',
  }) {
    if (!seedCanvas || !seedMask || !branches?.length) return false;
    await this.close();
    const lifecycle = {
      revision: ++this.lifecycleRevision,
      controller: new AbortController(),
    };
    this.lifecycle = lifecycle;
    try {
      const frame = await canvasToBlob(seedCanvas);
      this._assertActive(lifecycle);
      for (const branch of branches) {
        const staged = branchFrames?.get?.(branch) ?? [];
        // The official video predictor initializes from a complete ordered
        // frame sequence. Captured poses without a continuous branch keep using
        // the independent 3D-guided fallback.
        if (!staged.length) continue;
        const form = new FormData();
        form.append('frame', frame, 'seed.png');
        form.append('metadata', JSON.stringify({
          branch,
          objectId,
          mask: encodeMaskRle(seedMask, maskW, maskH),
          views: staged.map(({ view }, index) => ({
            id: view.id,
            order: index + 1,
            yawDegrees: view.yawDegrees ?? null,
            elevationDegrees: view.elevationDegrees ?? null,
          })),
        }));
        for (const { view, blob } of staged) {
          form.append('frames', blob, `${view.id}.png`);
        }
        const response = await fetch(`${this.endpoint}/sessions`, {
          method: 'POST',
          body: form,
          signal: lifecycle.controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Tracker session failed (${response.status}).`);
        }
        const result = await response.json();
        if (!this._isActive(lifecycle)) {
          if (result?.sessionId) this._deleteSessionBestEffort(result.sessionId);
          throw abortError();
        }
        if (!result?.sessionId) {
          throw new Error('Tracker service did not return a session id.');
        }
        this.sessions.set(branch, {
          id: result.sessionId,
          revision: lifecycle.revision,
        });
      }
      this._assertActive(lifecycle);
      if (this.sessions.size) return true;
      await this.close();
      return false;
    } catch (error) {
      if (this._isActive(lifecycle)) await this.close();
      throw error;
    }
  }

  hasSession(branch) {
    const session = this.sessions.get(branch);
    return Boolean(
      session
      && this.lifecycle
      && session.revision === this.lifecycle.revision
      && !this.lifecycle.controller.signal.aborted
    );
  }

  async propagate({
    canvas,
    guidance,
    previousAreaRatio = null,
    branch,
    view,
    onProgress = null,
  }) {
    const lifecycle = this.lifecycle;
    const session = this.sessions.get(branch);
    if (!lifecycle || !session || session.revision !== lifecycle.revision) {
      throw new Error(`No tracker session is active for ${branch}.`);
    }
    this._assertActive(lifecycle);
    const sessionId = session.id;
    const form = new FormData();
    // Every frame was uploaded when the temporal session was staged. Sending
    // the same high-resolution image again here forced a needless browser PNG
    // encode and upload before every tracked result.
    form.append('metadata', JSON.stringify({
      view,
      guidance: {
        positive: guidance.positive,
        negative: guidance.negative,
        box: guidance.box,
      },
    }));
    let polling = true;
    const progressPolling = this._pollProgress(
      sessionId,
      onProgress,
      () => polling,
      lifecycle.controller.signal,
    );
    const response = await fetch(
      `${this.endpoint}/sessions/${encodeURIComponent(sessionId)}/frames`,
      {
        method: 'POST',
        body: form,
        signal: lifecycle.controller.signal,
      },
    ).finally(() => {
      polling = false;
    });
    await progressPolling;
    this._assertActive(lifecycle, branch, session);
    if (!response.ok) throw new Error(`Tracker frame failed (${response.status}).`);
    const result = await response.json();
    this._assertActive(lifecycle, branch, session);
    const mask = decodeMaskRle(result.mask);
    const validation = validatePropagatedMask({
      mask,
      w: result.mask.w,
      h: result.mask.h,
      score: result.score ?? 0.8,
      guidance,
      previousAreaRatio,
      temporalTracking: true,
    });
    return {
      accepted: validation.fatalReasons.length === 0,
      needsReview: validation.needsReview,
      failure: validation.fatalReasons[0]?.code ?? null,
      reasons: [
        ...validation.fatalReasons.map((reason) => reason.message),
        ...validation.warnings.map((warning) => warning.message),
      ],
      mask,
      maskW: result.mask.w,
      maskH: result.mask.h,
      score: validation.confidence,
      rawModelScore: result.score ?? null,
      diagnostics: {
        frameIndex: result.frameIndex ?? null,
        maskArea: result.maskArea ?? validation.area,
        maskAreaRatio: result.maskAreaRatio ?? validation.areaRatio,
        reanchored: Boolean(result.reanchored),
        guideCoverage: result.guideCoverage ?? validation.positiveCoverage,
      },
      validation,
      provider: {
        id: this.id,
        label: this.label,
        mode: this.mode,
        modelId: this.capabilities?.modelId ?? 'sam-video-predictor',
        family: this.capabilities?.family ?? 'sam',
        device: this.capabilities?.device ?? 'service',
        temporalTracking: true,
      },
    };
  }

  async _pollProgress(sessionId, onProgress, isActive, signal) {
    if (typeof onProgress !== 'function') return;
    while (isActive() && !signal?.aborted) {
      try {
        await abortableDelay(450, signal);
      } catch (error) {
        if (error.name === 'AbortError') return;
        throw error;
      }
      if (!isActive() || signal?.aborted) break;
      try {
        const response = await fetch(
          `${this.endpoint}/sessions/${encodeURIComponent(sessionId)}`,
          {
            headers: { accept: 'application/json' },
            signal,
          },
        );
        if (!response.ok) continue;
        if (signal?.aborted) return;
        onProgress(await response.json());
      } catch (error) {
        if (error.name === 'AbortError' || signal?.aborted) return;
        // Progress is advisory. The frame request remains authoritative.
      }
    }
  }

  async close() {
    const lifecycle = this.lifecycle;
    this.lifecycle = null;
    lifecycle?.controller.abort();
    const sessions = [...this.sessions.values()].map((session) => session.id);
    this.sessions.clear();
    await Promise.allSettled(sessions.map((sessionId) =>
      this._deleteSessionBestEffort(sessionId)));
  }

  _isActive(lifecycle) {
    return Boolean(
      lifecycle
      && this.lifecycle === lifecycle
      && !lifecycle.controller.signal.aborted
    );
  }

  _assertActive(lifecycle, branch = null, session = null) {
    if (!this._isActive(lifecycle)
      || (branch !== null && this.sessions.get(branch) !== session)) {
      throw abortError();
    }
  }

  async _deleteSessionBestEffort(sessionId) {
    try {
      await fetchWithTimeout(
        `${this.endpoint}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
        this.timeoutMs,
      );
    } catch {
      // Local references and requests are already gone. Backend cleanup is
      // best-effort because a stopped/restarted local service may be offline.
    }
  }
}

export class MaskPropagationRouter {
  constructor({ temporal, fallback }) {
    this.temporal = temporal;
    this.fallback = fallback;
    this.active = fallback;
  }

  async begin(seed) {
    this.active = this.fallback;
    try {
      if (!await this.temporal.probe()) return false;
      if (!await this.temporal.begin(seed)) return false;
      this.active = this.temporal;
      return true;
    } catch (error) {
      console.warn('[tracking] temporal provider unavailable; using projected prompts', error);
      await this.temporal.close();
      this.active = this.fallback;
      return false;
    }
  }

  async probeTemporal() {
    try {
      return await this.temporal.probe();
    } catch {
      return false;
    }
  }

  propagate(request) {
    if (this.active === this.temporal && this.temporal.hasSession(request.branch)) {
      return this.temporal.propagate(request);
    }
    return this.fallback.propagate(request);
  }

  /**
   * An altered-visibility diagnostic frame is not part of the staged temporal
   * sequence. Decode it independently with the same 3D guidance rather than
   * claiming the tracker followed an image it was never initialized with.
   */
  propagateFallback(request) {
    return this.fallback.propagate(request);
  }

  async close() {
    await this.temporal.close();
    this.active = this.fallback;
  }

  get metadata() {
    return {
      id: this.active.id,
      label: this.active.label,
      mode: this.active.mode,
      temporalTracking: this.active === this.temporal,
    };
  }
}

export function buildProjectedSelectionGuidance({
  projection,
  selection,
  projectionW,
  projectionH,
  targetW,
  targetH,
  depthSlack = 0,
  maxPositive = 7,
  maxReference = 4_000,
}) {
  const { sx, sy, sd, depth, tw, tile } = projection;
  const visible = [];
  const reference = [];
  const stride = Math.max(1, Math.ceil(selection.size / maxReference));
  let ordinal = 0;

  for (const index of selection) {
    const slot = projectionSlot(projection, index);
    if (slot < 0) continue;
    const depthValue = sd[slot];
    if (depthValue <= 0) continue;
    const x = sx[slot];
    const y = sy[slot];
    if (x < 0 || y < 0 || x >= projectionW || y >= projectionH) continue;
    const depthIndex = ((y / tile) | 0) * tw + ((x / tile) | 0);
    const nearest = depth[depthIndex];
    if (depthValue > nearest + depthSlack + nearest * 0.012) continue;
    const point = {
      x: x / projectionW * targetW,
      y: y / projectionH * targetH,
      index,
    };
    visible.push(point);
    if (ordinal++ % stride === 0) reference.push(point);
  }

  if (!visible.length) {
    return {
      positive: [],
      negative: [],
      reference: [],
      visibleSelection: new Set(),
      box: null,
      projectedAreaRatio: 0,
    };
  }

  const xs = visible.map((point) => point.x).sort(ascending);
  const ys = visible.map((point) => point.y).sort(ascending);
  const box = {
    x1: quantile(xs, 0.025),
    y1: quantile(ys, 0.025),
    x2: quantile(xs, 0.975),
    y2: quantile(ys, 0.975),
  };
  const positive = sampleSpatialPrompts(visible, box, maxPositive);
  const negative = sampleNegativePrompts(box, targetW, targetH);
  const projectedAreaRatio = Math.max(0, box.x2 - box.x1)
    * Math.max(0, box.y2 - box.y1)
    / Math.max(1, targetW * targetH);

  return {
    positive,
    negative,
    reference,
    visibleSelection: new Set(visible.map((point) => point.index)),
    box,
    projectedAreaRatio,
  };
}

export function validatePropagatedMask({
  mask,
  w,
  h,
  score,
  guidance,
  previousAreaRatio = null,
  temporalTracking = false,
}) {
  let area = 0;
  for (let index = 0; index < mask.length; index++) area += mask[index] ? 1 : 0;
  const areaRatio = area / Math.max(1, w * h);
  const positiveCoverage = pointCoverage(mask, w, h, guidance.positive);
  const negativeLeak = pointCoverage(mask, w, h, guidance.negative);
  const referenceCoverage = pointCoverage(mask, w, h, guidance.reference);
  const areaChange = previousAreaRatio > 0
    ? Math.max(areaRatio / previousAreaRatio, previousAreaRatio / Math.max(areaRatio, 1e-8))
    : 1;
  const expectedRatio = guidance.projectedAreaRatio;
  const expectedAreaChange = expectedRatio > 0
    ? Math.max(areaRatio / expectedRatio, expectedRatio / Math.max(areaRatio, 1e-8))
    : 1;

  const fatalReasons = [];
  const warnings = [];
  if (area < 24 || areaRatio < 0.00002) {
    fatalReasons.push({
      code: 'empty-mask',
      message: 'The object was lost in this view.',
    });
  }
  if (areaRatio > 0.9) {
    fatalReasons.push({
      code: 'full-frame-mask',
      message: 'The mask spread across almost the entire view.',
    });
  }
  // A stateful tracker is allowed to expand beyond an incomplete visible-side
  // seed. Requiring half of several projected guide points made valid tracked
  // masks fail whenever the original 3D seed contained gaps or stray growth.
  // It still must overlap at least one meaningful part of the known object
  // whenever that original surface is actually visible. At a back-side view
  // the seed can be fully occluded; temporal continuity is the evidence there.
  const minimumPositiveCoverage = temporalTracking ? 0.14 : 0.5;
  if (guidance.positive.length && positiveCoverage < minimumPositiveCoverage) {
    fatalReasons.push({
      code: 'lost-identity',
      message: 'The mask no longer covers enough of the projected object.',
    });
  }
  if (negativeLeak > 0.5 && guidance.negative.length >= 2) {
    const reason = {
      code: temporalTracking ? 'expanded-past-seed' : 'background-spill',
      message: temporalTracking
        ? 'The tracked object expanded beyond the visible-side seed.'
        : 'The mask crossed several background guard points.',
    };
    if (temporalTracking) warnings.push(reason);
    else fatalReasons.push(reason);
  }
  if (areaChange > 5.5) {
    warnings.push({
      code: 'area-jump',
      message: 'The object changed size sharply from the preceding view.',
    });
  }
  if (expectedAreaChange > 5.5) {
    warnings.push({
      code: 'projection-disagreement',
      message: 'The 2D mask disagrees strongly with the projected 3D object extent.',
    });
  }
  if (guidance.reference.length
    && referenceCoverage < (temporalTracking ? 0.36 : 0.64)) {
    warnings.push({
      code: 'partial-reference-coverage',
      message: 'Part of the existing 3D object falls outside the proposed mask.',
    });
  }
  if (temporalTracking && !guidance.positive.length) {
    warnings.push({
      code: 'seed-occluded',
      message: 'The original visible surface is hidden at this angle; this result stays provisional.',
    });
  }

  const modelScore = clamp01(score);
  const confidence = clamp01(
    modelScore * 0.34
      + positiveCoverage * 0.26
      + referenceCoverage * 0.28
      + (1 - negativeLeak) * 0.12
      - Math.min(0.24, Math.max(0, Math.log2(areaChange)) * 0.055)
      - fatalReasons.length * 0.38,
  );
  const needsReview = fatalReasons.length > 0
    || warnings.length > 0
    || confidence < 0.76;

  return {
    area,
    areaRatio,
    positiveCoverage,
    negativeLeak,
    referenceCoverage,
    areaChange,
    expectedAreaChange,
    modelScore,
    confidence,
    fatalReasons,
    warnings,
    needsReview,
    rank: confidence - fatalReasons.length * 2 - warnings.length * 0.12,
  };
}

function sampleSpatialPrompts(points, box, maximum) {
  const candidates = [];
  const targets = [
    [0.5, 0.5],
    [0.25, 0.5],
    [0.75, 0.5],
    [0.5, 0.25],
    [0.5, 0.75],
    [0.25, 0.25],
    [0.75, 0.75],
  ].slice(0, maximum);
  const used = new Set();
  for (const [u, v] of targets) {
    const x = box.x1 + (box.x2 - box.x1) * u;
    const y = box.y1 + (box.y2 - box.y1) * v;
    let best = null;
    let bestDistance = Infinity;
    for (const point of points) {
      if (used.has(point.index)) continue;
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
    if (best) {
      candidates.push({ x: best.x, y: best.y });
      used.add(best.index);
    }
  }
  return candidates;
}

function sampleNegativePrompts(box, width, height) {
  const margin = Math.max(8, Math.min(width, height) * 0.035);
  const candidates = [
    { x: box.x1 - margin, y: box.y1 - margin },
    { x: box.x2 + margin, y: box.y1 - margin },
    { x: box.x1 - margin, y: box.y2 + margin },
    { x: box.x2 + margin, y: box.y2 + margin },
  ];
  return candidates
    .map((point) => ({
      x: Math.max(2, Math.min(width - 3, point.x)),
      y: Math.max(2, Math.min(height - 3, point.y)),
    }))
    .filter((point) =>
      point.x < box.x1 || point.x > box.x2 || point.y < box.y1 || point.y > box.y2);
}

function pointCoverage(mask, width, height, points) {
  if (!points?.length) return 0;
  let covered = 0;
  for (const point of points) {
    const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
    if (mask[y * width + x]) covered++;
  }
  return covered / points.length;
}

function providerMetadata(model, provider) {
  return {
    id: provider.id,
    label: provider.label,
    mode: provider.mode,
    modelId: model.modelId,
    family: model.family,
    device: model.device,
    temporalTracking: false,
  };
}

function quantile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const t = index - low;
  return sorted[low] * (1 - t) + sorted[high] * t;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function ascending(a, b) {
  return a - b;
}

function encodeMaskRle(mask, w, h) {
  const runs = [];
  let start = -1;
  for (let index = 0; index <= mask.length; index++) {
    const on = index < mask.length && Boolean(mask[index]);
    if (on && start < 0) start = index;
    else if (!on && start >= 0) {
      runs.push(start, index - start);
      start = -1;
    }
  }
  return { w, h, runs };
}

function decodeMaskRle(encoded) {
  if (!encoded?.w || !encoded?.h || !Array.isArray(encoded.runs)) {
    throw new Error('Tracker returned an invalid mask.');
  }
  const mask = new Uint8Array(encoded.w * encoded.h);
  for (let index = 0; index < encoded.runs.length; index += 2) {
    const start = encoded.runs[index];
    const length = encoded.runs[index + 1];
    mask.fill(1, start, start + length);
  }
  return mask;
}

export function canvasToBlob(canvas, type = 'image/png', quality = undefined) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Could not encode tracker frame.')),
    type,
    quality,
  ));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function abortError() {
  return new DOMException('Tracker session superseded', 'AbortError');
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', canceled, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', canceled);
    }
    function done() {
      cleanup();
      resolve();
    }
    function canceled() {
      cleanup();
      reject(abortError());
    }
  });
}
