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
- Board/connector/framework tasks default to agent verification. Require human
  Acceptance only for a visual, interactive, or policy decision that cannot be
  verified by tests, deployment state, protocol checks, or authenticated
  probes; record that reason on the task.
- Import `Looks good` and `Back to loop` decisions from the product banner.
  Route comments to the owning task; clear an active review item only after its
  durable import is acknowledged. Only explicit acceptance records
  `user_verified` and permits promotion from `staging` to `main`.

## Improvement ideas and board decisions

- A worker or orchestrator may submit a bounded improvement idea with
  `scripts/orchestration-board.ps1 idea -Agent <id> -Role worker|orchestrator
  -IdeaPriority P0..P3 -Evidence <one-line-fact> -Proposal <one-line-change>`.
  The wrapper records a typed `IDEA` comment on the dedicated
  `orchestration-improvement-intake` record. It is visible in the board's
  timeline, but is deliberately not a job, claim, handoff, dispatch authority,
  integration record, or user-verification record.
- Root evaluates each idea against current evidence, duplication, ownership,
  security, and user value. Root records `reject`, `defer`, or the stable task
  ID it published separately. An idea never authorizes its own implementation.
- Board/system work defaults to agent verification. Ask for human acceptance
  only when a visual/interactive behavior, product decision, or policy choice
  genuinely requires it.
- For board/system items, `Looks good` is only a recorded decision. Consume and
  archive it after an agent verifies the stated evidence. `Back to loop` stays
  pending with its note until root routes it to a separately published task.
  For product items, the GaussianEdit editor's Acceptance banner is the sole
  decision surface; the board only reflects its acknowledged result.

## Cloud continuation

Cloud dispatch requires a clean, tested, pushed immutable handoff commit and a
validated manifest. Authorize one dispatch only after the local owner stops.
The scheduled dispatcher reads the authenticated connector status, claims at
most one eligible task, creates one cloud task, and records the result before
lease expiry. Dirty, unpushed, inferred, or context-only work fails closed.
On every scheduled pass, evaluate eligible board/site/connector/framework
maintenance handoffs before product handoffs. Evaluate the bounded idea inbox
as root input before selecting work, but never dispatch an idea itself. Select
at most one already-published eligible job.

## Finish a turn

Export and synchronize the board after meaningful events. Confirm repository
and worktree Git state matches the board. Preserve work before cleanup; cleanup
is explicit and never performed by the helper.
