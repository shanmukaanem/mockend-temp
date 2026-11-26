import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mockend-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of ['scripts', 'src/chromium', 'src/vscode']) mkdirSync(join(root, path), { recursive: true })
  copyFileSync(new URL('../scripts/version.mjs', import.meta.url), join(root, 'scripts/version.mjs'))
  const files = ['package.json', 'package-lock.json', 'src/chromium/manifest.json', 'src/vscode/package.json']
  for (const file of files) writeFileSync(join(root, file), JSON.stringify({ version: '0.0.1', name: 'mockend', packages: { '': { version: '0.0.1' } } }))
  writeFileSync(join(root, 'CHROMEWEBSTORE.md'), 'Release: 0.0.1.')
  return { root, files, run: (...args) => spawnSync(process.execPath, ['scripts/version.mjs', ...args], { cwd: root, encoding: 'utf8' }) }
}

test('version command synchronizes both extensions and lockfile without changing identity', t => {
  const { root, files, run } = fixture(t)
  assert.equal(run('0.0.9').status, 0)
  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(root, file), 'utf8'))
    assert.equal(doc.version, '0.0.9')
    assert.equal(doc.name, 'mockend')
  }
  assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages[''].version, '0.0.9')
  assert.equal(readFileSync(join(root, 'CHROMEWEBSTORE.md'), 'utf8'), 'Release: 0.0.9.')
  assert.equal(run('patch').status, 0)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.10')
})

test('invalid versions fail before writing metadata', t => {
  const { root, run } = fixture(t)
  for (const value of ['0.0.0', '01.2.3', '1.0', '1.0.65536', '1.0.1-beta', '--auto']) assert.notEqual(run(value).status, 0, value)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.1')
})

test('automatic releases increment unchanged versions and preserve an explicit version reset', t => {
  const { root, run } = fixture(t)
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Initial')
  const base = git('rev-parse', 'HEAD')
  assert.equal(run('--auto', base).status, 0)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.1')
  git('tag', 'v0.0.1')
  assert.equal(run('--auto', base).status, 0)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.2')
  assert.equal(run('0.0.1').status, 0)
  assert.equal(run('0.0.5').status, 0)
  assert.equal(run('--auto', base).status, 0)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.5')
})
