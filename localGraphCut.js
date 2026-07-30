/**
 * Small deterministic max-flow/min-cut reference for changed supernodes or a
 * narrow disputed boundary band. It is not a full-scene solver and is not
 * wired into the UI.
 */

export const DEFAULT_GRAPH_LIMITS = Object.freeze({
  maxNodes: 4_096,
  maxPairwiseEdges: 65_536,
  maxEstimatedBytes: 24 * 1024 * 1024,
  maxSolveMs: 40,
  maxAugmentations: 250_000,
  cancellationCheckStride: 256,
});

const SOLVER_EPSILON = 1e-12;

export class GraphBudgetError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'GraphBudgetError';
    this.diagnostics = diagnostics;
  }
}

export function estimateLocalGraphBytes(nodeCount, pairwiseEdgeCount) {
  // Conservative accounting for JS objects plus forward/reverse residual arcs.
  return nodeCount * 192 + pairwiseEdgeCount * 4 * 96 + 64 * 1024;
}

/**
 * First-pass topology cleanup: keep only candidate nodes reachable from an
 * accepted seed. Manual include nodes become additional roots.
 */
export function retainSeedReachableComponent({
  nodeIds,
  pairwiseEdges,
  candidateIds,
  seedIds,
  hardIncludeIds = [],
  limits = {},
  signal = null,
  now = defaultNow,
}) {
  const cap = validateGraphLimits({ ...DEFAULT_GRAPH_LIMITS, ...limits });
  const startedAt = now();
  const checkpoint = createCheckpoint({
    signal,
    now,
    startedAt,
    maxSolveMs: cap.maxSolveMs,
    label: 'Local topology preprocessing',
  });
  checkpoint('validate');
  if (!(nodeIds instanceof Uint32Array)) {
    throw new TypeError('nodeIds must be a Uint32Array.');
  }
  if (!Array.isArray(pairwiseEdges)) {
    throw new TypeError('pairwiseEdges must be an array.');
  }
  const estimatedBytes = estimateLocalGraphBytes(nodeIds.length, pairwiseEdges.length);
  enforceConstructionBudget(nodeIds.length, pairwiseEdges.length, estimatedBytes, cap);
  const nodeSet = new Set(nodeIds);
  const candidateValues = consumeBoundedIterable(
    candidateIds,
    cap.maxNodes,
    checkpoint,
    'candidateIds',
  );
  const seedValues = consumeBoundedIterable(
    seedIds,
    cap.maxNodes,
    checkpoint,
    'seedIds',
  );
  const hardIncludeValues = consumeBoundedIterable(
    hardIncludeIds,
    cap.maxNodes,
    checkpoint,
    'hardIncludeIds',
  );
  const candidates = new Set();
  for (const id of candidateValues) {
    validateNodeId(id, 'candidateIds');
    if (nodeSet.has(id)) candidates.add(id);
  }
  const adjacency = new Map();
  for (const id of candidates) adjacency.set(id, []);
  for (let edgeIndex = 0; edgeIndex < pairwiseEdges.length; edgeIndex++) {
    if (edgeIndex % cap.cancellationCheckStride === 0) {
      checkpoint('build-adjacency', edgeIndex);
    }
    const edge = pairwiseEdges[edgeIndex];
    const weight = finiteCost(edge.weight, 'pairwise weight', `${edge.a}-${edge.b}`);
    if (!candidates.has(edge.a) || !candidates.has(edge.b) || weight === 0) continue;
    adjacency.get(edge.a).push(edge.b);
    adjacency.get(edge.b).push(edge.a);
  }
  const retained = new Set();
  for (const [label, values] of [
    ['seedIds', seedValues],
    ['hardIncludeIds', hardIncludeValues],
  ]) {
    for (const id of values) {
      validateNodeId(id, label);
      if (candidates.has(id)) retained.add(id);
    }
  }
  const queue = Array.from(retained);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (cursor % cap.cancellationCheckStride === 0) checkpoint('traverse', cursor);
    const id = queue[cursor];
    for (const neighbor of adjacency.get(id) ?? []) {
      if (retained.has(neighbor)) continue;
      retained.add(neighbor);
      queue.push(neighbor);
    }
  }
  const detached = new Set();
  for (const id of candidates) {
    if (!retained.has(id)) detached.add(id);
  }
  const elapsedMs = checkpoint('complete');
  return Object.freeze({
    retained,
    detached,
    diagnostics: Object.freeze({
      nodeCount: nodeIds.length,
      candidateCount: candidates.size,
      pairwiseEdgeCount: pairwiseEdges.length,
      estimatedBytes,
      elapsedMs,
    }),
  });
}

/**
 * Minimize:
 *   sum_i unary(label_i) + sum_(i,j) w_ij [label_i != label_j]
 *
 * `foregroundCost[i]` is paid when node i is foreground and
 * `backgroundCost[i]` when it is background.
 */
export function runBoundedBinaryGraphCut({
  nodeIds,
  foregroundCost,
  backgroundCost,
  pairwiseEdges,
  hardIncludeIds = [],
  hardExcludeIds = [],
  limits = {},
  now = defaultNow,
  signal = null,
}) {
  const cap = validateGraphLimits({ ...DEFAULT_GRAPH_LIMITS, ...limits });
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const startedAt = now();
  const checkpoint = createCheckpoint({
    signal,
    now,
    startedAt,
    maxSolveMs: cap.maxSolveMs,
    label: 'Local graph solve',
  });
  checkpoint('validate');
  if (!(nodeIds instanceof Uint32Array)) {
    throw new TypeError('nodeIds must be a Uint32Array.');
  }
  if (!(foregroundCost instanceof Float32Array)
    || foregroundCost.length !== nodeIds.length) {
    throw new TypeError('foregroundCost must align with nodeIds.');
  }
  if (!(backgroundCost instanceof Float32Array)
    || backgroundCost.length !== nodeIds.length) {
    throw new TypeError('backgroundCost must align with nodeIds.');
  }
  if (!Array.isArray(pairwiseEdges)) {
    throw new TypeError('pairwiseEdges must be an array.');
  }
  const estimatedBytes = estimateLocalGraphBytes(nodeIds.length, pairwiseEdges.length);
  enforceConstructionBudget(nodeIds.length, pairwiseEdges.length, estimatedBytes, cap);

  const indexById = new Map();
  for (let index = 0; index < nodeIds.length; index++) {
    if (index % cap.cancellationCheckStride === 0) checkpoint('index-nodes', index);
    if (indexById.has(nodeIds[index])) {
      throw new RangeError('nodeIds must be unique.');
    }
    indexById.set(nodeIds[index], index);
  }
  const hardInclude = new Set(consumeBoundedIterable(
    hardIncludeIds,
    cap.maxNodes,
    checkpoint,
    'hardIncludeIds',
  ));
  const hardExclude = new Set(consumeBoundedIterable(
    hardExcludeIds,
    cap.maxNodes,
    checkpoint,
    'hardExcludeIds',
  ));
  for (const id of hardInclude) {
    validateNodeId(id, 'hardIncludeIds');
    if (hardExclude.has(id)) {
      throw new RangeError(`Node ${id} has contradictory hard constraints.`);
    }
    if (!indexById.has(id)) throw new RangeError(`Hard include node ${id} is absent.`);
  }
  for (const id of hardExclude) {
    validateNodeId(id, 'hardExcludeIds');
    if (!indexById.has(id)) throw new RangeError(`Hard exclude node ${id} is absent.`);
  }

  // Compute a conservative upper bound on every finite term before creating
  // terminal arcs. A hard terminal is the next representable number above
  // this bound, so violating one hard constraint always costs more than any
  // assignment satisfying all hard constraints.
  const unaryForeground = new Float64Array(nodeIds.length);
  const unaryBackground = new Float64Array(nodeIds.length);
  const normalizedPairwise = new Array(pairwiseEdges.length);
  let totalFiniteEnergyUpperBound = 0;
  for (let index = 0; index < nodeIds.length; index++) {
    if (index % cap.cancellationCheckStride === 0) checkpoint('validate-unary', index);
    const costForeground = finiteCost(foregroundCost[index], 'foregroundCost', index);
    const costBackground = finiteCost(backgroundCost[index], 'backgroundCost', index);
    unaryForeground[index] = costForeground;
    unaryBackground[index] = costBackground;
    totalFiniteEnergyUpperBound = upperBoundAdd(
      totalFiniteEnergyUpperBound,
      costForeground,
    );
    totalFiniteEnergyUpperBound = upperBoundAdd(
      totalFiniteEnergyUpperBound,
      costBackground,
    );
  }
  for (let edgeIndex = 0; edgeIndex < pairwiseEdges.length; edgeIndex++) {
    if (edgeIndex % cap.cancellationCheckStride === 0) {
      checkpoint('validate-pairwise', edgeIndex);
    }
    const edge = pairwiseEdges[edgeIndex];
    const a = indexById.get(edge.a);
    const b = indexById.get(edge.b);
    if (a == null || b == null || a === b) {
      throw new RangeError('Pairwise edge refers to an absent or identical node.');
    }
    const weight = finiteCost(edge.weight, 'pairwise weight', `${edge.a}-${edge.b}`);
    normalizedPairwise[edgeIndex] = { a, b, weight };
    totalFiniteEnergyUpperBound = upperBoundAdd(totalFiniteEnergyUpperBound, weight);
  }
  const hardConstraintCapacity = nextUp(
    Math.max(totalFiniteEnergyUpperBound, SOLVER_EPSILON),
  );
  if (
    !Number.isFinite(hardConstraintCapacity)
    || hardConstraintCapacity <= totalFiniteEnergyUpperBound
  ) {
    throw new GraphBudgetError('Finite graph energy is too large for hard constraints.', {
      totalFiniteEnergyUpperBound,
    });
  }

  const source = nodeIds.length;
  const sink = source + 1;
  const graph = Array.from({ length: nodeIds.length + 2 }, () => []);
  const addEdge = (from, to, capacity) => {
    const forward = { to, rev: graph[to].length, capacity };
    const reverse = { to: from, rev: graph[from].length, capacity: 0 };
    graph[from].push(forward);
    graph[to].push(reverse);
  };
  for (let index = 0; index < nodeIds.length; index++) {
    if (index % cap.cancellationCheckStride === 0) checkpoint('build-unary', index);
    const id = nodeIds[index];
    let costForeground = unaryForeground[index];
    let costBackground = unaryBackground[index];
    if (hardInclude.has(id)) costBackground = hardConstraintCapacity;
    if (hardExclude.has(id)) costForeground = hardConstraintCapacity;
    // Source side is foreground. Cutting source->node pays background cost;
    // cutting node->sink pays foreground cost.
    addEdge(source, index, costBackground);
    addEdge(index, sink, costForeground);
  }
  for (let edgeIndex = 0; edgeIndex < normalizedPairwise.length; edgeIndex++) {
    if (edgeIndex % cap.cancellationCheckStride === 0) {
      checkpoint('build-pairwise', edgeIndex);
    }
    const edge = normalizedPairwise[edgeIndex];
    addEdge(edge.a, edge.b, edge.weight);
    addEdge(edge.b, edge.a, edge.weight);
  }

  const level = new Int32Array(graph.length);
  const cursor = new Int32Array(graph.length);
  let augmentations = 0;
  let flow = 0;

  const buildLevels = () => {
    checkpoint('bfs-start');
    level.fill(-1);
    level[source] = 0;
    const queue = new Int32Array(graph.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = source;
    while (head < tail) {
      if (head % cap.cancellationCheckStride === 0) checkpoint('bfs', head);
      const from = queue[head++];
      for (const edge of graph[from]) {
        if (edge.capacity <= SOLVER_EPSILON || level[edge.to] >= 0) continue;
        level[edge.to] = level[from] + 1;
        queue[tail++] = edge.to;
      }
    }
    const reachable = level[sink] >= 0;
    checkpoint(reachable ? 'bfs-found-path' : 'bfs-terminated');
    return reachable;
  };
  const sendFlow = (from, available) => {
    checkpoint('dfs-enter', augmentations);
    if (from === sink) {
      checkpoint('dfs-sink', augmentations);
      return available;
    }
    for (; cursor[from] < graph[from].length; cursor[from]++) {
      checkpoint('dfs-edge', cursor[from]);
      const edge = graph[from][cursor[from]];
      if (
        edge.capacity <= SOLVER_EPSILON
        || level[edge.to] !== level[from] + 1
      ) continue;
      const sent = sendFlow(edge.to, Math.min(available, edge.capacity));
      if (sent <= SOLVER_EPSILON) continue;
      edge.capacity -= sent;
      graph[edge.to][edge.rev].capacity += sent;
      checkpoint('dfs-sent', augmentations);
      return sent;
    }
    checkpoint('dfs-terminated', augmentations);
    return 0;
  };

  while (buildLevels()) {
    checkpoint('level-graph-ready', augmentations);
    cursor.fill(0);
    while (true) {
      checkpoint('augmentation-start', augmentations);
      if (augmentations >= cap.maxAugmentations) {
        throw new GraphBudgetError('Local graph solve exceeded runtime budget.', {
          nodeCount: nodeIds.length,
          pairwiseEdgeCount: pairwiseEdges.length,
          augmentations,
          elapsedMs: now() - startedAt,
          limits: cap,
        });
      }
      const sent = sendFlow(source, Number.POSITIVE_INFINITY);
      checkpoint('augmentation-result', augmentations);
      if (sent <= SOLVER_EPSILON) {
        checkpoint('augmentation-terminated', augmentations);
        break;
      }
      flow += sent;
      if (!Number.isFinite(flow)) {
        throw new GraphBudgetError('Local graph flow overflowed.', { flow });
      }
      augmentations++;
    }
  }

  checkpoint('residual-start');
  const sourceSide = new Uint8Array(graph.length);
  sourceSide[source] = 1;
  const queue = [source];
  for (let cursorIndex = 0; cursorIndex < queue.length; cursorIndex++) {
    if (cursorIndex % cap.cancellationCheckStride === 0) {
      checkpoint('residual-traverse', cursorIndex);
    }
    const from = queue[cursorIndex];
    for (const edge of graph[from]) {
      if (edge.capacity <= SOLVER_EPSILON || sourceSide[edge.to]) continue;
      sourceSide[edge.to] = 1;
      queue.push(edge.to);
    }
  }
  const includedIds = [];
  const excludedIds = [];
  for (let index = 0; index < nodeIds.length; index++) {
    if (index % cap.cancellationCheckStride === 0) checkpoint('classify', index);
    (sourceSide[index] ? includedIds : excludedIds).push(nodeIds[index]);
  }
  for (const id of hardInclude) {
    if (!sourceSide[indexById.get(id)]) {
      throw new GraphBudgetError(`Hard include constraint failed for node ${id}.`);
    }
  }
  for (const id of hardExclude) {
    if (sourceSide[indexById.get(id)]) {
      throw new GraphBudgetError(`Hard exclude constraint failed for node ${id}.`);
    }
  }
  const finalElapsedMs = checkpoint('complete');
  return Object.freeze({
    includedIds: Uint32Array.from(includedIds),
    excludedIds: Uint32Array.from(excludedIds),
    cutCost: flow,
    provenance: Object.freeze({
      algorithm: 'bounded-dinic-reference-v1',
      nodeCount: nodeIds.length,
      pairwiseEdgeCount: pairwiseEdges.length,
      estimatedBytes,
      elapsedMs: finalElapsedMs,
      augmentations,
      totalFiniteEnergyUpperBound,
      hardConstraintCapacity,
      limits: Object.freeze({ ...cap }),
    }),
  });
}

function finiteCost(value, label, index) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} at ${index} must be finite and non-negative.`);
  }
  return value;
}

function enforceConstructionBudget(nodeCount, pairwiseEdgeCount, estimatedBytes, limits) {
  if (
    nodeCount > limits.maxNodes
    || pairwiseEdgeCount > limits.maxPairwiseEdges
    || estimatedBytes > limits.maxEstimatedBytes
  ) {
    throw new GraphBudgetError('Local graph exceeds construction budget.', {
      nodeCount,
      pairwiseEdgeCount,
      estimatedBytes,
      limits,
    });
  }
}

function validateGraphLimits(limits) {
  for (const key of [
    'maxNodes',
    'maxPairwiseEdges',
    'maxEstimatedBytes',
    'maxSolveMs',
    'maxAugmentations',
    'cancellationCheckStride',
  ]) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) {
      throw new RangeError(`Graph limit ${key} must be finite and positive.`);
    }
  }
  return limits;
}

function consumeBoundedIterable(iterable, maxEntries, checkpoint, label) {
  if (iterable == null || typeof iterable[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label} must be an iterable.`);
  }
  const values = [];
  let count = 0;
  for (const value of iterable) {
    if (count % DEFAULT_GRAPH_LIMITS.cancellationCheckStride === 0) {
      checkpoint(`consume-${label}`, count);
    }
    if (count >= maxEntries) {
      throw new GraphBudgetError(`${label} exceeds its entry budget.`, {
        entries: count + 1,
        limit: maxEntries,
      });
    }
    values.push(value);
    count++;
  }
  checkpoint(`consume-${label}-complete`, count);
  return values;
}

function validateNodeId(id, label) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
    throw new RangeError(`${label} must contain Uint32 node IDs.`);
  }
}

function createCheckpoint({ signal, now, startedAt, maxSolveMs, label }) {
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  return (phase, progress = 0) => {
    if (signal?.aborted) {
      const error = new Error(`${label} was cancelled.`);
      error.name = 'AbortError';
      throw error;
    }
    const elapsedMs = now() - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs > maxSolveMs) {
      throw new GraphBudgetError(`${label} exceeded its runtime budget.`, {
        phase,
        progress,
        elapsedMs,
        limit: maxSolveMs,
      });
    }
    return elapsedMs;
  };
}

function upperBoundAdd(total, value) {
  const sum = total + value;
  if (!Number.isFinite(sum)) {
    throw new GraphBudgetError('Finite graph energy overflowed.', { total, value });
  }
  return nextUp(sum);
}

const nextUpBuffer = new ArrayBuffer(8);
const nextUpFloat = new Float64Array(nextUpBuffer);
const nextUpBits = new BigUint64Array(nextUpBuffer);

function nextUp(value) {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  nextUpFloat[0] = value;
  nextUpBits[0] += value > 0 ? 1n : -1n;
  return nextUpFloat[0];
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
