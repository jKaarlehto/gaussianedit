# GaussianEdit scheduled cloud dispatcher

Use this prompt for an hourly ChatGPT scheduled task after the
`GaussianEdit Orchestration` plugin has been installed and authorized in the
same ChatGPT account.

Suggested task name: `GaussianEdit cloud dispatcher`

Suggested plugin description:

> Private GaussianEdit development board and lease coordinator. It reads the
> authenticated orchestration status and immutable agent framework, atomically claims one authorized
> immutable cloud handoff, records cloud-dispatch results, and lets the
> launched worker claim and renew its bounded work lease. It cannot merge,
> publish product code, verify Edge behavior, or access dirty local files.

Scheduled-task prompt:

```text
Use the installed GaussianEdit Orchestration plugin and its
$dispatch-cloud-work skill. Run one fail-closed dispatch cycle for
jKaarlehto/gaussianedit.

First read the current development-framework pointer and its immutable MCP
resource (or the plugin's read-only compatibility action). Verify the source
commit, bundle digest, and freshness. Use that exact framework for this run.
If it is missing, stale, inconsistent, or cannot be authenticated, launch
nothing and report one concise reason.

Read the authenticated machine status through the plugin only. Do not scrape
dashboard HTML, access a local checkout, infer missing context, or ask me for
API keys. Validate the protocol, immutable source freshness, work queue, and
dispatch queue. Dispatch at most one task, and only when the board itself says
the task is authorized and eligible and the matching job contains a clean,
pushed immutable handoff with repository, branch, commit, ownership, tests,
acceptance criteria, and resume source.

Before choosing, read the bounded improvement-idea intake from the status
timeline. Ideas carry a role, evidence, proposal, and priority; they are not
jobs and never authorize themselves. A scheduled dispatcher must not publish
one: it may only select an already-published eligible maintenance job that a
root task has linked to the evidence. When selecting a real handoff, prefer an
eligible board/site/connector/framework maintenance job, then an eligible
product handoff. Default board/system work to agent verification; human
acceptance is reserved for visual, interactive, or policy decisions. This
still permits at most one dispatch in this run.

Atomically claim the dispatch first. Only after that claim succeeds, use a
native Codex cloud task-creation action if this scheduled-task host exposes
one. The worker prompt must require the new cloud task to independently read
the board, verify its exact Git scope, claim its worker lease using its cloud
task ID, perform no implementation before that claim succeeds, renew only
with meaningful changed-fact checkpoints, and close with review or completed.
The worker must never claim integrated or user_verified authority.

Record the created cloud task ID and URL through the plugin before the
dispatch lease expires. If this host cannot create a native Codex cloud task,
record DISPATCH_UNSUPPORTED through the plugin. Never create a local task as a
substitute. Never publish or release jobs, merge, force-push, delete branches
or worktrees, expose credentials, or dispatch dirty/unpushed work.

For board/system feedback, treat `Looks good` as a recorded action that an
agent consumes and archives only after verifying evidence. Keep `Back to loop`
and its note pending until root has routed it into a separately published job.
Product feedback is handled only through the GaussianEdit editor's Acceptance
banner; never present a duplicate product approval on the board.

If nothing is safely eligible, respond exactly:
NOOP
```

This scheduler is a dispatcher, not the root integrator. The repository root
task prepares, pushes, validates, and authorizes handoffs before local owners
stop. The scheduler never creates handoffs or repairs dirty local state. Root
reviews returned work, integrates it,
runs gates, pushes candidates, and records user verification.
