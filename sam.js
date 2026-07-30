import {
  SamModel,
  Sam3TrackerModel,
  AutoProcessor,
  RawImage,
  Tensor,
} from '@huggingface/transformers';

/**
 * Point-promptable SAM running in the browser.
 *
 * Two-phase by design, because that's what makes this interactive:
 *   encode(canvas)  ~150-400 ms on WebGPU — run once when the camera stops moving
 *   decode(x, y)    ~5-20 ms              — run on every click
 *
 * The multimask head returns several plausible masks for an ambiguous prompt.
 * We sort them by area for Tight/Broad controls and separately retain the
 * model's highest predicted-quality mask as Suggested.
 */
export class SamPromptModel {
  constructor({
    id,
    modelId,
    architecture = 'sam',
    family = architecture,
    webgpuDtype = 'fp16',
    wasmDtype = 'q8',
    maxInputSide = 1024,
  }) {
    this.id = id;
    this.modelId = modelId;
    this.ModelClass = architecture === 'sam3-tracker' ? Sam3TrackerModel : SamModel;
    this.family = family;
    this.webgpuDtype = webgpuDtype;
    this.wasmDtype = wasmDtype;
    this.maxInputSide = maxInputSide;
    this.ready = false;
    this.viewRevision = -1;
    this.loading = null;
  }

  async load(onProgress) {
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
    this.model = await this.ModelClass.from_pretrained(this.modelId, {
      dtype: device === 'webgpu' ? this.webgpuDtype : this.wasmDtype,
      device,
      progress_callback: onProgress,
    });
    this.processor = await AutoProcessor.from_pretrained(this.modelId);
    this.device = device;
    this.ready = true;
  }

  /** @param {HTMLCanvasElement} canvas an RGBA snapshot of the rendered view */
  async encode(canvas) {
    const scale = Math.min(1, this.maxInputSide / Math.max(canvas.width, canvas.height));
    let inputCanvas = canvas;
    if (scale < 1) {
      this.inputCanvas ??= document.createElement('canvas');
      this.inputCanvas.width = Math.max(1, Math.round(canvas.width * scale));
      this.inputCanvas.height = Math.max(1, Math.round(canvas.height * scale));
      this.inputCanvas.getContext('2d').drawImage(
        canvas,
        0,
        0,
        this.inputCanvas.width,
        this.inputCanvas.height,
      );
      inputCanvas = this.inputCanvas;
    }
    const ctx = inputCanvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = ctx.getImageData(
      0,
      0,
      inputCanvas.width,
      inputCanvas.height,
    );
    const image = new RawImage(new Uint8ClampedArray(data), width, height, 4);

    const nextInputs = await this.processor(image);
    const nextEmbeddings = await this.model.get_image_embeddings(nextInputs);

    disposeTensorRecord(this.embeddings);
    this.inputs?.pixel_values?.dispose?.();
    // Prompt coordinates remain in the frozen projection's coordinate space,
    // even when the fast provider analyzes a smaller copy internally.
    this.imageW = canvas.width;
    this.imageH = canvas.height;
    this.inputs = nextInputs;
    this.embeddings = nextEmbeddings;
  }

  /**
   * @param {number} x pixel x in the encoded image
   * @param {number} y pixel y in the encoded image
   * @returns {Promise<{masks: Uint8Array[], areas: number[], scores: number[], w: number, h: number}>}
   *          masks sorted small -> large
   */
  async decode(x, y) {
    return this.decodePoints([{ x, y, label: 1 }]);
  }

  /**
   * Decode with positive and negative point prompts. Positive points use
   * label=1 and negative/exclusion points use label=0.
   */
  async decodePoints(points) {
    if (!this.embeddings) throw new Error('Sam.decode called before encode');
    if (!points.length) throw new Error('Sam.decodePoints needs at least one point');

    const [rh, rw] = this.inputs.reshaped_input_sizes[0];
    const coords = [];
    const labels = [];
    for (const point of points) {
      coords.push(
        (point.x / this.imageW) * rw,
        (point.y / this.imageH) * rh,
      );
      labels.push(BigInt(point.label));
    }

    const input_points = new Tensor('float32', coords, [1, 1, points.length, 2]);
    const input_labels = new Tensor('int64', labels, [1, 1, points.length]);

    const out = await this.model({ ...this.embeddings, input_points, input_labels });
    const processed = await this.processor.post_process_masks(
      out.pred_masks,
      this.inputs.original_sizes,
      this.inputs.reshaped_input_sizes,
    );

    const t = processed[0];
    const dims = t.dims.length === 4 ? t.dims : [1, ...t.dims]; // [1, C, H, W]
    const C = dims[1], H = dims[2], W = dims[3];
    const src = t.data;
    const iou = Array.from(out.iou_scores.data);

    const entries = [];
    for (let c = 0; c < C; c++) {
      const m = new Uint8Array(H * W);
      let area = 0;
      const off = c * H * W;
      for (let i = 0; i < H * W; i++) {
        // post_process_masks may return logits rather than booleans. Negative
        // logits are non-zero (truthy in JavaScript) but mean background.
        // Explicitly thresholding at zero prevents an otherwise plausible SAM
        // result from becoming a near-full-frame mask.
        const on = Number(src[off + i]) > 0 ? 1 : 0;
        m[i] = on;
        area += on;
      }
      entries.push({ mask: m, area, score: iou[c] ?? 0 });
    }

    // Drop degenerate masks, then order by area: tightest region first.
    const kept = entries.filter((e) => e.area > 16);
    (kept.length ? kept : entries).sort((a, b) => a.area - b.area);
    const final = kept.length ? kept : entries;

    const result = {
      masks: final.map((e) => e.mask),
      areas: final.map((e) => e.area),
      scores: final.map((e) => e.score),
      suggested: final.reduce(
        (best, entry, i, all) => entry.score > all[best].score ? i : best,
        0,
      ),
      w: W,
      h: H,
    };
    for (const tensor of processed) tensor?.dispose?.();
    out.pred_masks?.dispose?.();
    out.iou_scores?.dispose?.();
    out.object_score_logits?.dispose?.();
    return result;
  }

  async dispose() {
    this.clearView();
    await this.model?.dispose?.();
  }

  clearView() {
    disposeTensorRecord(this.embeddings);
    this.inputs?.pixel_values?.dispose?.();
    this.embeddings = null;
    this.inputs = null;
    this.viewRevision = -1;
  }
}

function disposeTensorRecord(record) {
  if (!record) return;
  for (const value of Object.values(record)) value?.dispose?.();
}
