---
name: dispatch-cloud-work
description: Dispatch at most one eligible GaussianEdit backlog job through the authenticated board and documented GitHub draft-PR @codex trigger. Use for scheduled or manual catch-up runs that prioritize existing system work before product work, remain idempotent, invent no jobs, and fail closed on unsafe state.
---

# Dispatch GaussianEdit cloud work

Use the GaussianEdit Orchestration plugin for framework/status and dispatch
claims/results, and the GitHub plugin for pull-request and comment operations.
Never scrape HTML, read local files, request an API key, or call an undocumented
native cloud-task endpoint.

## Dispatch one catch-up job

1. Read the current immutable framework and verify its commit, digest, and
   freshness. Call `orchestration_status` and validate `protocol`, `workQueue`,
   `dispatchQueue`, `generatedAt`, `lastSeq`, and `sourceRevision`.
2. Select at most one already-published entry that is both authorized and
   eligible. Require either a new queued job at its clean pushed immutable base,
   or interrupted work with an expired lease and a clean pushed immutable
   handoff. Passing tests are not a dispatch prerequisite; the worker performs
   them. Order eligible
   SYSTEM cleanup/maintenance by priority then age before eligible PRODUCT work
   by priority then age. PRODUCT is GaussianEdit 3D editor work only; board,
   site, connector, orchestration/framework, audit, dispatch, agent,
   release-plumbing, and maintenance work is SYSTEM. Never publish work. Ideas
   remain proposals until root accepts one as a separate job.
3. Derive one stable idempotency key from task ID plus `sourceRevision`. Call
   `dispatch_claim` once for 900 seconds. Treat its opaque lease handle and
   exclusive dispatch execution record as dispatch authority. If the same key
   already has a terminal created result, return it without a GitHub write.
4. Require GitHub `search_prs`, `get_pr_info`, `fetch_issue_comments`,
   `create_pull_request`, and `add_comment_to_issue`, or documented equivalent
   connector actions with identical read/write semantics. Require Codex cloud
   to be confirmed configured for `jKaarlehto/gaussianedit`. Otherwise record
   failed `dispatch_result` with `DISPATCH_UNSUPPORTED`.
5. Find exactly one draft PR from the claimed job branch to `staging`, or
   create it when none exists. Fail closed on ambiguity or a mismatched head.
   Verify the PR resolves the exact claimed job commit.
6. Search PR comments for a stable task-ID/source-revision marker. Reuse an
   existing marked comment. If absent, post exactly one bounded non-review
   comment mentioning `@codex`. Include task ID, branch/commit, owned files,
   remaining work, acceptance, test expectations, and instructions to read
   `AGENTS.md` plus
   the immutable framework, push to the PR branch, and never merge or claim
   `integrated`/`user_verified` authority.
7. Call `dispatch_result` before expiry. On success set `cloudTaskId` to the
   opaque GitHub identifiers `github-pr:<number>:comment:<id>` and
   `cloudTaskUrl` to the canonical PR URL. These generic connector fields do
   not assert a native cloud-task API. On a capability/setup failure record
   `DISPATCH_UNSUPPORTED`; never post a second trigger or create a substitute
   task.

Do not require the GitHub-triggered cloud chat to call the orchestration
connector or acquire a worker lease; that access is not documented. Later
scheduled/root runs reconcile the PR head, commits, and comments against the
exclusive board dispatch record. Worker output is neither integration nor user
verification.

If no job is safely eligible, respond exactly `NOOP`.
