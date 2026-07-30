import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFreePort,
  findRuntime,
  probeRuntime,
} from './tracker-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = findRuntime(root);
if (!runtime) {
  throw new Error(
    'Dedicated tracker runtime not found in this worktree or the primary worktree',
  );
}
const report = probeRuntime(root, runtime);
const requestedPort = Number.parseInt(
  process.env.GAUSSIANEDIT_TRACKER_PORT || '8091',
  10,
);
const port = await findFreePort(requestedPort);
console.log(`Starting SAM 3.1 tracker on http://127.0.0.1:${port}`);
console.log(`${report.device} · ${runtime.python}`);

const child = spawn(runtime.python, [
  '-m',
  'uvicorn',
  'tracking_service.app:app',
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
], {
  cwd: root,
  env: {
    ...process.env,
    GAUSSIANEDIT_RUNTIME_ROOT: runtime.runtimeRoot,
    GAUSSIANEDIT_REQUIRE_CUDA: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
});

process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
