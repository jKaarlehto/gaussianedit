import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(root, ".codex", "orchestration", "framework-manifest.json"));
const files = [
  ["agent-guide", "AGENTS.md"],
  ["orchestrator-skill", ".codex/skills/gaussianedit-orchestrator/SKILL.md"],
  ["worker-skill", ".codex/skills/gaussianedit-worker/SKILL.md"],
  ["orchestration-handoff", "ORCHESTRATION_HANDOFF.md"],
  ["orchestration-kickoff", "ORCHESTRATION_KICKOFF_PROMPT.md"],
  ["scheduled-dispatch", "SCHEDULED_DISPATCH_PROMPT.md"],
  ["dispatch-plugin-manifest", ".agents/plugins/plugins/gaussianedit-orchestration/.codex-plugin/plugin.json"],
  ["dispatch-plugin-app", ".agents/plugins/plugins/gaussianedit-orchestration/.app.json"],
  ["dispatch-skill", ".agents/plugins/plugins/gaussianedit-orchestration/skills/dispatch-cloud-work/SKILL.md"],
  ["product-vision", "PRODUCT_VISION.md"],
  ["implementation-tasks", "IMPLEMENTATION_TASKS.md"],
  ["ui-model", "UI_MODEL.md"],
  ["fusion-architecture", "FUSION_ARCHITECTURE.md"],
  ["orchestration-protocol", ".codex/orchestration/config.json"],
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("full source commit required");

const documents = [];
for (const [id, relativePath] of files) {
  const content = await readFile(path.join(root, relativePath), "utf8");
  documents.push({ id, path: relativePath.replaceAll("\\", "/"), sha256: sha256(content), content });
}
const bundleDigest = sha256(JSON.stringify(documents));
const generatedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const manifest = {
  schemaVersion: 1,
  frameworkVersion: "1.0.0",
  sourceCommit,
  bundleSha256: bundleDigest,
  generatedAt,
  expiresAt,
  documents,
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, sourceCommit, bundleSha256: bundleDigest, documents: documents.length }));
