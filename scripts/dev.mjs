import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFreePort,
  findRuntime,
  probeRuntime,
} from './tracker-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const children = [];

async function waitForTracker(origin, instanceToken, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`tracker process exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/api/sam-tracking/runtime`, {
        signal: AbortSignal.timeout(1_500),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.detail || `HTTP ${response.status}`);
      if (body.instanceToken !== instanceToken) {
        throw new Error('the port answered from a different tracker process');
      }
      return body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`tracker did not become reachable (${lastError || 'timeout'})`);
}

let trackerOrigin = '';
let trackerStartupIssue = '';
let trackerChild = null;
const runtime = findRuntime(root);
if (runtime) {
  try {
    const report = probeRuntime(root, runtime);
    const trackerPort = await findFreePort(
      Number.parseInt(process.env.GAUSSIANEDIT_TRACKER_PORT || '8091', 10),
    );
    const instanceToken = randomUUID();
    trackerOrigin = `http://127.0.0.1:${trackerPort}`;
    const tracker = spawn(runtime.python, [
      '-m',
      'uvicorn',
      'tracking_service.app:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(trackerPort),
    ], {
      cwd: root,
      env: {
        ...process.env,
        GAUSSIANEDIT_RUNTIME_ROOT: runtime.runtimeRoot,
        GAUSSIANEDIT_SERVICE_INSTANCE_TOKEN: instanceToken,
        GAUSSIANEDIT_REQUIRE_CUDA: '1',
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    trackerChild = tracker;
    children.push(tracker);
    await waitForTracker(trackerOrigin, instanceToken, tracker);
    console.log(
      `[tracker] SAM 3.1 service ${trackerOrigin} · ${report.device} · ${runtime.python}`,
    );
  } catch (error) {
    trackerStartupIssue = error instanceof Error ? error.message : String(error);
    trackerOrigin = '';
    if (trackerChild && trackerChild.exitCode === null) trackerChild.kill();
    trackerChild = null;
    console.error(`[tracker] unavailable: ${trackerStartupIssue}`);
  }
} else {
  trackerStartupIssue = [
    'The dedicated SAM 3.1 runtime was not found.',
    'Expected .runtime\\sam3-service-venv (or GAUSSIANEDIT_RUNTIME_ROOT).',
  ].join(' ');
  console.error(`[tracker] unavailable: ${trackerStartupIssue}`);
}

const viteExecutable = join(
  root,
  'node_modules',
  '.bin',
  windows ? 'vite.cmd' : 'vite',
);
const vite = spawn(viteExecutable, process.argv.slice(2), {
  cwd: root,
  env: {
    ...process.env,
    GAUSSIANEDIT_TRACKER_ORIGIN: trackerOrigin,
    GAUSSIANEDIT_TRACKER_STARTUP_ISSUE: trackerStartupIssue,
  },
  stdio: 'inherit',
  shell: windows,
  windowsHide: true,
});
children.push(vite);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 80).unref();
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
vite.on('exit', (code) => stop(code ?? 0));
trackerChild?.on('exit', (code) => {
  if (stopping) return;
  console.error(`[tracker] service stopped unexpectedly (code ${code ?? 'unknown'})`);
  stop(code || 1);
});
