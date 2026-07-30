# GaussianEdit agent handoff — 2026-07-30

> Integration update: the reported worktree changes have now been incorporated
> into `feat/object-refinement` through commits `74759e0`, `be509b6`, and
> `3a1ea79`. Do not cherry-pick the old worktree commits again. This document is
> retained for provenance and unresolved findings; upcoming agents must follow
> [`AGENTS.md`](AGENTS.md).

All implementation agents were originally paused after the workstation was
shut down. Their reports below describe the isolated branches as they existed
before integration.

## Integration branch

- Branch: `feat/object-refinement`
- Baseline checkpoint: `79b19e4` — multiview selection workflow
- Live-scene isolation fix: `e0c725b` — prevents the diagnostic occluder pass
  from hiding the cockpit scene during backend work
- Pipeline-language contract: `356368c` — defines the stable user-facing
  stages and removes ambiguous generic `Review` terminology from the backlog

The authoritative backlog is [`IMPLEMENTATION_TASKS.md`](IMPLEMENTATION_TASKS.md).
The interaction direction is in [`PRODUCT_VISION.md`](PRODUCT_VISION.md).

## Agent reports

### Selection frame, coordinate correctness, and visible-side performance

- Agent branch: `feat/fix-selection-core`
- Commit: `34e5cdd`
- Worktree used:
  `C:\Users\JuhanaKaarlehto\Documents\gaussianedit-worktrees\selection-core`

Reported root cause:

`renderer.setViewport(targetWidth, targetHeight)` was applied to a
`WebGLRenderTarget` using dimensions that were effectively scaled by device
pixel ratio twice. The offscreen selection capture was cropped while click,
mask, projection, detector, lift, highlight, and hologram code assumed the
complete frame. This explains the observed vertical click displacement,
misplaced YOLO labels, wrong 2D mask, wrong lifted Gaussians, and mismatched
hologram. The offscreen target also lacked exact output-color parity.

Reported changes:

- Added one immutable selection-frame contract containing scene/view revision,
  view and view-projection matrices, render/capture/CSS dimensions, and DPR.
- Added consistent CSS → capture → mask → projection → crop transforms.
- Snapshots the exact camera before both capture and projection.
- Rejects stale scene, matrix, and detector results.
- Restores output color-space parity for the capture target.
- Adds `viewCoordinates.js` and
  `scripts/test-view-coordinates.mjs`.
- Dense masks skip redundant neighborhood bridging at 1,500 seeds.
- Replacement selection avoids a duplicate full confidence allocation.
- Protection iterates the active selection instead of the 8.8M-entry lock map.
- Avoids a duplicate hologram rebuild.
- Caps context-cube grid-cell visits.
- Makes visible-side status/progress stages explicit.

Reported verification:

- `npm run test:view-coordinates`
- `npm run test:projection-roi`
- `npm run test:cutout`
- `npm run build`

All reported as passing. The agent reported a clean worktree.

### SAM 3.1 runtime and backend observability

- Agent branch: `feat/sam-tracker-runtime`
- Commit: `c1e1277`
- Worktree used:
  `C:\Users\JuhanaKaarlehto\Documents\gaussianedit-worktrees\sam-tracker`

Reported root cause:

Port 8091 could be occupied by an unrelated Conda Python process. That process
could answer capability requests while lacking `sam3`, producing
`ModuleNotFoundError` and making the UI report temporal tracking unavailable.

Reported changes:

- Adds dedicated runtime discovery, including the primary project worktree.
- Preflights official `sam3`, checkpoint presence, and CUDA.
- Starts the tracker under supervision on a dynamic port.
- Uses a per-process identity token so a stale Conda/8091 service cannot
  impersonate the project tracker.
- Wires Vite proxying to the supervised service.
- Exposes explicit unavailable capability state instead of silently falling
  back to an unrelated process.
- Adds a runtime identity endpoint.
- Adds a bounded, read-only in-memory log feed:
  `/api/sam-tracking/logs?after=&limit=`.
- The log feed executes no commands and reads no arbitrary files. It is the
  backend source intended for a future `Backend activity` UI drawer.
- Adds runtime/service tests and supporting scripts.

Reported verification:

- `npm run test:tracker-runtime`
- `npm run test:tracker-service`
- `npm run build`
- Python `py_compile`
- `git diff --check`

The runtime test reportedly found the RTX 5090, correct virtual environment,
and correct checkpoint. The service test used a deliberately missing
checkpoint to avoid loading the 3.5 GB model during the test. The agent
reported a clean worktree.

### Single-item FIFO scan tray

- Agent branch: `feat/scan-tray-choreography`
- Commit: `1b35a57`
- Worktree used:
  `C:\Users\JuhanaKaarlehto\Documents\gaussianedit-worktrees\scan-tray`

Required and reportedly implemented choreography:

1. Exactly one active evidence transaction is shown.
2. Its real synthetic RGB view appears first.
3. Its real tracked mask appears beside it.
4. The two move together and overlap.
5. The accepted mask region flashes exactly twice.
6. The tray emits transfer-start and particle-flight events toward the
   hologram.
7. It emits transfer-complete, removes the pair, and advances the next FIFO
   item.

Reported safeguards:

- Exactly one `.scan-view-pair` can be mounted.
- Later views are only 132×76 data snapshots, never hidden/full DOM cards.
- Unknown or out-of-order tracker callbacks cannot create empty cards.
- The old six-card gallery and empty placeholders are not part of this branch.
- Integration instructions are in `SCAN_TRAY_INTEGRATION.md`.
- The hologram-hover requirement is documented: pause at the current
  orientation, hand control to the user, and resume without resetting.

Reported verification:

- `npm run test:scan-tray`
- `npm run build`

Both reported as passing. The agent reported a clean worktree.

## Historical review and merge order

The following sequence was used during integration. It is historical and must
not be repeated:

1. Review and incorporate `34e5cdd` first. Re-run its focused tests and inspect
   all coordinate/camera/color contracts. This is the prerequisite for judging
   YOLO, SAM, lift, highlight, or hologram quality.
2. Review and incorporate `c1e1277`. Confirm the supervised tracker starts from
   the project runtime and the read-only log feed is bounded.
3. Review and incorporate `1b35a57`. Follow
   `SCAN_TRAY_INTEGRATION.md` to connect actual RGB frames, actual masks, fusion
   completion, and the hologram particle destination.
4. Resolve conflicts deliberately; all three branches started from `79b19e4`,
   while the integration branch also contains `e0c725b` and `356368c`.
5. Run one performance/correctness review before advertising a candidate:
   Three.js render-target state, viewport/scissor/clear/color restoration,
   Gaussian sorter isolation, main-thread yielding, memory budgets,
   cancellation, and stale-revision rejection.
6. Update `releaseMetadata.js` / `STABLE_UPDATES.md` only after reviewed commits
   are merged. The banner must state exactly what changed and what the user
   should validate in Microsoft Edge.

## Known unresolved work

- Ordinary synthetic view rendering was still reported to flicker between the
  cockpit and a dark/black frame. `e0c725b` fixed one visibility leak, but the
  standard offscreen capture path still needs a render-state/isolation audit.
- The app still needs a read-only `Backend activity` drawer consuming the new
  bounded log endpoint.
- Generic `Review` language remains in implementation code and must be replaced
  with the stable stage rail:
  `Select visible side` → `Scan all sides` → `Fix if needed` → `Dock object`.
  Fine progress is `Rendering n/m`, `Tracking n/m`, and `Adding to 3D n/m`.
  Model work says `Checking object match`; a real human gate says
  `Your decision` with a reason and Keep/Skip/Edit actions.
- The hologram hover interaction still needs implementation and verification.
- Do not use Codex, MCP, in-app, or Chrome-controlled browsers on this machine.
  They were reported to run without the dGPU and contributed to severe system
  slowdown. The user validates manually in Microsoft Edge.
