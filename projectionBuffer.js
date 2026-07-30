export const SELECTION_FRAME_CANVAS_COLOR_SPACE = 'srgb';
export const SELECTION_EDITOR_CAPTURE_LONG_EDGE = 2048;
export const SELECTION_EDITOR_CAPTURE_BYTE_BUDGET = 48 * 1024 * 1024;
// RGBA8 render target + depth, readback, ImageData, and canvas backing store.
export const SELECTION_EDITOR_CAPTURE_BYTES_PER_PIXEL = 20;

export function planSelectionEditorCapture({
  width,
  height,
  longEdgeCap = SELECTION_EDITOR_CAPTURE_LONG_EDGE,
  byteBudget = SELECTION_EDITOR_CAPTURE_BYTE_BUDGET,
  bytesPerPixel = SELECTION_EDITOR_CAPTURE_BYTES_PER_PIXEL,
} = {}) {
  if (!(width > 0) || !(height > 0) || !(longEdgeCap > 0)
    || !(byteBudget > 0) || !(bytesPerPixel > 0)) {
    throw new RangeError('Selection editor capture dimensions and budgets must be positive');
  }
  const sourceWidth = Math.floor(width);
  const sourceHeight = Math.floor(height);
  const sourcePixels = sourceWidth * sourceHeight;
  const maxPixels = Math.max(1, Math.floor(byteBudget / bytesPerPixel));
  const scale = Math.min(
    1,
    longEdgeCap / Math.max(sourceWidth, sourceHeight),
    Math.sqrt(maxPixels / sourcePixels),
  );
  const plannedWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const plannedHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const pixels = plannedWidth * plannedHeight;
  return Object.freeze({
    sourceWidth,
    sourceHeight,
    width: plannedWidth,
    height: plannedHeight,
    scale,
    longEdgeCap,
    byteBudget,
    bytesPerPixel,
    rgbaBytes: pixels * 4,
    estimatedBytes: pixels * bytesPerPixel,
  });
}

export function projectionOverlayIsCurrent({
  suggestionRevision,
  frameRevision,
  sameFrame,
} = {}) {
  return Boolean(
    sameFrame
    && Number.isInteger(frameRevision)
    && suggestionRevision === frameRevision,
  );
}

export function captureBoxToProjection(box, crop, width, height) {
  if (!box || !crop || !(crop.w > 0) || !(crop.h > 0)
    || !(width > 0) || !(height > 0)) return null;
  return {
    x1: (box.x1 - crop.x) * width / crop.w,
    y1: (box.y1 - crop.y) * height / crop.h,
    x2: (box.x2 - crop.x) * width / crop.w,
    y2: (box.y2 - crop.y) * height / crop.h,
  };
}

export function projectionTargetingOverlaysVisible(editMode = 'off') {
  return editMode === 'off';
}

export function projectionClientPointToMask({
  clientX,
  clientY,
  rect,
  output,
  crop,
  capture,
  mask,
} = {}) {
  const cropWidth = crop?.width ?? crop?.w;
  const cropHeight = crop?.height ?? crop?.h;
  if (!rect || !output || !crop || !capture || !mask
    || !(rect.width > 0) || !(rect.height > 0)
    || !(output.width > 0) || !(output.height > 0)
    || !(cropWidth > 0) || !(cropHeight > 0)
    || !(capture.width > 0) || !(capture.height > 0)
    || !(mask.width > 0) || !(mask.height > 0)) return null;

  const imageAspect = output.width / output.height;
  const boxAspect = rect.width / rect.height;
  let width = rect.width;
  let height = rect.height;
  let left = rect.left;
  let top = rect.top;
  if (imageAspect > boxAspect) {
    height = rect.width / imageAspect;
    top += (rect.height - height) * 0.5;
  } else {
    width = rect.height * imageAspect;
    left += (rect.width - width) * 0.5;
  }
  if (clientX < left || clientX > left + width
    || clientY < top || clientY > top + height) return null;

  const u = (clientX - left) / width;
  const v = (clientY - top) / height;
  const captureX = crop.x + u * cropWidth;
  const captureY = crop.y + v * cropHeight;
  return Object.freeze({
    captureX,
    captureY,
    maskX: captureX * mask.width / capture.width,
    maskY: captureY * mask.height / capture.height,
    contentWidth: width,
    contentHeight: height,
  });
}
