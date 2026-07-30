import assert from 'node:assert/strict';
import {
  FusionBudgetError,
  createEvidenceEvent,
  fuseEvidenceFamilies,
  liftContributorEvidence,
} from '../evidenceFusion.js';
import {
  GraphBudgetError,
  retainSeedReachableComponent,
  runBoundedBinaryGraphCut,
} from '../localGraphCut.js';
import { resolveScaleIntent } from '../scaleHypotheses.js';
import { selectCausalEvidenceViews } from '../activeEvidencePlanner.js';

const revision = Object.freeze({
  scene: 1,
  view: 2,
  selection: 3,
  mask: 4,
  scan: 5,
});

function membershipEvent({
  id,
  family,
  unit,
  gaussianId = 7,
  positive = 1,
  negative = 0,
  semantics = 'binary-membership',
  effect = 'membership',
  parentEventIds = [],
  eventRevision = revision,
  negativeScope = 'visible-frame',
  transformation = null,
}) {
  return createEvidenceEvent({
    id,
    revision: eventRevision,
    provider: { id: 'test', version: '1' },
    causalFamilyId: family,
    observationUnitId: unit,
    target: 'gaussian',
    semantics,
    effect,
    negativeScope,
    fields: effect === 'membership'
      ? {
        ids: Uint32Array.of(gaussianId),
        positive: Float32Array.of(positive),
        negative: Float32Array.of(negative),
        observed: Float32Array.of(positive + negative),
        unknown: Float32Array.of(0),
      }
      : null,
    provenance: { parentEventIds, transformation },
  });
}

{
  const lifted = liftContributorEvidence({
    gaussianIds: Int32Array.of(
      10, 11, -1,
      10, 12, -1,
    ),
    weights: Float32Array.of(
      0.7, 0.2, 0,
      0.6, 0.3, 0,
    ),
    pixelLabels: Uint8Array.of(1, 0),
    pixelAlpha: Float32Array.of(0.95, 0.95),
    contributorsPerPixel: 3,
    foregroundPrefixMass: 0.8,
    viewReliability: 1,
  });
  assert.deepEqual([...lifted.fields.ids], [10, 11, 12]);
  // Foreground support is a front prefix of exact alpha*T weights. The
  // translucent tail is retained as unknown, never silently discarded.
  assert.ok(Math.abs(lifted.fields.positive[0] - 0.7) < 1e-6);
  assert.ok(lifted.fields.positive[1] > 0 && lifted.fields.positive[1] < 0.2);
  assert.ok(lifted.fields.unknown[1] > 0);
  assert.ok(Math.abs(lifted.fields.negative[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(lifted.fields.negative[2] - 0.3) < 1e-6);
  assert.ok(Number.isFinite(lifted.diagnostics.elapsedMs));
}

{
  assert.throws(() => liftContributorEvidence({
    gaussianIds: new Int32Array(8),
    weights: new Float32Array(8),
    pixelLabels: new Uint8Array(2),
    contributorsPerPixel: 4,
    limits: { maxIntersections: 7 },
  }), FusionBudgetError);
}

{
  assert.throws(() => liftContributorEvidence({
    gaussianIds: Int32Array.of(1),
    weights: Float32Array.of(1),
    pixelLabels: Uint8Array.of(2),
    contributorsPerPixel: 1,
  }), /exactly 0, 1, or 255/);
  assert.throws(() => liftContributorEvidence({
    gaussianIds: Int32Array.of(1),
    weights: Float32Array.of(Number.NaN),
    pixelLabels: Uint8Array.of(1),
    contributorsPerPixel: 1,
  }), /finite and within/);
  assert.throws(() => liftContributorEvidence({
    gaussianIds: Int32Array.of(1, 2),
    weights: Float32Array.of(0.7, 0.6),
    pixelLabels: Uint8Array.of(1),
    pixelAlpha: Float32Array.of(1),
    contributorsPerPixel: 2,
  }), /exceeds its observed alpha/);
  assert.throws(() => liftContributorEvidence({
    gaussianIds: Int32Array.of(1),
    weights: Float32Array.of(1),
    pixelLabels: Uint8Array.of(1),
    contributorsPerPixel: 1,
    limits: { maxPeakWorkingBytes: 1 },
  }), /peak working-memory budget/);
  assert.throws(() => membershipEvent({
    id: 'scope-none-negative',
    family: 'bad',
    unit: 'bad',
    positive: 0,
    negative: 1,
    negativeScope: 'none',
  }), /cannot carry negative evidence/);
  assert.throws(() => createEvidenceEvent({
    id: 'inconsistent-mass',
    revision,
    provider: { id: 'test', version: '1' },
    causalFamilyId: 'bad',
    observationUnitId: 'bad',
    target: 'gaussian',
    semantics: 'binary-membership',
    effect: 'membership',
    negativeScope: 'visible-frame',
    fields: {
      ids: Uint32Array.of(1),
      positive: Float32Array.of(1),
      negative: Float32Array.of(0),
      observed: Float32Array.of(0.5),
      unknown: Float32Array.of(0),
    },
    provenance: {},
  }), /inconsistent/);
}

{
  const rawEvent = {
    id: 'timed-event',
    revision,
    provider: { id: 'test', version: '1' },
    causalFamilyId: 'timed-family',
    observationUnitId: 'timed-unit',
    target: 'gaussian',
    semantics: 'binary-membership',
    effect: 'membership',
    negativeScope: 'visible-frame',
    fields: {
      ids: Uint32Array.of(1, 2, 3),
      positive: Float32Array.of(1, 1, 1),
      negative: Float32Array.of(0, 0, 0),
      observed: Float32Array.of(1, 1, 1),
      unknown: Float32Array.of(0, 0, 0),
    },
    provenance: {},
  };
  let clock = 0;
  assert.throws(() => createEvidenceEvent(rawEvent, {
    maxProcessingMs: 2,
    cancellationCheckStride: 1,
    now: () => clock++,
  }), /runtime budget/);
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => createEvidenceEvent(rawEvent, { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
}

{
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => liftContributorEvidence({
    gaussianIds: Int32Array.of(1),
    weights: Float32Array.of(1),
    pixelLabels: Uint8Array.of(1),
    contributorsPerPixel: 1,
    signal: controller.signal,
  }), (error) => error.name === 'AbortError');
}

{
  const yoloPrompt = createEvidenceEvent({
    id: 'yolo-box',
    revision,
    provider: { id: 'yolo', version: '1' },
    causalFamilyId: 'seed-rgb-1',
    observationUnitId: 'seed-frame',
    target: 'pixel',
    semantics: 'raw-model-score',
    effect: 'prompt-only',
    negativeScope: 'proposal-box',
    provenance: {},
  });
  const sam = membershipEvent({
    id: 'sam-mask',
    family: 'seed-rgb-1',
    unit: 'seed-frame',
    positive: 0.8,
    parentEventIds: ['yolo-box'],
  });
  const duplicateDerived = membershipEvent({
    id: 'sam-mask-derived-copy',
    family: 'seed-rgb-1',
    unit: 'seed-frame',
    positive: 0.8,
    parentEventIds: ['sam-mask'],
  });
  const adjacentTrack = membershipEvent({
    id: 'track-adjacent',
    family: 'seed-rgb-1',
    unit: 'sector-1',
    positive: 0.8,
    parentEventIds: ['sam-mask'],
    transformation: {
      id: 'tracker-next-frame-v1',
      kind: 'new-observation',
      correlation: 'same-causal-family',
      provider: { id: 'test-tracker', version: '1' },
    },
  });
  const captured = membershipEvent({
    id: 'captured-independent',
    family: 'capture-camera-9',
    unit: 'capture-camera-9',
    positive: 0.8,
  });
  const fused = fuseEvidenceFamilies(
    [yoloPrompt, sam, duplicateDerived, adjacentTrack, captured],
    { expectedRevision: revision, observationCap: 1, familyCap: 1.5 },
  );
  assert.equal(fused.ids[0], 7);
  // seed frame duplicates cap at 1; adjacent track shares the family cap; the
  // calibrated/captured family contributes independently.
  assert.ok(Math.abs(fused.boundedSignedEvidence[0] - 2.3) < 1e-5);
  assert.equal(fused.provenance[0].independentCausalFamilies, 2);
  assert.equal(
    fused.diagnostics.representation,
    'bounded-heterogeneous-signed-evidence-v1',
  );
  assert.ok(Number.isFinite(fused.diagnostics.elapsedMs));
}

{
  const parent = membershipEvent({
    id: 'correlated-parent',
    family: 'correlated-family',
    unit: 'same-rgb',
    positive: 0.3,
  });
  const child = membershipEvent({
    id: 'correlated-child',
    family: 'correlated-family',
    unit: 'same-rgb',
    positive: 0.3,
    parentEventIds: ['correlated-parent'],
  });
  const fused = fuseEvidenceFamilies(
    [parent, child],
    { expectedRevision: revision },
  );
  assert.ok(Math.abs(fused.boundedSignedEvidence[0] - 0.3) < 1e-6);
  assert.equal(fused.decisions[0], 'disputed');

  const extraPrompt = membershipEvent({
    id: 'extra-prompt-root',
    family: 'correlated-family',
    unit: 'same-rgb',
    effect: 'prompt-only',
  });
  const childWithExtraRoot = membershipEvent({
    id: 'child-with-extra-root',
    family: 'correlated-family',
    unit: 'same-rgb',
    positive: 0.3,
    parentEventIds: ['correlated-parent', 'extra-prompt-root'],
  });
  const promptLaunderingBlocked = fuseEvidenceFamilies(
    [parent, extraPrompt, childWithExtraRoot],
    { expectedRevision: revision },
  );
  assert.ok(
    Math.abs(promptLaunderingBlocked.boundedSignedEvidence[0] - 0.3) < 1e-6,
  );
}

{
  const parent = membershipEvent({
    id: 'dag-parent',
    family: 'dag-family',
    unit: 'dag-unit',
    positive: 0.2,
  });
  const missing = membershipEvent({
    id: 'missing-child',
    family: 'dag-family',
    unit: 'dag-unit',
    positive: 0.2,
    parentEventIds: ['not-present'],
  });
  assert.throws(() => fuseEvidenceFamilies(
    [parent, missing],
    { expectedRevision: revision },
  ), /missing parent/);

  const forwardParent = membershipEvent({
    id: 'forward-parent',
    family: 'dag-family',
    unit: 'dag-unit',
    positive: 0.2,
    parentEventIds: ['forward-child'],
  });
  const forwardChild = membershipEvent({
    id: 'forward-child',
    family: 'dag-family',
    unit: 'dag-unit',
    positive: 0.2,
    parentEventIds: ['forward-parent'],
  });
  assert.throws(() => fuseEvidenceFamilies(
    [forwardParent, forwardChild],
    { expectedRevision: revision },
  ), /cycles and forward references/);

  const launderedFamily = membershipEvent({
    id: 'laundered-family',
    family: 'fake-independent-family',
    unit: 'dag-unit',
    positive: 0.8,
    parentEventIds: ['dag-parent'],
  });
  assert.throws(() => fuseEvidenceFamilies(
    [parent, launderedFamily],
    { expectedRevision: revision },
  ), /cannot launder/);

  const launderedUnit = membershipEvent({
    id: 'laundered-unit',
    family: 'dag-family',
    unit: 'fake-independent-unit',
    positive: 0.8,
    parentEventIds: ['dag-parent'],
  });
  assert.throws(() => fuseEvidenceFamilies(
    [parent, launderedUnit],
    { expectedRevision: revision },
  ), /without an explicit/);
}

{
  const hardInclude = membershipEvent({
    id: 'manual-include',
    family: 'manual',
    unit: 'manual-edit-1',
    positive: 1,
    semantics: 'hard-constraint',
  });
  const modelOpposition = membershipEvent({
    id: 'model-negative',
    family: 'model',
    unit: 'view-a',
    positive: 0,
    negative: 100,
  });
  const fused = fuseEvidenceFamilies(
    [hardInclude, modelOpposition],
    { expectedRevision: revision },
  );
  assert.equal(fused.decisions[0], 'included');
}

{
  const event = membershipEvent({
    id: 'unique-event',
    family: 'family',
    unit: 'unit',
  });
  assert.throws(() => fuseEvidenceFamilies(
    [event, event],
    { expectedRevision: revision },
  ), /Duplicate evidence event id/);
  assert.throws(() => fuseEvidenceFamilies([
    event,
    membershipEvent({
      id: 'stale-event',
      family: 'family',
      unit: 'unit-2',
      eventRevision: { ...revision, mask: revision.mask + 1 },
    }),
  ], { expectedRevision: revision }), /revision does not match/);
  assert.throws(
    () => fuseEvidenceFamilies([event]),
    /revision record/,
  );
  assert.throws(() => fuseEvidenceFamilies(
    [event],
    { expectedRevision: revision, maxPeakWorkingBytes: 1 },
  ), /peak working-memory budget/);
  assert.throws(() => fuseEvidenceFamilies(
    [
      event,
      membershipEvent({
        id: 'entry-budget-second',
        family: 'family-2',
        unit: 'unit-2',
      }),
    ],
    { expectedRevision: revision, maxSparseEntries: 1 },
  ), /sparse-entry budget/);
}

{
  const topology = retainSeedReachableComponent({
    nodeIds: Uint32Array.of(1, 2, 3, 4),
    candidateIds: new Set([1, 2, 3, 4]),
    seedIds: new Set([1]),
    pairwiseEdges: [
      { a: 1, b: 2, weight: 1 },
      { a: 3, b: 4, weight: 1 },
    ],
  });
  assert.deepEqual([...topology.retained].sort(), [1, 2]);
  assert.deepEqual([...topology.detached].sort(), [3, 4]);
  assert.ok(Number.isFinite(topology.diagnostics.elapsedMs));
}

{
  const cut = runBoundedBinaryGraphCut({
    nodeIds: Uint32Array.of(1, 2, 3),
    // Nodes 1/2 prefer foreground; 3 prefers background. Smoothness keeps
    // 1/2 together while preserving the real boundary to 3.
    foregroundCost: Float32Array.of(0.1, 0.2, 3),
    backgroundCost: Float32Array.of(3, 2, 0.1),
    pairwiseEdges: [
      { a: 1, b: 2, weight: 2 },
      { a: 2, b: 3, weight: 0.2 },
    ],
    hardIncludeIds: [1],
  });
  assert.deepEqual([...cut.includedIds], [1, 2]);
  assert.deepEqual([...cut.excludedIds], [3]);
  assert.ok(cut.cutCost < 1);
  assert.equal(cut.provenance.algorithm, 'bounded-dinic-reference-v1');
  assert.ok(Number.isFinite(cut.provenance.elapsedMs));
}

{
  const adversarial = runBoundedBinaryGraphCut({
    nodeIds: Uint32Array.of(99),
    // A fixed 1e9 hard terminal would lose to this 2e9 unary and violate the
    // include. The derived terminal must be greater than all finite energy.
    foregroundCost: Float32Array.of(2e9),
    backgroundCost: Float32Array.of(0),
    pairwiseEdges: [],
    hardIncludeIds: [99],
  });
  assert.deepEqual([...adversarial.includedIds], [99]);
  assert.ok(
    adversarial.provenance.hardConstraintCapacity
      > adversarial.provenance.totalFiniteEnergyUpperBound,
  );
  assert.ok(adversarial.provenance.hardConstraintCapacity > 2e9);
}

{
  const zeroEnergyHardInclude = runBoundedBinaryGraphCut({
    nodeIds: Uint32Array.of(1),
    foregroundCost: Float32Array.of(0),
    backgroundCost: Float32Array.of(0),
    pairwiseEdges: [],
    hardIncludeIds: [1],
  });
  assert.deepEqual([...zeroEnergyHardInclude.includedIds], [1]);
  assert.ok(zeroEnergyHardInclude.provenance.hardConstraintCapacity > 1e-12);
}

{
  assert.throws(() => runBoundedBinaryGraphCut({
    nodeIds: Uint32Array.of(1, 2),
    foregroundCost: Float32Array.of(0, 0),
    backgroundCost: Float32Array.of(0, 0),
    pairwiseEdges: [],
    limits: { maxNodes: 1 },
  }), GraphBudgetError);
}

{
  let clock = 0;
  assert.throws(() => runBoundedBinaryGraphCut({
    nodeIds: Uint32Array.of(1, 2),
    foregroundCost: Float32Array.of(0, 0),
    backgroundCost: Float32Array.of(1, 1),
    pairwiseEdges: [{ a: 1, b: 2, weight: 1 }],
    limits: { maxSolveMs: 5 },
    now: () => clock++,
  }), (error) =>
    error instanceof GraphBudgetError
    && /runtime budget/.test(error.message)
    && error.diagnostics.elapsedMs > 5);
}

{
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => runBoundedBinaryGraphCut({
    nodeIds: Uint32Array.of(1),
    foregroundCost: Float32Array.of(0),
    backgroundCost: Float32Array.of(1),
    pairwiseEdges: [],
    signal: controller.signal,
  }), (error) => error.name === 'AbortError');
}

{
  function* tooManyCandidates() {
    yield 1;
    yield 2;
    yield 3;
  }
  assert.throws(() => retainSeedReachableComponent({
    nodeIds: Uint32Array.of(1, 2),
    candidateIds: tooManyCandidates(),
    seedIds: [1],
    pairwiseEdges: [],
    limits: { maxNodes: 2 },
  }), /candidateIds exceeds its entry budget/);

  let clock = 0;
  assert.throws(() => retainSeedReachableComponent({
    nodeIds: Uint32Array.of(1),
    candidateIds: [1],
    seedIds: [1],
    pairwiseEdges: [],
    limits: { maxSolveMs: 2 },
    now: () => clock++,
  }), /runtime budget/);
}

{
  const hypotheses = [
    { id: 'small', area: 10, recommended: false },
    { id: 'middle', area: 40, recommended: true },
    { id: 'large', area: 100, recommended: false },
  ];
  const item = resolveScaleIntent({ intent: 'item', hypotheses });
  const region = resolveScaleIntent({ intent: 'region', hypotheses });
  const whole = resolveScaleIntent({ intent: 'whole', hypotheses });
  assert.equal(item.selected.id, 'small');
  assert.equal(region.selected.id, 'middle');
  assert.equal(whole.selected.id, 'large');
  assert.equal(item.approximation, true);
  assert.match(item.reason, /not a learned hierarchy/i);

  const learned = resolveScaleIntent({
    intent: 'whole',
    hypotheses: [
      {
        id: 'saga-whole',
        area: 90,
        intent: 'whole',
        hierarchyClaim: {
          providerId: 'saga',
          providerVersion: 'commit-123',
          validationId: 'scale-eval-v1',
          validationDataset: 'held-out-scales',
        },
        physicalScale: 2.4,
        providerRank: 0.9,
      },
    ],
    hierarchyAuthorities: [{
      providerId: 'saga',
      providerVersion: 'commit-123',
      validationId: 'scale-eval-v1',
      validationDataset: 'held-out-scales',
    }],
  });
  assert.equal(learned.direct, true);
  assert.equal(learned.approximation, false);
  assert.ok(Number.isFinite(learned.diagnostics.elapsedMs));

  const untrusted = resolveScaleIntent({
    intent: 'whole',
    hypotheses: [{
      id: 'untrusted-whole',
      area: 90,
      intent: 'whole',
      hierarchyClaim: {
        providerId: 'unknown',
        providerVersion: '1',
        validationId: 'self-asserted',
        validationDataset: 'none',
      },
      semanticHierarchyId: 'whole',
    }],
  });
  assert.equal(untrusted.direct, false);
  assert.equal(untrusted.approximation, true);
  assert.throws(() => resolveScaleIntent({
    intent: 'whole',
    hypotheses: [{
      id: 'legacy-claim',
      area: 90,
      intent: 'whole',
      hierarchyValidated: true,
      physicalScale: 2.4,
    }],
  }), /Caller-only hierarchyValidated flags/);

  const collisionClaim = {
    providerId: 'a',
    providerVersion: 'b\u001fc',
    validationId: 'd',
    validationDataset: 'e',
  };
  const collisionAuthority = {
    providerId: 'a\u001fb',
    providerVersion: 'c',
    validationId: 'd',
    validationDataset: 'e',
  };
  const collisionSafe = resolveScaleIntent({
    intent: 'whole',
    hypotheses: [{
      id: 'collision-claim',
      area: 90,
      intent: 'whole',
      hierarchyClaim: collisionClaim,
      physicalScale: 1,
    }],
    hierarchyAuthorities: [collisionAuthority],
  });
  assert.equal(collisionSafe.direct, false);
  assert.throws(() => resolveScaleIntent({
    intent: 'whole',
    hypotheses: [{
      id: 'bad-scale',
      area: 10,
      physicalScale: 0,
    }],
  }), /positive physicalScale/);
  assert.throws(() => resolveScaleIntent({
    intent: 'whole',
    hypotheses: [{
      id: 'bad-rank',
      area: 10,
      providerRank: Number.NaN,
    }],
  }), /finite providerRank/);
  assert.throws(() => resolveScaleIntent({
    intent: 'whole',
    hypotheses: [{ id: 'plain', area: 10 }],
    hierarchyAuthorities: [{
      providerId: ' ',
      providerVersion: '1',
      validationId: 'v',
      validationDataset: 'd',
    }],
  }), /needs providerId/);
}

{
  const planned = selectCausalEvidenceViews([
    {
      id: 'adjacent-bridge',
      expectedDisputedAlphaMass: 0.8,
      expectedUnknownAlphaMass: 0.2,
      expectedBoundaryAlphaMass: 0.4,
      expectedVisibleAlphaMass: 1,
      expectedNewObservationUnits: 0,
      correlationWithExisting: 0.92,
      seedConsistency: 0.98,
      estimatedMs: 80,
      estimatedBytes: 1_000,
    },
    {
      id: 'new-boundary-view',
      expectedDisputedAlphaMass: 0.7,
      expectedUnknownAlphaMass: 0.8,
      expectedBoundaryAlphaMass: 0.9,
      expectedVisibleAlphaMass: 1,
      expectedNewObservationUnits: 1,
      correlationWithExisting: 0.1,
      seedConsistency: 0.9,
      estimatedMs: 120,
      estimatedBytes: 2_000,
    },
    {
      id: 'drifted-view',
      expectedDisputedAlphaMass: 2,
      expectedUnknownAlphaMass: 2,
      expectedBoundaryAlphaMass: 2,
      expectedVisibleAlphaMass: 1,
      expectedNewObservationUnits: 1,
      correlationWithExisting: 0,
      seedConsistency: 0.2,
      estimatedMs: 100,
      estimatedBytes: 2_000,
    },
  ], {
    maxViews: 1,
    maxTotalMs: 500,
    maxTotalBytes: 10_000,
  });
  assert.equal(planned.selected.length, 1);
  assert.equal(planned.selected[0].id, 'new-boundary-view');
  assert.equal(
    planned.ranked.find((entry) => entry.id === 'drifted-view').reason,
    'seed-inconsistent',
  );
}

console.log('fusion evidence contracts: ok');
