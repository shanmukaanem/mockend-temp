import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const files = ['package.json', 'package-lock.json', 'src/chromium/manifest.json', 'src/vscode/package.json']
const documents = files.map(path => JSON.parse(readFileSync(new URL(path, root), 'utf8')))
const current = documents[0].version
let requested = process.argv[2]
if (requested === '--auto') {
  const base = process.argv[3]
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Automatic versioning requires the previous push commit SHA.')
  const previous = JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { cwd: root, encoding: 'utf8' })).version
  const tagged = execFileSync('git', ['tag', '--list', `v${current}`], { cwd: root, encoding: 'utf8' }).trim() === `v${current}`
  requested = previous === current && tagged ? 'patch' : current
}
if (requested === 'patch') {
  const parts = current.split('.').map(Number)
  parts[2] += 1
  requested = parts.join('.')
}
const parts = requested?.split('.') ?? []
if (parts.length !== 3 || !parts.every(part => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535) || parts.every(part => Number(part) === 0)) {
  throw new Error('Use patch or a nonzero major.minor.patch version with each part from 0 to 65535.')
}
for (const document of documents) document.version = requested
if (documents[1].packages?.['']) documents[1].packages[''].version = requested
for (const [index, path] of files.entries()) writeFileSync(new URL(path, root), `${JSON.stringify(documents[index], null, 2)}\n`)
const storePath = new URL('CHROMEWEBSTORE.md', root)
writeFileSync(storePath, readFileSync(storePath, 'utf8').replace(/Release: \d+\.\d+\.\d+\./, `Release: ${requested}.`))
console.log(requested)
