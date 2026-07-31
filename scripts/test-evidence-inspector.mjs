import assert from 'node:assert/strict';

import {
  EvidenceInspectorBudgetError,
  INSPECT_EVIDENCE_DEFAULT,
  createEvidenceInspection,
  createEvidencePreviewPlan,
  expandEvidenceCohort,
} from '../evidenceInspector.js';

assert.equal(INSPECT_EVIDENCE_DEFAULT, false);

const revision = Object.freeze({
  scene: 1,
  view: 2,
  selection: 3,
  mask: 4,
  scan: 5,
});
const familyCatalog = [
  {
    familyId: 'visible-frame',
    passKey: 'visible-selection',
    label: 'Visible selection',
    eventIds: ['visible-mask', 'visible-lift'],
  },
  {
    familyId: 'tracked-left',
    passKey: 'hidden-side-tracking',
    label: 'Hidden-side tracking',
    eventIds: ['track-left'],
    adjustable: true,
    parameterSchemaId: 'tracking-v1',
  },
  {
    familyId: 'tracked-right',
    passKey: 'hidden-side-tracking',
    label: 'Hidden-side tracking',
    eventIds: ['track-right'],
    adjustable: true,
    parameterSchemaId: 'tracking-v1',
  },
  {
    familyId: 'bridge',
    passKey: 'bridge-growth',
    label: 'Gap fill',
    eventIds: ['bridge-1'],
  },
];
const gaussianIds = Uint32Array.of(10, 11, 12, 13, 14, 15);
const decisions = [
  'included',
  'included',
  'included',
  'included',
  'disputed',
  'included',
];
const provenance = [
  gaussianProvenance([family('visible-frame', 0.8)]),
  gaussianProvenance([family('visible-frame', 0.7), family('tracked-left', 0.6)]),
  gaussianProvenance([family('visible-frame', 0.7), family('tracked-right', 0.5)]),
  gaussianProvenance([family('tracked-left', 0.7)]),
  gaussianProvenance([family('bridge', 0.1)], { hardIncludeEventIds: ['manual-1'] }),
  gaussianProvenance([
    family('visible-frame', 0.7),
    family('tracked-left', 0.5),
    family('bridge', 0.2),
  ]),
];

const snapshot = createEvidenceInspection({
  revision,
  gaussianIds,
  decisions,
  provenance,
  familyCatalog,
  alphaMass: Float32Array.of(2, 1, 1, 0.5, 0.1, 0.3),
});

assert.equal(snapshot.diagnostics.productPasses, 4);
assert.equal(snapshot.diagnostics.observedCohorts, 5);
assert.equal(
  snapshot.cohorts.filter((cohort) =>
    cohort.supportPassKeys.length === 2
    &&
    cohort.supportPassKeys.includes('visible-selection')
    && cohort.supportPassKeys.includes('hidden-side-tracking')).length,
  1,
  'independent tracking families normalize into one product-pass signature',
);
assert.ok(
  snapshot.cohorts.some((cohort) => cohort.supportPassKeys.length === 3),
  'an observed three-pass cohort is materialized without power-set enumeration',
);

const trackingPass = snapshot.passes.find(
  (pass) => pass.passKey === 'hidden-side-tracking',
);
assert.deepEqual([...trackingPass.memberIds], [11, 12, 13, 15]);
assert.deepEqual(
  trackingPass.causalFamilyIds,
  ['tracked-left', 'tracked-right'],
  'product grouping retains the underlying independent causal families',
);

const jointCohort = snapshot.cohorts.find((cohort) =>
  cohort.supportPassKeys.length === 2
  && cohort.supportPassKeys.includes('visible-selection')
  && cohort.supportPassKeys.includes('hidden-side-tracking'));
assert.deepEqual([...jointCohort.memberIds], [11, 12]);

const expanded = expandEvidenceCohort(snapshot, jointCohort.id, {
  from: Uint32Array.of(11, 12, 11),
  to: Uint32Array.of(12, 99, 99),
});
assert.equal(expanded.parts.length, 1);
assert.deepEqual([...expanded.parts[0].memberIds], [11, 12]);

const trackingOff = createEvidencePreviewPlan(snapshot, {
  kind: 'pass',
  passKey: 'hidden-side-tracking',
  enabled: false,
});
assert.deepEqual(trackingOff.baseRevision, revision);
assert.deepEqual(trackingOff.disabledPassKeys, ['hidden-side-tracking']);
assert.deepEqual([...trackingOff.roiIds], [11, 12, 13, 15]);
assert.equal(trackingOff.requiresRoiRecompute, true);
assert.equal(trackingOff.mutatesObject, false);

const tuned = createEvidencePreviewPlan(snapshot, {
  kind: 'pass',
  passKey: 'hidden-side-tracking',
  parameterPatch: { minimumViews: 3 },
});
assert.equal(tuned.operation, 'parameter-preview');
assert.deepEqual(tuned.parameterOverrides, {
  'hidden-side-tracking': { minimumViews: 3 },
});

assert.throws(() => createEvidenceInspection({
  revision,
  gaussianIds: Uint32Array.of(1),
  decisions: ['included'],
  provenance: [gaussianProvenance([family('unknown-family', 1)])],
  familyCatalog,
}), /Missing family catalog entry/);

assert.throws(() => createEvidenceInspection({
  revision,
  gaussianIds: Uint32Array.of(1, 2, 3),
  decisions: ['included', 'included', 'included'],
  provenance: [
    gaussianProvenance([family('visible-frame', 1)]),
    gaussianProvenance([family('tracked-left', 1)]),
    gaussianProvenance([family('bridge', 1)]),
  ],
  familyCatalog,
}, {
  maxObservedCohorts: 2,
}), EvidenceInspectorBudgetError);

const cancelled = new AbortController();
cancelled.abort();
assert.throws(() => createEvidenceInspection({
  revision,
  gaussianIds: Uint32Array.of(1),
  decisions: ['included'],
  provenance: [gaussianProvenance([family('visible-frame', 1)])],
  familyCatalog,
}, {
  signal: cancelled.signal,
  cancellationCheckStride: 1,
}), { name: 'AbortError' });

console.log('evidence inspector contracts: ok');

function family(familyId, contribution) {
  return { familyId, contribution, observationUnits: 1 };
}

function gaussianProvenance(families, overrides = {}) {
  return {
    eventIds: [],
    hardIncludeEventIds: [],
    hardExcludeEventIds: [],
    hardConflict: false,
    independentCausalFamilies: families.length,
    families,
    ...overrides,
  };
}
