/**
 * Model-agnostic object-hint orchestration.
 *
 * Detectors only need detect(canvas, options). This layer handles content
 * cropping, a sparse-result tiled second pass, coordinate remapping, and NMS.
 * A future YOLO-World/backend provider can replace the detector without
 * changing selection or HUD code.
 */
export class DetectionSuggestionPipeline {
  constructor(detector, {
    minimumHints = 10,
    maximumHints = 56,
    firstPassThreshold = 0.13,
    detailPassThreshold = 0.09,
  } = {}) {
    this.detector = detector;
    this.minimumHints = minimumHints;
    this.maximumHints = maximumHints;
    this.firstPassThreshold = firstPassThreshold;
    this.detailPassThreshold = detailPassThreshold;
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  async detect(sourceCanvas, {
    contentRegion = null,
    onPass = () => {},
  } = {}) {
    const full = {
      x: 0,
      y: 0,
      w: sourceCanvas.width,
      h: sourceCanvas.height,
    };
    const base = normalizeRegion(contentRegion ?? full, full);
    let proposals = await this.detectRegion(
      sourceCanvas,
      base,
      this.firstPassThreshold,
    );
    onPass({ pass: 1, total: 1, detections: proposals.length });

    if (proposals.length < this.minimumHints) {
      const tiles = overlappingTiles(base);
      let pass = 1;
      for (const tile of tiles) {
        pass++;
        onPass({ pass, total: tiles.length + 1, detections: proposals.length });
        proposals.push(...await this.detectRegion(
          sourceCanvas,
          tile,
          this.detailPassThreshold,
        ));
      }
    }

    return consolidateObjectProposals(proposals)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maximumHints)
      .map((proposal, index) => ({
        ...proposal,
        id: `${proposal.source}:${index}:${Math.round(proposal.box.x1)}:${Math.round(proposal.box.y1)}`,
      }));
  }

  async detectRegion(sourceCanvas, region, threshold) {
    const maximumSide = 1024;
    const scale = Math.min(1, maximumSide / Math.max(region.w, region.h));
    const width = Math.max(32, Math.round(region.w * scale));
    const height = Math.max(32, Math.round(region.h * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.clearRect(0, 0, width, height);
    this.context.drawImage(
      sourceCanvas,
      region.x,
      region.y,
      region.w,
      region.h,
      0,
      0,
      width,
      height,
    );
    const proposals = await this.detector.detect(this.canvas, {
      threshold,
      maxDetections: this.maximumHints,
    });
    const scaleX = region.w / width;
    const scaleY = region.h / height;
    return proposals.map((proposal) => {
      const box = {
        x1: region.x + proposal.box.x1 * scaleX,
        y1: region.y + proposal.box.y1 * scaleY,
        x2: region.x + proposal.box.x2 * scaleX,
        y2: region.y + proposal.box.y2 * scaleY,
      };
      return {
        ...proposal,
        box,
        area: Math.max(1, box.x2 - box.x1) * Math.max(1, box.y2 - box.y1),
      };
    });
  }
}

function overlappingTiles(region) {
  const tileWidth = region.w * 0.62;
  const tileHeight = region.h * 0.62;
  const offsetX = region.w - tileWidth;
  const offsetY = region.h - tileHeight;
  return [
    { x: region.x, y: region.y, w: tileWidth, h: tileHeight },
    { x: region.x + offsetX, y: region.y, w: tileWidth, h: tileHeight },
    { x: region.x, y: region.y + offsetY, w: tileWidth, h: tileHeight },
    {
      x: region.x + offsetX,
      y: region.y + offsetY,
      w: tileWidth,
      h: tileHeight,
    },
  ];
}

/**
 * The detail passes intentionally see the same object through overlapping
 * crops. Plain class-aware NMS is not enough here: the same rusty vehicle may
 * be called "car", "truck", or even "boat" by separate low-confidence passes.
 * Consolidate similarly sized, spatially coincident boxes as one physical
 * target while preserving small genuinely nested objects (for example a
 * person inside a car).
 */
export function consolidateObjectProposals(proposals) {
  const ordered = [...proposals].sort((a, b) =>
    proposalTier(b) - proposalTier(a) || b.score - a.score);
  const kept = [];
  for (const proposal of ordered) {
    const duplicate = kept.find((candidate) => likelySameObject(proposal, candidate));
    if (!duplicate) {
      kept.push({
        ...proposal,
        alternateLabels: [],
        detectionPasses: 1,
      });
      continue;
    }
    duplicate.detectionPasses++;
    if (proposal.label !== duplicate.label
      && !duplicate.alternateLabels.some(({ label }) => label === proposal.label)) {
      duplicate.alternateLabels.push({
        label: proposal.label,
        score: proposal.score,
      });
    }
  }
  return kept;
}

function proposalTier(proposal) {
  return proposal.tier === 'refined' ? 2 : 1;
}

function intersectionOverUnion(a, b) {
  const intersection = intersectionArea(a, b);
  if (!intersection) return 0;
  const areaA = boxArea(a);
  const areaB = boxArea(b);
  return intersection / Math.max(1, areaA + areaB - intersection);
}

function likelySameObject(a, b) {
  const areaA = boxArea(a.box);
  const areaB = boxArea(b.box);
  const smaller = Math.min(areaA, areaB);
  const larger = Math.max(areaA, areaB);
  const areaRatio = smaller / Math.max(1, larger);
  const intersection = intersectionArea(a.box, b.box);
  const containment = intersection / Math.max(1, smaller);
  const iou = intersection / Math.max(1, areaA + areaB - intersection);
  const centreDistance = normalizedCentreDistance(a.box, b.box);
  const sameLabel = String(a.label).toLowerCase() === String(b.label).toLowerCase();

  if (sameLabel) {
    return iou >= 0.3
      || (areaRatio >= 0.24 && containment >= 0.72)
      || (areaRatio >= 0.58 && centreDistance <= 0.2);
  }
  return areaRatio >= 0.48
    && (iou >= 0.36 || containment >= 0.72 || centreDistance <= 0.16);
}

function intersectionArea(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxArea(box) {
  return Math.max(1, box.x2 - box.x1) * Math.max(1, box.y2 - box.y1);
}

function normalizedCentreDistance(a, b) {
  const ax = (a.x1 + a.x2) * 0.5;
  const ay = (a.y1 + a.y2) * 0.5;
  const bx = (b.x1 + b.x2) * 0.5;
  const by = (b.y1 + b.y2) * 0.5;
  const scale = Math.max(
    1,
    Math.hypot(
      Math.max(a.x2 - a.x1, b.x2 - b.x1),
      Math.max(a.y2 - a.y1, b.y2 - b.y1),
    ),
  );
  return Math.hypot(ax - bx, ay - by) / scale;
}

function normalizeRegion(region, full) {
  const x = clamp(region.x, full.x, full.x + full.w);
  const y = clamp(region.y, full.y, full.y + full.h);
  const x2 = clamp(region.x + region.w, x + 1, full.x + full.w);
  const y2 = clamp(region.y + region.h, y + 1, full.y + full.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
