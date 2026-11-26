const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const vscode = require('vscode')

/** Exercise recording and mocking against the installed VS Code Integrated Browser. */
exports.run = async () => {
  const resultPath = resolve(__dirname, '../test-results/vscode-integration.json')
  const { createIntegratedBrowser } = await import(pathToFileURL(resolve(__dirname, '../build/vscode/vscode/browser.mjs')).href)
  const { starterConfig } = await import(pathToFileURL(resolve(__dirname, '../src/core/config.mjs')).href)
  const publications = []
  const browser = createIntegratedBrowser(vscode, event => publications.push(event))
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<title>Mockend integration test</title><button onclick="load()">Load cart</button><pre id="result"></pre><script>async function load(){document.querySelector("pre").textContent=await(await fetch("/api/cart")).text()}setInterval(load,500);load()</script>')
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ item: 'Notebook' }))
    }
  })
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const value = predicate()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for Integrated Browser traffic')
  }
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${server.address().port}/`
    const config = starterConfig()
    const rule = config.scenarios[0].rules.find(rule => rule.id === 'filled')
    rule.url = `${url}api/cart`
    rule.response.body = { item: 'Canvas tote' }
    config.scenarios[0].rules = [rule]
    await vscode.commands.executeCommand('mockend.open')
    await browser.start({ url, recordingOnly: true }, () => config, () => {})
    const recorded = await waitFor(() => publications.find(event => event.row?.request.url === rule.url))
    assert.match((await browser.body(recorded.row.id)).text, /Notebook/)
    assert.equal((await browser.state()).active, null)
    await browser.start({}, () => config, () => {})
    const mocked = await waitFor(() => publications.find(event => event.row?._mocked))
    assert.match((await browser.body(mocked.row.id)).text, /Canvas tote/)
    assert.ok((await browser.state()).active)
    await browser.stopMocking()
    assert.equal((await browser.state()).active, null)
    assert.ok((await browser.state()).available)
    const previous = publications.length
    await waitFor(() => publications.slice(previous).find(event => event.row?.request.url === rule.url && !event.row._mocked))
    browser.pauseRecording()
    await browser.stop()
    assert.equal((await browser.state()).available, null)
    writeFileSync(resultPath, JSON.stringify({ passed: true, vscode: vscode.version, recording: true, mocking: true, stopKeepsBrowser: true }, null, 2))
  } catch (error) {
    writeFileSync(resultPath, JSON.stringify({ passed: false, vscode: vscode.version, error: error.stack }, null, 2))
    throw error
  } finally {
    await browser.dispose()
    server.closeAllConnections()
    server.close()
  }
}
