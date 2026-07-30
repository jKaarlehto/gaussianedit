import {
  AutoModel,
  AutoProcessor,
  RawImage,
} from '@huggingface/transformers';

const providers = new Map();

export function registerDetectionModel(provider) {
  if (!provider?.id || typeof provider.create !== 'function') {
    throw new Error('A detection model provider needs an id and create() factory.');
  }
  providers.set(provider.id, Object.freeze({ ...provider }));
}

export function listDetectionModels() {
  return [...providers.values()];
}

export function createDetectionModel(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown detection model provider: ${id}`);
  const model = provider.create();
  for (const method of ['load', 'detect']) {
    if (typeof model?.[method] !== 'function') {
      throw new Error(`Detection model "${id}" does not implement ${method}().`);
    }
  }
  return model;
}

class YoloV10Detector {
  constructor({
    id,
    modelId,
    threshold = 0.13,
    maxDetections = 96,
  }) {
    this.id = id;
    this.modelId = modelId;
    this.threshold = threshold;
    this.maxDetections = maxDetections;
    this.ready = false;
    this.loading = null;
  }

  async load(onProgress = () => {}) {
    if (this.ready) return;
    if (this.loading) return this.loading;
    this.loading = this._load(onProgress);
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async _load(onProgress) {
    const device = navigator.gpu ? 'webgpu' : 'wasm';
    this.model = await AutoModel.from_pretrained(this.modelId, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback: onProgress,
    });
    this.processor = await AutoProcessor.from_pretrained(this.modelId);
    this.labels = Object.entries(this.model.config.id2label ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, label]) => label);
    this.vocabulary = 'fixed-category';
    this.device = device;
    this.ready = true;
  }

  async detect(canvas, {
    threshold = this.threshold,
    maxDetections = this.maxDetections,
  } = {}) {
    if (!this.ready) throw new Error('YOLO detector is not loaded');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const image = new RawImage(new Uint8ClampedArray(data), width, height, 4);
    const inputs = await this.processor(image);
    let output;
    try {
      output = await this.model({ images: inputs.pixel_values });
      const predictions = output.output0?.tolist?.()?.[0] ?? [];
      const [resizedHeight, resizedWidth] = inputs.reshaped_input_sizes[0];
      const scaleX = width / resizedWidth;
      const scaleY = height / resizedHeight;
      const proposals = [];
      for (const [x1, y1, x2, y2, score, classId] of predictions) {
        if (score < threshold) continue;
        const box = {
          x1: clamp(x1 * scaleX, 0, width),
          y1: clamp(y1 * scaleY, 0, height),
          x2: clamp(x2 * scaleX, 0, width),
          y2: clamp(y2 * scaleY, 0, height),
        };
        const boxWidth = box.x2 - box.x1;
        const boxHeight = box.y2 - box.y1;
        if (boxWidth < 8 || boxHeight < 8) continue;
        proposals.push({
          id: `${classId}:${Math.round(box.x1)}:${Math.round(box.y1)}`,
          label: this.model.config.id2label?.[classId] ?? `object ${classId}`,
          score,
          box,
          area: boxWidth * boxHeight,
          source: this.id,
        });
      }
      proposals.sort((a, b) => b.score - a.score);
      return proposals.slice(0, maxDetections);
    } finally {
      inputs.pixel_values?.dispose?.();
      output?.output0?.dispose?.();
    }
  }

  async dispose() {
    await this.model?.dispose?.();
    this.model = null;
    this.processor = null;
    this.ready = false;
  }
}

registerDetectionModel({
  id: 'yolov10n',
  label: 'YOLO suggestions',
  description: 'Find recognizable objects once per settled camera view and use them as SAM prompts.',
  create: () => new YoloV10Detector({
    id: 'yolov10n',
    modelId: 'onnx-community/yolov10n',
  }),
});

class BackendYoloDetector {
  constructor({
    id,
    endpoint = '/api/object-detection',
    threshold = 0.11,
    maxDetections = 96,
  }) {
    this.id = id;
    this.endpoint = endpoint.replace(/\/$/, '');
    this.threshold = threshold;
    this.maxDetections = maxDetections;
    this.ready = false;
    this.loading = null;
    this.vocabulary = 'fixed-category';
    this.tier = 'refined';
  }

  async load(onProgress = () => {}) {
    if (this.ready) return;
    if (this.loading) return this.loading;
    this.loading = this._load(onProgress);
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async _load(onProgress) {
    const startedAt = performance.now();
    for (;;) {
      const response = await fetch(`${this.endpoint}/capabilities`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Refined target scanner is unavailable');
      const capabilities = await response.json();
      this.capabilities = capabilities;
      if (capabilities.available) {
        this.modelId = capabilities.modelId;
        this.device = capabilities.device;
        this.ready = true;
        return;
      }
      if (capabilities.status === 'error') {
        throw new Error(capabilities.detail || 'Refined target scanner failed to start');
      }
      const elapsed = performance.now() - startedAt;
      if (elapsed > 120_000) throw new Error('Refined target scanner is still preparing');
      onProgress({
        status: 'progress',
        progress: Math.min(95, 8 + elapsed / 1200),
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  async detect(canvas, {
    threshold = this.threshold,
    maxDetections = this.maxDetections,
  } = {}) {
    if (!this.ready) throw new Error('Refined target scanner is not ready');
    const blob = await canvasToBlob(canvas);
    const form = new FormData();
    form.append('image', blob, 'projection.png');
    form.append('metadata', JSON.stringify({
      threshold,
      maxDetections,
      imageSize: 1280,
    }));
    const response = await fetch(`${this.endpoint}/detect`, {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Refined target scan failed (${response.status}): ${message}`);
    }
    const result = await response.json();
    const scaleX = canvas.width / Math.max(1, result.width);
    const scaleY = canvas.height / Math.max(1, result.height);
    return (result.detections ?? []).map((detection, index) => {
      const box = {
        x1: clamp(detection.box.x1 * scaleX, 0, canvas.width),
        y1: clamp(detection.box.y1 * scaleY, 0, canvas.height),
        x2: clamp(detection.box.x2 * scaleX, 0, canvas.width),
        y2: clamp(detection.box.y2 * scaleY, 0, canvas.height),
      };
      return {
        id: `${this.id}:${index}:${Math.round(box.x1)}:${Math.round(box.y1)}`,
        label: detection.label,
        score: detection.score,
        classId: detection.classId,
        box,
        area: Math.max(1, box.x2 - box.x1) * Math.max(1, box.y2 - box.y1),
        source: this.id,
        tier: this.tier,
        modelId: result.modelId ?? this.modelId,
      };
    });
  }
}

registerDetectionModel({
  id: 'yolo12s-refined',
  label: 'Refined target detection',
  description: 'Improves cached target locations in the background after immediate hints appear.',
  create: () => new BackendYoloDetector({
    id: 'yolo12s-refined',
  }),
});

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode target-scan image'));
    }, 'image/png');
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
