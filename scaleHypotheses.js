/**
 * Honest Item / Region / Whole intent resolution.
 *
 * Area-ordered prompt-mask alternatives are approximations. Only a provider
 * explicitly validated for physical or semantic hierarchy may claim a direct
 * intent match.
 */

export const SCALE_INTENTS = Object.freeze(['item', 'region', 'whole']);

export function resolveScaleIntent({
  intent,
  hypotheses,
  prompt = null,
  hierarchyAuthorities = [],
  now = defaultNow,
}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const startedAt = now();
  if (!SCALE_INTENTS.includes(intent)) {
    throw new TypeError(`Unsupported scale intent: ${intent}`);
  }
  if (!Array.isArray(hypotheses) || !hypotheses.length) {
    throw new TypeError('At least one scale hypothesis is required.');
  }
  if (hypotheses.length > 128) {
    throw new RangeError('Scale hypotheses exceed the 128-entry reference budget.');
  }
  const usable = hypotheses
    .map((hypothesis, index) => validateHypothesis(hypothesis, index))
    .filter((hypothesis) => hypothesis.containsPrompt !== false);
  if (!usable.length) {
    return Object.freeze({
      intent,
      selected: null,
      direct: false,
      approximation: true,
      reason: 'No hypothesis contains the prompt.',
      alternatives: Object.freeze([]),
      diagnostics: Object.freeze({ elapsedMs: elapsedSince(startedAt, now) }),
    });
  }

  const trustedAuthorities = validateHierarchyAuthorities(hierarchyAuthorities);
  const direct = usable.filter((hypothesis) =>
    hierarchyClaimIsAuthorized(hypothesis.hierarchyClaim, trustedAuthorities)
    && hypothesis.intent === intent
    && (hypothesis.physicalScale != null || hypothesis.semanticHierarchyId));
  if (direct.length) {
    direct.sort((a, b) => b.providerRank - a.providerRank);
    return result(
      intent,
      direct[0],
      usable,
      true,
      'validated hierarchy provider',
      elapsedSince(startedAt, now),
    );
  }

  const ordered = [...usable].sort((a, b) =>
    a.area - b.area || b.providerRank - a.providerRank || a.id.localeCompare(b.id));
  let selected;
  if (intent === 'item') selected = ordered[0];
  else if (intent === 'whole') selected = ordered[ordered.length - 1];
  else {
    const recommended = ordered.filter((hypothesis) => hypothesis.recommended);
    selected = recommended[0] ?? ordered[Math.floor((ordered.length - 1) / 2)];
  }
  return result(
    intent,
    selected,
    ordered,
    false,
    prompt
      ? `Area-ordered alternatives around prompt ${prompt}; not a learned hierarchy.`
      : 'Area-ordered alternatives; not a learned hierarchy.',
    elapsedSince(startedAt, now),
  );
}

function validateHypothesis(hypothesis, index) {
  if (!isNonemptyString(hypothesis?.id)) {
    throw new TypeError(`Hypothesis ${index} needs a non-empty id.`);
  }
  if (!Number.isFinite(hypothesis.area) || hypothesis.area <= 0) {
    throw new TypeError(`Hypothesis ${hypothesis.id} needs positive area.`);
  }
  if (hypothesis.hierarchyClaim && !SCALE_INTENTS.includes(hypothesis.intent)) {
    throw new TypeError(
      `Hierarchy hypothesis ${hypothesis.id} needs an explicit scale intent.`,
    );
  }
  if (hypothesis.hierarchyValidated != null) {
    throw new TypeError(
      'Caller-only hierarchyValidated flags are not accepted; provide a hierarchyClaim '
      + 'and a separately configured hierarchy authority.',
    );
  }
  if (hypothesis.hierarchyClaim) validateHierarchyClaim(hypothesis.hierarchyClaim);
  if (!Number.isFinite(hypothesis.providerRank ?? 0)) {
    throw new TypeError(`Hypothesis ${hypothesis.id} needs finite providerRank.`);
  }
  if (
    hypothesis.physicalScale != null
    && (!Number.isFinite(hypothesis.physicalScale) || hypothesis.physicalScale <= 0)
  ) {
    throw new TypeError(`Hypothesis ${hypothesis.id} needs positive physicalScale.`);
  }
  if (
    hypothesis.semanticHierarchyId != null
    && !isNonemptyString(hypothesis.semanticHierarchyId)
  ) {
    throw new TypeError(
      `Hypothesis ${hypothesis.id} needs a non-empty semanticHierarchyId.`,
    );
  }
  return Object.freeze({
    providerRank: 0,
    recommended: false,
    containsPrompt: true,
    ...hypothesis,
  });
}

function validateHierarchyAuthorities(authorities) {
  if (!Array.isArray(authorities)) {
    throw new TypeError('hierarchyAuthorities must be an array.');
  }
  if (authorities.length > 128) {
    throw new RangeError('Hierarchy authorities exceed the 128-entry reference budget.');
  }
  const trusted = [];
  for (const [index, authority] of authorities.entries()) {
    if (!hasAuthorityTuple(authority)) {
      throw new TypeError(
        `Hierarchy authority ${index} needs providerId, providerVersion, `
        + 'validationId, and validationDataset.',
      );
    }
    trusted.push(Object.freeze({
      providerId: authority.providerId,
      providerVersion: authority.providerVersion,
      validationId: authority.validationId,
      validationDataset: authority.validationDataset,
    }));
  }
  return Object.freeze(trusted);
}

function validateHierarchyClaim(claim) {
  if (!hasAuthorityTuple(claim)) {
    throw new TypeError(
      'hierarchyClaim needs providerId, providerVersion, validationId, '
      + 'and validationDataset.',
    );
  }
}

function hierarchyClaimIsAuthorized(claim, trustedAuthorities) {
  if (!claim) return false;
  return trustedAuthorities.some((authority) =>
    authority.providerId === claim.providerId
    && authority.providerVersion === claim.providerVersion
    && authority.validationId === claim.validationId
    && authority.validationDataset === claim.validationDataset);
}

function hasAuthorityTuple(value) {
  return value != null
    && isNonemptyString(value.providerId)
    && isNonemptyString(value.providerVersion)
    && isNonemptyString(value.validationId)
    && isNonemptyString(value.validationDataset);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function elapsedSince(startedAt, now) {
  const elapsedMs = now() - startedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError('Scale resolver clock must be finite and monotonic.');
  }
  return elapsedMs;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function result(intent, selected, alternatives, direct, reason, elapsedMs) {
  return Object.freeze({
    intent,
    selected,
    direct,
    approximation: !direct,
    reason,
    alternatives: Object.freeze([...alternatives]),
    diagnostics: Object.freeze({ elapsedMs }),
  });
}
