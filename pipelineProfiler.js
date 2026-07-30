const MIB = 1024 * 1024;
const MESSAGE_LIMIT = 240;
const MAX_BLOCKING_SLICES = 8;
const DEFAULT_CAPACITY = 512;
const MAX_CAPACITY = 4096;

export const PIPELINE_STAGES = Object.freeze({
  BROWSER_YOLO10: 'browser-yolo10-detect',
  BACKEND_YOLO12: 'backend-yolo12-detect',
  BROWSER_SAM_ENCODE: 'browser-sam-encode',
  BROWSER_SAM_DECODE: 'browser-sam-decode',
  CLASSIC_COLOR_EDGE: 'classic-color-edge',
  CLASSIC_RADIUS: 'classic-radius',
  MASK_FUSION_2D: 'mask-fusion-2d',
  GAUSSIAN_LIFT: 'gaussian-lift',
  BRIDGE_GROW: 'bridge-grow',
  REFINE: 'refine',
  SYNTHETIC_ORBIT_STAGING: 'synthetic-orbit-staging',
  SYNTHETIC_RENDER: 'synthetic-render',
  SYNTHETIC_READBACK: 'synthetic-readback',
  FRAME_ENCODE: 'frame-encode',
  TRACKER_UPLOAD: 'tracker-upload',
  SAM3_TRACKING: 'sam3-tracking',
  PER_VIEW_LIFT: 'per-view-lift',
  EVIDENCE_FUSION: 'evidence-fusion',
  MATERIALIZATION: 'materialization',
  UNKNOWN: 'unknown',
});

export const PIPELINE_BYTE_BUDGETS = Object.freeze({
  input: 128 * MIB,
  output: 128 * MIB,
  staged: 128 * MIB,
  cutout: 256 * MIB,
  projection: 128 * MIB,
  evidence: 384 * MIB,
  allocatedActual: 512 * MIB,
  allocatedEstimated: 512 * MIB,
});

const STAGE_SET = new Set(Object.values(PIPELINE_STAGES));
const REVISION_KEYS = Object.freeze([
  'scene',
  'frame',
  'view',
  'selection',
  'mask',
  'scan',
]);
const SOURCE_KEYS = Object.freeze([
  'providerId',
  'providerVersion',
  'modelId',
  'viewId',
  'evidenceFamily',
  'correlationGroup',
  'cause',
]);
const COUNT_KEYS = Object.freeze([
  'input',
  'output',
  'addedGaussians',
  'removedGaussians',
]);
const BYTE_KEYS = Object.freeze(Object.keys(PIPELINE_BYTE_BUDGETS));

const DISABLED_SNAPSHOT = Object.freeze({
  version: 1,
  enabled: false,
  capacity: 0,
  size: 0,
  dropped: 0,
  blockingThresholdMs: 50,
  byteBudgets: PIPELINE_BYTE_BUDGETS,
  events: Object.freeze([]),
  stages: Object.freeze([]),
});

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

const DISABLED_PROFILER = Object.freeze({
  enabled: false,
  begin() { return NOOP_SPAN; },
  recordFrontendError() { return null; },
  clear() {},
  snapshot() { return DISABLED_SNAPSHOT; },
  view() {
    return Object.freeze({
      enabled: false,
      totalEvents: 0,
      dropped: 0,
      stageSummary: Object.freeze([]),
      recent: Object.freeze([]),
    });
  },
  exportJSON(space = 0) {
    return JSON.stringify(DISABLED_SNAPSHOT, null, normalizeJsonSpace(space));
  },
});

export function createPipelineProfiler(options = {}) {
  if (!options.enabled) return DISABLED_PROFILER;
  return new PipelineProfiler(options);
}

class PipelineProfiler {
  constructor({
    capacity = DEFAULT_CAPACITY,
    clock = defaultClock,
    wallClock = Date.now,
    blockingThresholdMs = 50,
    byteBudgets = PIPELINE_BYTE_BUDGETS,
  }) {
    this.enabled = true;
    this.capacity = clampInteger(capacity, 1, MAX_CAPACITY);
    this.clock = clock;
    this.wallClock = wallClock;
    this.blockingThresholdMs = Math.max(0, finiteNumber(blockingThresholdMs, 50));
    this.byteBudgets = Object.freeze(normalizeBudgets(byteBudgets));
    this.buffer = new Array(this.capacity);
    this.cursor = 0;
    this.size = 0;
    this.dropped = 0;
    this.nextSpanId = 1;
    this.nextSequence = 1;
  }

  begin(stage, context = {}) {
    const parent = context.parent instanceof PipelineSpan
      ? context.parent
      : null;
    const revisions = normalizeRevisions({
      ...(parent?.revisions ?? {}),
      ...(context.revisions ?? {}),
    });
    const source = normalizeSource({
      ...(parent?.source ?? {}),
      ...(context.source ?? {}),
    });
    return new PipelineSpan(this, {
      id: `span-${this.nextSpanId++}`,
      parentId: parent?.id ?? sanitizeId(context.parentId),
      runId: sanitizeId(context.runId ?? parent?.runId) || 'unassigned',
      stage: normalizeStage(stage),
      revisions,
      source,
      startedAt: this.clock(),
    });
  }

  recordFrontendError({
    stage = PIPELINE_STAGES.UNKNOWN,
    runId,
    revisions,
    source,
    parentId,
    code = 'frontend-error',
    error,
    message,
    counts,
    bytes,
  } = {}) {
    const span = this.begin(stage, {
      runId,
      revisions,
      source: {
        ...source,
        cause: source?.cause || 'frontend',
      },
      parentId,
    });
    return span.fail(error ?? message ?? 'Frontend pipeline error', {
      code,
      counts,
      bytes,
    });
  }

  _record(span, outcome, metrics = {}) {
    const endedAt = this.clock();
    const wallMs = nonnegativeNumber(
      metrics.wallMs,
      Math.max(0, endedAt - span.startedAt),
    );
    const suppliedActive = metrics.activeCpuMs ?? metrics.activeMs;
    const activeMs = suppliedActive == null && span.activeMs === 0
      ? null
      : nonnegativeNumber(suppliedActive, span.activeMs);
    const explicitYield = metrics.yieldGapMs == null
      ? span.yieldGapMs
      : nonnegativeNumber(metrics.yieldGapMs, 0);
    const yieldGapMs = explicitYield > 0
      ? explicitYield
      : activeMs == null
        ? null
        : Math.max(0, wallMs - activeMs);
    const counts = normalizeNumericFields(metrics.counts, COUNT_KEYS, true);
    const bytes = normalizeNumericFields(metrics.bytes, BYTE_KEYS, true);
    const event = Object.freeze({
      sequence: this.nextSequence++,
      id: span.id,
      parentId: span.parentId,
      runId: span.runId,
      stage: span.stage,
      source: span.source,
      revisions: span.revisions,
      capturedAtMs: this.wallClock(),
      wallMs,
      activeCpuMs: activeMs,
      yieldGapMs,
      networkMs: nullableNonnegative(metrics.networkMs),
      backendMs: nullableNonnegative(metrics.backendMs),
      blockingSlices: Object.freeze(span.blockingSlices.map((slice) => (
        Object.freeze({ ...slice })
      ))),
      counts: Object.freeze(counts),
      bytes: Object.freeze(bytes),
      exceededByteBudgets: Object.freeze(exceededBudgets(bytes, this.byteBudgets)),
      outcome,
      canceled: outcome === 'canceled',
      stale: outcome === 'stale',
      errorCode: outcome === 'error' ? sanitizeCode(metrics.code) : null,
      message: sanitizeMessage(
        metrics.message
        ?? (metrics.error instanceof Error ? metrics.error.message : metrics.error),
      ),
    });
    this.buffer[this.cursor] = event;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    else this.dropped++;
    return event;
  }

  _events() {
    const events = [];
    const start = this.size === this.capacity ? this.cursor : 0;
    for (let index = 0; index < this.size; index++) {
      events.push(this.buffer[(start + index) % this.capacity]);
    }
    return events;
  }

  clear() {
    this.buffer.fill(undefined);
    this.cursor = 0;
    this.size = 0;
    this.dropped = 0;
  }

  snapshot() {
    const events = this._events().map(cloneEvent);
    return {
      version: 1,
      enabled: true,
      capacity: this.capacity,
      size: events.length,
      dropped: this.dropped,
      blockingThresholdMs: this.blockingThresholdMs,
      byteBudgets: { ...this.byteBudgets },
      events,
      stages: aggregateStages(events),
    };
  }

  view({ recentLimit = 30 } = {}) {
    const snapshot = this.snapshot();
    const limit = clampInteger(recentLimit, 0, 100);
    return {
      enabled: true,
      totalEvents: snapshot.size,
      dropped: snapshot.dropped,
      stageSummary: snapshot.stages,
      recent: snapshot.events.slice(Math.max(0, snapshot.events.length - limit)),
    };
  }

  exportJSON(space = 0) {
    return JSON.stringify(this.snapshot(), null, normalizeJsonSpace(space));
  }
}

class PipelineSpan {
  constructor(profiler, fields) {
    this.profiler = profiler;
    Object.assign(this, fields);
    this.activeMs = 0;
    this.yieldGapMs = 0;
    this.blockingSlices = [];
    this.finished = false;
  }

  begin(stage, context = {}) {
    return this.profiler.begin(stage, { ...context, parent: this });
  }

  active(durationMs) {
    if (!this.finished) this.activeMs += nonnegativeNumber(durationMs, 0);
    return this;
  }

  yieldGap(durationMs) {
    if (!this.finished) this.yieldGapMs += nonnegativeNumber(durationMs, 0);
    return this;
  }

  blocking(durationMs, attribution = 'main-thread') {
    const measured = nonnegativeNumber(durationMs, 0);
    if (
      !this.finished
      && measured > this.profiler.blockingThresholdMs
      && this.blockingSlices.length < MAX_BLOCKING_SLICES
    ) {
      this.blockingSlices.push(Object.freeze({
        durationMs: measured,
        attribution: sanitizeLabel(attribution, 80) || 'main-thread',
      }));
    }
    return this;
  }

  end(metrics = {}) {
    return this._finish('ok', metrics);
  }

  cancel(metrics = {}) {
    return this._finish('canceled', metrics);
  }

  stale(metrics = {}) {
    return this._finish('stale', metrics);
  }

  fail(error, metrics = {}) {
    return this._finish('error', { ...metrics, error });
  }

  _finish(outcome, metrics) {
    if (this.finished) return null;
    this.finished = true;
    return this.profiler._record(this, outcome, metrics);
  }
}

function aggregateStages(events) {
  const byStage = new Map();
  for (const event of events) {
    let bucket = byStage.get(event.stage);
    if (!bucket) {
      bucket = {
        stage: event.stage,
        durations: [],
        totalMs: 0,
        blockingSlices: 0,
        canceled: 0,
        stale: 0,
        errors: 0,
      };
      byStage.set(event.stage, bucket);
    }
    bucket.durations.push(event.wallMs);
    bucket.totalMs += event.wallMs;
    bucket.blockingSlices += event.blockingSlices.length;
    if (event.canceled) bucket.canceled++;
    if (event.stale) bucket.stale++;
    if (event.outcome === 'error') bucket.errors++;
  }
  return [...byStage.values()].map((bucket) => {
    const sorted = bucket.durations.sort((a, b) => a - b);
    return {
      stage: bucket.stage,
      count: sorted.length,
      totalMs: roundMetric(bucket.totalMs),
      p50Ms: roundMetric(percentile(sorted, 0.5)),
      p95Ms: roundMetric(percentile(sorted, 0.95)),
      maxMs: roundMetric(sorted.at(-1) ?? 0),
      blockingSlices: bucket.blockingSlices,
      canceled: bucket.canceled,
      stale: bucket.stale,
      errors: bucket.errors,
    };
  });
}

function percentile(sorted, percentileValue) {
  if (!sorted.length) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index];
}

function cloneEvent(event) {
  return {
    ...event,
    source: { ...event.source },
    revisions: { ...event.revisions },
    blockingSlices: event.blockingSlices.map((slice) => ({ ...slice })),
    counts: { ...event.counts },
    bytes: { ...event.bytes },
    exceededByteBudgets: [...event.exceededByteBudgets],
  };
}

function normalizeRevisions(revisions) {
  const output = {};
  for (const key of REVISION_KEYS) {
    output[key] = normalizeRevision(revisions?.[key]);
  }
  return Object.freeze(output);
}

function normalizeRevision(value) {
  if (Number.isFinite(value)) return value;
  const normalized = sanitizeLabel(value, 80);
  return normalized || null;
}

function normalizeSource(source) {
  const output = {};
  for (const key of SOURCE_KEYS) {
    output[key] = sanitizeMessage(source?.[key])?.slice(0, 100) || null;
  }
  return Object.freeze(output);
}

function normalizeNumericFields(source, keys, integer) {
  const output = {};
  for (const key of keys) {
    const value = source?.[key];
    output[key] = value == null
      ? null
      : integer
        ? Math.round(nonnegativeNumber(value, 0))
        : nonnegativeNumber(value, 0);
  }
  return output;
}

function normalizeBudgets(budgets) {
  const normalized = {};
  for (const key of BYTE_KEYS) {
    normalized[key] = Math.round(nonnegativeNumber(
      budgets?.[key],
      PIPELINE_BYTE_BUDGETS[key],
    ));
  }
  return normalized;
}

function exceededBudgets(bytes, budgets) {
  return BYTE_KEYS.filter((key) => (
    bytes[key] != null && bytes[key] > budgets[key]
  ));
}

function sanitizeMessage(value) {
  if (value == null) return null;
  return String(value)
    .replace(/\b(prompt|textPrompt|queryText)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;\r\n]+)/gi, '$1=[redacted]')
    .replace(/(["'])(?:file:\/\/\/|[A-Za-z]:\\|\\\\|\/(?:Users|home|tmp|var|mnt)\/)[^"']+\1/gi, '[path]')
    .replace(/\bfile:\/\/\/[^\s"'<>]+/gi, '[path]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/g, '[path]')
    .replace(/\/(?:Users|home|tmp|var|mnt)\/[^\s"'<>]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_LIMIT) || null;
}

function sanitizeCode(value) {
  return String(value || 'pipeline-error')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .slice(0, 80);
}

function sanitizeId(value) {
  return sanitizeLabel(value, 100);
}

function sanitizeLabel(value, limit) {
  if (value == null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function normalizeStage(stage) {
  return STAGE_SET.has(stage) ? stage : PIPELINE_STAGES.UNKNOWN;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonnegativeNumber(value, fallback) {
  return Math.max(0, finiteNumber(value, fallback));
}

function nullableNonnegative(value) {
  return value == null ? null : nonnegativeNumber(value, 0);
}

function clampInteger(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.floor(finiteNumber(value, minimum))));
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function normalizeJsonSpace(space) {
  return clampInteger(space, 0, 2);
}

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}
