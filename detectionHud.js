/**
 * Cached screen-space detector labels. These are intentionally independent of
 * the 3D selection overlay: YOLO boxes exist only in the frozen 2D projection.
 */
export class DetectionHud {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.context = canvas.getContext('2d');
    this.detections = [];
    this.sourceWidth = 1;
    this.sourceHeight = 1;
    this.handleResize = () => this.draw();
    addEventListener('resize', this.handleResize);
  }

  setDetections(detections = [], sourceWidth = 1, sourceHeight = 1) {
    this.detections = detections.filter(({ source }) => source?.startsWith?.('yolo'));
    this.sourceWidth = Math.max(1, sourceWidth);
    this.sourceHeight = Math.max(1, sourceHeight);
    this.draw();
  }

  clear() {
    this.detections = [];
    this.draw();
  }

  draw() {
    const rect = this.viewport.getBoundingClientRect();
    const pixelRatio = Math.min(devicePixelRatio, 2);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${rect.height}px`;
    }
    const context = this.context;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    if (!this.detections.length) return;

    const scaleX = rect.width / this.sourceWidth;
    const scaleY = rect.height / this.sourceHeight;
    const occupiedLabels = [];
    const ordered = [...this.detections]
      .sort((a, b) => b.score - a.score)
      .slice(0, 42);

    for (const detection of ordered) {
      const confidence = clamp01(detection.score);
      const opacity = 0.1 + Math.pow(confidence, 1.55) * 0.78;
      const x1 = detection.box.x1 * scaleX;
      const x2 = detection.box.x2 * scaleX;
      const y1 = detection.box.y1 * scaleY;
      const y2 = detection.box.y2 * scaleY;
      const anchorX = (x1 + x2) * 0.5;
      const anchorY = y1 + Math.min(8, Math.max(2, (y2 - y1) * 0.08));
      const direction = anchorX < rect.width * 0.54 ? 1 : -1;
      const vertical = anchorY > 46 ? -1 : 1;
      const kneeX = anchorX + direction * 13;
      const kneeY = anchorY + vertical * 12;
      const text = `${String(detection.label).toUpperCase()} ${Math.round(confidence * 100)}%`;
      context.font = '8px ui-monospace, "Cascadia Mono", monospace';
      const labelWidth = context.measureText(text).width;
      let labelX = direction > 0 ? kneeX + 4 : kneeX - labelWidth - 4;
      let labelY = kneeY + (vertical > 0 ? 8 : -3);
      labelX = Math.max(4, Math.min(rect.width - labelWidth - 4, labelX));
      labelY = avoidVerticalCollision(labelX, labelY, labelWidth, occupiedLabels);
      occupiedLabels.push({ x: labelX, y: labelY - 8, w: labelWidth, h: 11 });

      context.save();
      context.globalAlpha = opacity;
      context.strokeStyle = '#70d7ff';
      context.fillStyle = '#a9f6ff';
      context.lineWidth = confidence > 0.5 ? 1 : 0.75;
      context.beginPath();
      context.arc(anchorX, anchorY, 1.5, 0, Math.PI * 2);
      context.moveTo(anchorX, anchorY);
      context.lineTo(kneeX, kneeY);
      context.lineTo(direction > 0 ? labelX - 2 : labelX + labelWidth + 2, kneeY);
      context.stroke();
      context.fillText(text, labelX, labelY);
      context.restore();
    }
  }

  dispose() {
    removeEventListener('resize', this.handleResize);
    this.clear();
  }
}

function avoidVerticalCollision(x, y, width, occupied) {
  let candidate = y;
  for (let attempt = 0; attempt < 8; attempt++) {
    const box = { x, y: candidate - 8, w: width, h: 11 };
    if (!occupied.some((other) => overlaps(box, other))) return candidate;
    candidate += attempt % 2 ? -(attempt + 1) * 6 : (attempt + 1) * 6;
  }
  return candidate;
}

function overlaps(a, b) {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
