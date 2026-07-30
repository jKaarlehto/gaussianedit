import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFreePort,
  findRuntime,
} from './tracker-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = findRuntime(root);
if (!runtime) {
  throw new Error(
    'Dedicated tracker runtime not found in this worktree or the primary worktree',
  );
}

const port = await findFreePort(18_091);
const origin = `http://127.0.0.1:${port}`;
const instanceToken = randomUUID();
const missingCheckpoint = join(root, '.runtime-test', 'missing-sam31.pt');
const child = spawn(runtime.python, [
  '-m',
  'uvicorn',
  'tracking_service.app:app',
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
  '--log-level',
  'warning',
], {
  cwd: root,
  env: {
    ...process.env,
    GAUSSIANEDIT_RUNTIME_ROOT: runtime.runtimeRoot,
    GAUSSIANEDIT_SAM_CHECKPOINT: missingCheckpoint,
    GAUSSIANEDIT_SERVICE_INSTANCE_TOKEN: instanceToken,
    GAUSSIANEDIT_REQUIRE_CUDA: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});

async function getJson(path) {
  const response = await fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(1_500),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForService(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`service exited with ${child.exitCode}: ${output.trim()}`);
    }
    try {
      const identity = await getJson('/api/sam-tracking/runtime');
      if (identity.instanceToken !== instanceToken) {
        throw new Error('identity token does not match the spawned process');
      }
      return identity;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`service did not start: ${lastError}\n${output.trim()}`);
}

try {
  const identity = await waitForService();
  const capabilities = await getJson('/api/sam-tracking/capabilities');
  const logs = await getJson('/api/sam-tracking/logs?after=0&limit=10');

  if (identity.service !== 'gaussianedit-sam31') {
    throw new Error(`unexpected service identity: ${identity.service}`);
  }
  if (!identity.cudaAvailable || !identity.device?.includes('NVIDIA')) {
    throw new Error(`dedicated CUDA device unavailable: ${identity.device}`);
  }
  if (capabilities.status !== 'waiting-checkpoint') {
    throw new Error(`expected lightweight waiting state, got ${capabilities.status}`);
  }
  if (!Array.isArray(logs.entries) || typeof logs.latestSequence !== 'number') {
    throw new Error('read-only log feed returned an invalid contract');
  }
  if (!logs.entries.some((entry) => entry.message?.includes('service started'))) {
    throw new Error('read-only log feed did not retain the startup event');
  }

  console.log(`Tracker service identity ready · ${identity.device}`);
  console.log(`Process: ${identity.processId} · Python: ${identity.python}`);
  console.log('Capabilities and bounded log feed ready');
} finally {
  if (child.exitCode === null) {
    child.kill();
  }
}
