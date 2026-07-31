/**
 * Feature-off, browser-free reference for explaining a finished Gaussian
 * object by causal product pass. It groups only observed support signatures;
 * it never enumerates the theoretical pass power set.
 */

export const INSPECT_EVIDENCE_DEFAULT = false;

export const DEFAULT_EVIDENCE_INSPECTOR_LIMITS = Object.freeze({
  maxGaussians: 250_000,
  maxCausalFamilies: 128,
  maxPasses: 32,
  maxObservedCohorts: 4_096,
  maxPassMemberships: 2_000_000,
  maxEventIds: 16_384,
  maxAdjacencyEdges: 1_000_000,
  maxPrimaryCohorts: 12,
  maxExpandedParts: 24,
  minContribution: 1e-6,
  minImpactFraction: 0.0025,
  minUncertainFraction: 0.25,
  minIsolation: 0.65,
  cancellationCheckStride: 2_048,
});

const REVISION_KEYS = Object.freeze(['scene', 'view', 'selection', 'mask', 'scan']);
const DECISIONS = new Set(['included', 'excluded', 'disputed', 'unknown']);

export class EvidenceInspectorBudgetError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'EvidenceInspectorBudgetError';
    this.diagnostics = diagnostics;
  }
}

export function createEvidenceInspection({
  revision,
  gaussianIds,
  decisions,
  provenance,
  familyCatalog,
  alphaMass = null,
  uncertainty = null,
  isolation = null,
}, options = {}) {
  const {
    signal = null,
    ...limitOverrides
  } = options;
  const limits = validateLimits({
    ...DEFAULT_EVIDENCE_INSPECTOR_LIMITS,
    ...limitOverrides,
  });
  const normalizedRevision = normalizeRevision(revision);
  validateAlignedInputs({
    gaussianIds,
    decisions,
    provenance,
    alphaMass,
    uncertainty,
    isolation,
    limits,
  });
  const checkpoint = createCheckpoint(signal, limits.cancellationCheckStride);
  const catalog = normalizeFamilyCatalog(familyCatalog, limits);
  const passBuilders = new Map();
  const cohortBuilders = [];
  const cohortBySignature = new Map();
  const signatureByCohortId = new Map();
  const cohortIndexBySlot = new Uint32Array(gaussianIds.length);
  let passMemberships = 0;
  const retainedEventIds = new Set();
  let totalImpact = 0;

  for (let slot = 0; slot < gaussianIds.length; slot++) {
    checkpoint(slot);
    const decision = decisions[slot];
    if (!DECISIONS.has(decision)) {
      throw new TypeError(`Unsupported final decision at slot ${slot}: ${decision}`);
    }
    const gaussianProvenance = provenance[slot];
    if (!gaussianProvenance || !Array.isArray(gaussianProvenance.families)) {
      throw new TypeError(`provenance[${slot}].families must be an array`);
    }
    const support = new Set();
    const oppose = new Set();
    const passEventIds = new Map();
    for (const family of gaussianProvenance.families) {
      const familyId = nonemptyString(family?.familyId, 'familyId');
      const definition = catalog.byFamilyId.get(familyId);
      if (!definition) {
        throw new RangeError(`Missing family catalog entry for ${familyId}`);
      }
      const contribution = Number(family.contribution);
      if (!Number.isFinite(contribution)) {
        throw new TypeError(`Family ${familyId} contribution must be finite`);
      }
      if (contribution > limits.minContribution) support.add(definition.passKey);
      if (contribution < -limits.minContribution) oppose.add(definition.passKey);
      let ids = passEventIds.get(definition.passKey);
      if (!ids) {
        ids = new Set();
        passEventIds.set(definition.passKey, ids);
      }
      for (const eventId of definition.eventIds) ids.add(eventId);
    }
    passMemberships += support.size + oppose.size;
    if (passMemberships > limits.maxPassMemberships) {
      throw new EvidenceInspectorBudgetError('Pass membership budget exceeded', {
        passMemberships,
        limit: limits.maxPassMemberships,
      });
    }

    const hardState = gaussianProvenance.hardConflict
      ? 'conflict'
      : gaussianProvenance.hardIncludeEventIds?.length
        ? 'include'
        : gaussianProvenance.hardExcludeEventIds?.length
          ? 'exclude'
          : 'none';
    const hardEventIds = [
      ...(gaussianProvenance.hardIncludeEventIds ?? []),
      ...(gaussianProvenance.hardExcludeEventIds ?? []),
    ];
    if (hardState === 'include' || hardState === 'conflict') {
      support.add('manual-change');
    }
    if (hardState === 'exclude' || hardState === 'conflict') {
      oppose.add('manual-change');
    }
    if (hardEventIds.length) {
      passEventIds.set('manual-change', new Set(normalizeStrings(
        hardEventIds,
        `provenance[${slot}] hard constraint event IDs`,
      )));
      ensureManualPass(catalog, limits);
    }
    const supportKeys = [...support].sort();
    const opposeKeys = [...oppose].sort();
    const signature = signatureKey(supportKeys, opposeKeys, hardState, decision);
    let cohortIndex = cohortBySignature.get(signature);
    if (cohortIndex == null) {
      if (cohortBuilders.length >= limits.maxObservedCohorts) {
        throw new EvidenceInspectorBudgetError('Observed support cohort budget exceeded', {
          observedCohorts: cohortBuilders.length + 1,
          limit: limits.maxObservedCohorts,
        });
      }
      cohortIndex = cohortBuilders.length;
      cohortBySignature.set(signature, cohortIndex);
      const cohortId = uniqueSignatureId(signature, signatureByCohortId);
      cohortBuilders.push({
        id: cohortId,
        signature,
        supportKeys,
        opposeKeys,
        hardState,
        decision,
        count: 0,
        impact: 0,
        uncertain: 0,
        isolation: 0,
        eventIds: new Set(),
      });
    }
    cohortIndexBySlot[slot] = cohortIndex;
    const impact = alphaMass ? alphaMass[slot] : 1;
    const uncertain = uncertainty
      ? uncertainty[slot]
      : decision === 'disputed' || decision === 'unknown'
        ? 1
        : 0;
    const isolated = isolation?.[slot] ?? 0;
    totalImpact += impact;
    const cohort = cohortBuilders[cohortIndex];
    cohort.count++;
    cohort.impact += impact;
    cohort.uncertain += uncertain;
    cohort.isolation += isolated;

    for (const passKey of new Set([...supportKeys, ...opposeKeys])) {
      const definition = catalog.byPassKey.get(passKey);
      let pass = passBuilders.get(passKey);
      if (!pass) {
        pass = {
          ...definition,
          count: 0,
          impact: 0,
          uncertain: 0,
          isolation: 0,
          slots: [],
          eventIds: new Set(definition.eventIds),
        };
        passBuilders.set(passKey, pass);
      }
      pass.count++;
      pass.impact += impact;
      pass.uncertain += uncertain;
      pass.isolation += isolated;
      pass.slots.push(slot);
      for (const eventId of passEventIds.get(passKey) ?? []) {
        pass.eventIds.add(eventId);
        cohort.eventIds.add(eventId);
        retainedEventIds.add(eventId);
      }
    }
    if (retainedEventIds.size > limits.maxEventIds) {
      throw new EvidenceInspectorBudgetError('Retained event reference budget exceeded', {
        eventIdCount: retainedEventIds.size,
        limit: limits.maxEventIds,
      });
    }
  }

  const cohortMembers = cohortBuilders.map((cohort) => new Uint32Array(cohort.count));
  const cohortOffsets = new Uint32Array(cohortBuilders.length);
  for (let slot = 0; slot < gaussianIds.length; slot++) {
    checkpoint(slot);
    const cohortIndex = cohortIndexBySlot[slot];
    cohortMembers[cohortIndex][cohortOffsets[cohortIndex]++] = gaussianIds[slot];
  }

  const cohorts = cohortBuilders.map((cohort, index) => Object.freeze({
    id: cohort.id,
    supportPassKeys: Object.freeze(cohort.supportKeys),
    opposingPassKeys: Object.freeze(cohort.opposeKeys),
    hardState: cohort.hardState,
    decision: cohort.decision,
    count: cohort.count,
    impact: cohort.impact,
    uncertainFraction: cohort.count ? cohort.uncertain / cohort.count : 0,
    meanIsolation: cohort.count ? cohort.isolation / cohort.count : 0,
    eventIds: Object.freeze([...cohort.eventIds].sort()),
    memberIds: cohortMembers[index],
  }));
  const primary = choosePrimaryCohorts(cohorts, totalImpact, limits);
  const primaryIds = new Set(primary.map((cohort) => cohort.id));
  const hidden = cohorts.filter((cohort) => !primaryIds.has(cohort.id));
  const other = hidden.length
    ? Object.freeze({
      id: 'other-small-combinations',
      label: 'Other small combinations',
      cohortIds: Object.freeze(hidden.map((cohort) => cohort.id)),
      count: hidden.reduce((sum, cohort) => sum + cohort.count, 0),
      impact: hidden.reduce((sum, cohort) => sum + cohort.impact, 0),
      toggleable: false,
    })
    : null;
  const passes = [...passBuilders.values()]
    .map((pass) => Object.freeze({
      passKey: pass.passKey,
      label: pass.label,
      stage: pass.stage,
      adjustable: pass.adjustable,
      parameterSchemaId: pass.parameterSchemaId,
      causalFamilyIds: pass.causalFamilyIds,
      eventIds: Object.freeze([...pass.eventIds].sort()),
      count: pass.count,
      impact: pass.impact,
      uncertainFraction: pass.count ? pass.uncertain / pass.count : 0,
      meanIsolation: pass.count ? pass.isolation / pass.count : 0,
      memberIds: idsFromSlots(gaussianIds, pass.slots),
    }))
    .sort((left, right) => right.impact - left.impact || left.label.localeCompare(right.label));

  return Object.freeze({
    revision: normalizedRevision,
    gaussianCount: gaussianIds.length,
    totalImpact,
    passes: Object.freeze(passes),
    cohorts: Object.freeze(cohorts),
    primaryCohorts: Object.freeze(primary),
    otherCohorts: other,
    diagnostics: Object.freeze({
      causalFamilies: catalog.byFamilyId.size,
      productPasses: catalog.byPassKey.size,
      observedCohorts: cohorts.length,
      passMemberships,
      representation: 'observed-product-pass-signatures-v1',
    }),
  });
}

export function expandEvidenceCohort(snapshot, cohortId, adjacency, options = {}) {
  const {
    signal = null,
    ...limitOverrides
  } = options;
  const limits = validateLimits({
    ...DEFAULT_EVIDENCE_INSPECTOR_LIMITS,
    ...limitOverrides,
  });
  const checkpoint = createCheckpoint(signal, limits.cancellationCheckStride);
  const cohort = snapshot?.cohorts?.find((entry) => entry.id === cohortId);
  if (!cohort) throw new RangeError(`Unknown evidence cohort: ${cohortId}`);
  const from = adjacency?.from;
  const to = adjacency?.to;
  if (!(from instanceof Uint32Array) || !(to instanceof Uint32Array)) {
    throw new TypeError('adjacency.from and adjacency.to must be Uint32Array values');
  }
  if (from.length !== to.length) {
    throw new RangeError('Adjacency endpoint arrays must have equal length');
  }
  if (from.length > limits.maxAdjacencyEdges) {
    throw new EvidenceInspectorBudgetError('Adjacency edge budget exceeded', {
      edges: from.length,
      limit: limits.maxAdjacencyEdges,
    });
  }
  const memberSlot = new Map();
  for (let index = 0; index < cohort.memberIds.length; index++) {
    checkpoint(index);
    memberSlot.set(cohort.memberIds[index], index);
  }
  const parent = new Int32Array(cohort.memberIds.length);
  const size = new Uint32Array(cohort.memberIds.length);
  for (let index = 0; index < parent.length; index++) {
    parent[index] = index;
    size[index] = 1;
  }
  for (let edge = 0; edge < from.length; edge++) {
    checkpoint(edge);
    const left = memberSlot.get(from[edge]);
    const right = memberSlot.get(to[edge]);
    if (left == null || right == null || left === right) continue;
    union(parent, size, left, right);
  }
  const components = new Map();
  for (let index = 0; index < cohort.memberIds.length; index++) {
    checkpoint(index);
    const root = find(parent, index);
    let ids = components.get(root);
    if (!ids) {
      ids = [];
      components.set(root, ids);
    }
    ids.push(cohort.memberIds[index]);
  }
  const ordered = [...components.values()]
    .map((ids) => Uint32Array.from(ids.sort((a, b) => a - b)))
    .sort((left, right) => right.length - left.length || left[0] - right[0]);
  const visible = ordered.slice(0, limits.maxExpandedParts);
  const hidden = ordered.slice(limits.maxExpandedParts);
  return Object.freeze({
    revision: snapshot.revision,
    cohortId,
    parts: Object.freeze(visible.map((memberIds, index) => Object.freeze({
      id: `${cohort.id}:part:${index + 1}`,
      count: memberIds.length,
      memberIds,
      supportPassKeys: cohort.supportPassKeys,
      opposingPassKeys: cohort.opposingPassKeys,
      eventIds: cohort.eventIds,
    }))),
    otherParts: hidden.length
      ? Object.freeze({
        id: `${cohort.id}:other-parts`,
        label: 'Other detached fragments',
        count: hidden.reduce((sum, ids) => sum + ids.length, 0),
        memberIds: concatenateIds(hidden),
        supportPassKeys: cohort.supportPassKeys,
        opposingPassKeys: cohort.opposingPassKeys,
        eventIds: cohort.eventIds,
      })
      : null,
    diagnostics: Object.freeze({
      adjacencyEdges: from.length,
      connectedParts: ordered.length,
      representation: 'lazy-exact-signature-components-v1',
    }),
  });
}

/**
 * Create a revisioned ROI replay request. This never mutates membership and
 * never treats renderer visibility as a saved evidence edit.
 */
export function createEvidencePreviewPlan(snapshot, command) {
  if (!snapshot?.revision || !Array.isArray(snapshot?.passes)) {
    throw new TypeError('A valid evidence inspection snapshot is required');
  }
  const kind = command?.kind;
  let target;
  if (kind === 'pass') {
    target = snapshot.passes.find((pass) => pass.passKey === command.passKey);
  } else if (kind === 'cohort') {
    target = snapshot.cohorts.find((cohort) => cohort.id === command.cohortId);
  } else if (kind === 'part') {
    target = command.part;
    if (!target || !(target.memberIds instanceof Uint32Array)) {
      throw new TypeError('Part preview needs an expanded part with memberIds');
    }
  } else {
    throw new TypeError(`Unsupported evidence preview target: ${kind}`);
  }
  if (!target) throw new RangeError('Evidence preview target does not exist');
  const parameterPatch = normalizeParameterPatch(command.parameterPatch);
  if (parameterPatch && kind !== 'pass') {
    throw new TypeError('Only a pass can receive a parameter preview');
  }
  if (parameterPatch && !target.adjustable) {
    throw new RangeError(`Pass ${target.passKey} does not expose adjustable parameters`);
  }
  const passKeys = kind === 'pass'
    ? [target.passKey]
    : [...new Set([
      ...(target.supportPassKeys ?? []),
      ...(target.opposingPassKeys ?? []),
    ])];
  return Object.freeze({
    baseRevision: snapshot.revision,
    operation: parameterPatch ? 'parameter-preview' : 'toggle-preview',
    target: Object.freeze({
      kind,
      id: target.passKey ?? target.id,
    }),
    disabledPassKeys: Object.freeze(
      parameterPatch || command.enabled !== false ? [] : passKeys,
    ),
    parameterOverrides: parameterPatch
      ? Object.freeze({ [target.passKey]: parameterPatch })
      : Object.freeze({}),
    roiIds: target.memberIds,
    eventIds: Object.freeze([...(target.eventIds ?? [])]),
    requiresRoiRecompute: true,
    mutatesObject: false,
  });
}

function normalizeFamilyCatalog(entries, limits) {
  if (!Array.isArray(entries)) throw new TypeError('familyCatalog must be an array');
  if (entries.length > limits.maxCausalFamilies) {
    throw new EvidenceInspectorBudgetError('Causal family catalog budget exceeded');
  }
  const byFamilyId = new Map();
  const byPassKey = new Map();
  for (const [index, entry] of entries.entries()) {
    const familyId = nonemptyString(entry?.familyId, `familyCatalog[${index}].familyId`);
    const passKey = nonemptyString(entry?.passKey, `familyCatalog[${index}].passKey`);
    const label = nonemptyString(entry?.label, `familyCatalog[${index}].label`);
    if (byFamilyId.has(familyId)) {
      throw new RangeError(`Duplicate causal family catalog entry: ${familyId}`);
    }
    const eventIds = normalizeStrings(entry.eventIds ?? [], 'eventIds');
    const normalized = Object.freeze({
      familyId,
      passKey,
      label,
      stage: String(entry.stage ?? passKey),
      adjustable: Boolean(entry.adjustable),
      parameterSchemaId: entry.parameterSchemaId == null
        ? null
        : nonemptyString(entry.parameterSchemaId, 'parameterSchemaId'),
      eventIds,
    });
    byFamilyId.set(familyId, normalized);
    const pass = byPassKey.get(passKey);
    if (pass && (
      pass.label !== label
      || pass.adjustable !== normalized.adjustable
      || pass.parameterSchemaId !== normalized.parameterSchemaId
      || pass.stage !== normalized.stage
    )) {
      throw new RangeError(`Inconsistent product pass catalog entries for ${passKey}`);
    }
    if (!pass) {
      byPassKey.set(passKey, {
        passKey,
        label,
        stage: normalized.stage,
        adjustable: normalized.adjustable,
        parameterSchemaId: normalized.parameterSchemaId,
        causalFamilyIds: [],
        eventIds: [],
      });
    }
    byPassKey.get(passKey).causalFamilyIds.push(familyId);
    byPassKey.get(passKey).eventIds.push(...eventIds);
  }
  if (byPassKey.size > limits.maxPasses) {
    throw new EvidenceInspectorBudgetError('Product pass catalog budget exceeded');
  }
  for (const pass of byPassKey.values()) {
    pass.causalFamilyIds = Object.freeze(pass.causalFamilyIds.sort());
    pass.eventIds = Object.freeze([...new Set(pass.eventIds)].sort());
  }
  return { byFamilyId, byPassKey };
}

function ensureManualPass(catalog, limits) {
  if (catalog.byPassKey.has('manual-change')) return;
  if (catalog.byPassKey.size >= limits.maxPasses) {
    throw new EvidenceInspectorBudgetError(
      'Manual-change provenance exceeds the product pass budget',
      { limit: limits.maxPasses },
    );
  }
  catalog.byPassKey.set('manual-change', {
    passKey: 'manual-change',
    label: 'Manual changes',
    stage: 'manual-change',
    adjustable: false,
    parameterSchemaId: null,
    causalFamilyIds: Object.freeze([]),
    eventIds: Object.freeze([]),
  });
}

function validateAlignedInputs({
  gaussianIds,
  decisions,
  provenance,
  alphaMass,
  uncertainty,
  isolation,
  limits,
}) {
  if (!(gaussianIds instanceof Uint32Array)) {
    throw new TypeError('gaussianIds must be a Uint32Array');
  }
  if (gaussianIds.length > limits.maxGaussians) {
    throw new EvidenceInspectorBudgetError('Gaussian inspection budget exceeded');
  }
  for (const [name, value] of Object.entries({ decisions, provenance })) {
    if (!Array.isArray(value) || value.length !== gaussianIds.length) {
      throw new RangeError(`${name} must be an array aligned with gaussianIds`);
    }
  }
  for (const [name, value] of Object.entries({ alphaMass, uncertainty, isolation })) {
    if (value == null) continue;
    if (!(value instanceof Float32Array) || value.length !== gaussianIds.length) {
      throw new RangeError(`${name} must be a Float32Array aligned with gaussianIds`);
    }
  }
  let previous = -1;
  for (let slot = 0; slot < gaussianIds.length; slot++) {
    const id = gaussianIds[slot];
    if (id <= previous) throw new RangeError('gaussianIds must be sorted and unique');
    previous = id;
    for (const [name, value] of Object.entries({ alphaMass, uncertainty, isolation })) {
      if (!value) continue;
      if (!Number.isFinite(value[slot]) || value[slot] < 0) {
        throw new RangeError(`${name}[${slot}] must be finite and non-negative`);
      }
      if ((name === 'uncertainty' || name === 'isolation') && value[slot] > 1) {
        throw new RangeError(`${name}[${slot}] must be within [0, 1]`);
      }
    }
  }
}

function choosePrimaryCohorts(cohorts, totalImpact, limits) {
  const ranked = [...cohorts].sort(
    (left, right) => right.impact - left.impact || left.id.localeCompare(right.id),
  );
  const chosen = new Set(ranked.slice(0, limits.maxPrimaryCohorts).map((entry) => entry.id));
  for (const cohort of ranked) {
    const impactFraction = totalImpact ? cohort.impact / totalImpact : 0;
    if (
      impactFraction >= limits.minImpactFraction
      || cohort.uncertainFraction >= limits.minUncertainFraction
      || cohort.meanIsolation >= limits.minIsolation
    ) {
      chosen.add(cohort.id);
    }
  }
  return ranked
    .filter((cohort) => chosen.has(cohort.id))
    .slice(0, limits.maxPrimaryCohorts);
}

function idsFromSlots(gaussianIds, slots) {
  const output = new Uint32Array(slots.length);
  for (let index = 0; index < slots.length; index++) output[index] = gaussianIds[slots[index]];
  return output;
}

function signatureKey(support, oppose, hardState, decision) {
  return JSON.stringify([support, oppose, hardState, decision]);
}

function stableSignatureId(signature) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < signature.length; index++) {
    const code = signature.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `cohort-${left.toString(36)}-${right.toString(36)}-${signature.length}`;
}

function uniqueSignatureId(signature, signatureByCohortId) {
  const base = stableSignatureId(signature);
  let id = base;
  let collision = 0;
  while (
    signatureByCohortId.has(id)
    && signatureByCohortId.get(id) !== signature
  ) {
    id = `${base}-${++collision}`;
  }
  signatureByCohortId.set(id, signature);
  return id;
}

function normalizeRevision(revision) {
  if (!revision || typeof revision !== 'object') {
    throw new TypeError('Evidence inspection needs a revision record');
  }
  const output = {};
  for (const key of REVISION_KEYS) {
    if (!Number.isSafeInteger(revision[key]) || revision[key] < 0) {
      throw new TypeError(`revision.${key} must be a non-negative safe integer`);
    }
    output[key] = revision[key];
  }
  return Object.freeze(output);
}

function validateLimits(limits) {
  const integerKeys = [
    'maxGaussians',
    'maxCausalFamilies',
    'maxPasses',
    'maxObservedCohorts',
    'maxPassMemberships',
    'maxEventIds',
    'maxAdjacencyEdges',
    'maxPrimaryCohorts',
    'maxExpandedParts',
    'cancellationCheckStride',
  ];
  for (const key of integerKeys) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new RangeError(`Evidence inspector limit ${key} must be a positive safe integer`);
    }
  }
  if (!Number.isFinite(limits.minContribution) || limits.minContribution < 0) {
    throw new RangeError('minContribution must be finite and non-negative');
  }
  for (const key of ['minImpactFraction', 'minUncertainFraction', 'minIsolation']) {
    if (!Number.isFinite(limits[key]) || limits[key] < 0 || limits[key] > 1) {
      throw new RangeError(`${key} must be finite and within [0, 1]`);
    }
  }
  return limits;
}

function createCheckpoint(signal, stride) {
  return (progress) => {
    if (progress % Math.max(1, stride) !== 0) return;
    if (signal?.aborted) throw new DOMException('Evidence inspection cancelled', 'AbortError');
  };
}

function nonemptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string`);
  if (normalized.length > 256) {
    throw new RangeError(`${label} exceeds the 256-character reference budget`);
  }
  return normalized;
}

function normalizeStrings(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(values.map((value, index) => nonemptyString(value, `${label}[${index}]`)));
}

function normalizeParameterPatch(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('parameterPatch must be an object');
  }
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) {
    throw new RangeError('parameterPatch must contain 1 to 32 entries');
  }
  const output = {};
  for (const [rawKey, rawValue] of entries) {
    const key = nonemptyString(rawKey, 'parameter name');
    if (
      !Number.isFinite(rawValue)
      && typeof rawValue !== 'string'
      && typeof rawValue !== 'boolean'
    ) {
      throw new TypeError(`Unsupported preview parameter value for ${key}`);
    }
    output[key] = rawValue;
  }
  return Object.freeze(output);
}

function find(parent, value) {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  while (parent[value] !== value) {
    const next = parent[value];
    parent[value] = root;
    value = next;
  }
  return root;
}

function union(parent, size, left, right) {
  let leftRoot = find(parent, left);
  let rightRoot = find(parent, right);
  if (leftRoot === rightRoot) return;
  if (size[leftRoot] < size[rightRoot]) {
    [leftRoot, rightRoot] = [rightRoot, leftRoot];
  }
  parent[rightRoot] = leftRoot;
  size[leftRoot] += size[rightRoot];
}

function concatenateIds(groups) {
  const length = groups.reduce((sum, ids) => sum + ids.length, 0);
  const output = new Uint32Array(length);
  let offset = 0;
  for (const ids of groups) {
    output.set(ids, offset);
    offset += ids.length;
  }
  output.sort();
  return output;
}
