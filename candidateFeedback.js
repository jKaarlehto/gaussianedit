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
  return `candidate-feedback:${candidateId}:${itemId}:${decision}`
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 128);
}

export function normalizeCandidateFeedback(input = {}) {
  const candidateId = boundedText(input.candidateId, MAX_ID_LENGTH);
  const itemId = boundedText(input.itemId, MAX_ID_LENGTH);
  const taskId = boundedText(input.taskId, MAX_ID_LENGTH);
  const owner = boundedText(input.owner, MAX_ID_LENGTH);
  const workspace = boundedText(input.workspace, MAX_ID_LENGTH);
  const decision = String(input.decision ?? '').toLowerCase();
  const comment = boundedText(input.comment, MAX_COMMENT_LENGTH);
  if (!candidateId || !itemId || !taskId || !owner || !workspace
    || (decision !== 'ok' && decision !== 'issue')) {
    throw new Error('Choose Looks good or Back to loop for a valid candidate item.');
  }
  if (decision === 'issue' && !comment) {
    throw new Error('Back to loop needs a short comment.');
  }
  return {
    candidateId,
    itemId,
    taskId,
    owner,
    workspace,
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
        body: JSON.stringify({
          taskId: feedback.taskId,
          action: feedback.decision === 'ok' ? 'looks_good' : 'back_to_loop',
          note: feedback.comment,
          idempotencyKey: feedback.idempotencyKey,
          candidateId: feedback.candidateId,
          itemId: feedback.itemId,
          owner: feedback.owner,
          workspace: feedback.workspace,
        }),
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
    const expectedAction = feedback.decision === 'ok' ? 'looks_good' : 'back_to_loop';
    if (!response.ok || body?.taskId !== feedback.taskId || body?.action !== expectedAction) {
      throw new Error(boundedText(body?.error, 180)
        || 'Feedback was not imported. Keep this item pending and try again.');
    }
    return feedback;
  }

  return { endpoint: safeEndpoint, submit };
}
