import { SamPromptModel } from './sam.js';

/**
 * Model-provider contract used by the editor:
 *
 * create() returns an object with:
 *   load(onProgress)
 *   encode(canvas)
 *   decodePoints([{ x, y, label }])
 *   ready, family, device, viewRevision
 *
 * Registering a provider is enough to make it available to the generated
 * model picker. The selection/lift/grow pipeline never imports a concrete
 * architecture.
 */
const providers = new Map();

export function registerSegmentationModel(provider) {
  if (!provider?.id || typeof provider.create !== 'function') {
    throw new Error('A segmentation model provider needs an id and create() factory.');
  }
  providers.set(provider.id, Object.freeze({ ...provider }));
}

export function listSegmentationModels() {
  return [...providers.values()];
}

export function createSegmentationModel(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown segmentation model provider: ${id}`);
  const model = provider.create();
  for (const method of ['load', 'encode', 'decodePoints']) {
    if (typeof model?.[method] !== 'function') {
      throw new Error(`Segmentation model "${id}" does not implement ${method}().`);
    }
  }
  return model;
}

registerSegmentationModel({
  id: 'fast',
  label: 'Fast',
  description: 'SlimSAM loads quickly and handles the first click.',
  create: () => new SamPromptModel({
    id: 'fast',
    modelId: 'Xenova/slimsam-77-uniform',
    architecture: 'sam',
    family: 'slimsam',
    // Fast is the always-on interaction path. A 640 px working image cuts the
    // WebGPU encoder cost substantially; users can explicitly choose the
    // accurate provider when a difficult edge warrants the extra resolution.
    maxInputSide: 640,
  }),
});
registerSegmentationModel({
  id: 'accurate',
  label: 'Accurate mask',
  description: 'Rerun this one frozen image with the slower SAM 3 mask model. This does not scan hidden sides.',
  create: () => new SamPromptModel({
    id: 'accurate',
    modelId: 'onnx-community/sam3-tracker-ONNX',
    architecture: 'sam3-tracker',
    family: 'sam3',
    // Reduces the browser download and GPU memory footprint substantially.
    webgpuDtype: 'q4f16',
    maxInputSide: 1024,
  }),
});
