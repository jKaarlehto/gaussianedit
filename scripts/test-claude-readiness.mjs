import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

const mcp = JSON.parse(await text(".mcp.json"));
assert.deepEqual(Object.keys(mcp), ["mcpServers"]);
const servers = mcp.mcpServers;
assert.deepEqual(Object.keys(servers), ["gaussianedit-orchestration"]);
assert.deepEqual(servers["gaussianedit-orchestration"], {
  type: "http",
  url: "https://gaussianedit-orchestration-connector.juhana-kaa.chatgpt.site/api/mcp"
});

const settings = JSON.parse(await text(".claude/settings.json"));
assert.equal(settings.permissions.defaultMode, "default");
assert(settings.permissions.deny.includes("Read(.codex/orchestration/secrets/**)"));
assert(settings.permissions.deny.includes("Read(.env)"));
assert(settings.permissions.deny.includes("Read(.env.*)"));

const guide = await text("CLAUDE.md");
for (const required of [
  "get_development_framework",
  "orchestration_status",
  "worker_claim",
  "worker_renew",
  "board:read",
  "worker:write",
  "dispatch:write",
  "claim-before-edit",
  "orchestration-board.ps1"
]) assert(guide.includes(required), `CLAUDE.md must mention ${required}`);
assert(!/Bearer\s+[A-Za-z0-9._-]{16,}/.test(`${guide}\n${JSON.stringify(mcp)}\n${JSON.stringify(settings)}`));

console.log("claude-readiness contract: pass");
