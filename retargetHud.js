function intersectArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Place the compact target-switch decision beside its candidate without
 * escaping the viewport. Prefer a side with no candidate overlap, then dock
 * to the least-overlapping bounded position on very narrow viewports.
 */
export function positionRetargetHud({
  candidate,
  hudWidth,
  hudHeight,
  viewportWidth,
  viewportHeight,
  gap = 10,
  margin = 12,
}) {
  const width = Math.min(Math.max(1, hudWidth), Math.max(1, viewportWidth - margin * 2));
  const height = Math.min(Math.max(1, hudHeight), Math.max(1, viewportHeight - margin * 2));
  const candidates = [
    { left: candidate.right + gap, top: candidate.top },
    { left: candidate.left - gap - width, top: candidate.top },
    {
      left: candidate.left + (candidate.right - candidate.left - width) / 2,
      top: candidate.bottom + gap,
    },
    {
      left: candidate.left + (candidate.right - candidate.left - width) / 2,
      top: candidate.top - gap - height,
    },
  ].map((position) => {
    const left = clamp(position.left, margin, viewportWidth - margin - width);
    const top = clamp(position.top, margin, viewportHeight - margin - height);
    const rect = { left, top, right: left + width, bottom: top + height };
    return { ...rect, overlap: intersectArea(rect, candidate) };
  });
  candidates.sort((a, b) => a.overlap - b.overlap);
  const best = candidates[0];
  return Object.freeze({
    left: best.left,
    top: best.top,
    width,
    height,
    overlapsCandidate: best.overlap > 0,
  });
}
