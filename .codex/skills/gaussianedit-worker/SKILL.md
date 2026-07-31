---
name: gaussianedit-worker
description: Worker role for leased GaussianEdit product jobs. Use after a published task has been atomically claimed to verify scope, implement only owned work, post meaningful checkpoints with Git provenance, and close for root review without integrating.
---

# GaussianEdit Worker

Do no implementation until the published task has a successful atomic claim
for your exact agent identity and the board shows your unexpired lease.

## Begin

1. Read the connector's versioned framework bundle and verify its source commit
   and digest.
2. Independently GET the task, then verify repository, base, branch, immutable
   commit, worktree mode, owned files, acceptance criteria, tests, and resume
   source against Git.
3. If anything is missing, stale, dirty, unpushed, inconsistent, or owned by
   someone else, change nothing and post one concise blocker.
4. Post one start checkpoint only after scope verification succeeds.

## Work

- Modify only owned files and never merge, rebase, force-push, target `main`,
  publish a candidate, change release authority, or clean up branches/worktrees.
- Preserve unrelated user changes. Keep the patch narrow and coherent.
- Post only changed facts, tests, blockers, and the next action. Each
  code-changing checkpoint attaches branch, immutable commit when available,
  upstream/pushed state, dirty state, and focused tests. Commit messages alone
  are not status.
- Renew the lease only with a meaningful checkpoint. Never print, persist, or
  transmit its plaintext token outside the private claim mechanism.
- For user-visible behavior, return one to five stable, falsifiable Acceptance
  questions with owning task and workspace. Otherwise return exactly
  `none: no user-visible change`.
- Product review questions are rendered in the GaussianEdit editor candidate
  banner. Never turn branch names, internal review tasks, shell proofs, or WIP
  checkpoints into user Acceptance items.
- If you identify a workflow improvement, submit one bounded idea through the
  board wrapper with role, evidence, proposal, and priority. The idea is
  separate from your job and gives you no authority to implement, dispatch,
  integrate, or verify it. Continue only the task you already own.

## Close

Create and push one or a few coherent commits only after relevant tests pass.
Finish with a `review` or `completed` checkpoint containing the exact head and
clean/dirty state; this closes the work lease. Never mark work `integrated` or
`user_verified`. Root owns patch review, integration into `staging`, candidate
publication, feedback routing, promotion to `main`, and cleanup.
