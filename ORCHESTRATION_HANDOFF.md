# GaussianEdit orchestration handoff — 2026-07-31

This is the compact continuation map for a new local or cloud task. Historical
branch provenance remains in `AGENT_HANDOFF.md`; do not overwrite or replay it.
Read `AGENTS.md`, `PRODUCT_VISION.md`, `UI_MODEL.md`,
`IMPLEMENTATION_TASKS.md`, and `FUSION_ARCHITECTURE.md` before editing.

## Current orchestration snapshot

- `staging` is the root-owned candidate branch. `main` is the last explicitly
  user-accepted state. Workers use isolated `feat/<task-id>` branches and never
  merge directly into either branch.
- Candidate `2026.07.31-rc4` is integrated and shell-verified on the initial
  staging line but remains unaccepted until the user completes its bounded
  Acceptance testing checklist. It must not be advanced to `main` yet.
- No implementation or dispatch lease is active. No product job is authorized
  for cloud dispatch because there is no genuinely unfinished clean immutable
  handoff. This is a safe idle state, not missing orchestration.
- The three inexpensive read-only Luna scans and the adversarial runtime review
  are complete. Their selected fixes were integrated before rc4; scanning
  creates no ownership or completion authority.
- The repo plugin under `plugins/gaussianedit-orchestration/`
  combines the authenticated connector with `$dispatch-cloud-work`. The remote
  web/mobile plugin must be updated from this package before a scheduled task
  can rely on the bundled skill.
- `ORCHESTRATION_KICKOFF_PROMPT.md` is the authoritative new-task prompt for
  reconciling the current WIP. Its completion gate requires clean pushed Git,
  exact board commit authority, zero accidental leases, and matching local and
  production cursors.

## Immutable remote checkpoint

- Candidate branch: `staging`
- Initial staging checkpoint: `83dc66f7a89962ce6a6abf39824af4cd9e7a5e9e`
- Candidate upstream: `origin/staging`
- Stable branch at capture: `main`
- Stable checkpoint: `1251e77b91daf18582f12d49d805937ab3d67486`
- Historical source branch: `feat/object-refinement` at the same initial staging
  checkpoint. Preserve it for provenance; do not keep integrating into it.

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

1. **User Acceptance testing:** run the four rc4 checks in the in-app banner.
2. **Root feedback routing:** record each item explicitly as `OK`, `ISSUE`, or
   still waiting. An issue becomes a new isolated job; it does not mutate rc4.
3. **Promotion:** only when all candidate items are accepted, fast-forward or
   merge that exact accepted staging commit to `main`, push it, and record
   `user_verified` authority at the exact stable commit.
4. **Next development:** publish narrow jobs from the current staging base.
   Before an owner stops, close finished/review-ready work. Any genuinely
   unfinished claimed job defaults to a clean pushed `handoff/*` branch,
   validated manifest, released local claim, dispatch authorization, export,
   and board sync so cloud can continue while the laptop is offline. Dirty,
   unpushed, or untested work stays explicitly local-only and blocked.

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
The shared orchestration ledger is discovered through Git's common directory,
so a handoff prepared in its linked worktree remains visible and its own remote
ref is validated when root exports from `staging`.

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
