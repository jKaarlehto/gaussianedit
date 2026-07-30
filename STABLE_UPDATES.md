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

## Current candidate — 2026.07.30-rc2

- The cockpit stays visible without black blinks while selecting and capturing all sides.
- The scan tray shows each real RGB view and exact mask, overlaps them, flashes twice, then transfers into the hologram.
- The 2D mask postcard docks on the left, and Edit starting mask opens a usable mask editor.
- Ambiguous angles offer Keep, Skip, and Edit; candidate checks and comments persist in the update banner.
