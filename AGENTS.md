# GaussianEdit agent guide

This file is the operating contract for agents working in this repository.
Read it before changing code. Historical branch reports and root-cause notes
are preserved in [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md).

## Product goal

Build cutting-edge Gaussian object segmentation that feels immediate and
understandable to a nontechnical user. The interaction should resemble a
restrained sci-fi spacecraft scanner, not a computer-vision research console.

The authoritative sources are:

1. [`PRODUCT_VISION.md`](PRODUCT_VISION.md) for the interaction and language.
2. [`IMPLEMENTATION_TASKS.md`](IMPLEMENTATION_TASKS.md) for ordered work.
3. This file for engineering workflow, safety, review, and release rules.

Do not redefine the project around whichever partial feature is easiest to
finish. Work through section 0 of `IMPLEMENTATION_TASKS.md` in its stated order
before advancing research-scale or decorative work.

## Current integration baseline

Work on `feat/object-refinement`. The important integrated commits are:

- `e0c725b` — isolate scan visibility from the live scene.
- `356368c` — define stable pipeline stages and actor/status language.
- `74759e0` — stabilize the immutable selection frame, visible-side work,
  tracking cancellation, scan cleanup, and coordinator tests.
- `be509b6` — supervise the dedicated SAM 3.1 runtime.
- `3a1ea79` — implement the single-item FIFO scan-tray choreography.

The former isolated worktree commits `34e5cdd`, `c1e1277`, and `1b35a57` have
already been reviewed and incorporated deliberately. Do not cherry-pick them
again. Read `AGENT_HANDOFF.md` only for provenance and unresolved findings.

## Immediate goals

Prioritize these outcomes:

1. Validate the selection-frame contract in Microsoft Edge: cockpit click,
   YOLO guidance, captured RGB, cropped 2D editor, SAM prompt, lifted
   Gaussians, main highlight, and hologram must agree.
2. Eliminate synthetic-render flicker. Synthetic capture must never alter the
   live cockpit framebuffer, visibility, or full-scene Gaussian sort state.
3. Keep visible-side lift, bridge growth, refinement, and hologram context
   bounded and timed. No small selection may scale with the entire scene.
4. Integrate `ScanCoordinator` into the all-sides path and drive UI from its
   ordered progress/cancellation events.
5. Finish the stable stage rail and real-unit counters:
   `Select visible side` → `Scan all sides` → `Fix if needed` → `Dock object`,
   with `Rendering n/m`, `Tracking n/m`, and `Adding to 3D n/m`.
6. Add the safe read-only `Backend activity` drawer using the bounded tracker
   log endpoint. Never expose command execution or arbitrary file access.
7. Add explicit scan byte budgets and actual/estimated memory diagnostics,
   then validate stability on the 8.8M-Gaussian Nelson scene.
8. Verify hologram hover pauses at the current orientation, hands orbit control
   to the user, and resumes without resetting spin, camera, or framing.

Do not mark visual behavior complete until the user verifies it in Edge.

## Hardware and browser safety

- Do not open or control Codex, MCP, in-app, Chrome, or Chrome DevTools
  browsers for this project. They may run without the discrete GPU and have
  previously contributed to severe slowdown and system instability.
- Use shell commands, unit tests, production builds, and static inspection.
  The user performs live visual validation manually in Microsoft Edge.
- Do not claim visual correctness from a successful build.
- The app must fail closed when a supported discrete NVIDIA/AMD adapter is not
  available.
- Do not start or stop services unless the task requires it. Inspect exact PIDs
  and command lines before terminating anything; never kill unrelated Node,
  Python, ComfyUI, or Codex helper processes.

## Development services

Use the supervised stack:

```text
npm run dev
```

Expected development URL:

```text
http://localhost:5173/
```

The supervisor starts Vite and the dedicated GaussianEdit SAM 3.1 service,
verifies its identity, and proxies tracker requests. The tracker normally
listens on port 8091 but the supervisor owns service discovery; do not hardwire
an unrelated process on that port.

The dedicated FastAPI tracker is the primary interactive backend. Do not
replace it with ComfyUI merely because some Python packages currently come
from `comfyenv`. ComfyUI may become an optional provider for broader workflows,
but direct stateful tracking, cancellation, progress, and identity checks stay
behind the existing `MaskPropagationProvider` contract.

## Rendering and coordinate invariants

- One immutable selection-frame record is authoritative for camera matrices,
  framebuffer and CSS scale, capture dimensions, crop, color transform,
  orientation, and scene/view revision.
- YOLO, SAM, 2D editing, projection, lift, highlights, and hologram updates
  must consume that exact frame or reject their result as stale.
- Matrix parity is authoritative when a revision counter misses camera damping
  or an automatic camera move.
- A `WebGLRenderTarget` viewport/scissor uses physical target pixels. Do not
  apply the display pixel ratio twice through renderer-level viewport sizing.
- Synthetic scans use only the resident isolated Gaussian cutout. Never ask
  the full cockpit scene to prepare or sort for a synthetic camera.
- Save and restore render target, viewport, scissor, scissor-test, clear color,
  clear alpha, auto-clear, output color space, tone mapping, exposure, and any
  temporarily hidden scene objects before yielding.
- Restore the visible framebuffer before awaiting asynchronous GPU readback.
- Exclude cargo, HUD geometry, highlights, and transient effects from model
  input without mutating their live-scene state across a yield.

## Cancellation, memory, and responsiveness

- Every camera, scene, selection, prompt, mask edit, and scan revision must
  supersede stale work safely.
- Cancellation must abort provider requests first, then release backend
  sessions, staged blobs, image bitmaps, temporary canvases, projection
  lookups, evidence buffers, cutouts, and render targets.
- Keep only small tray snapshots after upload. Release native-resolution staged
  frames when their FIFO item becomes active.
- Put explicit byte limits on cutout buffers, staged frames, projections, and
  evidence. Reduce resolution/view count or fail safely before allocation.
- Yield interactive frames between expensive synthetic sorts and bounded work
  batches.
- Never scan an 8–10M-entry scene-wide array when the same result can be
  computed from the active selection, touched IDs, or scan ROI.

## UX language contract

The top-level stage names never change:

```text
Select visible side → Scan all sides → Fix if needed → Dock object
```

Use active verbs for app work: `Rendering`, `Tracking`, `Checking object
match`, and `Adding to 3D`. A genuine human gate says `Your decision`, explains
the uncertainty in one sentence, and offers concrete `Keep`, `Skip`, and
`Edit` actions.

Do not use generic `Review`, `processing`, `working`, or unexplained
percentages in the normal workflow. Show monotonic real units. The FIFO tray
shows exactly one real evidence transaction: RGB first, real mask beside it,
overlap, exactly two accepted-mask flashes, evidence transfer, removal, then
the next item. Never restore a gallery or placeholder slots.

## Multi-agent workflow

- Partition work by files and responsibilities before editing.
- Only one agent may own `main.js` at a time. Likewise, avoid concurrent edits
  to `index.html`, `package.json`, or `tracking_service/app.py`.
- Prefer isolated modules and focused tests so integration remains deliberate.
- Before work, report branch, worktree, status, assigned files, and dependencies.
- After work, report changed files, behavior, tests and results, remaining
  risks, and the commit hash if committed.
- Do not merge or cherry-pick blindly. Compare the patch with current `HEAD`,
  preserve later fixes, and resolve conflicts intentionally.
- When the user asks to pause agents, stop active work, collect concise reports,
  and record them in `AGENT_HANDOFF.md` before continuing.
- Keep user commentary concise and provide an update at least once per minute
  during long-running work.

## Verification

Run the focused checks relevant to the patch, then the full shell gate:

```text
npm run test:selection-frame
npm run test:mask-abort
npm run test:scan-coordinator
npm run test:scan-tray
npm run test:tracker-runtime
npm run test:cutout
npm run test:projection-roi
npm run build
git diff --check
```

`npm run test:tracker-service` is a lightweight service-identity/log-contract
test that deliberately avoids loading the 3.5GB checkpoint. Use it for tracker
runtime or log-feed changes.

After implementation commits land, run a dedicated performance/correctness
review covering:

- Three.js render-state discipline and isolated Gaussian sorting.
- Selection frame, matrix, coordinate, crop, and revision correctness.
- Allocations, byte budgets, main-thread stalls, and yielding.
- Cancellation, cleanup, late responses, and stale-result rejection.
- Focused tests and production build output.

Do not publish a candidate banner until this review has no blocking findings.

## Update banner and release notes

[`releaseMetadata.js`](releaseMetadata.js) is the single source of truth for
the in-app update banner. [`STABLE_UPDATES.md`](STABLE_UPDATES.md) mirrors the
same candidate/stable label and notes for humans.

For every reviewed, merged, user-testable tranche:

1. Set a new unique `id`.
2. Keep `status: 'candidate'` until the user validates the main flow in Edge.
3. Set an accurate `publishedAt` timestamp.
4. Write two to four short notes describing behavior the user can directly
   verify. Do not advertise internal refactors alone.
5. Propose optional `reviewItems` with stable item IDs and short,
   user-verifiable labels for the candidate feedback inbox.
6. The orchestrator adds those `reviewItems` to release metadata only after
   integration review and all required shell gates pass.
7. Mirror the exact label and note bullets in `STABLE_UPDATES.md`.
8. Run the full shell verification gate again.
9. Tell the user what changed and provide a short Edge validation checklist.

Change a build to `stable` only after the agreed shell checks and live Edge
workflow pass. Never update the banner for unreviewed, unmerged, speculative,
or agent-only work.

## Git and documentation hygiene

- Inspect `git status`, recent commits, and worktrees before changing files.
- Preserve user-owned and unrelated changes.
- Use `apply_patch` for source/document edits.
- Do not use destructive reset/checkout operations without explicit authority.
- Commit coherent changes with intentional messages; do not commit generated
  diagnostics, logs, checkpoints, downloaded scenes, or `.runtime` contents.
- Update `IMPLEMENTATION_TASKS.md` only when behavior is implemented and
  verified to the standard stated at the top of that file.
- Keep `AGENT_HANDOFF.md` concise and current when work pauses or ownership
  changes.
