import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

const windows = process.platform === 'win32';

export function pythonFor(runtimeRoot) {
  return windows
    ? join(runtimeRoot, 'sam3-service-venv', 'Scripts', 'python.exe')
    : join(runtimeRoot, 'sam3-service-venv', 'bin', 'python');
}

function primaryWorktreeRoot(root) {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return null;
  const commonDirectory = result.stdout.trim();
  return commonDirectory ? dirname(commonDirectory) : null;
}

export function runtimeCandidates(root) {
  const configured = process.env.GAUSSIANEDIT_RUNTIME_ROOT?.trim();
  const primary = primaryWorktreeRoot(root);
  return [...new Set([
    configured && resolve(configured),
    join(root, '.runtime'),
    primary && join(primary, '.runtime'),
  ].filter(Boolean))];
}

export function findRuntime(root) {
  for (const runtimeRoot of runtimeCandidates(root)) {
    const python = pythonFor(runtimeRoot);
    if (existsSync(python)) return { runtimeRoot, python };
  }
  return null;
}

export function probeRuntime(root, runtime) {
  const result = spawnSync(
    runtime.python,
    [join(root, 'scripts', 'check_tracker_runtime.py'), '--json'],
    {
      cwd: root,
      env: {
        ...process.env,
        GAUSSIANEDIT_RUNTIME_ROOT: runtime.runtimeRoot,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    },
  );
  const output = result.stdout.trim();
  let report = null;
  try {
    report = output ? JSON.parse(output) : null;
  } catch {
    // The explicit stderr below is more useful than a JSON parsing exception.
  }
  if (result.status !== 0 || !report?.ok) {
    const reason = report?.problems?.join('; ')
      || result.stderr.trim()
      || output
      || `runtime check exited with ${result.status}`;
    throw new Error(reason);
  }
  return report;
}

export async function findFreePort(first = 8091, attempts = 40) {
  if (!Number.isInteger(first) || first < 1 || first > 65_535) {
    throw new Error(`Invalid tracker port: ${first}`);
  }
  for (let port = first; port < Math.min(65_536, first + attempts); port += 1) {
    const available = await new Promise((resolveAvailability) => {
      const server = createServer();
      server.unref();
      server.once('error', () => resolveAvailability(false));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close(() => resolveAvailability(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No free tracker port found from ${first}`);
}
