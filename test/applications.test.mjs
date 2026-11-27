import assert from 'node:assert/strict'
import { test } from 'node:test'
import { starterConfig, validateConfig } from '../src/core/config.mjs'
import { readApplications, mergeApplications, splitApplication, followApplication, applicationOrigins } from '../src/core/applications.mjs'
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


test('site origins select existing apps, isolate new sites, and survive merge and reload', () => {
  const workspace = readApplications(starterConfig())
  workspace.applications[0].url = 'https://first.example.test/dashboard'
  const first = workspace.activeApplicationId
  assert.equal(followApplication(workspace, 'https://first.example.test/settings?tab=1').changed, false)
  assert.equal(workspace.applications.length, 1)
  const result = followApplication(workspace, 'https://second.example.test/login')
  assert.equal(result.created, true)
  assert.equal(workspace.applications.length, 2)
  assert.equal(workspace.applications[1].config.scenarios[0].rules.length, 0)
  const second = workspace.activeApplicationId
  followApplication(workspace, 'https://second.example.test/home')
  assert.equal(workspace.activeApplicationId, second)
  followApplication(workspace, 'https://first.example.test/')
  assert.equal(workspace.activeApplicationId, first)
  mergeApplications(workspace, second, first)
  const restored = readApplications(structuredClone(workspace))
  followApplication(restored, 'https://second.example.test/home')
  assert.equal(restored.activeApplicationId, first)
  assert.equal(restored.applications.length, 1)
  assert.deepEqual(applicationOrigins(restored.applications[0]), ['https://first.example.test', 'https://second.example.test'])
  assert.throws(() => followApplication(restored, 'file:///tmp/a'))
})

test('automatic app changes preserve the browser, persist atomically, and retain separate activity', async () => {
  const workspace = readApplications(starterConfig())
  workspace.applications[0].url = 'https://first.example.test/'
  const stored = new Map([[STORAGE_KEY, workspace]])
  let fail = false
  let stopMocking = 0
  const controller = new Controller({ storage: {
    get: async key => stored.get(key), set: async (key, value) => { if (fail) throw new Error('Storage full'); stored.set(key, structuredClone(value)) }
  }, platform: { state: async () => ({}), stop: async () => { throw new Error('The browser must stay open') }, stopMocking: async () => { stopMocking++ } } })
  const first = await controller.dispatch('state')
  fail = true
  await assert.rejects(controller.dispatch('application-follow', { url: 'https://second.example.test/', revision: first.revision }), /Storage full/)
  assert.equal((await controller.dispatch('state')).applicationId, first.applicationId)
  fail = false
  const second = await controller.dispatch('application-follow', { url: 'https://second.example.test/', revision: first.revision })
  assert.notEqual(second.applicationId, first.applicationId)
  assert.equal(second.applicationNotice.origin, 'https://second.example.test')
  assert.equal(second.activity.length, 0)
  assert.equal(stopMocking, 2)
  const unchanged = await controller.dispatch('application-follow', { url: 'https://second.example.test/next', revision: second.revision })
  assert.equal(unchanged.revision, second.revision)
  assert.equal(stopMocking, 2)
  const original = await controller.dispatch('application-follow', { url: 'https://first.example.test/', revision: second.revision })
  assert.equal(original.applicationId, first.applicationId)
  assert.deepEqual(original.config, first.config)
})


test('claiming a mapped site retains a running session and respects a manually selected profile', async () => {
  const workspace = readApplications(starterConfig())
  const origin = workspace.applications[0].config.environments[0].baseUrls[0]
  const stored = new Map([[STORAGE_KEY, workspace]])
  const controller = new Controller({ storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value) },
    platform: { state: async () => ({}), stop: async () => { throw new Error('Do not close the browser') }, stopMocking: async () => { throw new Error('Do not stop the current mock') } } })
  const initial = await controller.dispatch('state')
  const claimed = await controller.dispatch('application-follow', { url: origin, revision: initial.revision })
  assert.equal(claimed.applicationId, initial.applicationId)
  assert.equal(claimed.activityVersion, initial.activityVersion)
  const duplicate = structuredClone(workspace.applications[0])
  duplicate.id = 'manual'
  duplicate.url = origin
  workspace.applications.push(duplicate)
  workspace.activeApplicationId = duplicate.id
  assert.equal(followApplication(workspace, origin).changed, false)
  assert.equal(workspace.activeApplicationId, 'manual')
})


test('manual profiles without a launch URL bind to the current site without sharing requests or rules', async () => {
  const stored = new Map()
  const controller = new Controller({ storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)) },
    platform: { state: async () => ({}), stop: async () => {} } })
  const initial = await controller.dispatch('state')
  const created = await controller.dispatch('application-create', { name: 'Alternative config', currentUrl: 'https://first.example.test/dashboard?token=private', revision: initial.revision })
  assert.equal(created.applications.find(app => app.id === created.applicationId).url, 'https://first.example.test/dashboard')
  assert.equal(created.config.scenarios[0].rules.length, 0)
  assert.deepEqual(created.activity, [])
  const followed = await controller.dispatch('application-follow', { url: 'https://first.example.test/home', revision: created.revision })
  assert.equal(followed.applicationId, created.applicationId)
  assert.equal(followed.applications.length, 2)
})
