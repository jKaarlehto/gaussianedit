const REVISION_FIELDS = [
  'frameId',
  'frameRevision',
  'sceneRevision',
  'maskRevision',
  'selectionRevision',
  'requestToken',
  'selectionCount',
];

export function createVisibleObjectGate() {
  return Object.freeze({
    candidate: null,
    confirmed: null,
    started: null,
  });
}

export function createVisibleObjectRevision(values) {
  const revision = {};
  for (const field of REVISION_FIELDS) {
    const value = values?.[field];
    if (field === 'frameId') {
      if (!value) throw new TypeError('frameId is required');
      revision[field] = String(value);
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a non-negative safe integer`);
    }
    revision[field] = value;
  }
  revision.key = REVISION_FIELDS.map((field) => revision[field]).join(':');
  return Object.freeze(revision);
}

export function publishVisibleObjectCandidate(gate, revision) {
  if (gate?.candidate?.key === revision.key) return gate;
  return Object.freeze({
    candidate: revision,
    confirmed: null,
    started: null,
  });
}

export function invalidateVisibleObjectGate() {
  return createVisibleObjectGate();
}

export function confirmVisibleObject(gate, revision) {
  if (!gate?.candidate || gate.candidate.key !== revision?.key) {
    return Object.freeze({ accepted: false, gate });
  }
  return Object.freeze({
    accepted: true,
    gate: Object.freeze({
      ...gate,
      confirmed: revision,
    }),
  });
}

export function isVisibleObjectConfirmed(gate, revision) {
  return Boolean(
    gate?.candidate?.key === revision?.key
    && gate?.confirmed?.key === revision.key,
  );
}

export function consumeVisibleObjectStart(gate, revision) {
  if (!isVisibleObjectConfirmed(gate, revision) || gate.started) {
    return Object.freeze({ started: false, gate });
  }
  return Object.freeze({
    started: true,
    gate: Object.freeze({
      ...gate,
      started: revision,
    }),
  });
}

export function resetVisibleObjectStart(gate, revision) {
  if (!isVisibleObjectConfirmed(gate, revision)) return gate;
  return Object.freeze({
    ...gate,
    started: null,
  });
}
