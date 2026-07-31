import {
  createPipelineProfiler,
  PIPELINE_STAGES,
} from './pipelineProfiler.js';

const EMPTY_CONTEXT = Object.freeze({});

const NOOP_SPAN = Object.freeze({
  id: null,
  begin() { return this; },
  active() { return this; },
  yieldGap() { return this; },
  blocking() { return this; },
  end() { return null; },
  cancel() { return null; },
  stale() { return null; },
  fail() { return null; },
});

/**
 * Thin live-call-site adapter around the bounded profiler core.
 *
 * `getContext` is evaluated only when profiling is enabled. It should return:
 * `{ runId, revisions, source }`. Explicit begin() context wins over the live
 * defaults, while revision/source fields are merged independently.
 */
export function createPipelineInstrumentation({
  enabled = false,
  getContext = () => EMPTY_CONTEXT,
  profiler: suppliedProfiler = null,
  ...profilerOptions
} = {}) {
  const profiler = suppliedProfiler ?? createPipelineProfiler({
    enabled,
    ...profilerOptions,
  });
  if (!profiler.enabled) return createDisabledInstrumentation(profiler);

  const clock = typeof profiler.clock === 'function'
    ? profiler.clock
    : typeof profilerOptions.clock === 'function'
      ? profilerOptions.clock
      : defaultClock;

  function begin(stage, context = EMPTY_CONTEXT) {
    const live = safeContext(getContext);
    return profiler.begin(stage, {
      ...live,
      ...context,
      runId: context.runId ?? live.runId,
      revisions: {
        ...(live.revisions ?? EMPTY_CONTEXT),
        ...(context.revisions ?? EMPTY_CONTEXT),
      },
      source: {
        ...(live.source ?? EMPTY_CONTEXT),
        ...(context.source ?? EMPTY_CONTEXT),
      },
    });
  }

  /**
   * Measure one synchronous main-thread slice. Awaited/network/GPU latency must
   * be reported as wall/network/backend time when the parent span is finished,
   * not passed through this helper.
   */
  function measureSlice(span, attribution, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('measureSlice requires an operation function');
    }
    const startedAt = clock();
    try {
      return operation();
    } finally {
      const durationMs = Math.max(0, clock() - startedAt);
      span?.active?.(durationMs);
      span?.blocking?.(durationMs, attribution);
    }
  }

  /**
   * Finish a span from a caught pipeline error without conflating cancellation,
   * stale-result rejection, and a genuine failure.
   */
  function finishError(span, error, {
    signal = null,
    stale = false,
    ...metrics
  } = {}) {
    if (stale) return span?.stale?.(metrics) ?? null;
    if (signal?.aborted || isAbortError(error)) {
      return span?.cancel?.({
        ...metrics,
        message: signal?.reason ?? error?.message ?? 'cancelled',
      }) ?? null;
    }
    return span?.fail?.(error, metrics) ?? null;
  }

  return Object.freeze({
    enabled: true,
    profiler,
    begin,
    measureSlice,
    finishError,
    read(options) {
      return deepFreeze(profiler.view(options));
    },
    snapshot() {
      return deepFreeze(profiler.snapshot());
    },
    clear() {
      profiler.clear();
    },
  });
}

function createDisabledInstrumentation(profiler) {
  return Object.freeze({
    enabled: false,
    profiler,
    begin() {
      return NOOP_SPAN;
    },
    measureSlice(_span, _attribution, operation) {
      if (typeof operation !== 'function') {
        throw new TypeError('measureSlice requires an operation function');
      }
      return operation();
    },
    finishError() {
      return null;
    },
    read(options) {
      return profiler.view(options);
    },
    snapshot() {
      return profiler.snapshot();
    },
    clear() {},
  });
}

function safeContext(getContext) {
  try {
    const context = getContext();
    return context && typeof context === 'object' ? context : EMPTY_CONTEXT;
  } catch {
    // Diagnostics cannot be allowed to break the live pipeline.
    return EMPTY_CONTEXT;
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export { PIPELINE_STAGES };
