# GaussianEdit development orchestration kickoff

Start a new Codex task from the GaussianEdit project and paste the prompt below.

```text
Use $orchestrate-development and the installed GaussianEdit Orchestration
plugin. Act as the root orchestrator for this repository and reconcile the
current messy development state into truthful, reviewable, clean Git and board
state, then immediately resume the highest-priority unfinished product work.
Continue until the contract below is satisfied; do not merely write a plan or
keep refining the board after it is operational.

Read the MCP development-framework current pointer and its immutable bundle
before claiming work. Verify its source commit and digest. If the pointer is
missing, stale, or inconsistent with the pushed repository contract, fail
closed and report that single blocker instead of improvising workflow rules.

First read AGENTS.md, ORCHESTRATION_HANDOFF.md, PRODUCT_VISION.md, UI_MODEL.md,
IMPLEMENTATION_TASKS.md, and FUSION_ARCHITECTURE.md. Inspect the canonical
branch, every worktree, every changed/untracked file, recent commits, upstreams,
the local orchestration summary/inbox/export, and the authenticated production
board. Do not open or control any browser. After framework verification and
the minimum safe repository/service checks, inspect exact PIDs and command
lines for the supervised staging stack. If it is already running, do not
duplicate it; otherwise start `npm run dev` from the canonical `staging`
worktree as the first operational action. Keep it running and report
`http://localhost:5173/` plus the supervised stdout/stderr paths. The user
performs all visual validation manually in Microsoft Edge.

Treat the bounded `orchestration-improvement-intake` timeline as proposals,
not work. A worker/orchestrator proposal contains role, evidence, proposal,
and priority. Evaluate it as root: record reject/defer, or publish a separate
job with normal ownership and acceptance. It never self-authorizes
implementation, job publication, cloud dispatch, integration, or user
verification. Prioritize already-published eligible SYSTEM cleanup and
maintenance by priority then age, followed by already-published eligible
PRODUCT work by priority then age. SYSTEM includes board, site, connector,
orchestration/framework, audit, dispatch, agent, release-plumbing, and
maintenance work. PRODUCT means GaussianEdit 3D editor work only. Board/system
tasks are agent-verifiable by default; ask the user only for genuinely visual,
interactive, or policy decisions.

Use inexpensive Luna agents when available, otherwise the cheapest available
model, only for temporary independent read-only board-status scans of: (1)
product WIP and test coverage, (2) Git/worktree provenance and duplicate
changes, and (3) orchestration/board/cloud-handoff consistency. Scanning grants
no completion authority. Every scan, review, research, or implementation
subagent still requires the hard launch gate: publish the exact job, confirm it
queued, claim through the private wrapper, confirm the visible unexpired lease,
and only then spawn the agent. Reconcile their evidence yourself. Never
reconstruct a lease after spawning. Choose normal implementation and review
worker models for the task's actual complexity; do not default them to Luna or
the cheapest model.

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

Human verification happens only on a named candidate built from staging. Turn
each integrated tranche's short falsifiable review questions into separate
in-product banner items with stable item ID, task ID, owning agent, and
workspace. The banner offers `Looks good` and `Back to loop`; the latter
requires a comment and the former may include one. Import banner decisions into
the orchestration ledger and board. Record `user_verified` only from an explicit
`Looks good`. Route every `Back to loop` comment to the owning task as new work,
preserve it in history, and clear the item from the active banner only after the
decision has been imported successfully. If the banner-to-board bridge is not
implemented, publish and complete that bounded bridge as the first workflow
task; never pretend browser-local state is visible to cloud orchestration.

For board/system actions, `Looks good` is a recorded decision, not Git or
completion authority: verify the evidence, consume it, then archive the item.
Keep `Back to loop` and its comment pending until it is routed to a separately
published task. Product decisions remain solely in the GaussianEdit editor
Acceptance banner; never duplicate them on the board.

Use cloud dispatch for an existing new queued job at its clean pushed immutable
base, or for genuinely unfinished work preserved at a clean pushed immutable
handoff after its short worker lease expires. Passing tests are not a dispatch
prerequisite; the resumed worker runs them. The scheduled dispatcher may claim
at most one eligible job and must use $dispatch-cloud-work. It must not receive
local files or dirty state. It uses the documented GitHub path only: open or
reuse the job branch's draft PR into `staging`, then post one bounded idempotent
non-review
`@codex` implementation comment. Require the GaussianEdit Orchestration and
GitHub plugins and no API key. If GitHub writes or configured Codex cloud
repository support are unavailable, record `DISPATCH_UNSUPPORTED`; never use
an undocumented native cloud-task API. The board's exclusive dispatch record,
GitHub PR/comment IDs, and later PR/commit reconciliation are authoritative;
do not assume the GitHub-triggered cloud chat can access connector worker
leases.

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
9. At least one real unfinished product job is published on its existing stable
   task ID and can be safely claimed locally or dispatched from an immutable
   handoff. If no product work remains, prove that against IMPLEMENTATION_TASKS
   and the named candidate instead of inventing a job.
10. Candidate banner decisions are durably importable into the board and route
    `Back to loop` comments without silently marking work verified.

Return the exact final commit, upstream comparison, clean status for every
worktree, test results, board cursor, remaining Edge questions, and any
deliberately retained branches. If any condition is not met, keep working or
state the concrete blocker; do not report the cleanup complete.
```
