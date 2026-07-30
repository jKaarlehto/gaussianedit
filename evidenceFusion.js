/**
 * Experimental, browser-free reference contracts for Gaussian evidence.
 *
 * This module is intentionally not wired into the live selection path. It is a
 * deterministic oracle for the backend implementation and its tests. Large
 * contributor buffers must be reduced on the GPU before crossing into JS.
 */

export const EVIDENCE_SEMANTICS = Object.freeze([
  'calibrated-log-evidence',
  'raw-model-score',
  'binary-membership',
  'hard-constraint',
  'pairwise-affinity',
  'quality-flag',
]);

export const EVIDENCE_EFFECTS = Object.freeze([
  'membership',
  'prompt-only',
  'quality-only',
]);

export const NEGATIVE_SCOPES = Object.freeze([
  'none',
  'local-ring',
  'proposal-box',
  'visible-frame',
  'manual-edit',
]);

export const EXPERIMENTAL_EVIDENCE_V2_DEFAULT = false;

export const DEFAULT_CONTRIBUTOR_LIMITS = Object.freeze({
  maxPixels: 512 * 512,
  maxContributorsPerPixel: 16,
  maxIntersections: 512 * 512 * 8,
  maxTouchedGaussians: 500_000,
  maxEstimatedBytes: 192 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPeakWorkingBytes: 192 * 1024 * 1024,
  maxProcessingMs: 150,
  cancellationCheckStride: 1_024,
  minContributorWeight: 1e-4,
  minObservedAlpha: 0.02,
  // Foreground pixels can still see unrelated background through translucent
  // or incomplete geometry. Attribute only the front prefix carrying this
  // fraction of the returned radiance mass; retain the tail as unknown.
  foregroundPrefixMass: 0.9,
});

export const DEFAULT_FUSION_LIMITS = Object.freeze({
  maxEvents: 96,
  maxSparseEntries: 500_000,
  maxTouchedGaussians: 250_000,
  maxCausalFamilies: 128,
  maxObservationUnits: 512,
  maxFamilyObservationEdges: 8_192,
  maxEstimatedBytes: 128 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPeakWorkingBytes: 192 * 1024 * 1024,
  maxProcessingMs: 100,
  cancellationCheckStride: 2_048,
  observationCap: 1,
  familyCap: 2.5,
  includeThreshold: 0.55,
  excludeThreshold: -0.55,
});

const DEFAULT_EVENT_LIMITS = Object.freeze({
  maxSparseEntries: 500_000,
  maxParentEventIds: 96,
  maxEstimatedBytes: 32 * 1024 * 1024,
  maxProcessingMs: 50,
  cancellationCheckStride: 2_048,
});

export class FusionBudgetError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = 'FusionBudgetError';
    this.diagnostics = diagnostics;
  }
}

export class FusionCancelledError extends Error {
  constructor(message = 'Evidence work was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Publish one immutable observation. Typed-array payloads remain externally
 * owned and are not copied; callers must transfer ownership or never mutate
 * them after publication.
 */
export function createEvidenceEvent(spec, validation = {}) {
  const {
    checkpoint: inheritedCheckpoint = null,
    signal = null,
    now = defaultNow,
    ...limitOverrides
  } = validation;
  const cap = { ...DEFAULT_EVENT_LIMITS, ...limitOverrides };
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  validateLimits(cap, [
    'maxSparseEntries',
    'maxParentEventIds',
    'maxEstimatedBytes',
    'maxProcessingMs',
    'cancellationCheckStride',
  ]);
  const startedAt = now();
  const checkpoint = inheritedCheckpoint ?? ((phase, progress = 0) => {
    throwIfAborted(signal);
    const elapsedMs = now() - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs > cap.maxProcessingMs) {
      throw new FusionBudgetError('Evidence event validation exceeded its runtime budget.', {
        phase,
        progress,
        elapsedMs,
        limit: cap.maxProcessingMs,
      });
    }
    return elapsedMs;
  });
  checkpoint('event-start');
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('Evidence event must be an object.');
  }
  const requiredString = [
    'id',
    'causalFamilyId',
    'observationUnitId',
    'target',
    'semantics',
    'effect',
  ];
  for (const key of requiredString) {
    if (!isNonemptyString(spec[key])) {
      throw new TypeError(`Evidence event needs a non-empty ${key}.`);
    }
  }
  if (!EVIDENCE_SEMANTICS.includes(spec.semantics)) {
    throw new TypeError(`Unsupported evidence semantics: ${spec.semantics}`);
  }
  if (!EVIDENCE_EFFECTS.includes(spec.effect)) {
    throw new TypeError(`Unsupported evidence effect: ${spec.effect}`);
  }
  validateRevision(spec.revision);
  if (!NEGATIVE_SCOPES.includes(spec.negativeScope)) {
    throw new TypeError(`Unsupported negativeScope: ${spec.negativeScope}`);
  }
  if (!isNonemptyString(spec.provider?.id) || !isNonemptyString(spec.provider?.version)) {
    throw new TypeError('Evidence event needs provider id and version.');
  }
  const parentEventIds = normalizeParentEventIds(
    spec.provenance?.parentEventIds ?? [],
    cap,
    checkpoint,
  );
  if (spec.provenance?.transformation != null) {
    validateTransformation(spec.provenance.transformation);
  }
  if (spec.effect === 'membership') validateSparseFields(spec.fields, cap, checkpoint);
  if (spec.effect !== 'membership' && spec.fields) {
    validateSparseFields(spec.fields, cap, checkpoint);
  }
  if (spec.semantics === 'calibrated-log-evidence' && !spec.calibrationId) {
    throw new TypeError('Calibrated log evidence needs calibrationId.');
  }
  if (spec.semantics === 'hard-constraint' && spec.effect !== 'membership') {
    throw new TypeError('Hard constraints must have membership effect.');
  }
  if (spec.negativeScope === 'none' && hasNegativeEvidence(
    spec.fields,
    cap,
    checkpoint,
  )) {
    throw new RangeError('negativeScope "none" cannot carry negative evidence.');
  }
  const provider = Object.freeze({ ...spec.provider });
  const revision = Object.freeze({ ...spec.revision });
  const provenance = Object.freeze({
    ...(spec.provenance ?? {}),
    parentEventIds: Object.freeze(parentEventIds),
    transformation: spec.provenance?.transformation
      ? Object.freeze({
        ...spec.provenance.transformation,
        provider: Object.freeze({ ...spec.provenance.transformation.provider }),
      })
      : null,
  });
  const fields = spec.fields ? Object.freeze({ ...spec.fields }) : null;
  return Object.freeze({
    ...spec,
    provider,
    revision,
    provenance,
    fields,
  });
}

/**
 * Aggregate front-to-back alpha*T contributor weights into sparse Gaussian
 * support/opposition/observation fields.
 *
 * pixelLabels: 1 foreground, 0 background, 255 unknown/unobserved.
 * gaussianIds and weights are [pixelCount, contributorsPerPixel], padded with
 * -1/0. Their order must remain front-to-back.
 */
export function liftContributorEvidence({
  gaussianIds,
  weights,
  pixelLabels,
  contributorsPerPixel,
  pixelReliability = null,
  pixelAlpha = null,
  viewReliability = 1,
  negativeScope = 'visible-frame',
  limits = {},
  signal = null,
  now = defaultNow,
}) {
  const cap = { ...DEFAULT_CONTRIBUTOR_LIMITS, ...limits };
  validateLimits(cap, [
    'maxPixels',
    'maxContributorsPerPixel',
    'maxIntersections',
    'maxTouchedGaussians',
    'maxEstimatedBytes',
    'maxOutputBytes',
    'maxPeakWorkingBytes',
    'maxProcessingMs',
    'cancellationCheckStride',
  ]);
  validateUnitInterval(cap.foregroundPrefixMass, 'foregroundPrefixMass');
  validateUnitInterval(cap.minObservedAlpha, 'minObservedAlpha');
  if (!Number.isFinite(cap.minContributorWeight) || cap.minContributorWeight < 0) {
    throw new RangeError('minContributorWeight must be finite and non-negative.');
  }
  if (!NEGATIVE_SCOPES.includes(negativeScope)) {
    throw new TypeError(`Unsupported negativeScope: ${negativeScope}`);
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const startedAt = now();
  const checkpoint = (phase, progress = 0) => {
    throwIfAborted(signal);
    const elapsedMs = now() - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs > cap.maxProcessingMs) {
      throw new FusionBudgetError('Contributor lift exceeds its runtime budget.', {
        phase,
        progress,
        elapsedMs,
        limit: cap.maxProcessingMs,
      });
    }
    return elapsedMs;
  };
  checkpoint('validate');
  if (!(gaussianIds instanceof Int32Array)) {
    throw new TypeError('gaussianIds must be an Int32Array.');
  }
  if (!(weights instanceof Float32Array)) {
    throw new TypeError('weights must be a Float32Array.');
  }
  if (!(pixelLabels instanceof Uint8Array)) {
    throw new TypeError('pixelLabels must be a Uint8Array.');
  }
  if (!Number.isInteger(contributorsPerPixel) || contributorsPerPixel <= 0) {
    throw new TypeError('contributorsPerPixel must be a positive integer.');
  }
  const pixelCount = pixelLabels.length;
  const intersections = pixelCount * contributorsPerPixel;
  if (gaussianIds.length !== intersections || weights.length !== intersections) {
    throw new RangeError('Contributor arrays do not match pixel dimensions.');
  }
  if (pixelReliability && pixelReliability.length !== pixelCount) {
    throw new RangeError('pixelReliability length does not match pixelLabels.');
  }
  if (pixelAlpha && pixelAlpha.length !== pixelCount) {
    throw new RangeError('pixelAlpha length does not match pixelLabels.');
  }
  validateUnitInterval(viewReliability, 'viewReliability');
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (pixel % cap.cancellationCheckStride === 0) checkpoint('validate-pixels', pixel);
    const label = pixelLabels[pixel];
    if (label !== 0 && label !== 1 && label !== 255) {
      throw new RangeError(`pixelLabels[${pixel}] must be exactly 0, 1, or 255.`);
    }
    if (pixelReliability) {
      validateUnitInterval(pixelReliability[pixel], `pixelReliability[${pixel}]`);
    }
    if (pixelAlpha) validateUnitInterval(pixelAlpha[pixel], `pixelAlpha[${pixel}]`);
  }
  for (let offset = 0; offset < intersections; offset++) {
    if (offset % cap.cancellationCheckStride === 0) {
      checkpoint('validate-contributors', offset);
    }
    const id = gaussianIds[offset];
    const contributorWeight = weights[offset];
    if (id < -1) throw new RangeError('Contributor IDs must be -1 or non-negative.');
    if (
      !Number.isFinite(contributorWeight)
      || contributorWeight < 0
      || contributorWeight > 1
    ) {
      throw new RangeError('Contributor weights must be finite and within [0, 1].');
    }
    if (id < 0 && contributorWeight !== 0) {
      throw new RangeError('Padded contributor lanes must have exactly zero weight.');
    }
  }
  const estimatedBytes = gaussianIds.byteLength
    + weights.byteLength
    + pixelLabels.byteLength
    + (pixelReliability?.byteLength ?? 0)
    + (pixelAlpha?.byteLength ?? 0);
  if (
    pixelCount > cap.maxPixels
    || contributorsPerPixel > cap.maxContributorsPerPixel
    || intersections > cap.maxIntersections
    || estimatedBytes > cap.maxEstimatedBytes
  ) {
    throw new FusionBudgetError('Contributor lift exceeds its input budget.', {
      pixelCount,
      contributorsPerPixel,
      intersections,
      estimatedBytes,
      limits: cap,
    });
  }
  const maxPossibleTouched = Math.min(cap.maxTouchedGaussians, intersections);
  const reservedOutputBytes = maxPossibleTouched
    * (Uint32Array.BYTES_PER_ELEMENT + Float32Array.BYTES_PER_ELEMENT * 4);
  const estimatedPeakWorkingBytes = estimatedBytes
    + reservedOutputBytes
    + maxPossibleTouched * 176;
  if (estimatedPeakWorkingBytes > cap.maxPeakWorkingBytes) {
    throw new FusionBudgetError('Contributor lift exceeds its peak working-memory budget.', {
      estimatedPeakWorkingBytes,
      maxPossibleTouched,
      limit: cap.maxPeakWorkingBytes,
    });
  }

  const byId = new Map();
  let assignedPositiveMass = 0;
  let assignedNegativeMass = 0;
  let unknownTailMass = 0;
  let omittedContributorMass = 0;
  let observedPixels = 0;
  const boundedViewReliability = viewReliability;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (pixel % cap.cancellationCheckStride === 0) checkpoint('aggregate', pixel);
    const label = pixelLabels[pixel];
    const alpha = pixelAlpha ? pixelAlpha[pixel] : 1;
    const reliability = boundedViewReliability
      * (pixelReliability ? pixelReliability[pixel] : 1);
    if (label === 255 || alpha < cap.minObservedAlpha || reliability === 0) {
      continue;
    }
    observedPixels++;
    const start = pixel * contributorsPerPixel;
    let returnedMass = 0;
    for (let lane = 0; lane < contributorsPerPixel; lane++) {
      const offset = start + lane;
      const id = gaussianIds[offset];
      const contributorWeight = weights[offset];
      if (id < 0) continue;
      returnedMass += contributorWeight;
    }
    const massTolerance = Math.max(1e-5, alpha * 1e-5);
    if (returnedMass > alpha + massTolerance) {
      throw new RangeError(
        `Returned contributor mass for pixel ${pixel} exceeds its observed alpha.`,
      );
    }
    omittedContributorMass += Math.max(0, alpha - returnedMass) * reliability;
    const foregroundBudget = label === 1
      ? returnedMass * cap.foregroundPrefixMass
      : Infinity;
    let foregroundUsed = 0;

    for (let lane = 0; lane < contributorsPerPixel; lane++) {
      const offset = start + lane;
      const id = gaussianIds[offset];
      const rawWeight = weights[offset];
      if (id < 0 || rawWeight < cap.minContributorWeight) continue;
      let entry = byId.get(id);
      if (!entry) {
        if (byId.size >= cap.maxTouchedGaussians) {
          throw new FusionBudgetError('Contributor lift touched too many Gaussians.', {
            touchedGaussians: byId.size,
            limit: cap.maxTouchedGaussians,
          });
        }
        entry = { positive: 0, negative: 0, observed: 0, unknown: 0 };
        byId.set(id, entry);
      }
      const weighted = rawWeight * reliability;
      entry.observed += weighted;
      if (label === 1) {
        const remaining = Math.max(0, foregroundBudget - foregroundUsed);
        const attributedRaw = Math.min(rawWeight, remaining);
        const attributed = attributedRaw * reliability;
        const tail = Math.max(0, rawWeight - attributedRaw) * reliability;
        entry.positive += attributed;
        entry.unknown += tail;
        foregroundUsed += attributedRaw;
        assignedPositiveMass += attributed;
        unknownTailMass += tail;
      } else if (negativeScope !== 'none') {
        entry.negative += weighted;
        assignedNegativeMass += weighted;
      } else {
        entry.unknown += weighted;
        unknownTailMass += weighted;
      }
    }
  }

  checkpoint('materialize');
  const ids = Uint32Array.from([...byId.keys()].sort((a, b) => a - b));
  const estimatedOutputBytes = ids.byteLength + ids.length * Float32Array.BYTES_PER_ELEMENT * 4;
  if (estimatedOutputBytes > cap.maxOutputBytes) {
    throw new FusionBudgetError('Contributor lift exceeds its output byte budget.', {
      estimatedOutputBytes,
      estimatedPeakWorkingBytes,
      limit: cap.maxOutputBytes,
    });
  }
  const positive = new Float32Array(ids.length);
  const negative = new Float32Array(ids.length);
  const observed = new Float32Array(ids.length);
  const unknown = new Float32Array(ids.length);
  for (let slot = 0; slot < ids.length; slot++) {
    if (slot % cap.cancellationCheckStride === 0) checkpoint('materialize', slot);
    const entry = byId.get(ids[slot]);
    positive[slot] = entry.positive;
    negative[slot] = entry.negative;
    observed[slot] = entry.observed;
    unknown[slot] = entry.unknown;
  }
  const finalElapsedMs = checkpoint('complete');
  return {
    fields: { ids, positive, negative, observed, unknown },
    diagnostics: Object.freeze({
      pixelCount,
      observedPixels,
      intersections,
      touchedGaussians: ids.length,
      estimatedInputBytes: estimatedBytes,
      estimatedOutputBytes,
      elapsedMs: finalElapsedMs,
      assignedPositiveMass,
      assignedNegativeMass,
      unknownTailMass,
      omittedContributorMass,
      foregroundPrefixMass: cap.foregroundPrefixMass,
    }),
  };
}

/**
 * Fuse sparse membership observations with hierarchical causal caps.
 *
 * Events from one rendered RGB frame share observationUnitId. Frames derived
 * from one tracker seed/session share causalFamilyId. A detector used only to
 * prompt SAM has effect "prompt-only" and contributes no membership vote.
 */
export function fuseEvidenceFamilies(events, options = {}) {
  const {
    expectedRevision,
    signal = null,
    now = defaultNow,
    ...limitOverrides
  } = options;
  validateRevision(expectedRevision);
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const cap = { ...DEFAULT_FUSION_LIMITS, ...limitOverrides };
  validateLimits(cap, [
    'maxEvents',
    'maxSparseEntries',
    'maxTouchedGaussians',
    'maxCausalFamilies',
    'maxObservationUnits',
    'maxFamilyObservationEdges',
    'maxEstimatedBytes',
    'maxOutputBytes',
    'maxPeakWorkingBytes',
    'maxProcessingMs',
    'cancellationCheckStride',
  ]);
  validateLimits(cap, ['observationCap', 'familyCap']);
  if (
    !Number.isFinite(cap.includeThreshold)
    || !Number.isFinite(cap.excludeThreshold)
    || cap.excludeThreshold >= cap.includeThreshold
  ) {
    throw new RangeError(
      'Fusion thresholds must be finite with excludeThreshold < includeThreshold.',
    );
  }
  const startedAt = now();
  const checkpoint = (phase, progress = 0) => {
    throwIfAborted(signal);
    const elapsedMs = now() - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs > cap.maxProcessingMs) {
      throw new FusionBudgetError('Evidence fusion exceeds its runtime budget.', {
        phase,
        progress,
        elapsedMs,
        limit: cap.maxProcessingMs,
      });
    }
    return elapsedMs;
  };
  checkpoint('validate');
  if (!Array.isArray(events)) throw new TypeError('events must be an array.');
  if (events.length > cap.maxEvents) {
    throw new FusionBudgetError('Too many evidence events.', {
      eventCount: events.length,
      limit: cap.maxEvents,
    });
  }

  // Preflight array shape, entry count, and byte count before scanning any
  // sparse values or allocating nested aggregation Maps.
  let sparseEntries = 0;
  let estimatedInputBytes = 0;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    checkpoint('preflight-events', eventIndex);
    const fields = events[eventIndex]?.fields;
    if (!fields) continue;
    const shape = preflightSparseFields(fields);
    sparseEntries = finiteAdd(sparseEntries, shape.entries, 'sparse-entry count');
    estimatedInputBytes = finiteAdd(
      estimatedInputBytes,
      shape.estimatedBytes,
      'evidence input bytes',
    );
    if (sparseEntries > cap.maxSparseEntries) {
      throw new FusionBudgetError('Evidence fusion exceeds sparse-entry budget.', {
        sparseEntries,
        limit: cap.maxSparseEntries,
      });
    }
    if (estimatedInputBytes > cap.maxEstimatedBytes) {
      throw new FusionBudgetError('Evidence fusion exceeds its input byte budget.', {
        estimatedInputBytes,
        limit: cap.maxEstimatedBytes,
      });
    }
  }

  const validatedEvents = new Array(events.length);
  const eventIds = new Set();
  const causalFamilies = new Set();
  const observationUnits = new Set();
  const familyObservationEdges = new Set();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    checkpoint('events', eventIndex);
    const event = events[eventIndex];
    const validated = createEvidenceEvent(event, {
      maxSparseEntries: cap.maxSparseEntries,
      maxEstimatedBytes: cap.maxEstimatedBytes,
      maxProcessingMs: cap.maxProcessingMs,
      cancellationCheckStride: cap.cancellationCheckStride,
      checkpoint,
    });
    validatedEvents[eventIndex] = validated;
    if (!revisionEquals(validated.revision, expectedRevision)) {
      throw new RangeError(
        `Evidence event ${validated.id} revision does not match the requested target.`,
      );
    }
    if (eventIds.has(validated.id)) {
      throw new RangeError(`Duplicate evidence event id: ${validated.id}`);
    }
    eventIds.add(validated.id);
    causalFamilies.add(validated.causalFamilyId);
    observationUnits.add(validated.observationUnitId);
    familyObservationEdges.add(
      JSON.stringify([validated.causalFamilyId, validated.observationUnitId]),
    );
    if (
      causalFamilies.size > cap.maxCausalFamilies
      || observationUnits.size > cap.maxObservationUnits
      || familyObservationEdges.size > cap.maxFamilyObservationEdges
    ) {
      throw new FusionBudgetError('Evidence fusion exceeds its provenance graph budget.', {
        causalFamilies: causalFamilies.size,
        observationUnits: observationUnits.size,
        familyObservationEdges: familyObservationEdges.size,
        limits: cap,
      });
    }
  }

  const lineageKeyByEventId = validateCausalDag(validatedEvents, checkpoint);
  const maxPossibleTouched = Math.min(cap.maxTouchedGaussians, sparseEntries);
  const reservedOutputBytes = maxPossibleTouched
    * (Uint32Array.BYTES_PER_ELEMENT + Float32Array.BYTES_PER_ELEMENT * 3 + 96);
  const estimatedPeakWorkingBytes = estimatedInputBytes
    + reservedOutputBytes
    + maxPossibleTouched * 192
    + sparseEntries * 96
    + familyObservationEdges.size * 128;
  if (estimatedPeakWorkingBytes > cap.maxPeakWorkingBytes) {
    throw new FusionBudgetError('Evidence fusion exceeds its peak working-memory budget.', {
      estimatedPeakWorkingBytes,
      maxPossibleTouched,
      sparseEntries,
      limit: cap.maxPeakWorkingBytes,
    });
  }

  const gaussians = new Map();
  for (let eventIndex = 0; eventIndex < validatedEvents.length; eventIndex++) {
    checkpoint('aggregate-events', eventIndex);
    const validated = validatedEvents[eventIndex];
    if (validated.effect !== 'membership') continue;
    const fields = validated.fields;
    const lineageKey = lineageKeyByEventId.get(validated.id);
    for (let slot = 0; slot < fields.ids.length; slot++) {
      if (slot % cap.cancellationCheckStride === 0) checkpoint('sparse-fields', slot);
      const id = fields.ids[slot];
      let aggregate = gaussians.get(id);
      if (!aggregate) {
        if (gaussians.size >= cap.maxTouchedGaussians) {
          throw new FusionBudgetError('Evidence fusion touched too many Gaussians.', {
            touchedGaussians: gaussians.size,
            limit: cap.maxTouchedGaussians,
          });
        }
        aggregate = {
          families: new Map(),
          observed: 0,
          unknown: 0,
          hardInclude: [],
          hardExclude: [],
          eventIds: [],
        };
        gaussians.set(id, aggregate);
      }
      aggregate.eventIds.push(validated.id);
      aggregate.observed = finiteAdd(
        aggregate.observed,
        fields.observed[slot],
        'observed evidence',
      );
      aggregate.unknown = finiteAdd(
        aggregate.unknown,
        fields.unknown[slot],
        'unknown evidence',
      );
      const positive = fields.positive[slot];
      const negative = fields.negative[slot];
      if (validated.semantics === 'hard-constraint') {
        if (positive > 0) aggregate.hardInclude.push(validated.id);
        if (negative > 0) aggregate.hardExclude.push(validated.id);
        continue;
      }
      let family = aggregate.families.get(validated.causalFamilyId);
      if (!family) {
        family = new Map();
        aggregate.families.set(validated.causalFamilyId, family);
      }
      let observation = family.get(validated.observationUnitId);
      if (!observation) {
        observation = new Map();
        family.set(validated.observationUnitId, observation);
      }
      const prior = observation.get(lineageKey) ?? 0;
      observation.set(
        lineageKey,
        combineCorrelatedEvidence(
          prior,
          contributionForEvent(validated, positive, negative),
        ),
      );
    }
  }

  checkpoint('materialize');
  const ids = Uint32Array.from([...gaussians.keys()].sort((a, b) => a - b));
  const estimatedOutputBytes = ids.byteLength
    + ids.length * Float32Array.BYTES_PER_ELEMENT * 3
    + ids.length * 96;
  if (estimatedOutputBytes > cap.maxOutputBytes) {
    throw new FusionBudgetError('Evidence fusion exceeds its output byte budget.', {
      estimatedOutputBytes,
      limit: cap.maxOutputBytes,
    });
  }
  const boundedSignedEvidence = new Float32Array(ids.length);
  const observed = new Float32Array(ids.length);
  const unknown = new Float32Array(ids.length);
  const decisions = new Array(ids.length);
  const provenance = new Array(ids.length);
  for (let slot = 0; slot < ids.length; slot++) {
    if (slot % cap.cancellationCheckStride === 0) checkpoint('materialize', slot);
    const aggregate = gaussians.get(ids[slot]);
    observed[slot] = aggregate.observed;
    unknown[slot] = aggregate.unknown;
    const hardConflict = aggregate.hardInclude.length && aggregate.hardExclude.length;
    let familyScore = 0;
    const familySummaries = [];
    for (const [familyId, units] of aggregate.families) {
      let sum = 0;
      for (const lineages of units.values()) {
        let observationValue = 0;
        for (const value of lineages.values()) {
          observationValue = finiteAdd(
            observationValue,
            value,
            'observation evidence',
          );
        }
        sum = finiteAdd(
          sum,
          clamp(observationValue, -cap.observationCap, cap.observationCap),
          'family evidence',
        );
      }
      const bounded = clamp(sum, -cap.familyCap, cap.familyCap);
      familyScore = finiteAdd(familyScore, bounded, 'fused evidence');
      familySummaries.push(Object.freeze({
        familyId,
        observationUnits: units.size,
        contribution: bounded,
      }));
    }
    boundedSignedEvidence[slot] = familyScore;
    decisions[slot] = hardConflict
      ? 'disputed'
      : aggregate.hardInclude.length
        ? 'included'
        : aggregate.hardExclude.length
          ? 'excluded'
          : familyScore >= cap.includeThreshold
            ? 'included'
            : familyScore <= cap.excludeThreshold
              ? 'excluded'
              : aggregate.observed > 0
                ? 'disputed'
                : 'unknown';
    provenance[slot] = Object.freeze({
      eventIds: Object.freeze([...new Set(aggregate.eventIds)]),
      hardIncludeEventIds: Object.freeze([...aggregate.hardInclude]),
      hardExcludeEventIds: Object.freeze([...aggregate.hardExclude]),
      hardConflict: Boolean(hardConflict),
      independentCausalFamilies: aggregate.families.size,
      families: Object.freeze(familySummaries),
    });
  }
  const finalElapsedMs = checkpoint('complete');
  return Object.freeze({
    ids,
    // This is a capped, heterogeneous evidence accumulator. It is explicitly
    // not a posterior probability or authoritative log-odds value.
    boundedSignedEvidence,
    observed,
    unknown,
    decisions: Object.freeze(decisions),
    provenance: Object.freeze(provenance),
    diagnostics: Object.freeze({
      eventCount: events.length,
      sparseEntries,
      touchedGaussians: ids.length,
      causalFamilies: causalFamilies.size,
      observationUnits: observationUnits.size,
      familyObservationEdges: familyObservationEdges.size,
      estimatedInputBytes,
      estimatedOutputBytes,
      estimatedPeakWorkingBytes,
      elapsedMs: finalElapsedMs,
      representation: 'bounded-heterogeneous-signed-evidence-v1',
      observationCap: cap.observationCap,
      familyCap: cap.familyCap,
    }),
  });
}

function contributionForEvent(event, positive, negative) {
  const signed = positive - negative;
  if (event.semantics === 'calibrated-log-evidence') {
    return signed;
  }
  if (
    event.semantics === 'raw-model-score'
    || event.semantics === 'binary-membership'
  ) {
    return signed;
  }
  return 0;
}

function validateRevision(revision) {
  if (!revision || typeof revision !== 'object') {
    throw new TypeError('Evidence event needs a revision record.');
  }
  for (const key of ['scene', 'view', 'selection', 'mask', 'scan']) {
    if (!Number.isInteger(revision[key]) || revision[key] < 0) {
      throw new TypeError(`Evidence revision ${key} must be a non-negative integer.`);
    }
  }
}

function preflightSparseFields(fields) {
  if (!fields || !(fields.ids instanceof Uint32Array)) {
    throw new TypeError('Evidence fields need Uint32Array ids.');
  }
  for (const key of ['positive', 'negative', 'observed', 'unknown']) {
    const field = fields[key];
    if (!(field instanceof Float32Array) || field.length !== fields.ids.length) {
      throw new TypeError(`${key} must be a Float32Array aligned with ids.`);
    }
  }
  return {
    entries: fields.ids.length,
    estimatedBytes: sparseFieldBytes(fields),
  };
}

function validateSparseFields(fields, limits, checkpoint) {
  const { entries, estimatedBytes } = preflightSparseFields(fields);
  if (entries > limits.maxSparseEntries || estimatedBytes > limits.maxEstimatedBytes) {
    throw new FusionBudgetError('Evidence event exceeds its sparse-field budget.', {
      entries,
      estimatedBytes,
      limits,
    });
  }
  let previous = -1;
  for (let slot = 0; slot < fields.ids.length; slot++) {
    if (slot % limits.cancellationCheckStride === 0) {
      checkpoint('validate-sparse-ids', slot);
    }
    const id = fields.ids[slot];
    if (id <= previous) throw new RangeError('Evidence ids must be sorted and unique.');
    previous = id;
  }
  for (let slot = 0; slot < fields.ids.length; slot++) {
    if (slot % limits.cancellationCheckStride === 0) {
      checkpoint('validate-sparse-mass', slot);
    }
    let partition = 0;
    for (const key of ['positive', 'negative', 'unknown']) {
      const value = fields[key][slot];
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${key}[${slot}] must be finite and non-negative.`);
      }
      partition += value;
    }
    const observed = fields.observed[slot];
    if (!Number.isFinite(observed) || observed < 0) {
      throw new RangeError(`observed[${slot}] must be finite and non-negative.`);
    }
    const tolerance = Math.max(1e-5, observed * 1e-5);
    if (!Number.isFinite(partition) || Math.abs(partition - observed) > tolerance) {
      throw new RangeError(
        `Evidence mass at slot ${slot} is inconsistent: `
        + `positive + negative + unknown must equal observed.`,
      );
    }
  }
}

function normalizeParentEventIds(parentEventIds, limits, checkpoint) {
  if (!Array.isArray(parentEventIds)) {
    throw new TypeError('parentEventIds must be an array.');
  }
  if (parentEventIds.length > limits.maxParentEventIds) {
    throw new FusionBudgetError('parentEventIds exceeds its entry budget.', {
      entries: parentEventIds.length,
      limit: limits.maxParentEventIds,
    });
  }
  const unique = new Set();
  const normalized = new Array(parentEventIds.length);
  for (let index = 0; index < parentEventIds.length; index++) {
    if (index % limits.cancellationCheckStride === 0) {
      checkpoint('validate-parent-ids', index);
    }
    const parentId = parentEventIds[index];
    if (!isNonemptyString(parentId)) {
      throw new TypeError(`parentEventIds[${index}] must be a non-empty string.`);
    }
    if (unique.has(parentId)) {
      throw new RangeError(`Duplicate parent event id: ${parentId}`);
    }
    unique.add(parentId);
    normalized[index] = parentId;
  }
  return normalized;
}

function validateTransformation(transformation) {
  if (
    !transformation
    || transformation.kind !== 'new-observation'
    || transformation.correlation !== 'same-causal-family'
    || !isNonemptyString(transformation.id)
    || !isNonemptyString(transformation.provider?.id)
    || !isNonemptyString(transformation.provider?.version)
  ) {
    throw new TypeError(
      'Evidence transformation must declare a non-empty id/provider and '
      + 'kind "new-observation" with correlation "same-causal-family".',
    );
  }
}

function validateCausalDag(events, checkpoint) {
  const eventById = new Map();
  const indexById = new Map();
  const rootsById = new Map();
  const lineageKeyByEventId = new Map();
  for (let index = 0; index < events.length; index++) {
    checkpoint('causal-index', index);
    eventById.set(events[index].id, events[index]);
    indexById.set(events[index].id, index);
  }
  for (let index = 0; index < events.length; index++) {
    checkpoint('causal-dag', index);
    const event = events[index];
    const parentIds = event.provenance.parentEventIds;
    const transformation = event.provenance.transformation;
    if (!parentIds.length) {
      if (transformation) {
        throw new RangeError(
          `Root evidence event ${event.id} cannot declare a derived transformation.`,
        );
      }
      const roots = Object.freeze([event.id]);
      rootsById.set(event.id, roots);
      lineageKeyByEventId.set(event.id, JSON.stringify(roots));
      continue;
    }
    const roots = new Set();
    let membershipParentRoots = null;
    let inheritedUnit = null;
    let membershipParentCount = 0;
    for (const parentId of parentIds) {
      const parentIndex = indexById.get(parentId);
      if (parentIndex == null) {
        throw new RangeError(`Evidence event ${event.id} has missing parent ${parentId}.`);
      }
      if (parentIndex >= index) {
        throw new RangeError(
          `Evidence parent ${parentId} must precede child ${event.id}; cycles `
          + 'and forward references are rejected.',
        );
      }
      const parent = eventById.get(parentId);
      if (parent.effect === 'membership') {
        membershipParentCount++;
        membershipParentRoots = rootsById.get(parentId);
      }
      if (parent.causalFamilyId !== event.causalFamilyId) {
        throw new RangeError(
          `Evidence event ${event.id} cannot launder parent ${parentId} into `
          + 'an independent causal family.',
        );
      }
      if (inheritedUnit == null) inheritedUnit = parent.observationUnitId;
      else if (inheritedUnit !== parent.observationUnitId) {
        throw new RangeError(
          `Evidence event ${event.id} cannot merge parents from different observation units.`,
        );
      }
      for (const rootId of rootsById.get(parentId)) roots.add(rootId);
    }
    if (event.effect === 'membership' && membershipParentCount > 1) {
      throw new RangeError(
        `Membership event ${event.id} cannot merge multiple membership parents.`,
      );
    }
    if (event.observationUnitId === inheritedUnit) {
      if (transformation) {
        throw new RangeError(
          `Evidence event ${event.id} declares a new-observation transformation `
          + 'without changing observationUnitId.',
        );
      }
    } else if (!transformation) {
      throw new RangeError(
        `Evidence event ${event.id} changed observationUnitId without an explicit `
        + 'same-family transformation contract.',
      );
    }
    const orderedRoots = Object.freeze(
      [...(membershipParentRoots ?? roots)].sort(),
    );
    rootsById.set(event.id, orderedRoots);
    lineageKeyByEventId.set(event.id, JSON.stringify(orderedRoots));
  }
  return lineageKeyByEventId;
}

function combineCorrelatedEvidence(prior, next) {
  const magnitude = Math.max(Math.abs(prior), Math.abs(next));
  return clamp(finiteAdd(prior, next, 'correlated evidence'), -magnitude, magnitude);
}

function hasNegativeEvidence(fields, limits, checkpoint) {
  if (!fields?.negative) return false;
  for (let index = 0; index < fields.negative.length; index++) {
    if (index % limits.cancellationCheckStride === 0) {
      checkpoint('validate-negative-scope', index);
    }
    const value = fields.negative[index];
    if (value > 0) return true;
  }
  return false;
}

function sparseFieldBytes(fields) {
  return fields.ids.byteLength
    + fields.positive.byteLength
    + fields.negative.byteLength
    + fields.observed.byteLength
    + fields.unknown.byteLength;
}

function revisionEquals(left, right) {
  return ['scene', 'view', 'selection', 'mask', 'scan']
    .every((key) => left[key] === right[key]);
}

function validateUnitInterval(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be finite and within [0, 1].`);
  }
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateLimits(limits, keys) {
  for (const key of keys) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) {
      throw new RangeError(`Limit ${key} must be finite and positive.`);
    }
  }
}

function finiteAdd(left, right, label) {
  const result = left + right;
  if (!Number.isFinite(result)) {
    throw new RangeError(`${label} overflowed.`);
  }
  return result;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new FusionCancelledError();
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
