import assert from 'node:assert/strict'
import { test } from 'node:test'
import { starterConfig, validateConfig } from '../src/core/config.mjs'
import { readApplications, mergeApplications, splitApplication } from '../src/core/applications.mjs'
import { mapConfigEnvironments, mapRuleEnvironment } from '../src/core/environment-rules.mjs'
import { ruleUrls, selectRule } from '../src/core/matcher.mjs'
import { Controller, STORAGE_KEY } from '../src/core/controller.mjs'
import { postmanMockScript, readPostmanMock } from '../src/chromium/postman-mock.mjs'

test('legacy rules become paths and follow either Env without duplicating mocks', async () => {
  const original = starterConfig()
  original.environments = [{ id: 'dev', name: 'DEV', baseUrls: ['https://dev.example.org'] }]
  original.settings.environmentId = 'dev'
  const config = validateConfig(mapConfigEnvironments(original))
  const rule = config.scenarios[0].rules[1]
  assert.equal(original.scenarios[0].rules[1].url, 'http://127.0.0.1:4319/api/cart')
  assert.equal(rule.url, '/api/cart')
  assert.equal(rule.environmentScope, 'active')
  assert.equal(config.environments.length, 2)
  assert.deepEqual(ruleUrls(rule, config), ['https://dev.example.org/api/cart'])
  const request = url => ({ resourceType: 'Fetch', request: { url, method: 'GET' } })
  assert.ok(await selectRule([rule], request('https://dev.example.org/api/cart'), async () => '', config))
  assert.equal(await selectRule([rule], request('https://foreign.example.org/api/cart'), async () => '', config), null)
  config.settings.environmentId = config.environments[1].id
  assert.ok(await selectRule([rule], request('http://127.0.0.1:4319/api/cart'), async () => '', config))
  delete config.settings.environmentId
  assert.deepEqual(ruleUrls(rule, config), [])
  assert.equal(mapConfigEnvironments(config).environments.length, 2)
})

test('path rules preserve exact queries, conditions, custom statuses, and portable exports', async () => {
  const config = mapConfigEnvironments(starterConfig())
  const rule = config.scenarios[0].rules[1]
  rule.url = '/api/cart?mode=qa'
  rule.exactUrl = true
  rule.response.statusText = 'Controlled response'
  config.scenarios[0].rules = [rule]
  validateConfig(config)
  assert.equal(await selectRule([rule], { resourceType: 'Fetch', request: { url: 'http://127.0.0.1:4319/api/cart?mode=prod', method: 'GET' } }, async () => '', config), null)
  const exported = readPostmanMock(postmanMockScript(config.scenarios[0], config))
  assert.equal(exported.rules[0].url, 'http://127.0.0.1:4319/api/cart?mode=qa')
  assert.equal(exported.rules[0].response.statusText, 'Controlled response')
  assert.equal(exported.rules[0].environmentScope, undefined)
})

test('splitting and merging apps preserves Env references, Flow IDs, and destination settings', () => {
  const workspace = readApplications(starterConfig())
  const source = workspace.applications[0]
  source.config.environments.push({ id: 'qa', name: 'QA', baseUrls: ['https://qa.example.org'] })
  source.config.scenarios[0].rules[0].environmentScope = 'selected'
  source.config.scenarios[0].rules[0].environmentIds = [source.config.environments[0].id, 'qa']
  splitApplication(workspace, { name: 'QA app', environmentIds: ['qa'] })
  const split = workspace.applications[1]
  assert.equal(source.config.environments.length, 1)
  assert.equal(split.config.environments.length, 1)
  assert.deepEqual(split.config.scenarios[0].rules[0].environmentIds, ['qa'])
  assert.deepEqual(source.config.scenarios[0].rules[0].environmentIds, [source.config.environments[0].id])
  split.config.settings.bypassServiceWorker = false
  readApplications(workspace)
  mergeApplications(workspace, split.id, source.id)
  const merged = readApplications(workspace)
  assert.equal(merged.applications.length, 1)
  assert.equal(merged.applications[0].config.scenarios.length, 6)
  assert.equal(merged.applications[0].config.settings.bypassServiceWorker, true)
  assert.equal(new Set(merged.applications[0].config.scenarios.map(flow => flow.id)).size, 6)
  assert.equal(new Set(merged.applications[0].config.scenarios.map(flow => flow.name)).size, 6)
  assert.equal(merged.applications[0].config.environments.length, 2)
})

test('app changes stop mocking, persist independently, reject stale edits, and survive reopening', async () => {
  const storage = new Map([[STORAGE_KEY, starterConfig()]])
  let fail = false
  let stops = 0
  const options = {
    storage: { get: async key => storage.get(key), set: async (key, value) => { if (fail) throw new Error('Disk unavailable'); storage.set(key, structuredClone(value)) } },
    platform: { stop: async () => { stops++ }, state: async () => ({}) }
  }
  const controller = new Controller(options)
  const initial = await controller.dispatch('state')
  assert.equal(storage.get('mockend.legacy-backup.v1').scenarios[0].rules[1].url, 'http://127.0.0.1:4319/api/cart')
  const created = await controller.dispatch('application-create', { name: 'Other app', revision: initial.revision, currentUrl: 'https://app.example.org/home?token=secret#auth' })
  assert.equal(created.applications[0].url, 'https://app.example.org/home')
  assert.equal(created.config.scenarios[0].rules.length, 0)
  assert.equal(created.config.environments, undefined)
  assert.equal(stops, 1)
  await assert.rejects(controller.dispatch('save', { config: initial.config, revision: initial.revision }), /changed/)
  const original = await controller.dispatch('application-select', { id: initial.applicationId, revision: created.revision })
  assert.equal(original.config.scenarios[0].rules.length, 2)
  fail = true
  await assert.rejects(controller.dispatch('application-rename', { name: 'Lost', revision: original.revision }), /Disk unavailable/)
  assert.equal((await controller.dispatch('state')).applications[0].name, 'My App')
  const reopened = await new Controller(options).dispatch('state')
  assert.equal(reopened.applications.length, 2)
  assert.equal(reopened.applicationId, initial.applicationId)
  const exported = await controller.dispatch('export-applications')
  assert.equal(readApplications(JSON.parse(JSON.stringify(exported))).applications.length, 2)
})


test('new mocked API origins join one selected Env without changing other named Envs', () => {
  const config = starterConfig();
  config.environments = [
    { id: 'qa', name: 'QA', baseUrls: ['https://qa.example.com'] },
    { id: 'prod', name: 'PROD', baseUrls: ['https://api.example.com'] }
  ];
  config.settings.environmentId = 'qa';
  mapRuleEnvironment(config, { url: 'https://accounts.qa.example.com/users' });
  mapRuleEnvironment(config, { url: 'https://orders.qa.example.com/orders' });
  mapRuleEnvironment(config, { url: 'https://orders.qa.example.com/orders/1' });
  assert.equal(config.environments.length, 2);
  assert.deepEqual(config.environments[0].baseUrls, ['https://qa.example.com', 'https://accounts.qa.example.com', 'https://orders.qa.example.com']);
  mapRuleEnvironment(config, { url: 'https://api.example.com/shared' });
  assert.ok(config.environments[0].baseUrls.includes('https://api.example.com'));
  assert.deepEqual(config.environments[1].baseUrls, ['https://api.example.com']);
  validateConfig(config);
  const legacy = starterConfig();
  legacy.scenarios[0].rules[0].url = 'https://accounts.qa.example.com/users';
  legacy.scenarios[0].rules[1].url = 'https://orders.qa.example.com/orders';
  assert.equal(mapConfigEnvironments(legacy, { groupIntoActive: true }).environments.length, 1);
});


test('saving a recorded Flow groups its API hosts into the selected Env', async () => {
  const storage = new Map([[STORAGE_KEY, starterConfig()]])
  const controller = new Controller({
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, structuredClone(value)) },
    platform: { state: async () => ({}) }
  })
  const initial = await controller.dispatch('state')
  const config = structuredClone(initial.config)
  config.scenarios[0].rules[0].url = 'https://accounts.qa.example.com/users'
  config.scenarios[0].rules[1].url = 'https://orders.qa.example.com/orders'
  const count = config.environments.length
  const saved = await controller.dispatch('save', { config, revision: initial.revision })
  assert.equal(saved.config.environments.length, count)
  const env = saved.config.environments.find(item => item.id === saved.config.settings.environmentId)
  assert.ok(env.baseUrls.includes('https://accounts.qa.example.com'))
  assert.ok(env.baseUrls.includes('https://orders.qa.example.com'))
  assert.deepEqual(saved.config.scenarios[0].rules.map(rule => rule.url), ['/users', '/orders'])
})
