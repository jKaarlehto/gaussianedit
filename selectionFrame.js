const DEFAULT_COLOR_TRANSFORM = Object.freeze({
  outputColorSpace: 'srgb',
  toneMapping: 'none',
  toneMappingExposure: 1,
  alpha: 'opaque',
});

/**
 * Immutable description of the exact image/camera contract used by selection.
 *
 * Large projection buffers deliberately live outside this record. The frame is
 * the small provenance token that every model result, edit and lift can compare
 * by identity before publishing work.
 */
export function createSelectionFrame({
  viewRevision,
  sceneRevision,
  viewMatrix,
  projectionMatrix,
  viewProjectionMatrix,
  framebuffer,
  capture,
  cssViewport,
  crop = null,
  colorTransform = DEFAULT_COLOR_TRANSFORM,
  orientation = 'top-left',
}) {
  const framebufferSize = freezeSize(framebuffer, 'framebuffer');
  const captureSize = freezeSize(capture, 'capture');
  const css = freezeRect(cssViewport, 'cssViewport');
  const captureCrop = freezeCrop(crop ?? {
    x: 0,
    y: 0,
    width: captureSize.width,
    height: captureSize.height,
  }, captureSize);
  const cssToCapture = Object.freeze({
    x: captureSize.width / css.width,
    y: captureSize.height / css.height,
  });
  const framebufferToCapture = Object.freeze({
    x: captureSize.width / framebufferSize.width,
    y: captureSize.height / framebufferSize.height,
  });
  const camera = Object.freeze({
    viewMatrix: freezeMatrix(viewMatrix, 'viewMatrix'),
    projectionMatrix: freezeMatrix(projectionMatrix, 'projectionMatrix'),
    viewProjectionMatrix: freezeMatrix(viewProjectionMatrix, 'viewProjectionMatrix'),
  });
  const color = Object.freeze({
    ...DEFAULT_COLOR_TRANSFORM,
    ...colorTransform,
  });

  return Object.freeze({
    id: `selection-frame:${sceneRevision}:${viewRevision}`,
    viewRevision,
    sceneRevision,
    camera,
    framebuffer: framebufferSize,
    capture: captureSize,
    cssViewport: css,
    cssToCapture,
    framebufferToCapture,
    crop: captureCrop,
    colorTransform: color,
    orientation,
  });
}

export function selectionFrameMatches(frame, {
  viewRevision,
  sceneRevision,
  framebufferWidth,
  framebufferHeight,
} = {}) {
  if (!frame) return false;
  return frame.viewRevision === viewRevision
    && frame.sceneRevision === sceneRevision
    && (framebufferWidth == null || frame.framebuffer.width === framebufferWidth)
    && (framebufferHeight == null || frame.framebuffer.height === framebufferHeight);
}

export function assertSelectionFrame(frame, current) {
  if (selectionFrameMatches(frame, current)) return frame;
  const error = new Error('Selection frame is stale');
  error.name = 'AbortError';
  throw error;
}

/**
 * Map a DOM pointer to the exact top-left-origin capture pixel used by models.
 *
 * The current viewport rect may move on screen, but a resize invalidates the
 * frozen frame because its CSS-to-frame scale would no longer be authoritative.
 */
export function clientPointToCapture(frame, clientX, clientY, currentViewport = null) {
  if (!frame) return null;
  const viewport = currentViewport
    ? normalizeRect(currentViewport, 'currentViewport')
    : frame.cssViewport;
  if (!nearlyEqual(viewport.width, frame.cssViewport.width)
    || !nearlyEqual(viewport.height, frame.cssViewport.height)) {
    return null;
  }
  const x = (clientX - viewport.left) * frame.cssToCapture.x;
  const y = (clientY - viewport.top) * frame.cssToCapture.y;
  if (x < 0 || y < 0 || x >= frame.capture.width || y >= frame.capture.height) {
    return null;
  }
  return Object.freeze({ x, y });
}

export function capturePointToCrop(frame, x, y) {
  if (!frame) return null;
  const crop = frame.crop;
  return Object.freeze({
    x: (x - crop.x) / crop.width,
    y: (y - crop.y) / crop.height,
  });
}

export function cropPointToCapture(frame, u, v) {
  if (!frame) return null;
  const crop = frame.crop;
  return Object.freeze({
    x: crop.x + u * crop.width,
    y: crop.y + v * crop.height,
  });
}

export function capturePointToMask(frame, x, y, maskWidth, maskHeight) {
  if (!frame || !(maskWidth > 0) || !(maskHeight > 0)) return null;
  return Object.freeze({
    x: x * maskWidth / frame.capture.width,
    y: y * maskHeight / frame.capture.height,
  });
}

export function framebufferPointToCapture(frame, x, y) {
  if (!frame) return null;
  return Object.freeze({
    x: x * frame.framebufferToCapture.x,
    y: y * frame.framebufferToCapture.y,
  });
}

export function viewMatricesMatch(frozen, current, epsilon = 1e-5) {
  if (!frozen || !current || frozen.length !== 16 || current.length !== 16) {
    return false;
  }
  for (let index = 0; index < 16; index++) {
    const scale = Math.max(1, Math.abs(frozen[index]), Math.abs(current[index]));
    if (Math.abs(frozen[index] - current[index]) > epsilon * scale) return false;
  }
  return true;
}

function freezeMatrix(values, label) {
  if (!values || values.length !== 16) {
    throw new TypeError(`${label} must contain 16 values`);
  }
  return Object.freeze(Array.from(values, Number));
}

function freezeSize(value, label) {
  const width = positive(value?.width, `${label}.width`);
  const height = positive(value?.height, `${label}.height`);
  return Object.freeze({ width, height });
}

function freezeRect(value, label) {
  const rect = normalizeRect(value, label);
  return Object.freeze(rect);
}

function normalizeRect(value, label) {
  return {
    left: finite(value?.left, `${label}.left`),
    top: finite(value?.top, `${label}.top`),
    width: positive(value?.width, `${label}.width`),
    height: positive(value?.height, `${label}.height`),
  };
}

function freezeCrop(value, capture) {
  const x = finite(value?.x, 'crop.x');
  const y = finite(value?.y, 'crop.y');
  const width = positive(value?.width ?? value?.w, 'crop.width');
  const height = positive(value?.height ?? value?.h, 'crop.height');
  if (x < 0 || y < 0 || x + width > capture.width || y + height > capture.height) {
    throw new RangeError('crop must stay inside the capture');
  }
  return Object.freeze({ x, y, width, height });
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function positive(value, label) {
  const number = finite(value, label);
  if (!(number > 0)) throw new RangeError(`${label} must be positive`);
  return number;
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.001);
}
