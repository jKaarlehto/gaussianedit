import assert from 'node:assert/strict';

import {
  createPipelineInstrumentation,
  PIPELINE_STAGES,
} from '../pipelineInstrumentation.js';

let disabledContextReads = 0;
let disabledClockReads = 0;
const disabled = createPipelineInstrumentation({
  enabled: false,
  getContext() {
    disabledContextReads++;
    return { runId: 'must-not-read' };
  },
  clock() {
    disabledClockReads++;
    return 0;
  },
});
const disabledSpan = disabled.begin(PIPELINE_STAGES.GAUSSIAN_LIFT);
const disabledValue = disabled.measureSlice(
  disabledSpan,
  'disabled-work',
  () => 42,
);
assert.equal(disabledValue, 42);
assert.equal(disabledContextReads, 0);
assert.equal(disabledClockReads, 0);
assert.equal(disabled.read().totalEvents, 0);

let now = 10;
let liveRevision = 3;
const instrumentation = createPipelineInstrumentation({
  enabled: true,
  capacity: 4,
  clock: () => now,
  wallClock: () => 1000,
  getContext() {
    return {
      runId: 'scan-9',
      revisions: {
        scene: 1,
        selection: liveRevision,
        scan: 9,
      },
      source: {
        evidenceFamily: 'tracked-orbit',
      },
    };
  },
});

const span = instrumentation.begin(PIPELINE_STAGES.PER_VIEW_LIFT, {
  revisions: { view: 7 },
  source: { viewId: 'starboard' },
});
now = 20;
const output = instrumentation.measureSlice(
  span,
  'projection-chunk',
  () => {
    now = 85;
    return 'lifted';
  },
);
assert.equal(output, 'lifted');
now = 100;
span.end({
  counts: {
    input: 1200,
    output: 400,
    addedGaussians: 90,
    removedGaussians: 2,
  },
  bytes: {
    input: 4800,
    output: 1600,
    projection: 12000,
    allocatedActual: 18400,
    allocatedEstimated: 22000,
  },
});

liveRevision = 4;
const stale = instrumentation.begin(PIPELINE_STAGES.EVIDENCE_FUSION);
instrumentation.finishError(stale, new Error('late result'), { stale: true });

const canceled = instrumentation.begin(PIPELINE_STAGES.SAM3_TRACKING);
instrumentation.finishError(
  canceled,
  new DOMException('request aborted', 'AbortError'),
);

const failed = instrumentation.begin(PIPELINE_STAGES.MATERIALIZATION, {
  source: { providerId: 'https://private.invalid/model?token=secret' },
});
instrumentation.finishError(
  failed,
  new Error('Authorization: Bearer hidden https://private.invalid/output?api_key=secret'),
  { code: 'materialize-failed' },
);

const snapshot = instrumentation.snapshot();
assert.ok(Object.isFrozen(snapshot));
assert.ok(Object.isFrozen(snapshot.events));
assert.equal(snapshot.events.length, 4);
assert.deepEqual(snapshot.events[0].revisions, {
  scene: 1,
  frame: null,
  view: 7,
  selection: 3,
  mask: null,
  scan: 9,
});
assert.equal(snapshot.events[0].activeCpuMs, 65);
assert.deepEqual(snapshot.events[0].blockingSlices, [{
  durationMs: 65,
  attribution: 'projection-chunk',
}]);
assert.equal(snapshot.events[1].outcome, 'stale');
assert.equal(snapshot.events[2].outcome, 'canceled');
assert.equal(snapshot.events[3].outcome, 'error');
assert.ok(!snapshot.events[3].message.includes('hidden'));
assert.ok(!snapshot.events[3].message.includes('private.invalid'));
assert.ok(!snapshot.events[3].source.providerId.includes('private.invalid'));
assert.throws(() => {
  snapshot.events.push({});
}, TypeError);

let fallibleContextReads = 0;
const fallibleContext = createPipelineInstrumentation({
  enabled: true,
  getContext() {
    fallibleContextReads++;
    throw new Error('diagnostic state unavailable');
  },
});
fallibleContext.begin(PIPELINE_STAGES.UNKNOWN).end();
assert.equal(fallibleContextReads, 1);
assert.equal(fallibleContext.snapshot().size, 1);

console.log('pipeline instrumentation live adapter and feature-off behavior: ok');
