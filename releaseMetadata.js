// This is the single source of truth for the in-app build notice.
// Keep the notes short and describe behavior a user can actually verify.
export const releaseMetadata = Object.freeze({
  id: '2026.07.31-rc5',
  status: 'candidate',
  publishedAt: '2026-07-31T16:02:00+03:00',
  notes: Object.freeze([
    'Acceptance checks now live in the GaussianEdit editor and route Looks good or Back to loop directly to the owning product task.',
    'A review item disappears only after the board confirms the exact candidate, item, owner, workspace, action, and idempotency key.',
    'Back to loop requires a useful comment; failed or mismatched imports stay visible and retryable.',
    'The accumulated all-sides scan candidate remains available for one focused in-product Acceptance pass.',
  ]),
  reviewItems: Object.freeze([
    Object.freeze({
      id: 'scan-runtime-continues-after-growth',
      label: 'After an accepted view adds splats, does scanning continue through the later angles?',
      taskId: 'scan-coordinator-live', owner: 'scan_coordinator_live', workspace: '3D Object',
    }),
    Object.freeze({
      id: 'scan-runtime-pause-resume',
      label: 'Does Pause then Resume continue the same scan without duplicate tray work or restarted counters?',
      taskId: 'scan-coordinator-live', owner: 'scan_coordinator_live', workspace: '3D Object',
    }),
    Object.freeze({
      id: 'scan-runtime-cancel-on-edit',
      label: 'Does editing the starting mask stop the scan promptly and require Use this object again?',
      taskId: 'scan-coordinator-live', owner: 'scan_coordinator_live', workspace: '2D Mask',
    }),
    Object.freeze({
      id: 'candidate-feedback-exact-clear',
      label: 'Does Looks good remove only the item you clicked after its decision is saved?',
      taskId: 'candidate-feedback-bridge', owner: 'candidate_feedback_worker', workspace: 'General',
    }),
    Object.freeze({
      id: 'candidate-feedback-comment-required',
      label: 'Does Back to loop keep the item visible and ask for a comment when the comment is empty?',
      taskId: 'candidate-feedback-bridge', owner: 'candidate_feedback_worker', workspace: 'General',
    }),
  ]),
});
