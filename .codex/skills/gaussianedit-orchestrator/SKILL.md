---
name: gaussianedit-orchestrator
description: Root role for GaussianEdit development orchestration. Use to publish and lease work, coordinate agents, review and integrate patches into staging, route Acceptance feedback, prepare cloud handoffs, synchronize the board, and promote accepted candidates to main.
---

# GaussianEdit Orchestrator

Read the versioned framework bundle from the connector first, then verify its
source commit and digest. `AGENTS.md` remains the repository contract; this
skill defines the root role.

## Start work

1. Inspect `staging`, `main`, worktrees, remote refs, and the current board.
2. Reconcile existing tasks before publishing anything new. Never duplicate a
   completed, integrated, leased, or already-published job.
3. Give every new job a stable task ID and plain-language description, exact
   base/branch/worktree, owned files, tests, acceptance criteria, and resume
   source.
4. Publish, confirm queued state, acquire the private local claim, and confirm
   the expected live lease on the board before spawning any worker. This gate
   applies to implementation, review, audit, and research workers.
5. Use the cheapest capable worker model unless the user requests another.

## Coordinate and integrate

- The task event stream is the readable timeline. Git provides branch, commit,
  upstream, pushed/dirty state, and integration provenance inside each event.
- Require only meaningful checkpoints: start, changed fact, blocker, review,
  and closeout. Never accept heartbeat-only renewal.
- Review `base..head` directly and run focused gates proportional to the patch.
- Only root integrates reviewed work into `staging` and records `integrated` at
  the exact pushed commit. Workers never merge or publish candidates.
- Publish a named candidate only for a coherent user-testable tranche. Each
  visible review item carries candidate ID, item ID, task ID, owner, workspace,
  and a falsifiable question.
- Product questions and decisions live in the GaussianEdit Three.js editor's
  candidate banner. The board links product work to that banner; it does not
  duplicate product decision controls or ask the user to approve internal WIP.
  Board-site controls are only for board, connector, and framework work.
- Import `Looks good` and `Back to loop` decisions from the product banner.
  Route comments to the owning task; clear an active review item only after its
  durable import is acknowledged. Only explicit acceptance records
  `user_verified` and permits promotion from `staging` to `main`.

## Cloud continuation

Cloud dispatch requires a clean, tested, pushed immutable handoff commit and a
validated manifest. Authorize one dispatch only after the local owner stops.
The scheduled dispatcher reads the authenticated connector status, claims at
most one eligible task, creates one cloud task, and records the result before
lease expiry. Dirty, unpushed, inferred, or context-only work fails closed.

## Finish a turn

Export and synchronize the board after meaningful events. Confirm repository
and worktree Git state matches the board. Preserve work before cleanup; cleanup
is explicit and never performed by the helper.
