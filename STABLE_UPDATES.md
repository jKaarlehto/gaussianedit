# Stable build updates

The in-app update banner reads its build label, state, timestamp, and notes from
`releaseMetadata.js`. Update that one file when a testable build changes.

## Publishing a build

1. Change `id` to a new unique build label.
2. Keep two to four short notes describing behavior a user can verify.
3. Use `status: 'candidate'` while the build is still being validated.
4. Change it to `status: 'stable'` only after the build and its main workflow
   have passed the agreed checks.

During Vite development, changing the metadata is detected without silently
replacing the running app. The banner asks the user to reload so code and build
notes always refer to the same loaded version. Collapsing the banner leaves a
small build chip at the top of the screen.

## Current candidate — 2026.07.31-rc5

- Acceptance checks now live in the GaussianEdit editor and route Looks good or Back to loop directly to the owning product task.
- A review item disappears only after the board confirms the exact candidate, item, owner, workspace, action, and idempotency key.
- Back to loop requires a useful comment; failed or mismatched imports stay visible and retryable.
- The accumulated all-sides scan candidate remains available for one focused in-product Acceptance pass.

