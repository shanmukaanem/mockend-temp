import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const packages = [
  [`Mockend-Chrome-${version}.zip`, 'Mockend-Chrome.zip'],
  [`mockend-${version}.vsix`, 'Mockend.vsix'],
  [`Mockend-${version}.zip`, 'Mockend.zip']
]
const check = process.argv.includes('--check')
const versionedPackage = /^(?:mockend(?:-chrome(?:-store)?)?)-\d+(?:\.\d+){2,3}(?:-[\w.-]+)?\.(?:zip|vsix)$/i
mkdirSync(new URL('release/', root), { recursive: true })
const checksums = packages.map(([name, filename]) => {
  const built = readFileSync(new URL(`dist/${name}`, root))
  const target = new URL(`release/${filename}`, root)
  if (check) {
    if (!built.equals(readFileSync(target))) throw new Error(`${filename} is stale. Run npm run build.`)
  } else copyFileSync(new URL(`dist/${name}`, root), target)
  return `${createHash('sha256').update(built).digest('hex')}  ${filename}`
}).join('\n') + '\n'

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Release folders must not contain symbolic links.')
    const name = prefix + entry.name
    return entry.isDirectory() ? files(new URL(`${entry.name}/`, directory), `${name}/`) : [name]
  })
}
// Keep the loaded browser directory itself in place across rebuilds.
const source = new URL('build/chromium/', root)
const destination = new URL('release/chromium/', root)
mkdirSync(destination, { recursive: true })
const expected = new Set(files(source))
for (const name of files(destination)) {
  if (expected.has(name)) continue
  if (check) throw new Error(`Unexpected release/chromium/${name}`)
  unlinkSync(new URL(name, destination))
}
for (const name of expected) {
  const target = new URL(name, destination)
  if (check) {
    if (!readFileSync(new URL(name, source)).equals(readFileSync(target))) throw new Error(`Browser release is stale: ${name}`)
  } else {
    mkdirSync(new URL('./', target), { recursive: true })
    copyFileSync(new URL(name, source), target)
  }
}
// Keep only stable filenames in release; versioned packages belong in dist.
for (const entry of readdirSync(new URL('release/', root), { withFileTypes: true })) {
  if (!entry.isFile() || (!versionedPackage.test(entry.name) && entry.name !== 'Mockend-Chrome-Store.zip')) continue
  if (check) throw new Error(`Obsolete release package: ${entry.name}. Run npm run build.`)
  unlinkSync(new URL(`release/${entry.name}`, root))
}
const checksumFile = new URL('release/SHA256SUMS', root)
if (check) {
  if (readFileSync(checksumFile, 'utf8') !== checksums) throw new Error('Release checksums are stale.')
} else writeFileSync(checksumFile, checksums)
console.log(check ? `Release ${version} matches the build and SHA-256 checksums.` : `Updated release ${version} and SHA-256 checksums.`)
