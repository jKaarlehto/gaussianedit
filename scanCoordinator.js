/**
 * DOM-free coordinator for an ordered all-sides scan.
 *
 * The renderer finishes the complete fixed view sequence before tracking
 * begins. Tracking results may arrive out of order, but lift and fusion always
 * consume them in the original view order.
 *
 * Dependency contracts:
 * - renderView(view, context) -> frame
 * - trackMask({ views, frames, seed, signal, runId }) ->
 *     Array | AsyncIterable | { results: Array | AsyncIterable, close? }
 * - liftMask({ view, frame, tracked, index, signal, runId }) -> lifted evidence
 * - fuseEvidence({ view, frame, tracked, lifted, index, signal, runId }) ->
 *     fused result
 *
 * Temporary values may expose dispose(), release(), or close(). The
 * coordinator releases them after every terminal path. A tracking session may
 * additionally expose cancel(reason), which is called before close/dispose
 * when its run was aborted.
 */
export class ScanCoordinator {
  constructor({
    renderView,
    trackMask,
    liftMask,
    fuseEvidence,
    onEvent = () => {},
  }) {
    for (const [name, dependency] of Object.entries({
      renderView,
      trackMask,
      liftMask,
      fuseEvidence,
    })) {
      if (typeof dependency !== 'function') {
        throw new TypeError(`ScanCoordinator requires a ${name} function`);
      }
    }
    if (typeof onEvent !== 'function') {
      throw new TypeError('ScanCoordinator onEvent must be a function');
    }

    this.renderView = renderView;
    this.trackMask = trackMask;
    this.liftMask = liftMask;
    this.fuseEvidence = fuseEvidence;
    this.onEvent = onEvent;
    this.nextRunId = 1;
    this.activeRun = null;
  }

  get running() {
    return Boolean(this.activeRun);
  }

  /**
   * Start a scan. A currently active run is superseded and fully cleaned
   * before the replacement invokes any provider.
   */
  start({ views, seed = null, signal: externalSignal = null } = {}, {
    reason = 'start',
  } = {}) {
    if (!Array.isArray(views) || views.length === 0) {
      throw new TypeError('ScanCoordinator.start requires a non-empty views array');
    }
    if (externalSignal != null && !isAbortSignal(externalSignal)) {
      throw new TypeError('ScanCoordinator signal must be an AbortSignal');
    }

    const previous = this.activeRun;
    if (previous && !previous.controller.signal.aborted) {
      this._event(previous, 'cancel-requested', {
        reason: 'superseded',
      });
      previous.controller.abort('superseded');
    }

    const run = {
      id: this.nextRunId++,
      reason,
      views: views.slice(),
      seed,
      controller: new AbortController(),
      externalSignal,
      removeExternalAbort: null,
      done: null,
    };
    this.activeRun = run;

    if (externalSignal) {
      const abortFromOutside = () => {
        if (run.controller.signal.aborted) return;
        this._event(run, 'cancel-requested', {
          reason: externalSignal.reason ?? 'external',
        });
        run.controller.abort(externalSignal.reason);
      };
      if (externalSignal.aborted) abortFromOutside();
      else {
        externalSignal.addEventListener('abort', abortFromOutside, { once: true });
        run.removeExternalAbort = () => {
          externalSignal.removeEventListener('abort', abortFromOutside);
        };
      }
    }

    run.done = (async () => {
      if (previous?.done) {
        try {
          await previous.done;
        } catch {
          // A superseded failed run has already emitted its terminal event.
        }
      }
      return this._run(run);
    })().finally(() => {
      run.removeExternalAbort?.();
      if (this.activeRun === run) this.activeRun = null;
    });
    return run.done;
  }

  /**
   * Restart from a changed seed mask. This is deliberately just a named
   * superseding start so there can never be two provider sessions in flight.
   */
  restart(request, reason = 'mask-edit') {
    if (this.activeRun) {
      this._event(this.activeRun, 'restart-requested', { reason });
    }
    return this.start(request, { reason });
  }

  /**
   * Request cancellation and return the active run's completion promise.
   */
  cancel(reason = 'user') {
    const run = this.activeRun;
    if (!run) return Promise.resolve(null);
    if (!run.controller.signal.aborted) {
      this._event(run, 'cancel-requested', { reason });
      run.controller.abort(reason);
    }
    return run.done;
  }

  async _run(run) {
    const { signal } = run.controller;
    const total = run.views.length;
    const frames = [];
    const fused = [];
    const cleanup = [];
    let terminalError = null;
    let status = 'completed';
    let counts = {
      rendered: 0,
      tracked: 0,
      lifted: 0,
      fused: 0,
    };

    this._event(run, 'scan-started', { total, reason: run.reason });
    try {
      throwIfAborted(signal);

      for (let index = 0; index < total; index++) {
        const view = run.views[index];
        const frame = await this.renderView(view, this._context(run, index));
        if (frame == null) {
          throw new Error(`renderView returned no frame for view ${viewLabel(view, index)}`);
        }
        frames.push(frame);
        cleanup.push(() => releaseTemporary(frame));
        throwIfAborted(signal);
        counts.rendered++;
        this._progress(run, 'rendering', counts.rendered, total, view, index);
      }
      this._event(run, 'rendering-complete', { total });
      throwIfAborted(signal);

      const tracker = await this.trackMask({
        views: run.views.slice(),
        frames: frames.slice(),
        seed: run.seed,
        signal,
        runId: run.id,
      });
      if (tracker == null) throw new Error('trackMask returned no tracking results');
      cleanup.push(() => releaseTracker(tracker, signal));
      throwIfAborted(signal);
      this._event(run, 'tracking-started', { total });

      const results = trackingResults(tracker);
      const pending = new Map();
      let nextIndex = 0;
      let emittedOrdinal = 0;

      for await (const tracked of results) {
        cleanup.push(() => releaseTemporary(tracked));
        throwIfAborted(signal);
        const index = trackedResultIndex(tracked, run.views, emittedOrdinal);
        emittedOrdinal++;
        if (pending.has(index) || index < nextIndex) {
          throw new Error(`trackMask returned view ${viewLabel(run.views[index], index)} twice`);
        }
        pending.set(index, tracked);
        counts.tracked++;
        this._progress(
          run,
          'tracking',
          counts.tracked,
          total,
          run.views[index],
          index,
        );

        while (pending.has(nextIndex)) {
          const currentIndex = nextIndex++;
          const currentView = run.views[currentIndex];
          const currentTracked = pending.get(currentIndex);
          pending.delete(currentIndex);
          this._event(run, 'evidence-active', {
            index: currentIndex,
            viewId: viewId(currentView, currentIndex),
          });

          const lifted = await this.liftMask({
            view: currentView,
            frame: frames[currentIndex],
            tracked: currentTracked,
            index: currentIndex,
            signal,
            runId: run.id,
          });
          if (lifted == null) {
            throw new Error(
              `liftMask returned no evidence for view ${viewLabel(currentView, currentIndex)}`,
            );
          }
          cleanup.push(() => releaseTemporary(lifted));
          throwIfAborted(signal);
          counts.lifted++;
          this._event(run, 'view-lifted', {
            completed: counts.lifted,
            total,
            index: currentIndex,
            viewId: viewId(currentView, currentIndex),
          });

          const fusedResult = await this.fuseEvidence({
            view: currentView,
            frame: frames[currentIndex],
            tracked: currentTracked,
            lifted,
            index: currentIndex,
            signal,
            runId: run.id,
          });
          throwIfAborted(signal);
          fused.push(fusedResult);
          counts.fused++;
          this._progress(
            run,
            'adding-to-3d',
            counts.fused,
            total,
            currentView,
            currentIndex,
          );
        }
      }

      if (nextIndex !== total) {
        const missing = run.views
          .map((view, index) => ({ view, index }))
          .filter(({ index }) => index >= nextIndex && !pending.has(index))
          .map(({ view, index }) => viewLabel(view, index));
        throw new Error(`trackMask omitted ${missing.join(', ') || 'one or more views'}`);
      }
      counts = Object.freeze({ ...counts });
    } catch (error) {
      terminalError = error;
      status = signal.aborted || isAbortError(error) ? 'cancelled' : 'failed';
    }

    this._event(run, 'cleanup-started', { status });
    const cleanupErrors = await runCleanup(cleanup);
    this._event(run, 'cleanup-complete', {
      status,
      errors: cleanupErrors.length,
    });
    if (cleanupErrors.length && status === 'completed') {
      status = 'failed';
      terminalError = cleanupErrors[0];
    }

    const result = Object.freeze({
      status,
      runId: run.id,
      reason: status === 'cancelled'
        ? signal.reason ?? terminalError?.message ?? 'cancelled'
        : run.reason,
      total,
      counts: Object.freeze({ ...counts }),
      fused: Object.freeze(fused.slice()),
    });

    if (status === 'cancelled') {
      this._event(run, 'scan-cancelled', {
        reason: result.reason,
        counts: result.counts,
      });
      return result;
    }
    if (status === 'failed') {
      this._event(run, 'scan-failed', {
        error: terminalError,
        counts: result.counts,
      });
      throw terminalError;
    }
    this._event(run, 'scan-completed', {
      counts: result.counts,
      total,
    });
    return result;
  }

  _context(run, index) {
    return Object.freeze({
      index,
      runId: run.id,
      signal: run.controller.signal,
      total: run.views.length,
    });
  }

  _progress(run, phase, completed, total, view, index) {
    this._event(run, 'progress', {
      phase,
      completed,
      total,
      index,
      viewId: viewId(view, index),
    });
  }

  _event(run, type, detail = {}) {
    const event = Object.freeze({
      type,
      runId: run.id,
      ...detail,
    });
    try {
      this.onEvent(event);
    } catch {
      // UI/event observers cannot corrupt the coordinator or leak resources.
    }
  }
}

export function createScanCoordinator(options) {
  return new ScanCoordinator(options);
}

function trackingResults(tracker) {
  const value = tracker?.results ?? tracker?.masks ?? tracker;
  if (Array.isArray(value)) return arrayAsAsyncIterable(value);
  if (value && typeof value[Symbol.asyncIterator] === 'function') return value;
  if (value && typeof value[Symbol.iterator] === 'function') {
    return arrayAsAsyncIterable([...value]);
  }
  throw new TypeError(
    'trackMask must return an array, iterable, async iterable, or a session with results',
  );
}

async function* arrayAsAsyncIterable(values) {
  for (const value of values) yield value;
}

function trackedResultIndex(tracked, views, ordinal) {
  const explicitId = tracked && typeof tracked === 'object'
    ? tracked.viewId ?? tracked.id
    : null;
  if (explicitId == null) {
    if (ordinal >= views.length) {
      throw new Error('trackMask returned more results than requested views');
    }
    return ordinal;
  }
  const index = views.findIndex(
    (view, viewIndex) => viewId(view, viewIndex) === String(explicitId),
  );
  if (index < 0) throw new Error(`trackMask returned unknown view ${explicitId}`);
  return index;
}

function viewId(view, index) {
  return String(view?.id ?? index);
}

function viewLabel(view, index) {
  return view?.label ?? viewId(view, index);
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw new DOMException('Scan cancelled', 'AbortError');
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function isAbortSignal(signal) {
  return typeof signal === 'object'
    && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function';
}

async function releaseTracker(tracker, signal) {
  const errors = [];
  if (signal.aborted && typeof tracker?.cancel === 'function') {
    try {
      await tracker.cancel(signal.reason);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const method of ['close', 'dispose', 'release']) {
    if (typeof tracker?.[method] !== 'function') continue;
    try {
      await tracker[method]();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}

async function releaseTemporary(value) {
  for (const method of ['dispose', 'release', 'close']) {
    if (typeof value?.[method] !== 'function') continue;
    await value[method]();
    return;
  }
}

async function runCleanup(cleanup) {
  const errors = [];
  for (let index = cleanup.length - 1; index >= 0; index--) {
    try {
      await cleanup[index]();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
