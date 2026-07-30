import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const windows = process.platform === 'win32';
const trackerPython = join(
  root,
  '.runtime',
  'sam3-service-venv',
  'Scripts',
  windows ? 'python.exe' : 'python',
);
const children = [];

if (existsSync(trackerPython)) {
  const tracker = spawn(trackerPython, [
    '-m',
    'uvicorn',
    'tracking_service.app:app',
    '--host',
    '127.0.0.1',
    '--port',
    '8091',
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  tracker.on('exit', (code) => {
    if (code && code !== 1) console.warn(`[tracker] exited with code ${code}`);
  });
  children.push(tracker);
} else {
  console.warn('[tracker] local SAM runtime not installed; using browser-guided masks');
}

const viteExecutable = join(
  root,
  'node_modules',
  '.bin',
  windows ? 'vite.cmd' : 'vite',
);
const vite = spawn(viteExecutable, process.argv.slice(2), {
  cwd: root,
  env: process.env,
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
