import { createCandidateFeedbackBridge } from './candidateFeedback.js';

const STORAGE_PREFIX = 'gaussianedit.candidateReview.v1';
const COMMENT_LIMIT = 240;

export function normalizeReviewItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const id = String(item?.id ?? '').trim().slice(0, 80);
    const label = String(item?.label ?? '').trim().slice(0, 180);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const taskId = String(item?.taskId ?? '').trim().slice(0, 80);
    const owner = String(item?.owner ?? '').trim().slice(0, 80);
    const workspace = String(item?.workspace ?? '').trim().slice(0, 80);
    if (!taskId || !owner || !workspace) continue;
    normalized.push({ id, label, taskId, owner, workspace });
  }
  return normalized;
}

export function reviewStorageKey(releaseId, itemId) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(String(releaseId))}:${encodeURIComponent(String(itemId))}`;
}

export function reviewReleaseForNotice(loadedRelease, displayedRelease, isUpdate) {
  return isUpdate ? loadedRelease : displayedRelease;
}

export function classifyReviewState(state) {
  const explicit = String(state?.status ?? '').toLowerCase();
  if (explicit === 'ok') return { key: 'ok', label: 'OK' };
  if (explicit === 'issue') return { key: 'issue', label: 'Issue' };
  if (explicit === 'pending') return { key: 'pending', label: 'Pending' };
  // Preserve v1 checkbox decisions without treating a free-form note as a
  // second status or trying to infer whether its wording is positive/negative.
  if (state?.ok === true) return { key: 'ok', label: 'OK' };
  return { key: 'pending', label: 'Pending' };
}

export function formatReviewReport(release, states = new Map()) {
  const items = normalizeReviewItems(release?.reviewItems);
  const lines = [`Candidate feedback · ${String(release?.id || 'unknown')}`];
  for (const item of items) {
    const state = states.get(item.id) ?? {};
    const status = classifyReviewState(state).label.toUpperCase();
    const comment = String(state.comment ?? '').trim();
    lines.push(`- ${status} · ${item.label}`);
    if (comment) lines.push(`  Note: ${comment}`);
  }
  return lines.join('\n');
}

export function createCandidateReviewInbox({
  host,
  before = null,
  storage = safeLocalStorage(),
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
  feedbackBridge = createCandidateFeedbackBridge(),
} = {}) {
  if (!host || !documentRef) {
    throw new Error('Candidate review inbox requires a host and document.');
  }
  ensureStyles(documentRef);
  const root = documentRef.createElement('section');
  root.className = 'candidate-review-inbox';
  root.hidden = true;
  host.insertBefore(root, before);

  let currentRelease = null;
  let currentItems = [];
  let states = new Map();

  function loadState(releaseId, itemId) {
    try {
      const parsed = JSON.parse(storage?.getItem(reviewStorageKey(releaseId, itemId)) || 'null');
      return {
        status: classifyReviewState(parsed).key,
        comment: String(parsed?.comment ?? '').slice(0, COMMENT_LIMIT),
      };
    } catch {
      return { status: 'pending', comment: '' };
    }
  }

  function saveState(itemId, state) {
    states.set(itemId, state);
    try {
      storage?.setItem(
        reviewStorageKey(currentRelease.id, itemId),
        JSON.stringify(state),
      );
    } catch {
      // Private browsing or a full storage quota must not break the banner.
    }
  }

  function updateSummary(summary) {
    const values = [...states.values()];
    const counts = { pending: 0, ok: 0, issue: 0 };
    for (const state of values) counts[classifyReviewState(state).key]++;
    const notes = values.filter((state) => String(state.comment).trim()).length;
    summary.textContent =
      `${counts.ok} accepted · ${counts.issue} issues · ${counts.pending} waiting · ${notes} notes`;
  }

  function render(release) {
    currentRelease = release;
    currentItems = normalizeReviewItems(release?.reviewItems);
    states = new Map();
    root.replaceChildren();
    root.hidden = currentItems.length === 0;
    if (!currentItems.length) {
      delete root.dataset.releaseId;
      return;
    }
    root.dataset.releaseId = String(release.id);

    const heading = documentRef.createElement('div');
    heading.className = 'candidate-review-heading';
    const title = documentRef.createElement('b');
    title.textContent = `Acceptance testing · ${release.id}`;
    const summary = documentRef.createElement('span');
    heading.append(title, summary);
    root.append(heading);

    for (const item of currentItems) {
      const state = loadState(release.id, item.id);
      states.set(item.id, state);
      const row = documentRef.createElement('div');
      row.className = 'candidate-review-item';
      row.dataset.itemId = item.id;

      const itemLabel = documentRef.createElement('b');
      itemLabel.textContent = item.label;

      const comment = documentRef.createElement('input');
      comment.type = 'text';
      comment.className = 'candidate-review-comment';
      comment.maxLength = COMMENT_LIMIT;
      comment.placeholder = 'Optional note';
      comment.value = state.comment;
      comment.setAttribute('aria-label', `Note for ${item.label}`);

      const refresh = (status = state.status) => {
        const next = {
          status: classifyReviewState({ status }).key,
          comment: comment.value.slice(0, COMMENT_LIMIT),
        };
        const classification = classifyReviewState(next);
        row.dataset.state = classification.key;
        saveState(item.id, next);
        updateSummary(summary);
      };
      comment.addEventListener('input', () => refresh());

      const actions = documentRef.createElement('div');
      actions.className = 'candidate-review-decision';
      const submitDecision = async (decision) => {
        if (!feedbackBridge?.submit) {
          failure.textContent = 'Feedback import is unavailable. This item remains pending.';
          failure.hidden = false;
          return;
        }
        const button = decision === 'ok' ? good : loop;
        button.disabled = true;
        failure.hidden = true;
        try {
          await feedbackBridge.submit({
            candidateId: release.id,
            itemId: item.id,
            taskId: item.taskId,
            owner: item.owner,
            workspace: item.workspace,
            decision,
            comment: comment.value,
          });
          states.delete(item.id);
          try {
            storage?.removeItem(reviewStorageKey(release.id, item.id));
          } catch {
            // The durable import succeeded; stale browser storage cannot block it.
          }
          row.remove();
          updateSummary(summary);
          if (!root.querySelector?.('.candidate-review-item')) root.hidden = true;
        } catch (error) {
          failure.textContent = error instanceof Error ? error.message : 'Feedback import failed.';
          failure.hidden = false;
          button.disabled = false;
        }
      };
      const good = documentRef.createElement('button');
      good.type = 'button';
      good.textContent = 'Looks good';
      good.addEventListener('click', () => submitDecision('ok'));
      const loop = documentRef.createElement('button');
      loop.type = 'button';
      loop.textContent = 'Back to loop';
      loop.addEventListener('click', () => submitDecision('issue'));
      const failure = documentRef.createElement('span');
      failure.className = 'candidate-review-failure';
      failure.hidden = true;
      actions.append(good, loop);
      row.append(itemLabel, actions, comment, failure);
      root.append(row);
      const classification = classifyReviewState(state);
      row.dataset.state = classification.key;
    }

    const actions = documentRef.createElement('div');
    actions.className = 'candidate-review-actions';
    const copy = documentRef.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy feedback';
    copy.addEventListener('click', async () => {
      const copied = await copyText(
        formatReviewReport(currentRelease, states),
        clipboard,
        documentRef,
      );
      copy.textContent = copied ? 'Copied' : 'Select report';
      if (!copied) {
        const report = documentRef.createElement('textarea');
        report.readOnly = true;
        report.value = formatReviewReport(currentRelease, states);
        report.setAttribute('aria-label', 'Candidate feedback report');
        actions.append(report);
        report.select?.();
      }
    });
    actions.append(copy);
    root.append(actions);
    updateSummary(summary);
  }

  return {
    render,
    get report() {
      return formatReviewReport(currentRelease, states);
    },
    destroy() {
      root.remove();
    },
  };
}

async function copyText(text, clipboard, documentRef) {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the synchronous, user-gesture clipboard path.
    }
  }
  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  documentRef.body.append(textarea);
  textarea.select?.();
  let copied = false;
  try {
    copied = Boolean(documentRef.execCommand?.('copy'));
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function ensureStyles(documentRef) {
  if (documentRef.querySelector?.('[data-candidate-review-styles]')) return;
  const style = documentRef.createElement('style');
  style.dataset.candidateReviewStyles = '';
  style.textContent = `
    .candidate-review-inbox { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--line); }
    .candidate-review-heading { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .candidate-review-heading b { color: #a9f6ff; text-transform: uppercase; letter-spacing: .06em; }
    .candidate-review-heading span { color: #71808c; }
    .candidate-review-item { display: grid; grid-template-columns: minmax(0, 1fr) 144px 150px; gap: 6px; align-items: start; padding: 4px 0; }
    .candidate-review-item > b {
      color: #aeb8c1; font-weight: 400; line-height: 1.35;
      overflow-wrap: anywhere; text-overflow: clip; white-space: normal;
    }
    .candidate-review-decision { display: flex; gap: 4px; }
    .candidate-review-decision button { flex: 1; min-width: 0; }
    .candidate-review-comment, .candidate-review-actions textarea {
      box-sizing: border-box; width: 100%; min-width: 0; padding: 3px 5px;
      border: 1px solid var(--line); background: rgba(0, 0, 0, .18); color: var(--ink);
      font: 8px var(--mono);
    }
    .candidate-review-actions { display: flex; justify-content: flex-end; margin-top: 6px; }
    .candidate-review-actions textarea { min-height: 52px; margin-left: 6px; resize: vertical; }
    .candidate-review-failure { grid-column: 1 / -1; color: #ef6b73; font: 8px var(--mono); }
    @media (max-width: 760px) {
      .candidate-review-item { grid-template-columns: 1fr 144px; }
      .candidate-review-comment { grid-column: 1 / -1; }
    }
  `;
  (documentRef.head || documentRef.body).append(style);
}
