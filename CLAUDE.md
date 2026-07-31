# GaussianEdit Claude Code bridge

Read `AGENTS.md` before acting. It is the repository contract; this file only
adds the Claude Code connection and a concise worker start sequence.

## Connect to the private board

`.mcp.json` declares the project-scoped `gaussianedit-orchestration` remote
MCP. In Claude Code, open `/mcp`, approve the project server, and complete its
OAuth owner sign-in. Never copy a bearer token, OAuth cookie, API key, or a
value from `.codex/orchestration/secrets/` into a prompt, config, commit, or
terminal output.

Request only `board:read` and `worker:write`. Do not request or use
`dispatch:write`: scheduled Codex-cloud dispatch is not a Claude worker role.
If OAuth reports an unsupported redirect URI, stop and report the connector
blocker; do not fall back to a browser scrape, a static token, or a public API.

## Start one job safely (claim-before-edit)

1. Call `get_development_framework` and verify its source commit, bundle
   digest, expiry, and document hashes.
2. Call `orchestration_status`; use live `workQueue`, never rendered board
   HTML or a task-card mirror.
3. Select only an explicitly published, queued, startable job. System work is
   before product work; within a category use priority then age. Never invent
   a job.
4. Call `worker_claim` with your stable agent name and a 300-second lease.
   Do not edit until the returned job matches the task, exact worktree, branch,
   base/head, upstream, owned files, and acceptance criteria.
5. Use `worker_renew` only for a meaningful changed-facts checkpoint. Keep its
   opaque `leaseHandle` private. Closing into review or completed releases the
   lease.

If MCP OAuth is not yet compatible with Claude Code, use the repository
wrapper only when the root has assigned you a named local job:

```powershell
.\scripts\orchestration-board.ps1 claim -Task <task-id> -Agent claude-local-<name> -LeaseSeconds 300
```

The wrapper stores the lease token privately. A failed or invisible claim means
no edits. Never claim integration, merge to `staging` or `main`, or perform
user/Edge acceptance. Commit and push only your bounded task branch; root
reviews and integrates it.
