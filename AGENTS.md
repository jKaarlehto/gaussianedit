# GaussianEdit project guide

This file contains only GaussianEdit-specific product and repository rules.
Read it before changing code. Historical provenance is in `AGENT_HANDOFF.md`.

## Framework entrypoint

The reusable development framework—job publication, worker-owned claims,
leases, worktrees, checkpoints, machine evidence, root integration, MCP
scopes, and human gates—comes only from the private orchestration MCP.

Before coordinating work, claiming a job, creating a worktree, or launching a
subagent:

1. Call `get_development_framework`.
2. Verify its source commit and bundle digest.
3. Call `orchestration_status` and use the authoritative `workQueue`.

The canonical framework source is the private
`jKaarlehto/gaussianedit-orchestration-framework` repository. Do not rebuild
it from this file, copied prompts, rendered board HTML, cached task cards,
browser scraping, tokens, or product files. If the MCP framework or queue is
unavailable, stale, or incoherent, do not coordinate system work.

## Product goal and sources

Build immediate, understandable Gaussian object segmentation for a
nontechnical user. The experience should feel like a restrained sci-fi scanner,
not a computer-vision research console.

Product authority is local to this repository:

1. `PRODUCT_VISION.md` — interaction and language.
2. `UI_MODEL.md` — workspace names and state transitions.
3. `IMPLEMENTATION_TASKS.md` — ordered product work.
4. `FUSION_ARCHITECTURE.md` — evidence semantics and provider roles.
5. This file — product safety, validation, and repository constraints.

Do not redefine the product around whichever partial feature is easiest to
finish. Work section 0 of `IMPLEMENTATION_TASKS.md` in order before research
or decorative work.

## Product acceptance and scope

- The product is the GaussianEdit 3D editor. Board, connector, MCP, framework,
  automation, and dispatch work are system work; they never change product
  counts or product acceptance state.
- The user validates visible product behaviour manually in Microsoft Edge. A
  build, unit test, static inspection, or agent report is never visual proof.
- Product Acceptance lives only in the GaussianEdit candidate banner. Do not
  expose board/system review records as product decisions.
- Root integrates reviewed patches into `staging`; only an explicitly accepted
  candidate advances to `main`.

## Hardware and browser safety

- Do not open or control Codex, MCP, in-app, Chrome, or Chrome DevTools
  browsers for this project. They can use the wrong GPU and destabilize the
  machine. The user performs live validation in Microsoft Edge.
- Use shell checks, focused tests, production builds, and static inspection.
- Fail closed without a supported discrete NVIDIA or AMD adapter.
- Do not start or stop services unless required. Inspect exact PIDs and command
  lines first; never kill unrelated Node, Python, ComfyUI, or Codex processes.

## Development services

Use the supervised stack:

```text
npm run dev
```

Expected development URL: `http://localhost:5173/`.

The supervisor owns Vite, the dedicated SAM 3.1 service, and tracker service
discovery. The tracker normally uses port 8091; do not hardwire an unrelated
process there. Direct stateful tracking, cancellation, progress, and identity
checks remain behind `MaskPropagationProvider`; do not replace it with ComfyUI.

## Rendering and selection-frame invariants

- One immutable selection-frame record owns camera matrices, framebuffer/CSS
  scale, capture dimensions, crop, colour transform, orientation, and
  scene/view revision.
- YOLO, SAM, 2D editing, projection, lift, highlight, and hologram work use
  that exact frame or reject stale results. Matrix parity is authoritative when
  a revision misses damping or automatic camera movement.
- Synthetic scans operate only on the resident isolated Gaussian cutout. Never
  prepare or sort the full cockpit scene for a synthetic camera.
- Render transactions restore target, viewport, scissor, clear state, output
  colour space, tone mapping, exposure, and hidden objects before yielding.
- Restore the visible framebuffer before asynchronous GPU readback. Exclude
  cargo, HUD, highlights, and transient effects from model input without
  changing live-scene state across a yield.

## Cancellation, memory, and responsiveness

- Camera, scene, selection, prompt, mask edit, and scan revisions supersede
  stale work safely.
- Cancellation aborts provider requests before releasing backend sessions,
  blobs, bitmaps, canvases, projections, evidence buffers, cutouts, and render
  targets.
- Keep only small tray snapshots after upload. Enforce byte limits for cutouts,
  staged frames, projections, and evidence; reduce resolution/view count or
  fail safely before allocation.
- Yield interactive frames between bounded expensive batches. Never scan a
  full 8–10M scene array where the active selection, touched IDs, or ROI works.

## Product UX contract

Top-level stages never change:

```text
Select visible side → Scan all sides → Fix if needed → Dock object
```

Use `Rendering`, `Tracking`, `Checking object match`, and `Adding to 3D` with
monotonic real units. A true product human gate says `Your decision`, explains
the uncertainty, and offers `Keep`, `Skip`, and `Edit`; do not use fake review
states or unexplained percentages.

The FIFO tray shows one real evidence transaction: RGB, real mask, overlap,
two accepted-mask flashes, evidence transfer, removal, then the next item.
Never restore a gallery or placeholder slots.

## GaussianEdit-specific coordination constraints

- Only one agent may own `main.js` at a time. Avoid concurrent edits to
  `index.html`, `package.json`, or `tracking_service/app.py`.
- Keep a product tranche narrow, coherent, and reviewable. Do not perform a
  broad cosmetic/framework rewrite while stabilizing rendering.
- Preserve unrelated user changes. Do not reset, checkout, delete, or overwrite
  broad state without explicit user authority.
- Keep user commentary concise and provide an update at least once per minute
  during long-running work.

## Verification

Run focused checks for the patch, then the relevant shell gate:

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

`npm run test:tracker-service` is the lightweight service-identity/log-contract
check. After implementation commits land, review render-state discipline,
selection-frame parity, allocations and byte budgets, cancellation/cleanup,
stale-result rejection, focused tests, and production build output.

## Candidate banner and release notes

`releaseMetadata.js` is the source for the in-app update banner and
`STABLE_UPDATES.md` mirrors it for people. For reviewed, merged, user-testable
product work: use a new unique ID, keep `candidate` until Edge validation,
record accurate timestamp and user-verifiable notes, and mirror the label and
notes. Do not advertise internal refactors as visible product behaviour.

## Git and documentation hygiene

- Inspect status, recent commits, and worktrees before changes.
- Use `apply_patch` for source and documentation edits.
- Commit coherent changes; never commit generated diagnostics, logs,
  checkpoints, downloads, or `.runtime`.
- Update `IMPLEMENTATION_TASKS.md` only for behaviour implemented and verified
  to its stated standard.
- Keep `AGENT_HANDOFF.md` concise when product work pauses or ownership changes.
