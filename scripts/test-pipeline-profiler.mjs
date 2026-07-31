import assert from 'node:assert/strict';
import {
  createPipelineProfiler,
  pipelineProfilerDiagnosticEnabled,
  PIPELINE_BYTE_BUDGETS,
  PIPELINE_STAGES,
} from '../pipelineProfiler.js';

assert.equal(pipelineProfilerDiagnosticEnabled(''), false);
assert.equal(pipelineProfilerDiagnosticEnabled('?pipelineProfiler=1'), true);
assert.equal(pipelineProfilerDiagnosticEnabled('?pipelineProfiler=0'), false);
assert.equal(pipelineProfilerDiagnosticEnabled('?other=1&pipelineProfiler=1'), true);

let disabledClockCalls = 0;
const disabled = createPipelineProfiler({
  enabled: false,
  clock: () => {
    disabledClockCalls++;
    return 10;
  },
});
const noop = disabled.begin(PIPELINE_STAGES.BROWSER_YOLO10);
noop
  .active(100)
  .yieldGap(20)
  .blocking(400, 'should-not-record')
  .begin(PIPELINE_STAGES.BROWSER_SAM_ENCODE)
  .fail(new Error('ignored'));
disabled.recordFrontendError({
  stage: PIPELINE_STAGES.SYNTHETIC_ORBIT_STAGING,
  error: new Error('ignored'),
});
assert.equal(disabledClockCalls, 0, 'disabled instrumentation never reads a clock');
assert.equal(disabled.snapshot().size, 0);
assert.equal(disabled.exportJSON(), JSON.stringify(disabled.snapshot()));

let now = 0;
let wallNow = Date.parse('2026-07-30T20:00:00.000Z');
const profiler = createPipelineProfiler({
  enabled: true,
  capacity: 8,
  clock: () => now,
  wallClock: () => wallNow,
});
const root = profiler.begin(PIPELINE_STAGES.MASK_FUSION_2D, {
  runId: 'run-7',
  revisions: {
    scene: 3,
    frame: 8,
    view: 9,
    selection: 11,
    mask: 14,
    scan: 2,
  },
  source: {
    providerId: 'smart-fusion',
    evidenceFamily: 'visible-frame-8',
    correlationGroup: 'rgb-8',
  },
});
now = 10;
const child = root.begin(PIPELINE_STAGES.GAUSSIAN_LIFT, {
  source: { providerId: 'projected-centre-lift' },
});
child
  .active(14)
  .yieldGap(6)
  .blocking(50, 'threshold-is-exclusive')
  .blocking(72, 'projection-chunk');
now = 40;
const childEvent = child.end({
  counts: {
    input: 400,
    output: 125,
    addedGaussians: 22,
    removedGaussians: 3,
  },
  bytes: {
    input: 1600,
    output: 500,
    staged: PIPELINE_BYTE_BUDGETS.staged + 1,
  },
});
now = 100;
const rootEvent = root.end({
  activeMs: 60,
  networkMs: 12,
  backendMs: 8,
});

assert.equal(childEvent.parentId, root.id);
assert.equal(childEvent.runId, 'run-7');
assert.deepEqual(childEvent.revisions, {
  scene: 3,
  frame: 8,
  view: 9,
  selection: 11,
  mask: 14,
  scan: 2,
});
assert.equal(childEvent.source.providerId, 'projected-centre-lift');
assert.equal(childEvent.source.evidenceFamily, 'visible-frame-8');
assert.equal(childEvent.wallMs, 30);
assert.equal(childEvent.activeCpuMs, 14);
assert.equal(childEvent.yieldGapMs, 6);
assert.deepEqual(childEvent.blockingSlices, [{
  durationMs: 72,
  attribution: 'projection-chunk',
}]);
assert.deepEqual(childEvent.exceededByteBudgets, ['staged']);
assert.equal(rootEvent.wallMs, 100);
assert.equal(rootEvent.yieldGapMs, 40);
assert.equal(rootEvent.networkMs, 12);
assert.equal(rootEvent.backendMs, 8);
assert.equal(root.end(), null, 'a span can be completed only once');

now = 110;
profiler.begin(PIPELINE_STAGES.BROWSER_SAM_DECODE, {
  runId: 'run-7',
  revisions: root.revisions,
}).cancel({ wallMs: 4 });
now = 120;
profiler.begin(PIPELINE_STAGES.EVIDENCE_FUSION, {
  runId: 'run-7',
  revisions: root.revisions,
}).stale({ wallMs: 5 });

const errorEvent = profiler.recordFrontendError({
  stage: PIPELINE_STAGES.SYNTHETIC_ORBIT_STAGING,
  runId: 'run-7',
  revisions: root.revisions,
  source: {
    providerId: 'C:\\private\\provider.bin',
    evidenceFamily: 'tracked-synthetic-view',
    correlationGroup: 'orbit-starboard',
    prompt: 'this field is not allowlisted',
  },
  code: 'black-frame/retry failed',
  error: new Error(
    'Failed "C:\\Users\\Private Name\\secret scene.png"; prompt="private object description"',
  ),
});
assert.equal(errorEvent.stage, PIPELINE_STAGES.SYNTHETIC_ORBIT_STAGING);
assert.equal(errorEvent.outcome, 'error');
assert.equal(errorEvent.errorCode, 'black-frame-retry-failed');
assert.ok(!errorEvent.message.includes('Private Name'));
assert.ok(!errorEvent.message.includes('private object description'));
assert.match(errorEvent.message, /\[path\]/);
assert.equal(errorEvent.source.providerId, '[path]');
assert.equal('prompt' in errorEvent.source, false);

const cappedMessage = profiler.recordFrontendError({
  stage: PIPELINE_STAGES.REFINE,
  runId: 'run-7',
  revisions: root.revisions,
  error: new Error('x'.repeat(500)),
});
assert.equal(cappedMessage.message.length, 240, 'frontend error messages stay bounded');

const secretMessage = profiler.recordFrontendError({
  stage: PIPELINE_STAGES.TRACKER_UPLOAD,
  runId: 'run-7',
  source: {
    providerId: 'https://tracker.invalid/upload?token=source-secret',
  },
  error: new Error(
    'Authorization: Bearer abc.def.ghi https://tracker.invalid/result?api_key=query-secret',
  ),
});
assert.equal(secretMessage.source.providerId, '[url]');
assert.equal(secretMessage.message, 'Bearer [redacted] [url]');

const outcomes = profiler.snapshot().events.map(({ outcome }) => outcome);
assert.deepEqual(outcomes, ['ok', 'ok', 'canceled', 'stale', 'error', 'error', 'error']);

let aggregationNow = 0;
const aggregation = createPipelineProfiler({
  enabled: true,
  capacity: 10,
  clock: () => aggregationNow,
  wallClock: () => wallNow,
});
for (const duration of [10, 20, 30, 40, 100]) {
  aggregation.begin(PIPELINE_STAGES.SAM3_TRACKING, {
    runId: `track-${duration}`,
  }).end({ wallMs: duration });
}
const summary = aggregation.snapshot().stages[0];
assert.deepEqual(summary, {
  stage: PIPELINE_STAGES.SAM3_TRACKING,
  count: 5,
  totalMs: 200,
  p50Ms: 30,
  p95Ms: 100,
  maxMs: 100,
  blockingSlices: 0,
  canceled: 0,
  stale: 0,
  errors: 0,
});

const bounded = createPipelineProfiler({
  enabled: true,
  capacity: 3,
  clock: () => 0,
  wallClock: () => wallNow,
});
for (let index = 1; index <= 5; index++) {
  bounded.begin(PIPELINE_STAGES.FRAME_ENCODE, {
    runId: `encode-${index}`,
  }).end({ wallMs: index });
}
const boundedSnapshot = bounded.snapshot();
assert.equal(boundedSnapshot.size, 3);
assert.equal(boundedSnapshot.dropped, 2);
assert.deepEqual(
  boundedSnapshot.events.map(({ runId }) => runId),
  ['encode-3', 'encode-4', 'encode-5'],
  'ring buffer retains only the newest events in chronological order',
);
assert.deepEqual(
  bounded.view({ recentLimit: 2 }).recent.map(({ runId }) => runId),
  ['encode-4', 'encode-5'],
);
assert.deepEqual(
  JSON.parse(bounded.exportJSON()).events.map(({ runId }) => runId),
  ['encode-3', 'encode-4', 'encode-5'],
  'JSON export is a read-only snapshot of the bounded buffer',
);

console.log('pipeline profiler bounds, revisions, outcomes, and aggregation tests passed');
