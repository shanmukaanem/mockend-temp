import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('src/vscode/package.json', root), 'utf8'))
const issues = []
if (manifest.publisher !== 'mockend' || manifest.name !== 'mockend') issues.push('Set the VS Code publisher and name to mockend.')
if (!existsSync(new URL('LICENSE', root)) || !manifest.license) issues.push('Choose a license and add LICENSE plus the VS Code manifest license field.')
for (const path of ['PRIVACY.md', 'CHROMEWEBSTORE.md', 'publishing/STORE-LISTING.md', 'publishing/requests.png', 'publishing/rules.png']) {
  if (!existsSync(new URL(path, root))) issues.push(`Missing ${path}`)
}
if (issues.length) {
  console.error(issues.join('\n'))
  process.exit(1)
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/release.mjs', root)), '--check'], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log('Local publishing checks passed. Confirm ownership of the mockend publisher, host the privacy policy, and complete the store forms before submitting.')
