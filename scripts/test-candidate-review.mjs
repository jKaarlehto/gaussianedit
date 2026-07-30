import assert from 'node:assert/strict';
import {
  classifyReviewState,
  createCandidateReviewInbox,
  formatReviewReport,
  normalizeReviewItems,
  reviewReleaseForNotice,
  reviewStorageKey,
} from '../candidateReview.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.listeners = new Map();
    this.attributes = new Map();
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  insertBefore(child, before) {
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, target: this });
    }
  }

  select() {}
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelector() {
    return null;
  }
}

class FakeStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const release = {
  id: 'candidate-42',
  reviewItems: [
    { id: 'rgb-view', label: 'RGB view is visible before its mask' },
    { id: 'fifo', label: 'Views leave the tray in order' },
    { id: 'fifo', label: 'duplicate is ignored' },
    { id: '', label: 'invalid is ignored' },
  ],
};

assert.deepEqual(normalizeReviewItems(release.reviewItems), [
  { id: 'rgb-view', label: 'RGB view is visible before its mask' },
  { id: 'fifo', label: 'Views leave the tray in order' },
]);
assert.deepEqual(classifyReviewState({}), { key: 'pending', label: 'Pending' });
assert.deepEqual(
  classifyReviewState({ comment: 'Mask began late' }),
  { key: 'pending', label: 'Pending' },
);
assert.deepEqual(
  classifyReviewState({ ok: true, comment: 'Looks good' }),
  { key: 'ok', label: 'OK' },
);
assert.deepEqual(classifyReviewState({ status: 'issue' }), { key: 'issue', label: 'Issue' });
assert.deepEqual(
  classifyReviewState({ status: 'pending', ok: true }),
  { key: 'pending', label: 'Pending' },
  'an explicit acceptance state takes precedence over the legacy checkbox',
);

const documentRef = new FakeDocument();
const storage = new FakeStorage();
const host = new FakeElement('div');
const meta = new FakeElement('div');
host.append(meta);
let copied = '';
const inbox = createCandidateReviewInbox({
  host,
  before: meta,
  storage,
  clipboard: { writeText: async (text) => { copied = text; } },
  documentRef,
});
const reviewStyles = documentRef.head.children[0].textContent;
assert.match(reviewStyles, /overflow-wrap:\s*anywhere/);
assert.match(reviewStyles, /white-space:\s*normal/);
assert.doesNotMatch(
  reviewStyles,
  /candidate-review-item label b[^}]*text-overflow:\s*ellipsis/s,
  'review labels wrap in full instead of truncating',
);

inbox.render({ id: 'legacy', notes: [] });
const root = host.children[0];
assert.equal(root.hidden, true, 'metadata without reviewItems keeps the inbox hidden');

inbox.render(release);
assert.equal(root.hidden, false);
assert.equal(root.children.length, 4, 'heading, two items, and actions are rendered');
const firstRow = root.children[1];
const secondRow = root.children[2];
assert.equal(firstRow.dataset.state, 'pending');
assert.equal(firstRow.children[1].value, 'pending');
assert.equal(secondRow.dataset.state, 'pending');

const firstDecision = firstRow.children[1];
const firstComment = firstRow.children[2];
firstDecision.value = 'ok';
firstDecision.dispatch('change');
firstComment.value = '  Exact colors and camera angle match.  ';
firstComment.dispatch('input');
assert.equal(firstRow.dataset.state, 'ok');
assert.equal(firstDecision.value, 'ok');
assert.deepEqual(
  JSON.parse(storage.getItem(reviewStorageKey(release.id, 'rgb-view'))),
  { status: 'ok', comment: '  Exact colors and camera angle match.  ' },
);

firstDecision.value = 'issue';
firstDecision.dispatch('change');
assert.equal(firstRow.dataset.state, 'issue');
assert.equal(
  firstComment.value,
  '  Exact colors and camera angle match.  ',
  'changing acceptance state preserves the note',
);
assert.deepEqual(
  JSON.parse(storage.getItem(reviewStorageKey(release.id, 'rgb-view'))),
  { status: 'issue', comment: '  Exact colors and camera angle match.  ' },
);

const report = formatReviewReport(release, new Map([
  ['rgb-view', { status: 'ok', comment: 'Exact colors and camera angle match.' }],
  ['fifo', { status: 'issue', comment: 'Mask was stale; tray ordering was not accepted.' }],
]));
assert.equal(report, [
  'Candidate feedback · candidate-42',
  '- OK · RGB view is visible before its mask',
  '  Note: Exact colors and camera angle match.',
  '- ISSUE · Views leave the tray in order',
  '  Note: Mask was stale; tray ordering was not accepted.',
].join('\n'));
assert.equal(
  formatReviewReport({
    id: 'no-sentiment',
    reviewItems: [{ id: 'checked', label: 'Ambiguous-angle gate accepted' }],
  }, new Map([
    ['checked', { status: 'ok', comment: 'This note says the gate was not accepted.' }],
  ])),
  [
    'Candidate feedback · no-sentiment',
    '- OK · Ambiguous-angle gate accepted',
    '  Note: This note says the gate was not accepted.',
  ].join('\n'),
  'free-form note sentiment never changes the explicit acceptance state',
);

root.children[3].children[0].dispatch('click');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(copied, inbox.report, 'copy exports the current local feedback report');

const reloadedHost = new FakeElement('div');
const reloaded = createCandidateReviewInbox({
  host: reloadedHost,
  storage,
  clipboard: null,
  documentRef,
});
reloaded.render(release);
const reloadedFirst = reloadedHost.children[0].children[1];
assert.equal(reloadedFirst.children[1].value, 'issue');
assert.equal(
  reloadedFirst.children[2].value,
  '  Exact colors and camera angle match.  ',
  'feedback survives a recreated inbox/HMR reload',
);

const legacyRelease = {
  id: 'legacy-schema',
  reviewItems: [{ id: 'legacy-check', label: 'Legacy checkbox decision' }],
};
storage.setItem(
  reviewStorageKey(legacyRelease.id, 'legacy-check'),
  JSON.stringify({ ok: true, comment: 'Keep this legacy note.' }),
);
reloaded.render(legacyRelease);
const legacyRow = reloadedHost.children[0].children[1];
assert.equal(legacyRow.children[1].value, 'ok', 'v1 checked state migrates to explicit OK');
assert.equal(legacyRow.children[2].value, 'Keep this legacy note.', 'v1 note is preserved');
legacyRow.children[1].value = 'pending';
legacyRow.children[1].dispatch('change');
assert.deepEqual(
  JSON.parse(storage.getItem(reviewStorageKey(legacyRelease.id, 'legacy-check'))),
  { status: 'pending', comment: 'Keep this legacy note.' },
  'changing a migrated acceptance state preserves its note',
);

reloaded.render({ ...release, id: 'candidate-43' });
assert.equal(
  reloadedHost.children[0].children[1].dataset.state,
  'pending',
  'the same item ID is isolated by release ID',
);

const loadedRc1 = {
  id: 'rc1',
  reviewItems: [{ id: 'same-check', label: 'Check the loaded rc1 behavior' }],
};
const announcedRc2 = {
  id: 'rc2',
  reviewItems: [{ id: 'same-check', label: 'Check the announced rc2 behavior' }],
};
const hmrHost = new FakeElement('div');
const hmrInbox = createCandidateReviewInbox({
  host: hmrHost,
  storage,
  clipboard: null,
  documentRef,
});
hmrInbox.render(reviewReleaseForNotice(loadedRc1, loadedRc1, false));
const rc1Row = hmrHost.children[0].children[1];
rc1Row.children[1].value = 'ok';
rc1Row.children[1].dispatch('change');
hmrInbox.render(reviewReleaseForNotice(loadedRc1, announcedRc2, true));
const hmrRow = hmrHost.children[0].children[1];
assert.equal(hmrHost.children[0].dataset.releaseId, 'rc1');
assert.equal(
  hmrRow.children[0].textContent,
  'Check the loaded rc1 behavior',
  'an HMR announcement cannot expose checks for code that is not loaded',
);
assert.equal(hmrRow.children[1].value, 'ok');
assert.equal(
  storage.getItem(reviewStorageKey('rc2', 'same-check')),
  null,
  'reviewing loaded rc1 never creates rc2 feedback',
);
assert.deepEqual(
  JSON.parse(storage.getItem(reviewStorageKey('rc1', 'same-check'))),
  { status: 'ok', comment: '' },
  'loaded rc1 feedback remains persisted under rc1',
);

console.log('candidate review inbox persistence and report tests passed');
