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

## Current candidate — 2026.07.31-rc4

- All-sides scanning now stays on one ordered run and continues after accepted views add new splats.
- Pause and Resume stay on that same scan; editing or changing the confirmed seed cancels stale work safely.
- Large-object preparation yields between bounded chunks and stops with a clear limit instead of attempting scene-scale work.
- The 3D Object controls no longer advertise the disconnected Gaussians display mode.
