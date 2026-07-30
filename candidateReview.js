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
    normalized.push({ id, label });
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
  const ok = Boolean(state?.ok);
  const commented = Boolean(String(state?.comment ?? '').trim());
  if (ok && commented) return { key: 'ok-commented', label: 'OK · commented' };
  if (ok) return { key: 'ok', label: 'OK' };
  if (commented) return { key: 'commented', label: 'Commented' };
  return { key: 'pending', label: 'Pending' };
}

export function formatReviewReport(release, states = new Map()) {
  const items = normalizeReviewItems(release?.reviewItems);
  const lines = [`Candidate feedback · ${String(release?.id || 'unknown')}`];
  for (const item of items) {
    const state = states.get(item.id) ?? {};
    const status = classifyReviewState(state).label.toUpperCase();
    const comment = String(state.comment ?? '').trim();
    lines.push(`- ${status} · ${item.label}${comment ? ` — ${comment}` : ''}`);
  }
  return lines.join('\n');
}

export function createCandidateReviewInbox({
  host,
  before = null,
  storage = safeLocalStorage(),
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
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
        ok: Boolean(parsed?.ok),
        comment: String(parsed?.comment ?? '').slice(0, COMMENT_LIMIT),
      };
    } catch {
      return { ok: false, comment: '' };
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
    const ok = values.filter((state) => state.ok).length;
    const commented = values.filter((state) => String(state.comment).trim()).length;
    summary.textContent = `${ok}/${currentItems.length} OK · ${commented} commented`;
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
    title.textContent = `Loaded build checks · ${release.id}`;
    const summary = documentRef.createElement('span');
    heading.append(title, summary);
    root.append(heading);

    for (const item of currentItems) {
      const state = loadState(release.id, item.id);
      states.set(item.id, state);
      const row = documentRef.createElement('div');
      row.className = 'candidate-review-item';
      row.dataset.itemId = item.id;

      const checkLabel = documentRef.createElement('label');
      const checkbox = documentRef.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.ok;
      checkbox.setAttribute('aria-label', `Mark ${item.label} OK`);
      const okText = documentRef.createElement('span');
      okText.textContent = 'OK';
      const itemLabel = documentRef.createElement('b');
      itemLabel.textContent = item.label;
      checkLabel.append(checkbox, okText, itemLabel);

      const comment = documentRef.createElement('input');
      comment.type = 'text';
      comment.className = 'candidate-review-comment';
      comment.maxLength = COMMENT_LIMIT;
      comment.placeholder = 'Short comment';
      comment.value = state.comment;
      comment.setAttribute('aria-label', `Comment on ${item.label}`);

      const status = documentRef.createElement('span');
      status.className = 'candidate-review-state';

      const refresh = () => {
        const next = {
          ok: checkbox.checked,
          comment: comment.value.slice(0, COMMENT_LIMIT),
        };
        const classification = classifyReviewState(next);
        row.dataset.state = classification.key;
        status.textContent = classification.label;
        saveState(item.id, next);
        updateSummary(summary);
      };
      checkbox.addEventListener('change', refresh);
      comment.addEventListener('input', refresh);
      row.append(checkLabel, comment, status);
      root.append(row);
      const classification = classifyReviewState(state);
      row.dataset.state = classification.key;
      status.textContent = classification.label;
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
    .candidate-review-item { display: grid; grid-template-columns: minmax(0, 1fr) 150px auto; gap: 6px; align-items: start; padding: 4px 0; }
    .candidate-review-item label { justify-content: flex-start; align-items: flex-start; min-width: 0; margin: 0; }
    .candidate-review-item label b {
      color: #aeb8c1; font-weight: 400; line-height: 1.35;
      overflow-wrap: anywhere; text-overflow: clip; white-space: normal;
    }
    .candidate-review-item input[type="checkbox"] { accent-color: #70d7ff; }
    .candidate-review-comment, .candidate-review-actions textarea {
      box-sizing: border-box; width: 100%; min-width: 0; padding: 3px 5px;
      border: 1px solid var(--line); background: rgba(0, 0, 0, .18); color: var(--ink);
      font: 8px var(--mono);
    }
    .candidate-review-state { min-width: 66px; color: #66737e; text-align: right; }
    .candidate-review-item[data-state="ok"] .candidate-review-state,
    .candidate-review-item[data-state="ok-commented"] .candidate-review-state { color: var(--ok); }
    .candidate-review-item[data-state="commented"] .candidate-review-state { color: #efc45d; }
    .candidate-review-actions { display: flex; justify-content: flex-end; margin-top: 6px; }
    .candidate-review-actions textarea { min-height: 52px; margin-left: 6px; resize: vertical; }
    @media (max-width: 760px) {
      .candidate-review-item { grid-template-columns: 1fr auto; }
      .candidate-review-comment { grid-column: 1 / -1; }
    }
  `;
  (documentRef.head || documentRef.body).append(style);
}
