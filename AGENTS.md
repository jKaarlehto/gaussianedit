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
2. [`UI_MODEL.md`](UI_MODEL.md) for canonical interface names, workspaces, and
   state transitions.
3. [`IMPLEMENTATION_TASKS.md`](IMPLEMENTATION_TASKS.md) for ordered work.
4. [`FUSION_ARCHITECTURE.md`](FUSION_ARCHITECTURE.md) for evidence semantics,
   provider roles, and the research-derived fusion direction.
5. This file for engineering workflow, safety, review, and release rules.

Do not redefine the project around whichever partial feature is easiest to
finish. Work through section 0 of `IMPLEMENTATION_TASKS.md` in its stated order
before advancing research-scale or decorative work.

## How the user develops this product

The user works continuously in Microsoft Edge while agents implement small
tranches. Treat their live feedback as the primary visual acceptance signal.

- The root task is an orchestrator and reviewer. Delegate implementation to
  subagents unless the user explicitly assigns implementation to the root.
- Keep subagent ownership narrow, review their patches, integrate deliberately,
  run the gates, manage Git, and publish the next candidate for the user.
- The user expects frequent candidate checklists in the in-app update banner,
  not a large feature dump at the end. Prefer small reviewed tranches that can
  be understood and tested independently.
- Route every banner comment to the responsible agent. Record an explicit
  `PENDING`, `OK`, or `ISSUE` state plus an optional note; never infer acceptance
  from the wording of a comment.
- A live HMR result is validation of the current working tree, not necessarily
  of `HEAD`. Record the exact WIP/commit being tested before calling it passed.
- When the user says an item failed, it failed. Do not average it with shell
  success or keep advertising it because most of the underlying code exists.
- Distinguish clearly between specified, implemented, shell-verified,
  integrated, and Edge-verified behavior. A design report is not an
  implementation.

## Current integration baseline

Work on `feat/object-refinement`. The important integrated commits are:

- `e0c725b` — isolate scan visibility from the live scene.
- `356368c` — define stable pipeline stages and actor/status language.
- `74759e0` — stabilize the immutable selection frame, visible-side work,
  tracking cancellation, scan cleanup, and coordinator tests.
- `be509b6` — supervise the dedicated SAM 3.1 runtime.
- `3a1ea79` — implement the single-item FIFO scan-tray choreography.
- `1251e77` — stabilize the first candidate review experience, renderer state,
  and tray behavior before the current WIP tranche.

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
6. Require the user to approve the actual visible-side 3D Gaussian selection
   before any synthetic views, upload, or tracking begin.
7. Move workspace-specific controls out of General. Keep General compact and
   persistent while Workspace controls show only the active workspace's
   relevant controls.
8. Promote the confirmed object into a main 3D workspace with an independent
   orbit camera; keep 2D Mask and 3D Object as reciprocal postcards.
9. Add the safe read-only `Backend activity` drawer using the bounded tracker
   log endpoint. Never expose command execution or arbitrary file access.
10. Add a bounded pipeline profiler that attributes time, blocking slices,
   counts, bytes, cancellation, and stale work to every fusion stage.
11. Add explicit scan byte budgets and actual/estimated memory diagnostics,
   then validate stability on the 8.8M-Gaussian Nelson scene.
12. Verify hologram hover pauses at the current orientation, hands orbit control
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

The development-only default scene is:

```text
C:\Users\JuhanaKaarlehto\Downloads\blender livingroom\scene.ply
```

Serve it through the existing Vite `/__demo__/` route. Keep
`GAUSSIANEDIT_DEMO_PLY`, the Nelson fallback, and drag-and-drop working; never
embed an absolute Windows path in production client code.

Background launches may not have a visible console. The current supervised
stdout/stderr files are `.runtime/dev.current.stdout.log` and
`.runtime/dev.current.stderr.log`. A log viewer must be read-only and must not
restart or duplicate the supervised stack.

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
- Instrument browser YOLO, backend YOLO, SAM encode/decode, classic masks,
  2D fusion, lift, bridge growth, refinement, synthetic render/readback,
  upload, SAM 3.1 tracking, evidence fusion, and materialization.
- Profiler events must carry scene/view/selection/mask/scan revisions plus
  input/output counts, added/removed Gaussian counts, bytes, cancellation, and
  stale outcomes. Store only a bounded ring buffer.
- Flag blocking slices over 50 ms and report stage p50/p95/max. Profiling must
  remain cheap when enabled and near-zero overhead when disabled. Never add a
  synchronous GPU query, extra readback, console flood, or unbounded trace to
  measure performance.

## Interaction and object-state contract

Use the canonical names and transitions in [`UI_MODEL.md`](UI_MODEL.md). The
rules below add engineering invariants to that user-facing model.

Global workspace and object progress are separate concepts. There are exactly
three stable workspaces:

```text
Scene ↔ 2D Mask ↔ 3D Object
                  Current object
                  ├─ Scan all sides
                  └─ Dock
```

- General is a compact persistent shell for scene/load state, GPU/backend
  health, the workspace switch, and cross-workspace real-unit progress. It may
  expand for loading, a blocking error, or a genuine decision.
- The central Workspace Controller is the sole authority for the active
  workspace, input ownership, main viewport, Workspace controls, and Postcard
  deck. Pipeline stages remain independent from it.
- Exactly one workspace owns interactive input at a time. Scene owns
  pointer-lock mouse look plus `WASD`/`QE`; 2D Mask owns its paint/edit
  gestures; 3D Object owns drag-orbit and wheel zoom. Inactive workspaces must
  not react to the active workspace's gestures.
- Scene owns Home, Frame scene, Set home, Clean view, Show origin,
  and flight speed. Movement help belongs in the transient viewport
  click-to-control cue, never as permanent General-panel copy.
- Selection is not a fourth workspace. In Scene Selection view, the right-side
  Workspace controls own the Auto object, Color fill, and Radius targeting
  methods, Target scanner, method options, and configured `Item`, `Region`, or
  `Whole` scale preference. They must work before the first click.
- One draft represents one object. Do not advertise scene Shift-click as
  additive selection, and do not silently replace the draft with another
  object.
- The existing scene Shift-click subtraction path may not reach `Use this
  object` or all-sides processing until it produces an authoritative 2D mask
  of the remaining object and records removed regions as persistent negative
  provenance. Until then, correct membership through the single object's 2D
  editor.
- Future additive selection requires explicit per-component immutable frames,
  masks, prompts, provider provenance, Gaussian membership, revisions, and
  tracker object IDs. Union components only at the object-assembly layer.
- Keep inactive workspaces visible as a persistent left stack of postcards.
  Clicking a card activates that exact workspace. `Tab` advances in the fixed
  order Scene → 2D Mask → 3D Object; `Shift+Tab` traverses the same
  order in reverse. A workspace whose artifact does not exist remains visibly
  disabled and is skipped without changing the order.
- `Item`/`Region`/`Whole` are an intent contract. Until a learned hierarchy
  provider is validated, describe area-ordered SAM alternatives as an honest
  approximation rather than claiming semantic part/object/whole certainty.
- After the 2D Mask is lifted and refined, show the actual highlighted Gaussian
  selection and a viewport-anchored `Use this object` action with its real
  splat count. It must be visually distinct from YOLO target labels.
- No synthetic render, tracker upload, or all-sides work may start before the
  user confirms the current mask/frame/selection revision. A provider, scale,
  prompt, or mask edit invalidates confirmation and returns to this gate.
- Confirmation promotes the object to the main 3D workspace and starts ordered
  all-sides work. The transition uses the actual selected splats and stays
  inside the one coherent render transaction; decorative particles must never
  masquerade as evidence.
- The main 3D Object has a preview camera independent from synthetic scan
  cameras. User orbiting the preview cannot change tracking inputs.
- 2D Mask and 3D Object are peer postcards with one clear action each:
  `Edit mask` and `Edit object`. Do not restore the tiny multi-button hologram
  toolbar.
- Preserve the immutable selection freeze, draft, and last substate across
  workspace navigation. Switching workspace is non-destructive and does not
  itself abandon, mutate, or invalidate the current selection.
- Isolated all-sides processing may continue safely while Scene or 3D Object is
  active. Merely opening 2D Mask does not cancel it, but the first
  real mask edit invalidates and cancels the affected revision, clears visible
  object confirmation, and requires `Use this object` again before a new
  all-sides run.
- A status strip may report progress and offer an explicitly labelled action,
  but the strip itself must not teleport to a different destination depending
  on state. Stable Scene, 2D Mask, and 3D Object destinations remain
  available.
- Only an explicit `Clear` / `Abandon current object` destroys the draft.
  Starting a replacement must require that explicit action first. `Back`,
  Escape, Tab, direct card navigation, and editor close actions never abandon
  it.
- `Dock object` is clipboard-style CUT semantics: on successful docking the
  exact selected Gaussian IDs leave the live scene and become dock cargo.
  Failure/cancellation is a no-op, and Return/undock restores the exact IDs and
  transforms. Never silently overwrite occupied cargo.

## UX language contract

The top-level stage names never change:

```text
Select visible side → Scan all sides → Fix if needed → Dock object
```

Use active verbs for app work: `Rendering`, `Tracking`, `Checking object
match`, and `Adding to 3D`. A genuine human gate says `Your decision`, explains
the uncertainty in one sentence, and offers concrete `Keep`, `Skip`, and
`Edit` actions.

Do not show or simulate that gate merely because the future workflow includes
it. It appears only for a real, persisted uncertainty event. Technical render,
readback, upload, or tracker failures retry/skip/fail closed and never become a
fake human decision.

Do not use generic `Review`, `processing`, `working`, or unexplained
percentages in the normal workflow. Show monotonic real units. The FIFO tray
shows exactly one real evidence transaction: RGB first, real mask beside it,
overlap, exactly two accepted-mask flashes, evidence transfer, removal, then
the next item. Never restore a gallery or placeholder slots.

## Fusion and model-use truth

Follow `FUSION_ARCHITECTURE.md`. Providers publish evidence with provenance;
they do not become interchangeable confidence numbers.

- A YOLO detection box is a location/class proposal and weak extent prior, not
  a pixel boundary. State explicitly whether a box was sent as a real SAM
  prompt or merely used to rank returned masks.
- The current browser YOLOv10n and backend YOLO12s paths are fixed-vocabulary
  detection providers. Never describe them as general objectness or
  open-vocabulary segmentation.
- A YOLO score that helped choose or prompt a SAM mask is correlated with that
  mask. It must not be counted again as an independent evidence vote.
- Color fill is a deterministic connected RGB region with a local color-change
  stop, not a learned edge model or calibrated probability. Radius is a
  deterministic spatial guide.
- Under Auto-led/Smart fusion, classic guides may constrain or reclassify
  confidence while the SAM shape stays authoritative. Union/intersection or a
  classic-only choice may change shape. Make the exact behavior visible and
  testable.
- Preserve SAM logits/quality/provenance when available, but do not call raw
  logits, predicted IoU, detector scores, or deterministic guides calibrated
  probabilities.
- Attribute visible 3D growth separately to lifted seeds, bridge additions,
  refinement additions, and multiview additions. Never report only the final
  count when one stage grew unexpectedly.
- The research path is contributor-aware `alpha × transmittance` lifting,
  bounded local GaussianCut-style graph regularization, and optional
  scale-aware/identity sidecars. Do not claim those are implemented until the
  real path and benchmarks exist.

## Multi-agent workflow

- The root orchestrator owns task partitioning, patch review, integration,
  commits, pushes, candidate publication, and feedback routing. Implementation
  agents do not merge, publish, or update release metadata unless assigned that
  exact integration task.
- Prioritize by user-visible risk:
  - **P0 live-flow blockers:** render corruption or flicker, inability to
    navigate/escape, selection-to-confirmation failures, SAM/tray not starting,
    or accepted evidence not updating the 3D object.
  - **P1 stabilization:** `ScanCoordinator` integration, revisioned buffer
    previews, cancellation/cleanup, profiler wiring, byte budgets, and backend
    diagnostics.
  - **P2 research:** disabled fusion/model experiments and longer-horizon
    architecture. P2 work must not delay a P0 fix or enter the live path before
    adversarial review passes.
- Keep at most one owner in `main.js` and one independent infrastructure or
  research lane active alongside an independent reviewer. Do not start another
  visible feature while a P0 tranche is failing its focused tests or live Edge
  flow.
- Finish the smallest coherent user-testable tranche, review it, publish its
  banner questions, and only then expand scope. Do not accumulate an entire
  session of unrelated WIP behind one candidate.
- Partition work by files and responsibilities before editing.
- Only one agent may own `main.js` at a time. Likewise, avoid concurrent edits
  to `index.html`, `package.json`, or `tracking_service/app.py`.
- Prefer extracting cohesive, testable modules over growing `main.js`, but be
  pragmatic. Do not perform a framework rewrite or broad cosmetic refactor
  while stabilizing rendering.
- Prefer isolated modules and focused tests so integration remains deliberate.
- Before work, report branch, worktree, status, assigned files, and dependencies.
- Checkpoints use the same compact fields: `owner`, `priority`, `files`,
  `completed`, `tests`, `blocker`, `next`, and `reviewItems`. The orchestrator
  derives the user-facing dashboard from these reports; the dashboard is not a
  substitute for repository state, test output, or Edge validation.
- After work, report changed files, behavior, tests and results, remaining
  risks, and the commit hash if committed. Every implementation agent must also
  return one to five short, falsifiable questions about user-visible behavior
  for Edge review. Each question carries a stable item ID, owning agent, and
  affected workspace. If the patch has no user-visible change, report exactly
  `none: no user-visible change`.
- Research-only agents submit no visual review questions unless their work
  lands behavior the user can actually test.
- Treat new live Edge feedback as the current acceptance evidence. State
  explicitly which older instruction it supersedes, and update focused tests
  and UI documentation with the resolved contract. Do not keep implementing a
  stale interpretation in parallel.
- Never return a cached or unrelated final report from an earlier assignment.
  A final report must name the current task and current changed files; if work
  was interrupted, report the current partial state instead.
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
node scripts/test-candidate-review.mjs
node scripts/test-render-contracts.mjs
node scripts/test-viewfinder-cue.mjs
node scripts/test-targeting-panel.mjs
node scripts/test-development-scene.mjs
npm run build
git diff --check
```

Run newly added focused tests when their files exist on the current branch.
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

Publish a fresh candidate for every user-testable tranche as soon as it is
integrated, independently reviewed, and its applicable focused checks plus the
full required shell gate pass. Do not wait for unrelated agents, a large
feature bundle, or the end of the session.

1. Set a new unique `id`.
2. Keep `status: 'candidate'` until the user validates the main flow in Edge.
3. Set an accurate `publishedAt` timestamp.
4. Write two to four short notes describing behavior the user can directly
   verify. Do not advertise internal refactors alone.
5. Turn the owning implementation agent's one to five review questions into
   focused `reviewItems`. Each item must retain its stable item ID, owner, and
   affected workspace, and ask one short falsifiable user-visible question.
   Include regressions that this tranche could plausibly reintroduce.
6. The orchestrator adds those `reviewItems` to release metadata only after
   integration review and all required shell gates pass.
7. Mirror the exact label and note bullets in `STABLE_UPDATES.md`.
8. Run the full shell verification gate again.
9. Tell the user what changed and provide a short Edge validation checklist.

Change a build to `stable` only after the agreed shell checks and live Edge
workflow pass. Never update the banner for unreviewed, unmerged, speculative,
or agent-only work.

Do not mutate an already-reviewed candidate in place. Publish a new candidate
ID and initialize its current review items cleanly at `PENDING`; review state is
namespaced by candidate ID even when a stable item ID recurs. Preserve prior
questions, outcomes, comments, and notes in history, but never show solved old
items as the current candidate's checklist. Stale checklist reuse is
prohibited: current items must come from the current tranche's agent report and
plausible current regressions, not be copied forward for convenience.

Every review item has exactly one explicit `PENDING`, `OK`, or `ISSUE` state
plus an optional note. Notes survive state changes and are not a second status.
Keep review text untruncated and copyable so the user can send it back to the
orchestrator. The root routes every `ISSUE` comment to the item's owning agent
and publishes the resulting follow-up question in the next independently
reviewed tranche.

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
