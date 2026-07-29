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
  async resolve({ active, model }) {
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
    const mask = active.extent === 'tight' ? result.masks[0]
      : active.extent === 'broad' ? result.masks[result.masks.length - 1]
        : result.masks[result.suggested] ?? result.masks[0];
    return { mask, w: result.w, h: result.h };
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
    };
  },
});
