const BUFFER_IDS = Object.freeze(['scene', 'mask', 'object']);
const BUFFER_ID_SET = new Set(BUFFER_IDS);
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_COUNT_FIELDS = 32;

export const BUFFER_PREVIEW_IDS = Object.freeze({
  SCENE: 'scene',
  MASK: 'mask',
  OBJECT: 'object',
});

/**
 * Retains one last-valid preview for each workspace buffer.
 *
 * A revision is `{ tuple: number[], key: string }`. Tuples are compared
 * lexicographically; equal tuples must have equal keys. Render payloads are
 * opaque handles, while all preview metadata returned by the store is frozen.
 */
export function createBufferPreviewStore({
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  disposePayload,
} = {}) {
  return new BufferPreviewStore({ maxPayloadBytes, disposePayload });
}

class BufferPreviewStore {
  constructor({ maxPayloadBytes, disposePayload }) {
    this.maxPayloadBytes = normalizeByteLimit(maxPayloadBytes);
    this.disposePayload = typeof disposePayload === 'function'
      ? disposePayload
      : null;
    this.previews = new Map();
    this.disposed = false;
  }

  publish(input) {
    this.#assertLive();
    const bufferId = normalizeBufferId(input?.bufferId);
    const current = this.previews.get(bufferId) ?? null;
    const revision = normalizeRevision(input?.revision);
    const order = current
      ? compareRevision(revision, current.revision)
      : 1;

    if (order < 0 || (
      order === 0
      && revision.key !== current.revision.key
    )) {
      this.#disposeRejectedRender(input?.render, current?.render);
      return null;
    }

    const incomingRender = normalizeRender(input?.render);
    if (
      incomingRender
      && incomingRender.bytes != null
      && incomingRender.bytes > this.maxPayloadBytes
    ) {
      this.#disposeRender(incomingRender, current?.render);
      return null;
    }

    const sameRevision = Boolean(current && order === 0);
    const counts = sameRevision
      ? mergeMonotonicCounts(current.counts, input?.counts)
      : normalizeCounts(input?.counts);
    const render = incomingRender ?? (sameRevision ? current.render : null);
    const status = normalizeStatus(input?.status, counts);
    const preview = Object.freeze({
      bufferId,
      revision,
      status,
      counts,
      displayMode: normalizeDisplayMode(
        input?.displayMode,
        sameRevision ? current.displayMode : 'preview',
      ),
      render,
    });

    this.previews.set(bufferId, preview);
    if (current?.render && current.render !== render) {
      this.#disposeRender(current.render, render);
    }
    return preview;
  }

  /**
   * Adds tray/materialization counts without allowing a later update to lower
   * an already-published count. A newer revision inherits the last preview
   * payload so a workspace switch can show it immediately.
   */
  addCounts(bufferId, revision, additions, options = {}) {
    this.#assertLive();
    const id = normalizeBufferId(bufferId);
    const current = this.previews.get(id) ?? null;
    const normalizedRevision = normalizeRevision(revision);
    if (current && compareRevision(normalizedRevision, current.revision) < 0) {
      this.#disposeRejectedRender(options.render, current.render);
      return null;
    }
    if (
      current
      && compareRevision(normalizedRevision, current.revision) === 0
      && normalizedRevision.key !== current.revision.key
    ) {
      this.#disposeRejectedRender(options.render, current.render);
      return null;
    }

    const counts = addCounts(current?.counts, additions);
    return this.publish({
      bufferId: id,
      revision: normalizedRevision,
      status: options.status ?? current?.status,
      counts,
      displayMode: options.displayMode ?? current?.displayMode,
      render: options.render ?? current?.render,
    });
  }

  read(bufferId) {
    this.#assertLive();
    return this.previews.get(normalizeBufferId(bufferId)) ?? null;
  }

  clear(bufferId) {
    this.#assertLive();
    const id = normalizeBufferId(bufferId);
    const current = this.previews.get(id);
    if (!current) return false;
    this.previews.delete(id);
    this.#disposeRender(current.render);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const preview of this.previews.values()) {
      this.#disposeRender(preview.render);
    }
    this.previews.clear();
  }

  #assertLive() {
    if (this.disposed) throw new Error('Buffer preview store is disposed');
  }

  #disposeRejectedRender(render, retainedRender) {
    if (!render) return;
    this.#disposeRender(normalizeRender(render), retainedRender);
  }

  #disposeRender(render, retainedRender = null) {
    if (!render?.payload || render.payload === retainedRender?.payload) return;
    try {
      if (typeof render.dispose === 'function') {
        render.dispose(render.payload);
      } else if (this.disposePayload) {
        this.disposePayload(render.payload, render.source);
      } else if (typeof render.payload.close === 'function') {
        render.payload.close();
      }
    } catch {
      // Preview cleanup must not destabilize workspace navigation.
    }
  }
}

function normalizeBufferId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!BUFFER_ID_SET.has(id)) {
    throw new TypeError(`Unknown preview buffer: ${value}`);
  }
  return id;
}

function normalizeRevision(value) {
  if (!value || !Array.isArray(value.tuple) || value.tuple.length === 0) {
    throw new TypeError('revision.tuple must be a non-empty array');
  }
  const tuple = value.tuple.map((part, index) => {
    if (!Number.isSafeInteger(part) || part < 0) {
      throw new TypeError(`revision.tuple[${index}] must be a non-negative safe integer`);
    }
    return part;
  });
  const key = String(value.key ?? '').trim();
  if (!key) throw new TypeError('revision.key is required');
  return Object.freeze({
    tuple: Object.freeze(tuple),
    key,
  });
}

function compareRevision(left, right) {
  const length = Math.max(left.tuple.length, right.tuple.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.tuple[index] ?? -1;
    const rightPart = right.tuple[index] ?? -1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function normalizeCounts(value) {
  const output = {};
  const entries = Object.entries(value ?? {}).slice(0, MAX_COUNT_FIELDS);
  for (const [rawKey, rawCount] of entries) {
    const key = String(rawKey).trim();
    if (!key) continue;
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`counts.${key} must be a non-negative safe integer`);
    }
    output[key] = count;
  }
  return Object.freeze(output);
}

function mergeMonotonicCounts(current, incoming) {
  if (incoming == null) return current;
  const next = normalizeCounts(incoming);
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return Object.freeze(merged);
}

function addCounts(current, additions) {
  const delta = normalizeCounts(additions);
  const counts = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(delta)) {
    const next = (counts[key] ?? 0) + value;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`counts.${key} exceeds the safe integer range`);
    }
    counts[key] = next;
  }
  return Object.freeze(counts);
}

function normalizeStatus(value, counts) {
  let status = String(value ?? '').trim().toUpperCase();
  const hasSelection = Object.values(counts).some((count) => count > 0);
  if (!status) status = hasSelection ? 'READY' : 'EMPTY';
  if (status === 'EMPTY' && hasSelection) status = 'READY';
  return status;
}

function normalizeDisplayMode(value, fallback) {
  return String(value ?? fallback ?? 'preview').trim() || 'preview';
}

function normalizeRender(value) {
  if (value == null) return null;
  const bytes = estimatePayloadBytes(value.payload, value.bytes);
  const source = typeof value.source === 'object' && value.source !== null
    ? Object.freeze({ ...value.source })
    : value.source == null
      ? null
      : String(value.source);
  return Object.freeze({
    source,
    payload: value.payload ?? null,
    bytes,
    dispose: typeof value.dispose === 'function' ? value.dispose : null,
  });
}

function estimatePayloadBytes(payload, suppliedBytes) {
  if (suppliedBytes != null) {
    const bytes = Number(suppliedBytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('render.bytes must be a non-negative safe integer');
    }
    return bytes;
  }
  if (Number.isSafeInteger(payload?.byteLength) && payload.byteLength >= 0) {
    return payload.byteLength;
  }
  if (Number.isSafeInteger(payload?.size) && payload.size >= 0) {
    return payload.size;
  }
  if (
    Number.isSafeInteger(payload?.width)
    && payload.width >= 0
    && Number.isSafeInteger(payload?.height)
    && payload.height >= 0
  ) {
    const estimate = payload.width * payload.height * 4;
    return Number.isSafeInteger(estimate) ? estimate : null;
  }
  return null;
}

function normalizeByteLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('maxPayloadBytes must be a non-negative safe integer');
  }
  return limit;
}
