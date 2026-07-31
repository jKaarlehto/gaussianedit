# GaussianEdit orchestration handoff — 2026-07-31

This is the compact continuation map for a new local or cloud task. Historical
branch provenance remains in `AGENT_HANDOFF.md`; do not overwrite or replay it.
Read `AGENTS.md`, `PRODUCT_VISION.md`, `UI_MODEL.md`,
`IMPLEMENTATION_TASKS.md`, and `FUSION_ARCHITECTURE.md` before editing.

## Current orchestration snapshot

- The production board is synchronized through local event 49. The completed
  OAuth smoke claim is released, and no raw work token remains in generated
  job state.
- No product job is currently authorized for cloud dispatch. That is correct:
  the integration checkout is dirty, no immutable handoff manifest exists, and
  the reviewed WIP has not received root `integrated` authority.
- Three inexpensive read-only Luna scans were used to inventory product WIP,
  orchestration integrity, and offline dispatch. Scanning creates no ownership
  or completion authority.
- The next root task is cleanup orchestration, not new feature expansion:
  classify the shared diff, mark superseded records, run the required gates,
  and partition the smallest coherent review/integration tranches.
- The repo plugin under `.agents/plugins/plugins/gaussianedit-orchestration/`
  combines the authenticated connector with `$dispatch-cloud-work`. The remote
  web/mobile plugin must be updated from this package before a scheduled task
  can rely on the bundled skill.
- `ORCHESTRATION_KICKOFF_PROMPT.md` is the authoritative new-task prompt for
  reconciling the current WIP. Its completion gate requires clean pushed Git,
  exact board commit authority, zero accidental leases, and matching local and
  production cursors.

## Immutable remote checkpoint

- Integration branch: `feat/object-refinement`
- Pushed checkpoint: `ed0c9a7afd46c4d6f6d47e78a122edacacfe7a32`
- Upstream at capture: `origin/feat/object-refinement`
- The shared main worktree contains uncommitted integration work after that
  checkpoint. A cloud task must use an exact later pushed commit, never assume
  this dirty state exists remotely.

## Shared main-worktree provenance

There is no active implementation lease in the shared checkout. Root owns the
preserved dirty state until it republishes narrow jobs. Only one future agent
may edit `main.js`.

| Owner | Priority | Files / responsibility |
| --- | --- | --- |
| root orchestrator | P0 | Review, integration, Git, candidate metadata, routing Edge feedback; unassigned shared WIP remains root-owned until explicitly repartitioned |
| root orchestrator | P0 | Preserved `main.js`, scan coordinator, memory budget, compact lookup, and related tests until review partitions them |
| root orchestrator | P1 | `AGENTS.md`, `.codex/orchestration/`, `ORCHESTRATION_HANDOFF.md`, board wrapper, and plugin package |
| no active owner | P1 | Hosted/cloud continuation; dispatch remains closed until a clean pushed handoff is deliberately authorized |

Current dirty integration files also include `index.html`, `lift.js`,
`multiviewRefinement.js`, `pipelineProfiler.js`,
`pipelineInstrumentation.js`, their focused tests, and the feature-off
`evidenceInspector.js` tranche. Treat these as preserved shared WIP; inspect
their diffs and ask the root before assigning overlapping ownership.

## Preserved legacy worktrees

Keep these worktrees and branches intact. Their old commits were already
incorporated; do not cherry-pick them again.

| Worktree | Branch | Historical commit |
| --- | --- | --- |
| `gaussianedit-worktrees/selection-core` | `feat/fix-selection-core` | `34e5cdd` |
| `gaussianedit-worktrees/sam-tracker` | `feat/sam-tracker-runtime` | `c1e1277` |
| `gaussianedit-worktrees/scan-tray` | `feat/scan-tray-choreography` | `1b35a57` |

No orchestration helper is authorized to delete a branch, worktree, or source
file. Cleanup events are audit records only.

## Active WIP and order

1. **P0 root cleanup:** review the current shared WIP against `ed0c9a7`, map
   every changed file to one coherent tranche, and identify duplicate or
   superseded board records before assigning implementation.
2. **P0:** make confirmed `Use this object` start the real ordered all-sides
   pipeline through `ScanCoordinator`; accepted tray evidence must update the
   3D object.
3. **P0:** preserve immutable selection-frame/matrix parity and prevent stale
   2D raster overlays from appearing over a moved 3D camera.
4. **P0:** keep the 3D preview independent: no YOLO HUD, real Gaussian mode,
   continuous hover pause/resume phase, stable framing, no grey unavailable
   control presented as complete.
5. **P1:** retain revisioned postcard previews, cancellation, byte budgets,
   profiler attribution, and bounded diagnostics.
6. **P2 / feature-off:** evidence fusion research and Inspect Evidence. It may
   not delay or enter the live path ahead of the P0 flow.

## Inspect Evidence: finished-pipeline group editor

The user wants to understand and edit *why spatial parts of the finished object
exist*, without exposing an exploding research matrix in the normal flow.
`INSPECT_EVIDENCE_DESIGN.md` is authoritative and
`INSPECT_EVIDENCE_DEFAULT` stays `false`.

- Open one secondary `Inspect evidence` overlay from a finished 3D Object.
- Show compact **Passes** such as Visible selection, Hidden-side tracking, Gap
  fill, Local refinement, and Manual changes.
- Show only support combinations that actually occur, such as
  `Visible + tracking`, `Tracking only`, or `Gap fill only`; never enumerate
  the theoretical pass power set.
- Within a support combination, lazily group connected Gaussian components so
  a suspicious strand or patch can be selected and highlighted.
- Keep the common view bounded to impactful rows; aggregate tiny combinations
  and fragments until expanded.
- Pass/cohort/part toggles are non-destructive previews. A saved change must
  replay retained causal evidence in a bounded ROI and produce exact added,
  removed, and disputed Gaussian IDs. A renderer-only hide is labelled
  `Hide in preview` and cannot silently become the object.
- Parameter controls come from safe provider-owned schemas. Missing lineage,
  replay data, budget, or revision parity fails closed.

Current `evidenceInspector.js` is a browser-free grouping/recompute-plan
reference only. It is not wired to `main.js`, the 3D workspace, or live fusion.

## Token-light status and dashboard flow

Use the personal `$orchestrate-development` skill. Its helper lives at:

```text
C:\Users\JuhanaKaarlehto\.codex\skills\orchestrate-development\scripts\orchestrate.py
```

Workers append tiny `delegation`, `checkpoint`, `review`, `blocked`, or
`completed` events. The root polls `inbox --after <seq>`, validates patches and
tests, then alone appends `integrated` or `user_verified` authority. Run
`export` after meaningful changes.

The status site and any scheduled dispatcher consume the same generated
`.codex/orchestration/dashboard.json`; automation never scrapes dashboard UI.
Its task cards distinguish agent claims, root integration, and user
verification. Live event files and handoff manifests are local generated state
and intentionally ignored by Git.

Before every cloud dispatch, run `handoff` and then `dispatch`. The helper
refuses an unknown dashboard task, missing ownership/acceptance/passing tests,
a dirty or unpushed branch, an integrated record that does not name exact
`HEAD`, or a stale/tampered manifest. Worktrees and files persist between local
tasks; conversation/private context does not. Cloud tasks receive only the
immutable pushed commit plus explicit handoff.

## Exact green definition

A tranche is not green until its focused tests and every applicable command
below pass from the exact intended tree:

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
node scripts/test-visible-object-gate.mjs
node scripts/test-pipeline-profiler.mjs
node scripts/test-pipeline-instrumentation.mjs
node scripts/test-scan-memory-budget.mjs
node scripts/test-evidence-inspector.mjs
npm run build
git diff --check
```

Missing optional focused files are skipped only when they genuinely do not
exist on the branch. Shell green means shell-verified, not visually correct.
The user alone marks live behavior `user_verified` after testing in Microsoft
Edge. Publish a fresh candidate banner only after independent review finds no
blocking correctness/performance issue and the required gate is green.
