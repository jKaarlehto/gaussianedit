/**
 * Track one visible WebGL presentation. Overlay passes are only valid after
 * the complete cockpit scene has been rendered into the default framebuffer.
 */
export function beginVisibleFrameTransaction(sequence) {
  return {
    sequence,
    cockpitRendered: false,
    overlays: [],
  };
}

export function markCockpitRendered(transaction) {
  if (!transaction) throw new Error('Visible frame transaction is missing');
  transaction.cockpitRendered = true;
}

export function assertOverlayAfterCockpit(transaction, overlayName) {
  if (!transaction?.cockpitRendered) {
    throw new Error(
      `${overlayName || 'Overlay'} cannot draw before the cockpit framebuffer`,
    );
  }
  transaction.overlays.push(overlayName || 'overlay');
}

/**
 * Inspect every pixel in a capture. Regular-stride sampling can miss a small
 * valid object, so black-frame rejection must use the complete bounded frame.
 */
export function analyzeRgbaFrame(pixels, width, height) {
  const pixelCount = Math.max(
    0,
    Math.min(Math.trunc(width) * Math.trunc(height), Math.floor(pixels?.length / 4)),
  );
  let litPixels = 0;
  let nonzeroRgbPixels = 0;
  let transparentPixels = 0;
  let luminanceTotal = 0;
  let maximumLuminance = 0;
  let minX = Math.max(0, Math.trunc(width));
  let minY = Math.max(0, Math.trunc(height));
  let maxX = -1;
  let maxY = -1;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminanceTotal += luminance;
    maximumLuminance = Math.max(maximumLuminance, luminance);
    if (red || green || blue) {
      nonzeroRgbPixels++;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (luminance >= 6) litPixels++;
    if (pixels[offset + 3] < 8) transparentPixels++;
  }

  return Object.freeze({
    pixels: pixelCount,
    meanLuminance: pixelCount ? luminanceTotal / pixelCount : 0,
    maximumLuminance,
    litPixels,
    litFraction: pixelCount ? litPixels / pixelCount : 0,
    nonzeroRgbPixels,
    nonzeroRgbFraction: pixelCount ? nonzeroRgbPixels / pixelCount : 0,
    transparentPixels,
    transparentFraction: pixelCount ? transparentPixels / pixelCount : 0,
    contentBounds: nonzeroRgbPixels
      ? Object.freeze({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      })
      : null,
    black: pixelCount === 0 || (litPixels === 0 && maximumLuminance < 3),
  });
}

export function inspectCaptureDimensions({
  logicalWidth,
  logicalHeight,
  drawingBufferWidth,
  drawingBufferHeight,
  targetWidth,
  targetHeight,
}) {
  const exact = logicalWidth === targetWidth
    && logicalHeight === targetHeight
    && drawingBufferWidth === targetWidth
    && drawingBufferHeight === targetHeight;
  return Object.freeze({
    logicalWidth,
    logicalHeight,
    drawingBufferWidth,
    drawingBufferHeight,
    targetWidth,
    targetHeight,
    exact,
  });
}
