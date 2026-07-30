import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntime, probeRuntime } from './tracker-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = findRuntime(root);
if (!runtime) {
  throw new Error(
    'Dedicated tracker runtime not found in this worktree or the primary worktree',
  );
}
const report = probeRuntime(root, runtime);
console.log(`SAM 3.1 runtime ready · ${report.device}`);
console.log(`Python: ${report.python}`);
console.log(`Checkpoint: ${report.checkpoint}`);
