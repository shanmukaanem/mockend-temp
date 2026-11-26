import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vsix = fileURLToPath(new URL('../release/Mockend.vsix', import.meta.url))
// Invoke the user's installed CLI; --force updates the same extension identity.
const result = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', `code --install-extension "${vsix}" --force`], { stdio: 'inherit' })
  : spawnSync('code', ['--install-extension', vsix, '--force'], { stdio: 'inherit' })
if (result.error) console.error('VS Code CLI not found. Enable the code command or use Extensions: Install from VSIX with release/Mockend.vsix.')
process.exit(result.status ?? 1)
