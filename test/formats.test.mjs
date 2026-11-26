import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { starterConfig, validateConfig } from '../src/core/config.mjs'
import { HTTP_STATUSES } from '../src/core/http-statuses.mjs'
import { Interceptor } from '../src/core/interceptor.mjs'
import { scenarioCollection, scenarioSpec, readApiSpec } from '../src/chromium/formats.mjs'
import { postmanMockScript, readPostmanMock } from '../src/chromium/postman-mock.mjs'

function fixture() {
  const config = starterConfig()
  const rule = config.scenarios[0].rules.find(rule => rule.id === 'filled')
  config.scenarios[0].rules = [rule]
  rule.response.status = 599
  rule.response.statusText = 'Upstream maintenance'
  return { config, scenario: config.scenarios[0], rule }
}

test('predefined statuses and custom names validate and reach the interception protocol', async () => {
  assert.equal(HTTP_STATUSES[200], 'OK')
  assert.equal(HTTP_STATUSES[404], 'Not Found')
  const { config, rule } = fixture()
  validateConfig(config)
  const calls = []
  const engine = new Interceptor({ send: async (method, params) => calls.push({ method, params }), getConfig: () => config, onActivity() {} })
  await engine.start()
  engine.event('Fetch.requestPaused', { requestId: 'custom', resourceType: 'Fetch', request: { method: 'GET', url: rule.url, headers: {} } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.find(call => call.method === 'Fetch.fulfillRequest').params.responsePhrase, 'Upstream maintenance')
  await engine.stop()
  for (const invalid of ['', '  ', 'bad\r\nHeader: value', 'x'.repeat(101)]) {
    rule.response.statusText = invalid
    assert.throws(() => validateConfig(config), /status name/)
  }
})

test('Postman mock handlers replay the custom status number and name over HTTP', async t => {
  const { config, scenario } = fixture()
  const module = { exports: {} }
  runInNewContext(postmanMockScript(scenario, config), { module, require: createRequire(import.meta.url), URL, TextEncoder, Buffer })
  const server = module.exports
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cart`)
  assert.equal(response.status, 599)
  assert.equal(response.statusText, 'Upstream maintenance')
  assert.equal((await response.json()).items[0].name, 'Canvas tote')
})

test('Collections retain response examples and custom status names; incompatible routes fail clearly', () => {
  const { config, scenario, rule } = fixture()
  const collection = scenarioCollection(scenario, config)
  const imported = readPostmanMock(JSON.stringify(collection))
  assert.equal(imported.rules[0].response.status, 599)
  assert.equal(imported.rules[0].response.statusText, 'Upstream maintenance')
  assert.equal(JSON.parse(imported.rules[0].response.body).items[0].name, 'Canvas tote')
  rule.url += '*'
  assert.throws(() => scenarioCollection(scenario, config), /concrete HTTP routes/)
})

test('OpenAPI specs preserve expanded Env routes and predicates in the Mockend extension', () => {
  const { config, scenario, rule } = fixture()
  config.environments = [{ id: 'qa', name: 'QA', baseUrls: ['https://qa.example.test'] }]
  config.settings.environmentId = 'qa'
  rule.environmentScope = 'active'
  rule.parameters = [{ source: 'query', key: 'mode', value: 'qa' }]
  const spec = scenarioSpec(scenario, config)
  assert.equal(spec.openapi, '3.0.3')
  assert.equal(spec.paths['/api/cart'].get.servers[0].url, 'https://qa.example.test')
  const imported = readApiSpec(JSON.parse(JSON.stringify(spec)))
  assert.equal(imported.rules[0].url, 'https://qa.example.test/api/cart')
  assert.deepEqual(imported.rules[0].parameters, rule.parameters)
  assert.equal(imported.rules[0].response.statusText, 'Upstream maintenance')
})

test('third-party OpenAPI JSON imports inline examples and rejects unresolved references', () => {
  const spec = { openapi: '3.1.0', info: { title: 'Orders' }, servers: [{ url: 'https://api.example.test/v1' }],
    paths: { '/orders/{id}': { get: { responses: { 200: { content: { 'application/json': { example: { id: 7 } } } } } } } } }
  const imported = readApiSpec(spec)
  assert.equal(imported.rules[0].url, 'https://api.example.test/v1/orders/*')
  assert.deepEqual(imported.rules[0].response.body, { id: 7 })
  spec.paths['/orders/{id}'].get.responses[200] = { $ref: '#/components/responses/Order' }
  assert.throws(() => readApiSpec(spec), /inline HTTP response examples/)
})
