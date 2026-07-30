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

## Current candidate — 2026.07.30-rc3

- The selected mask and highlight stay aligned; orbit hides the 2D raster, and Return to captured view restores the exact pose without a jump.
- TARGET stays animated with current-frame YOLO hover and target-centered orbit and zoom; pan and flight stay blocked, with no YOLO in Mask or 3D Object.
- The wider 3D card has no edge slivers; hover freezes its exact orientation, then unhover or promotion resumes the same phase.
- Retargeting highlights the candidate first, then shows one compact SWITCH TARGET? Replace/Cancel choice without overlapping acquired and new-target HUDs.
