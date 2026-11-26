import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const files = ['Mockend-Chrome.zip', 'Mockend.vsix', 'Mockend.zip', 'SHA256SUMS']
const digest = file => createHash('sha256').update(readFileSync(new URL(`release/${file}`, root))).digest('hex')
const before = files.map(digest)
const build = spawnSync(process.execPath, [fileURLToPath(new URL('build.mjs', import.meta.url))], { cwd: root, stdio: 'inherit' })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
for (const [index, file] of files.entries()) if (digest(file) !== before[index]) throw new Error(`Build is not reproducible: ${file}`)
console.log('All release packages rebuild byte-for-byte.')
