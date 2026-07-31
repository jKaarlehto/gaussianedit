const DEFAULT_LOAD_FACTOR = 0.7;
const DEFAULT_MAX_ENTRIES = 360_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * ROI-sized global Gaussian id -> compact slot lookup.
 *
 * `slots` stores one-based local slots so zero can mark an empty hash bucket.
 * The parallel key array means global id zero remains valid without a sentinel
 * value. Memory scales with the resident cutout, never the full scene.
 */
export class CompactIndexLookup {
  constructor(entryCount, {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    loadFactor = DEFAULT_LOAD_FACTOR,
  } = {}) {
    assertNonNegativeInteger(entryCount, 'entryCount');
    assertPositiveInteger(maxEntries, 'maxEntries');
    assertPositiveInteger(maxBytes, 'maxBytes');
    if (!(loadFactor > 0.5) || !(loadFactor <= 0.85)) {
      throw new RangeError('loadFactor must be greater than 0.5 and at most 0.85');
    }
    if (entryCount > maxEntries) {
      throw new RangeError(
        `Compact index lookup rejected ${entryCount} entries; limit is ${maxEntries}`,
      );
    }

    const capacity = hashCapacity(entryCount, loadFactor);
    const byteLength = capacity * Uint32Array.BYTES_PER_ELEMENT * 2;
    if (byteLength > maxBytes) {
      throw new RangeError(
        `Compact index lookup requires ${byteLength} bytes; limit is ${maxBytes}`,
      );
    }

    this.keys = new Uint32Array(capacity);
    this.slots = new Uint32Array(capacity);
    this.capacity = capacity;
    this.byteLength = byteLength;
    this.entryCount = entryCount;
    this.mask = capacity - 1;
  }

  set(globalIndex, localSlot) {
    assertUint32(globalIndex, 'globalIndex');
    assertNonNegativeInteger(localSlot, 'localSlot');
    if (localSlot >= 0xffff_ffff) {
      throw new RangeError('localSlot exceeds the compact lookup range');
    }
    let bucket = hashUint32(globalIndex) & this.mask;
    for (let probe = 0; probe < this.capacity; probe++) {
      const stored = this.slots[bucket];
      if (stored === 0) {
        this.keys[bucket] = globalIndex;
        this.slots[bucket] = localSlot + 1;
        return;
      }
      if (this.keys[bucket] === globalIndex) {
        throw new RangeError(`Duplicate global Gaussian id ${globalIndex}`);
      }
      bucket = (bucket + 1) & this.mask;
    }
    throw new RangeError('Compact index lookup capacity was exhausted');
  }

  /** Return a zero-based compact slot, or -1 when the id is outside the ROI. */
  slot(globalIndex) {
    if (!Number.isInteger(globalIndex) || globalIndex < 0
      || globalIndex > 0xffff_ffff) return -1;
    let bucket = hashUint32(globalIndex) & this.mask;
    for (let probe = 0; probe < this.capacity; probe++) {
      const stored = this.slots[bucket];
      if (stored === 0) return -1;
      if (this.keys[bucket] === globalIndex) return stored - 1;
      bucket = (bucket + 1) & this.mask;
    }
    return -1;
  }
}

export function createCompactIndexLookup(globalIndices, options = {}) {
  const indices = normalizeGlobalIndices(globalIndices);
  const lookup = new CompactIndexLookup(indices.length, options);
  for (let slot = 0; slot < indices.length; slot++) {
    lookup.set(indices[slot], slot);
  }
  return lookup;
}

export async function createCompactIndexLookupAsync(
  globalIndices,
  onProgress = () => {},
  shouldCancel = () => false,
  {
    chunkSize = 32_000,
    yieldTask = defaultYieldTask,
    ...options
  } = {},
) {
  const indices = normalizeGlobalIndices(globalIndices);
  assertPositiveInteger(chunkSize, 'chunkSize');
  if (typeof onProgress !== 'function' || typeof shouldCancel !== 'function'
    || typeof yieldTask !== 'function') {
    throw new TypeError('Lookup progress, cancellation, and yield hooks must be functions');
  }
  throwIfCancelled(shouldCancel);
  const lookup = new CompactIndexLookup(indices.length, options);
  for (let start = 0; start < indices.length; start += chunkSize) {
    throwIfCancelled(shouldCancel);
    const end = Math.min(indices.length, start + chunkSize);
    for (let slot = start; slot < end; slot++) lookup.set(indices[slot], slot);
    onProgress(end / Math.max(1, indices.length));
    if (end < indices.length) await yieldTask();
  }
  throwIfCancelled(shouldCancel);
  return lookup;
}

export function compactLookupSlot(lookup, globalIndex) {
  if (!lookup) return globalIndex;
  if (typeof lookup.slot === 'function') return lookup.slot(globalIndex);
  if (typeof lookup.get === 'function') {
    const stored = lookup.get(globalIndex);
    return stored == null ? -1 : stored - 1;
  }
  return (lookup[globalIndex] ?? 0) - 1;
}

export function estimateCompactLookupBytes(entryCount, {
  loadFactor = DEFAULT_LOAD_FACTOR,
} = {}) {
  assertNonNegativeInteger(entryCount, 'entryCount');
  if (!(loadFactor > 0.5) || !(loadFactor <= 0.85)) {
    throw new RangeError('loadFactor must be greater than 0.5 and at most 0.85');
  }
  return hashCapacity(entryCount, loadFactor)
    * Uint32Array.BYTES_PER_ELEMENT * 2;
}

function normalizeGlobalIndices(indices) {
  if (indices instanceof Uint32Array) return indices;
  if (!indices || typeof indices[Symbol.iterator] !== 'function') {
    throw new TypeError('globalIndices must be an iterable of Gaussian ids');
  }
  return Uint32Array.from(indices);
}

function hashCapacity(entryCount, loadFactor) {
  const minimum = Math.max(2, Math.ceil(entryCount / loadFactor));
  let capacity = 1;
  while (capacity < minimum) {
    capacity *= 2;
    if (capacity > 0x4000_0000) {
      throw new RangeError('Compact index lookup capacity is too large');
    }
  }
  return capacity;
}

function hashUint32(value) {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function throwIfCancelled(shouldCancel) {
  if (shouldCancel()) {
    throw new DOMException('Compact index lookup superseded', 'AbortError');
  }
}

function defaultYieldTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
