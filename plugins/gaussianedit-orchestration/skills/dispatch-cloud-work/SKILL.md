---
name: dispatch-cloud-work
description: Safely dispatch at most one eligible GaussianEdit board job to a Codex cloud task. Use for scheduled or manual orchestration runs that must read the authenticated board, atomically claim an immutable handoff, create a cloud worker, record the result, and otherwise return NOOP.
---

# Dispatch GaussianEdit cloud work

Use only the plugin tools `orchestration_status`, `dispatch_claim`,
`dispatch_result`, `worker_claim`, and `worker_renew`. Use a native Codex cloud
task-creation tool only when the current host exposes one. Never substitute a
local task, local files, dashboard HTML, guessed context, or an undocumented
HTTP endpoint for cloud creation.

## Dispatch one job

1. Call `orchestration_status`. Validate `protocol`, `workQueue`,
   `dispatchQueue`, `generatedAt`, `lastSeq`, `sourceRevision`, and freshness.
   Fail closed on authentication, storage, schema, cursor, or consistency
   errors and report one concise reason.
2. Select at most one entry whose `authorized` and `eligible` values are true.
   Require the matching published work job to be startable and to name the
   repository, branch, immutable commit, ownership, passing tests, acceptance
   criteria, and resume or handoff source. Require no active work or dispatch
   lease. Do not reinterpret an eligibility reason.
   Handoff preparation is root-only and must already be complete. Never invent,
   repair, or authorize a handoff from the scheduled dispatcher.
3. Create one stable idempotency key from the exact task ID and source
   revision. Reuse that key for retries of the same revision. Call
   `dispatch_claim` once with a 900-second lease.
4. After a successful claim, require a native Codex cloud task-creation tool.
   Create exactly one task for `jKaarlehto/gaussianedit` using only the claimed
   immutable branch, commit, handoff, owned files, remaining work, tests, and
   acceptance criteria.
5. In the worker prompt, require the worker to call `orchestration_status`,
   verify the task and Git scope, call `worker_claim` with its cloud task ID,
   and start no implementation unless the claim succeeds. Require meaningful
   `worker_renew` checkpoints only when facts change. Finish with `review` or
   `completed`; never claim `integrated` or `user_verified`.
6. Record successful creation with `dispatch_result`, the original task ID,
   source revision and idempotency key, the opaque dispatch `leaseHandle`, and
   the returned cloud task ID and URL.
7. If no native cloud task creator is available after claiming, immediately
   call `dispatch_result` with outcome `failed` and failure code
   `DISPATCH_UNSUPPORTED`.

If nothing is safely eligible, respond exactly `NOOP`.

## Safety

- Never dispatch more than one task per run.
- Never print, store, or request raw lease tokens. Treat plugin lease handles
  as opaque.
- Never publish or release jobs, merge, force-push, delete branches or
  worktrees, expose credentials, or dispatch dirty or unpushed work.
- Never renew without a meaningful checkpoint.
- Do not turn worker completion into integration proof. Root review and human
  user Acceptance testing remain separate authority levels.
