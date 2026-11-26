import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
  : process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' : 'code')
const profile = mkdtempSync(join(tmpdir(), 'mockend-vscode-'))
const output = resolve('test-results/vscode-integration.json')
mkdirSync(resolve('test-results'), { recursive: true })
if (existsSync(output)) rmSync(output)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && key !== 'ELECTRON_RUN_AS_NODE'))
const child = spawn(executable, [
  `--user-data-dir=${profile}`, `--extensions-dir=${join(profile, 'extensions')}`,
  `--extensionDevelopmentPath=${resolve('build/vscode')}`,
  `--extensionTestsPath=${resolve('test/vscode.integration.cjs')}`,
  '--skip-welcome', '--skip-release-notes', '--new-window'
], { env, stdio: 'inherit' })
const timeout = setTimeout(() => child.kill(), 120000)
try {
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (!existsSync(output)) throw new Error('VS Code exited before the integration test ran. Finish any pending VS Code update and retry. Set VSCODE_EXECUTABLE if needed.')
  const result = JSON.parse(readFileSync(output, 'utf8'))
  if (exitCode !== 0 || !result.passed) throw new Error(result.error ?? `VS Code exited with code ${exitCode}`)
  console.log(`VS Code ${result.vscode}: Integrated Browser recording, mocking, and stop controls passed.`)
} finally {
  clearTimeout(timeout)
}
