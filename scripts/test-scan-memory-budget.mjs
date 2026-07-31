import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_SCAN_MEMORY_LIMITS,
  estimateScanPeakBytes,
  planScanMemory,
  ScanMemoryLedger,
} from '../scanMemoryBudget.js';

const estimate = estimateScanPeakBytes({
  width: 1280,
  height: 720,
  viewCount: 8,
  trackingViewCount: 24,
  cutoutSplats: 360_000,
  selectionSplats: 120_000,
});
assert.equal(
  estimate.peakBytes,
  Object.values(estimate.breakdown).reduce((total, bytes) => total + bytes, 0),
);
assert.ok(estimate.breakdown.projectionLookup < 16 * 1024 * 1024);
assert.ok(estimate.breakdown.cutout > 0);
assert.ok(estimate.breakdown.stagedFrames > estimate.breakdown.activeCapture);
assert.equal(
  estimate.breakdown.selectionCopies,
  120_000 * DEFAULT_SCAN_MEMORY_LIMITS.selectionCopyBytesPerSplat,
);
assert.equal(estimate.trackingViewCount, 24);

const capped = planScanMemory({
  width: 3840,
  height: 2160,
  viewCount: 12,
  cutoutSplats: 600_000,
});
assert.equal(capped.status, 'reduced');
assert.ok(capped.width <= DEFAULT_SCAN_MEMORY_LIMITS.maxLongEdge);
assert.ok(capped.height <= DEFAULT_SCAN_MEMORY_LIMITS.maxLongEdge);
assert.ok(
  capped.width * capped.height <= DEFAULT_SCAN_MEMORY_LIMITS.maxPixelsPerView,
);
assert.equal(capped.viewCount, DEFAULT_SCAN_MEMORY_LIMITS.maxViews);
assert.equal(capped.cutoutSplats, DEFAULT_SCAN_MEMORY_LIMITS.maxCutoutSplats);
assert.ok(capped.reservation.peakBytes <= capped.limits.peakBytes);
assert.deepEqual(capped.decisions.slice(0, 3), [
  'reduce-resolution-to-component-cap',
  'reduce-view-count-to-component-cap',
  'reduce-cutout-to-component-cap',
]);

const constrained = planScanMemory({
  width: 1920,
  height: 1080,
  viewCount: 8,
  cutoutSplats: 360_000,
  limits: {
    ...DEFAULT_SCAN_MEMORY_LIMITS,
    peakBytes: 64 * 1024 * 1024,
  },
});
assert.notEqual(constrained.status, 'ok');
if (constrained.status !== 'rejected') {
  assert.ok(constrained.reservation.peakBytes <= constrained.limits.peakBytes);
  assert.ok(
    constrained.decisions.some((decision) => decision.includes('peak-budget')),
  );
}

const rejected = planScanMemory({
  width: 1920,
  height: 1080,
  viewCount: 8,
  cutoutSplats: 360_000,
  limits: {
    ...DEFAULT_SCAN_MEMORY_LIMITS,
    peakBytes: 18 * 1024 * 1024,
  },
});
assert.equal(rejected.status, 'rejected');
assert.equal(rejected.action, 'fail-closed');
assert.equal(rejected.decisions.at(-1), 'fail-closed');

const ledger = new ScanMemoryLedger(1_000);
const first = ledger.tryReserve('projection', 640);
assert.equal(first.ok, true);
assert.equal(ledger.tryReserve('frame', 400).ok, false);
const second = ledger.tryReserve('mask', 300);
assert.equal(second.ok, true);
assert.equal(ledger.snapshot().usedBytes, 940);
assert.equal(ledger.snapshot().peakBytes, 940);
assert.equal(ledger.release(first.token), true);
assert.equal(ledger.release(first.token), false);
assert.equal(ledger.snapshot().usedBytes, 300);
assert.equal(ledger.tryReserve('frame', 700).ok, true);
assert.equal(ledger.snapshot().peakBytes, 1_000);

const denseFrames = estimateScanPeakBytes({
  width: 640,
  height: 480,
  viewCount: 4,
  trackingViewCount: 16,
  cutoutSplats: 24_000,
  selectionSplats: 8_000,
});
const keyFramesOnly = estimateScanPeakBytes({
  width: 640,
  height: 480,
  viewCount: 4,
  trackingViewCount: 4,
  cutoutSplats: 24_000,
  selectionSplats: 8_000,
});
assert.ok(denseFrames.peakBytes > keyFramesOnly.peakBytes);

assert.throws(
  () => estimateScanPeakBytes({
    width: 640,
    height: 480,
    viewCount: 4,
    cutoutSplats: 10,
    projectionSplats: 11,
  }),
  /cannot exceed/,
);

const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const scanStart = main.slice(
  main.indexOf('async function startMultiviewRefinement'),
  main.indexOf('function coordinatedScanIsCurrent'),
);
const planAt = scanStart.indexOf('memoryPlan = planScanMemory');
const collectAt = scanStart.indexOf('collectRefinementProjectionIndices(analysis');
assert.ok(planAt >= 0 && collectAt > planAt);
assert.match(
  scanStart.slice(collectAt, collectAt + 320),
  /maxSplats:\s*memoryPlan\.cutoutSplats/,
);
const collector = main.slice(
  main.indexOf('function collectRefinementProjectionIndices'),
  main.indexOf("startMultiviewButton.addEventListener('click'"),
);
assert.match(collector, /indices\.length < maxSplats/);
assert.match(collector, /const contextCapacity = maxSplats - priorityCount/);
assert.match(collector, /indices\[priorityCount \+ slot\] = index/);
assert.match(collector, /canceled\(\)/);
assert.match(main, /async function collectRefinementProjectionIndices/);
assert.match(collector, /maxVisits = MAX_REFINEMENT_ROI_VISITS/);
assert.match(collector, /if \(recordVisit\(\)\) await yieldAtCheckpoint\(\)/);
assert.match(collector, /work > maxVisits/);
assert.doesNotMatch(
  collector,
  /await (?:recordVisit|checkpoint)\(\)/,
  'ordinary ROI visits must remain synchronous inside each bounded chunk',
);
assert.match(
  collector,
  /for \(const index of state\.selection\) \{\s*if \(indices\.length >= priorityLimit\) break;/,
);
assert.match(main, /new ScanMemoryLedger\(memoryPlan\.limits\.peakBytes\)/);
assert.match(main, /trackingViewCount:\s*synthetic\.trackingViews\.length/);
assert.match(main, /selectionSplats:\s*state\.selection\.size/);
assert.match(main, /reserveScanFrameBlob\(session, blob/);
assert.match(
  main,
  /await createProjectionIndexSpaceAsync\([\s\S]*?\(\) => session\.canceled \|\| !scanSeedIsCurrent\(session\)/,
  'the compact lookup must yield and reject an invalidated seed before tracking',
);

console.log('scan memory planning and reservations: ok');
