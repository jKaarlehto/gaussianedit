const DEFAULT_ENDPOINT = '/api/orchestration/board-action';
const MAX_ID_LENGTH = 80;
const MAX_COMMENT_LENGTH = 240;

function boundedText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function allowedEndpoint(value) {
  const endpoint = String(value ?? DEFAULT_ENDPOINT).trim();
  return endpoint === DEFAULT_ENDPOINT ? endpoint : DEFAULT_ENDPOINT;
}

export function createFeedbackIdempotencyKey(candidateId, itemId, decision) {
  return `candidate-feedback:${encodeURIComponent(candidateId)}:${encodeURIComponent(itemId)}:${decision}`;
}

export function normalizeCandidateFeedback(input = {}) {
  const candidateId = boundedText(input.candidateId, MAX_ID_LENGTH);
  const itemId = boundedText(input.itemId, MAX_ID_LENGTH);
  const decision = String(input.decision ?? '').toLowerCase();
  const comment = boundedText(input.comment, MAX_COMMENT_LENGTH);
  if (!candidateId || !itemId || (decision !== 'ok' && decision !== 'issue')) {
    throw new Error('Choose Looks good or Back to loop for a valid candidate item.');
  }
  if (decision === 'issue' && !comment) {
    throw new Error('Back to loop needs a short comment.');
  }
  return {
    candidateId,
    itemId,
    decision,
    comment,
    idempotencyKey: createFeedbackIdempotencyKey(candidateId, itemId, decision),
  };
}

export function createCandidateFeedbackBridge({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
} = {}) {
  const safeEndpoint = allowedEndpoint(endpoint);

  async function submit(input) {
    const feedback = normalizeCandidateFeedback(input);
    if (typeof fetchImpl !== 'function') {
      throw new Error('Feedback import is unavailable. Keep this item pending and try again.');
    }
    let response;
    try {
      response = await fetchImpl(safeEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedback),
      });
    } catch {
      throw new Error('Feedback was not imported. Keep this item pending and try again.');
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON acknowledgement is never evidence of durable import.
    }
    if (!response.ok || body?.imported !== true) {
      throw new Error(boundedText(body?.error, 180)
        || 'Feedback was not imported. Keep this item pending and try again.');
    }
    return feedback;
  }

  return { endpoint: safeEndpoint, submit };
}
