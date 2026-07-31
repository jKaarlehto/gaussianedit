# GaussianEdit cleanup orchestration kickoff

Start a new Codex task from the GaussianEdit project and paste the prompt below.

```text
Use $orchestrate-development and the installed GaussianEdit Orchestration
plugin. Act as the root orchestrator for this repository and reconcile the
current messy development state into truthful, reviewable, clean Git and board
state. Continue until the cleanup contract below is satisfied; do not merely
write a plan.

First read AGENTS.md, ORCHESTRATION_HANDOFF.md, PRODUCT_VISION.md, UI_MODEL.md,
IMPLEMENTATION_TASKS.md, and FUSION_ARCHITECTURE.md. Inspect the canonical
branch, every worktree, every changed/untracked file, recent commits, upstreams,
the local orchestration summary/inbox/export, and the authenticated production
board. Do not open or control any browser or start development services.

Use inexpensive Luna agents for independent read-only scans of: (1) product
WIP and test coverage, (2) Git/worktree provenance and duplicate changes, and
(3) orchestration/board/cloud-handoff consistency. Scanning grants no ownership
or completion authority. Reconcile their evidence yourself.

Preserve all user and agent work. Do not reset, discard, delete, rebase,
force-push, or blindly cherry-pick. Mark already-incorporated branches and
superseded board records explicitly. Partition remaining changes into the
smallest coherent non-overlapping tranches. Before any implementation prompt,
publish the job with exact base, branch, worktree mode, owned files, acceptance
criteria, and tests; require the worker to claim it atomically. Keep at most
one main.js owner. Root reviews every patch and alone records integrated or
user_verified authority.

Run focused tests and the complete AGENTS.md shell gate for each integrated
tranche. Commit intentionally to staging, push the exact reviewed
candidate, and publish a candidate banner only if the required gates and
independent review pass. Acceptance-testing items remain explicitly pending
until the user verifies them; do not call shell success visual proof.

Use cloud dispatch only for genuinely unfinished work preserved at a clean,
pushed immutable handoff commit. The scheduled dispatcher may claim at most one
eligible job and must use $dispatch-cloud-work. It must not receive local files
or dirty state. If native cloud-task creation is unavailable, record
DISPATCH_UNSUPPORTED instead of creating a substitute task.

Before any local owner or this root task stops, run a remote-preservation
sweep. Close finished/review-ready work. For each genuinely unfinished claimed
job, create and push `handoff/<task-id>-<date>`, validate the exact checkpoint
manifest and upstream ref, release the intentionally stopped local lease as a
confirmed orphan, authorize dispatch, export, and sync. If work is dirty,
unpushed, or untested, keep it explicitly local-only with an owner, blocker,
and next action; never advertise it as cloud-eligible.

After every meaningful local event, synchronize through
scripts/orchestration-board.ps1 sync. Keep product jobs separate from board and
automation jobs. Never expose tokens or persist raw lease credentials.

Completion requires evidence for every item below:

1. Every changed file and worktree is integrated, deliberately abandoned with
   preserved remote provenance, or published as an explicit unfinished job.
2. The canonical staging worktree and every active task worktree are clean.
3. staging HEAD exactly equals origin/staging; main remains at the last
   explicitly user-accepted candidate.
4. Applicable focused tests and the full required shell gate pass at that HEAD.
5. Board task states distinguish worker evidence, root integration, and user
   verification and name the exact commits they prove.
6. No active or expired work/dispatch lease remains accidentally open.
7. Production generatedAt, lastSeq, and sourceRevision match the final local
   export, and no task is dispatch-eligible without an authorized immutable
   handoff.
8. Every genuinely unfinished job is either remote-ready on its own verified
   handoff ref or explicitly local-only and blocked; none is stranded merely
   because its former owner or the laptop stopped.

Return the exact final commit, upstream comparison, clean status for every
worktree, test results, board cursor, remaining Edge questions, and any
deliberately retained branches. If any condition is not met, keep working or
state the concrete blocker; do not report the cleanup complete.
```
