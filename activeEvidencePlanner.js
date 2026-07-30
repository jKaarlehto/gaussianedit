/**
 * Experimental "causal disagreement frontier" view planner.
 *
 * This is a scoring surrogate, not a claim of information-theoretic optimality.
 * It selects preflight synthetic cameras expected to expose disputed/unknown
 * alpha mass while discounting causal correlation and bounded compute cost.
 * It must be benchmarked against a fixed orbit and SAGO-style prune-count NBV
 * before any product integration.
 */

export const DEFAULT_ACTIVE_VIEW_BUDGET = Object.freeze({
  maxViews: 8,
  maxTotalMs: 4_000,
  maxTotalBytes: 256 * 1024 * 1024,
  minSeedConsistency: 0.55,
  targetViewMs: 500,
  weights: Object.freeze({
    disputedMass: 1,
    unknownMass: 0.35,
    boundaryMass: 0.8,
    independentObservation: 0.45,
  }),
});

export function rankCausalEvidenceViews(candidates, options = {}) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('candidates must be an array.');
  }
  const budget = {
    ...DEFAULT_ACTIVE_VIEW_BUDGET,
    ...options,
    weights: {
      ...DEFAULT_ACTIVE_VIEW_BUDGET.weights,
      ...(options.weights ?? {}),
    },
  };
  const ranked = [];
  for (const candidate of candidates) {
    validateCandidate(candidate);
    if (
      candidate.unsafe
      || candidate.seedConsistency < budget.minSeedConsistency
      || candidate.estimatedMs > budget.maxTotalMs
      || candidate.estimatedBytes > budget.maxTotalBytes
    ) {
      ranked.push(Object.freeze({
        id: candidate.id,
        eligible: false,
        score: Number.NEGATIVE_INFINITY,
        reason: candidate.unsafe
          ? 'unsafe-pose'
          : candidate.seedConsistency < budget.minSeedConsistency
            ? 'seed-inconsistent'
            : 'single-view-budget',
        candidate,
      }));
      continue;
    }
    const evidenceGain =
      candidate.expectedDisputedAlphaMass * budget.weights.disputedMass
      + candidate.expectedUnknownAlphaMass * budget.weights.unknownMass
      + candidate.expectedBoundaryAlphaMass * budget.weights.boundaryMass
      + Math.min(1, candidate.expectedNewObservationUnits)
        * budget.weights.independentObservation;
    const causalNovelty = Math.max(0.05, 1 - candidate.correlationWithExisting);
    const reliability = candidate.seedConsistency
      * (candidate.expectedVisibleAlphaMass > 0 ? 1 : 0);
    const cost = 1
      + candidate.estimatedMs / Math.max(1, budget.targetViewMs)
      + candidate.estimatedBytes / Math.max(1, budget.maxTotalBytes);
    ranked.push(Object.freeze({
      id: candidate.id,
      eligible: true,
      score: evidenceGain * causalNovelty * reliability / cost,
      reason: 'causal-disagreement-surrogate',
      components: Object.freeze({
        evidenceGain,
        causalNovelty,
        reliability,
        cost,
      }),
      candidate,
    }));
  }
  ranked.sort((a, b) =>
    b.score - a.score || a.candidate.estimatedMs - b.candidate.estimatedMs
    || a.id.localeCompare(b.id));
  return Object.freeze(ranked);
}

export function selectCausalEvidenceViews(candidates, options = {}) {
  const budget = { ...DEFAULT_ACTIVE_VIEW_BUDGET, ...options };
  const ranked = rankCausalEvidenceViews(candidates, options);
  const selected = [];
  let totalMs = 0;
  let totalBytes = 0;
  for (const entry of ranked) {
    if (!entry.eligible || selected.length >= budget.maxViews) continue;
    const nextMs = totalMs + entry.candidate.estimatedMs;
    const nextBytes = totalBytes + entry.candidate.estimatedBytes;
    if (nextMs > budget.maxTotalMs || nextBytes > budget.maxTotalBytes) continue;
    selected.push(entry);
    totalMs = nextMs;
    totalBytes = nextBytes;
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    ranked,
    diagnostics: Object.freeze({
      selectedViews: selected.length,
      totalEstimatedMs: totalMs,
      totalEstimatedBytes: totalBytes,
      hypothesis: 'causal-disagreement-frontier-v0',
    }),
  });
}

function validateCandidate(candidate) {
  if (!candidate?.id) throw new TypeError('Candidate view needs an id.');
  for (const key of [
    'expectedDisputedAlphaMass',
    'expectedUnknownAlphaMass',
    'expectedBoundaryAlphaMass',
    'expectedVisibleAlphaMass',
    'expectedNewObservationUnits',
    'correlationWithExisting',
    'seedConsistency',
    'estimatedMs',
    'estimatedBytes',
  ]) {
    if (!Number.isFinite(candidate[key]) || candidate[key] < 0) {
      throw new TypeError(`Candidate ${candidate.id} needs non-negative ${key}.`);
    }
  }
  if (candidate.correlationWithExisting > 1 || candidate.seedConsistency > 1) {
    throw new RangeError('Correlation and seed consistency must be within [0, 1].');
  }
}
