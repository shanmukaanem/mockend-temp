import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./build.py', import.meta.url));
const launchers = process.platform === 'win32'
  ? [['py', '-3'], ['python3'], ['python']]
  : [['python3'], ['python']];

for (const [command, ...options] of launchers) {
  const result = spawnSync(command, [...options, script], { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
  const release = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const updated = spawnSync(process.execPath, [release], { stdio: 'inherit' });
  if (updated.error) console.error(updated.error.message);
  process.exit(updated.status ?? 1);
}

console.error('Python 3.10 or newer is required. Install Python and add it to PATH.');
process.exit(1);
