# GaussianEdit scheduled cloud dispatcher

Use this prompt for an hourly ChatGPT scheduled task after both the
`GaussianEdit Orchestration` and `GitHub` plugins have been installed and
authorized in the same ChatGPT account. Codex cloud must also be configured for
`jKaarlehto/gaussianedit`; the dispatcher cannot configure or infer that setup.

Suggested task name: `GaussianEdit cloud dispatcher`

Suggested plugin description:

> Coordinates at most one immutable GaussianEdit handoff through the private
> board and the documented GitHub `@codex` pull-request trigger. It cannot
> publish jobs, access a local checkout, merge code, or verify Edge behavior.

Scheduled-task prompt:

```text
Use the installed GaussianEdit Orchestration and GitHub plugins. Use
$dispatch-cloud-work and run one fail-closed dispatch cycle for
jKaarlehto/gaussianedit. Do not ask for or use an OpenAI API key.

First read the current development-framework pointer and its immutable MCP
resource through GaussianEdit Orchestration. Verify the source commit, bundle
digest, and freshness. Use that exact framework for this run. If it is missing,
stale, inconsistent, or cannot be authenticated, launch nothing and report one
concise reason.

Read authenticated machine status with `orchestration_status` through
GaussianEdit Orchestration only. Do not scrape dashboard HTML, access a local
checkout, infer missing context, or publish a job. Validate protocol, source
freshness, workQueue, and dispatchQueue. Select at most one already-published
entry that the board marks authorized and eligible and whose matching job
contains a clean, pushed, immutable handoff: repository, branch, exact commit,
ownership, passing tests, acceptance criteria, and resume source. Never create
or repair a handoff.

Order existing eligible jobs by category, then priority, then age. SYSTEM means
board, site, connector, orchestration/framework, audit, dispatch, agent,
release-plumbing, and maintenance work. Process eligible SYSTEM cleanup or
maintenance before PRODUCT. PRODUCT means GaussianEdit 3D editor work only.
Within a category use P0 before P1 before P2 before P3, then the oldest
published job. Never invent or auto-publish work. Improvement-intake records
are proposals only; dispatch one only after root has explicitly accepted it by
publishing a separate normal job.

Build a stable idempotency key from the exact task ID and board sourceRevision,
then atomically call dispatch_claim once with a 900-second lease. Treat the
returned dispatch execution record and opaque lease handle as the exclusive
dispatch authority. Do not claim or promise a worker lease for Codex cloud:
plugin/MCP access from the GitHub-triggered cloud chat is not assumed. If the
same idempotency key already has a terminal created result, return that stored
result without making any GitHub write.

After dispatch_claim succeeds, use the GitHub plugin only. Require
`search_prs`, `get_pr_info`, `fetch_issue_comments`, `create_pull_request`, and
`add_comment_to_issue` (or documented equivalent GitHub connector actions with
the same read/write semantics), and require Codex cloud to be confirmed
configured for this repository. Find a draft pull request whose head is the
claimed immutable handoff branch and whose base is staging. Reuse exactly one
match; create one only when none exists; fail closed on ambiguous or mismatched
matches. Verify the PR resolves the claimed branch and exact handoff commit
before commenting.

Use a stable marker derived from task ID plus sourceRevision. Search all PR
comments for that marker before writing. If it already exists, do not post
again; reuse its PR and comment identifiers. Otherwise add exactly one bounded,
non-review PR comment that mentions @codex and asks it to implement the
remaining work on the PR branch. Include only the stable marker, task ID,
handoff branch and commit, owned files, remaining-work summary, passing tests,
acceptance criteria, and instructions to read AGENTS.md plus the immutable
framework. Require Codex to push results to the same PR branch, report tests,
and never merge, target main, claim integrated/user_verified authority, or
access local-only state.

Before the dispatch lease expires, call `dispatch_result` with outcome
`created`, `cloudTaskId` set to the opaque GitHub identifiers
`github-pr:<number>:comment:<id>`, and `cloudTaskUrl` set to the canonical PR
URL. These generic result field names are the existing connector schema; they
do not assert a native cloud-task API.

The PR/comment facts, exact branch commit, and board dispatch execution record
are the durable handoff evidence. Later scheduled/root runs reconcile the PR
head and comments with the board; the triggering cloud chat is not treated as
integrated or user-verified proof.

If GitHub read/write actions are unavailable, Codex cloud repository setup is
absent or unconfirmed, the PR/comment cannot be proved idempotent, or any step
after dispatch_claim fails, call dispatch_result with outcome failed and
failureCode DISPATCH_UNSUPPORTED when capability/setup is the cause (otherwise
use the connector's bounded failure code). Never substitute an undocumented
native cloud-task endpoint, a local task, or a second comment. Never publish or
release jobs, merge, force-push, delete branches/worktrees, expose credentials,
or dispatch dirty or unpushed work.

For board/system feedback, treat Looks good as a recorded action that an agent
consumes and archives only after verifying evidence. Keep Back to loop and its
note pending until root routes it into a separately published job. Product
feedback exists only in the GaussianEdit editor Acceptance banner.

If nothing is safely eligible, respond exactly:
NOOP
```

This scheduler is a dispatcher, not the root integrator. Root prepares and
authorizes immutable handoffs, reviews returned PR commits, integrates into
`staging`, runs gates, publishes candidates, and records user verification.
