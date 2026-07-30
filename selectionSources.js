import { colorFillMask, radiusMask } from './maskTools.js';

/**
 * Every 2D selection source resolves to the same mask contract:
 * { mask: Uint8Array, w: number, h: number }.
 *
 * That makes learned models, classic CV, detector proposals, manual boxes, and
 * future text/concept queries interchangeable before the shared 3D lift.
 */
const sources = new Map();

export function registerSelectionSource(source) {
  if (!source?.id || typeof source.resolve !== 'function') {
    throw new Error('A selection source needs an id and resolve() function.');
  }
  sources.set(source.id, Object.freeze({ ...source }));
}

export function listSelectionSources() {
  return [...sources.values()];
}

export function getSelectionSource(id) {
  const source = sources.get(id);
  if (!source) throw new Error(`Unknown selection source: ${id}`);
  return source;
}

registerSelectionSource({
  id: 'auto',
  label: 'Auto object',
  description: 'A promptable model proposes an object-like mask from the click.',
  panel: 'auto',
  async resolve({
    active,
    model,
    capture,
    settings,
  }) {
    if (!model?.ready || model.viewRevision !== active.viewRevision) {
      return resolveClassicAutoFallback(active, capture, settings, model);
    }
    active.samResults ??= new Map();
    const promptKey = active.prompts
      .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)},${point.label}`)
      .join(';');
    const cacheKey = `${model.id}:${model.viewRevision}:${promptKey}`;
    let cached = active.samResults.get(cacheKey);
    if (!cached) {
      cached = model.decodePoints(active.prompts);
      active.samResults.set(cacheKey, cached);
    }
    let result;
    try {
      result = await cached;
      active.samResults.set(cacheKey, result);
    } catch (error) {
      active.samResults.delete(cacheKey);
      throw error;
    }
    const areas = result.areas?.length
      ? result.areas
      : result.masks.map((mask) => mask.reduce((sum, value) => sum + value, 0));
    const frameArea = Math.max(1, result.w * result.h);
    const detectorChoice = active.detectorSuggestion?.source?.startsWith?.('yolo')
      ? chooseDetectorAlignedMask(result, active, capture)
      : null;
    let index = active.extent === 'tight' ? 0
      : active.extent === 'broad' ? result.masks.length - 1
        : detectorChoice?.index ?? chooseUsefulObjectMask(result, areas, frameArea);
    let mask = result.masks[index] ?? result.masks[0];
    let areaRatio = (areas[index] ?? 0) / frameArea;
    let recovery = null;
    let outputW = result.w;
    let outputH = result.h;

    if (detectorChoice && active.extent === 'suggested') {
      if (!detectorChoice.usable) {
        const fallback = detectorConstrainedFallback(active, capture, settings);
        mask = fallback.mask;
        outputW = fallback.w;
        outputH = fallback.h;
        areaRatio = fallback.areaRatio;
        recovery = 'detector-mismatch-edge-fallback';
      }
    }

    // A first click should never silently publish a whole-frame failure as an
    // object. If every learned hypothesis is implausible, keep the interaction
    // useful with the local edge-aware fill and disclose the recovery.
    if (active.extent === 'suggested' && (areaRatio > 0.9 || areaRatio < 0.00002)) {
      mask = colorFillMask(
        capture,
        active.point.x,
        active.point.y,
        Math.min(settings.fillThreshold, 22),
      );
      outputW = capture.width;
      outputH = capture.height;
      areaRatio = mask.reduce((sum, value) => sum + value, 0)
        / Math.max(1, capture.width * capture.height);
      recovery = 'local-edge-fallback';
      if (areaRatio > 0.82 || areaRatio < 0.00002) {
        mask = radiusMask(
          capture.width,
          capture.height,
          active.point.x,
          active.point.y,
          Math.max(3, Math.min(8, settings.screenRadius)),
        );
        areaRatio = mask.reduce((sum, value) => sum + value, 0)
          / Math.max(1, capture.width * capture.height);
        recovery = 'safe-local-radius';
      }
      index = -1;
    }
    active.autoDiagnostics = {
      hypothesisIndex: index,
      areaRatio,
      recovery,
      modelId: model.modelId,
      detectorAlignment: detectorChoice
        ? {
          boxCoverage: detectorChoice.boxCoverage,
          purity: detectorChoice.purity,
          expandedPurity: detectorChoice.expandedPurity,
          clickIncluded: detectorChoice.clickIncluded,
          usable: detectorChoice.usable,
        }
        : null,
    };
    return {
      mask,
      w: outputW,
      h: outputH,
      role: 'primary',
      confidenceKind: 'model',
      confidence: recovery
        ? 0.58
        : result.scores[index] ?? result.scores[0] ?? 0.75,
      diagnostics: active.autoDiagnostics,
    };
  },
});

registerSelectionSource({
  id: 'fill',
  label: 'Color fill',
  description: 'Edge-aware contiguous color fill from the clicked pixel.',
  panel: 'fill',
  resolve({ active, capture, settings }) {
    return {
      mask: colorFillMask(capture, active.point.x, active.point.y, settings.fillThreshold),
      w: capture.width,
      h: capture.height,
      role: 'guide',
      confidenceKind: 'deterministic',
    };
  },
});

registerSelectionSource({
  id: 'radius',
  label: 'Radius',
  description: 'Deterministic circular selection in screen space.',
  panel: 'radius',
  resolve({ active, capture, settings }) {
    return {
      mask: radiusMask(
        capture.width,
        capture.height,
        active.point.x,
        active.point.y,
        settings.screenRadius,
      ),
      w: capture.width,
      h: capture.height,
      role: 'guide',
      confidenceKind: 'deterministic',
    };
  },
});

function chooseUsefulObjectMask(result, areas, frameArea) {
  const candidates = result.masks.map((_mask, index) => {
    const areaRatio = (areas[index] ?? 0) / frameArea;
    return {
      index,
      areaRatio,
    };
  }).filter((candidate) =>
    candidate.areaRatio >= 0.00002 && candidate.areaRatio <= 0.86);
  if (!candidates.length) return result.suggested ?? 0;
  candidates.sort((a, b) => a.areaRatio - b.areaRatio);
  // SAM's click head commonly returns a nested detail / object / surrounding
  // set. The middle plausible scale is the least surprising one-click object;
  // users can still choose either extreme explicitly and see its exact diff.
  return candidates[Math.floor(candidates.length / 2)].index;
}

/**
 * SAM returns several hypotheses and its highest IoU prediction is not
 * necessarily the object represented by a detector box. Rank hypotheses by
 * their actual agreement with the clicked region before publishing one.
 */
function chooseDetectorAlignedMask(result, active, capture) {
  const box = scaleDetectorBox(
    active.detectorSuggestion.box,
    capture.width,
    capture.height,
    result.w,
    result.h,
  );
  const expanded = expandBox(box, result.w, result.h, 0.1);
  const clickX = Math.max(0, Math.min(
    result.w - 1,
    Math.floor(active.point.x * result.w / capture.width),
  ));
  const clickY = Math.max(0, Math.min(
    result.h - 1,
    Math.floor(active.point.y * result.h / capture.height),
  ));
  const boxArea = Math.max(1, Math.ceil(box.x2 - box.x1) * Math.ceil(box.y2 - box.y1));
  const candidates = result.masks.map((mask, index) => {
    const area = result.areas?.[index]
      ?? mask.reduce((sum, value) => sum + value, 0);
    const inside = countMaskInBox(mask, result.w, result.h, box);
    const insideExpanded = countMaskInBox(mask, result.w, result.h, expanded);
    const boxCoverage = inside / boxArea;
    const purity = inside / Math.max(1, area);
    const expandedPurity = insideExpanded / Math.max(1, area);
    const clickIncluded = Boolean(mask[clickY * result.w + clickX]);
    const modelScore = Math.max(0, Math.min(1, result.scores?.[index] ?? 0));
    const relativeArea = area / Math.max(1, boxArea);
    const scaleFit = Math.exp(-Math.abs(Math.log(Math.max(0.08, relativeArea))));
    // The actual click and SAM's own mask quality dominate. Box agreement is
    // deliberately weak: YOLO locates an intent, not the object's boundary.
    const rank = (clickIncluded ? 1.25 : 0)
      + modelScore * 1.05
      + boxCoverage * 0.38
      + purity * 0.2
      + expandedPurity * 0.08
      + scaleFit * 0.24;
    return {
      index,
      area,
      inside,
      boxCoverage,
      purity,
      expandedPurity,
      clickIncluded,
      rank,
    };
  }).sort((a, b) => b.rank - a.rank);

  const best = candidates[0] ?? {
    index: result.suggested ?? 0,
    area: 0,
    inside: 0,
    boxCoverage: 0,
    purity: 0,
    expandedPurity: 0,
    clickIncluded: false,
    rank: -Infinity,
  };
  best.usable = best.clickIncluded
    || best.inside >= Math.max(16, boxArea * 0.025);
  return best;
}

function detectorConstrainedFallback(active, capture, settings) {
  let mask = colorFillMask(
    capture,
    active.point.x,
    active.point.y,
    Math.min(settings.fillThreshold, 18),
  );
  const frameArea = Math.max(1, capture.width * capture.height);
  let area = mask.reduce((sum, value) => sum + value, 0);
  if (area < 16 || area > frameArea * 0.42) {
    mask = radiusMask(
      capture.width,
      capture.height,
      active.point.x,
      active.point.y,
      Math.max(4, Math.min(10, settings.screenRadius)),
    );
    area = mask.reduce((sum, value) => sum + value, 0);
  }
  return {
    mask,
    w: capture.width,
    h: capture.height,
    areaRatio: area / frameArea,
  };
}

function countMaskInBox(mask, w, h, box) {
  const x1 = Math.max(0, Math.floor(box.x1));
  const y1 = Math.max(0, Math.floor(box.y1));
  const x2 = Math.min(w, Math.ceil(box.x2));
  const y2 = Math.min(h, Math.ceil(box.y2));
  let area = 0;
  for (let y = y1; y < y2; y++) {
    const row = y * w;
    for (let x = x1; x < x2; x++) area += mask[row + x] ? 1 : 0;
  }
  return area;
}

function scaleDetectorBox(box, sourceW, sourceH, targetW, targetH) {
  return {
    x1: box.x1 * targetW / sourceW,
    y1: box.y1 * targetH / sourceH,
    x2: box.x2 * targetW / sourceW,
    y2: box.y2 * targetH / sourceH,
  };
}

function expandBox(box, w, h, fraction) {
  const padX = Math.max(2, (box.x2 - box.x1) * fraction);
  const padY = Math.max(2, (box.y2 - box.y1) * fraction);
  return {
    x1: Math.max(0, box.x1 - padX),
    y1: Math.max(0, box.y1 - padY),
    x2: Math.min(w, box.x2 + padX),
    y2: Math.min(h, box.y2 + padY),
  };
}

function resolveClassicAutoFallback(active, capture, settings, model) {
  const frameArea = Math.max(1, capture.width * capture.height);
  let mask = colorFillMask(
    capture,
    active.point.x,
    active.point.y,
    Math.min(settings.fillThreshold, 22),
  );
  let areaRatio = mask.reduce((sum, value) => sum + value, 0) / frameArea;
  let recovery = 'model-loading-edge-fallback';
  if (areaRatio > 0.82 || areaRatio < 0.00002) {
    mask = radiusMask(
      capture.width,
      capture.height,
      active.point.x,
      active.point.y,
      Math.max(3, Math.min(8, settings.screenRadius)),
    );
    areaRatio = mask.reduce((sum, value) => sum + value, 0) / frameArea;
    recovery = 'model-loading-radius-fallback';
  }
  active.autoDiagnostics = {
    hypothesisIndex: -1,
    areaRatio,
    recovery,
    modelId: model?.modelId ?? 'not-loaded',
  };
  return {
    mask,
    w: capture.width,
    h: capture.height,
    role: 'primary',
    confidenceKind: 'heuristic',
    confidence: recovery === 'model-loading-radius-fallback' ? 0.52 : 0.58,
    diagnostics: active.autoDiagnostics,
  };
}
