import assert from 'node:assert/strict';

import { createScanCoordinator } from '../scanCoordinator.js';

await testOrderedPipeline();
await testCancellationCleanup();
await testMaskEditRestart();
await testFailureCleanup();

console.log('scan coordinator ordering, cancellation, restart, and cleanup: ok');

async function testOrderedPipeline() {
  const calls = [];
  const events = [];
  const disposed = [];
  let trackerClosed = 0;
  const views = [{ id: 'left' }, { id: 'front' }, { id: 'right' }];
  const coordinator = createScanCoordinator({
    async renderView(view) {
      calls.push(`render:${view.id}`);
      return disposable(`frame:${view.id}`, disposed);
    },
    async trackMask({ views: trackedViews, frames, seed }) {
      calls.push(`track:${trackedViews.map(({ id }) => id).join(',')}`);
      assert.equal(frames.length, views.length);
      assert.deepEqual(seed, { maskRevision: 7 });
      return {
        // Deliberately return the last two views out of order. Fusion must
        // still advance through the original FIFO order.
        results: asyncIterator([
          disposableResult('left', disposed),
          disposableResult('right', disposed),
          disposableResult('front', disposed),
        ]),
        async close() {
          trackerClosed++;
          disposed.push('tracker');
        },
      };
    },
    async liftMask({ view, tracked }) {
      calls.push(`lift:${view.id}:${tracked.viewId}`);
      return disposable(`lifted:${view.id}`, disposed);
    },
    async fuseEvidence({ view, lifted }) {
      calls.push(`fuse:${view.id}:${lifted.name}`);
      return `fused:${view.id}`;
    },
    onEvent(event) {
      events.push(event);
    },
  });

  const result = await coordinator.start({
    views,
    seed: { maskRevision: 7 },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.counts, {
    rendered: 3,
    tracked: 3,
    lifted: 3,
    fused: 3,
  });
  assert.deepEqual(result.fused, ['fused:left', 'fused:front', 'fused:right']);
  assert.deepEqual(calls, [
    'render:left',
    'render:front',
    'render:right',
    'track:left,front,right',
    'lift:left:left',
    'fuse:left:lifted:left',
    'lift:front:front',
    'fuse:front:lifted:front',
    'lift:right:right',
    'fuse:right:lifted:right',
  ]);
  assert.equal(trackerClosed, 1);
  assert.deepEqual(new Set(disposed), new Set([
    'frame:left',
    'frame:front',
    'frame:right',
    'tracked:left',
    'tracked:front',
    'tracked:right',
    'lifted:left',
    'lifted:front',
    'lifted:right',
    'tracker',
  ]));

  const progress = events
    .filter(({ type }) => type === 'progress')
    .map(({ phase, completed, viewId }) => `${phase}:${completed}:${viewId}`);
  assert.deepEqual(progress, [
    'rendering:1:left',
    'rendering:2:front',
    'rendering:3:right',
    'tracking:1:left',
    'adding-to-3d:1:left',
    'tracking:2:right',
    'tracking:3:front',
    'adding-to-3d:2:front',
    'adding-to-3d:3:right',
  ]);
  assert.deepEqual(
    events.slice(-3).map(({ type }) => type),
    ['cleanup-started', 'cleanup-complete', 'scan-completed'],
  );
}

async function testCancellationCleanup() {
  const disposed = [];
  const events = [];
  const secondRenderStarted = deferred();
  let trackingCalls = 0;
  const coordinator = createScanCoordinator({
    async renderView(view, { signal }) {
      if (view.id === 'blocked') {
        secondRenderStarted.resolve();
        await waitForAbort(signal);
      }
      return disposable(`frame:${view.id}`, disposed);
    },
    async trackMask() {
      trackingCalls++;
      return [];
    },
    async liftMask() {
      assert.fail('liftMask must not run after render cancellation');
    },
    async fuseEvidence() {
      assert.fail('fuseEvidence must not run after render cancellation');
    },
    onEvent(event) {
      events.push(event);
    },
  });

  const running = coordinator.start({
    views: [{ id: 'ready' }, { id: 'blocked' }, { id: 'never' }],
  });
  await secondRenderStarted.promise;
  const cancelResult = await coordinator.cancel('user');
  const result = await running;

  assert.equal(cancelResult, result);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'user');
  assert.deepEqual(result.counts, {
    rendered: 1,
    tracked: 0,
    lifted: 0,
    fused: 0,
  });
  assert.equal(trackingCalls, 0);
  assert.deepEqual(disposed, ['frame:ready']);
  assert.deepEqual(
    events.slice(-3).map(({ type }) => type),
    ['cleanup-started', 'cleanup-complete', 'scan-cancelled'],
  );
}

async function testMaskEditRestart() {
  const disposed = [];
  const events = [];
  const oldTrackingStarted = deferred();
  let oldTrackerCancelled = 0;
  let oldTrackerClosed = 0;
  const coordinator = createScanCoordinator({
    async renderView(view) {
      return disposable(`frame:${view.id}`, disposed);
    },
    async trackMask({ seed, signal, views }) {
      if (seed.revision === 1) {
        oldTrackingStarted.resolve();
        return {
          results: (async function* oldResults() {
            await waitForAbort(signal);
          })(),
          async cancel(reason) {
            assert.equal(reason, 'superseded');
            oldTrackerCancelled++;
          },
          async close() {
            oldTrackerClosed++;
          },
        };
      }
      return views.map(({ id }) => ({
        viewId: id,
        mask: `mask:${seed.revision}:${id}`,
      }));
    },
    async liftMask({ view, tracked }) {
      return { viewId: view.id, mask: tracked.mask };
    },
    async fuseEvidence({ view, lifted }) {
      return `${lifted.mask}->${view.id}`;
    },
    onEvent(event) {
      events.push(event);
    },
  });

  const first = coordinator.start({
    views: [{ id: 'old-left' }, { id: 'old-right' }],
    seed: { revision: 1 },
  });
  await oldTrackingStarted.promise;
  const replacement = coordinator.restart({
    views: [{ id: 'new-left' }, { id: 'new-right' }],
    seed: { revision: 2 },
  }, 'mask-edit');

  const firstResult = await first;
  const replacementResult = await replacement;
  assert.equal(firstResult.status, 'cancelled');
  assert.equal(replacementResult.status, 'completed');
  assert.deepEqual(replacementResult.fused, [
    'mask:2:new-left->new-left',
    'mask:2:new-right->new-right',
  ]);
  assert.equal(oldTrackerCancelled, 1);
  assert.equal(oldTrackerClosed, 1);
  assert.deepEqual(
    disposed.filter((name) => name.startsWith('frame:old')),
    ['frame:old-right', 'frame:old-left'],
  );

  const oldTerminal = events.findIndex(
    ({ type, runId }) => type === 'scan-cancelled' && runId === firstResult.runId,
  );
  const replacementStart = events.findIndex(
    ({ type, runId }) => type === 'scan-started'
      && runId === replacementResult.runId,
  );
  assert.ok(oldTerminal >= 0 && replacementStart > oldTerminal);
  assert.ok(events.some(
    ({ type, reason, runId }) => type === 'restart-requested'
      && reason === 'mask-edit'
      && runId === firstResult.runId,
  ));
}

async function testFailureCleanup() {
  const disposed = [];
  const events = [];
  let trackerClosed = 0;
  const coordinator = createScanCoordinator({
    async renderView(view) {
      return disposable(`frame:${view.id}`, disposed);
    },
    async trackMask({ views }) {
      return {
        results: views.map(({ id }) => disposableResult(id, disposed)),
        async close() {
          trackerClosed++;
        },
      };
    },
    async liftMask({ view }) {
      return disposable(`lifted:${view.id}`, disposed);
    },
    async fuseEvidence() {
      throw new Error('fake fusion failure');
    },
    onEvent(event) {
      events.push(event);
    },
  });

  await assert.rejects(
    coordinator.start({ views: [{ id: 'failure' }] }),
    /fake fusion failure/,
  );
  assert.equal(trackerClosed, 1);
  assert.deepEqual(new Set(disposed), new Set([
    'frame:failure',
    'tracked:failure',
    'lifted:failure',
  ]));
  assert.deepEqual(
    events.slice(-3).map(({ type }) => type),
    ['cleanup-started', 'cleanup-complete', 'scan-failed'],
  );
}

function disposable(name, disposed) {
  return {
    name,
    async dispose() {
      disposed.push(name);
    },
  };
}

function disposableResult(viewId, disposed) {
  return {
    viewId,
    async dispose() {
      disposed.push(`tracked:${viewId}`);
    },
  };
}

async function* asyncIterator(values) {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function abortError() {
  return new DOMException('aborted', 'AbortError');
}
