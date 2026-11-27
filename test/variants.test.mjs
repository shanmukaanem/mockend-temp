import { readApplications, splitApplication, mergeApplications } from '../src/core/applications.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { starterConfig, validateConfig, exportConfig } from '../src/core/config.mjs'
import { responseScenarios, activeResponseScenario, effectiveRules, setRuleState, addResponseScenario, removeResponseScenario, pruneResponseScenarios } from '../src/core/variants.mjs'
import { selectRule, responseFor } from '../src/core/matcher.mjs'
import { postmanMockScript, readPostmanMock } from '../src/chromium/postman-mock.mjs'
import { formatStructured } from '../src/ui/code-format.mjs'

const request = { resourceType: 'Fetch', request: { method: 'GET', url: 'http://127.0.0.1:4319/api/cart' } }

test('legacy Flows retain identity and acquire sparse response scenarios without copying request conditions', async () => {
  const config = starterConfig()
  const before = structuredClone(config)
  const flow = config.scenarios[0]
  assert.equal(responseScenarios(flow)[0].name, 'Default')
  assert.deepEqual(validateConfig(config), before)
  const selected = addResponseScenario(flow, 'Unauthorized')
  const base = flow.rules.find(rule => rule.id === 'filled')
  const original = structuredClone(base)
  setRuleState(flow, base.id, { response: { ...base.response, status: 401, body: { error: 'unauthorized' }, delayMs: 1200 } })
  assert.deepEqual(base, original)
  assert.deepEqual(Object.keys(selected.overrides), ['filled'])
  assert.equal(Object.hasOwn(selected, 'rules'), false)
  const match = await selectRule(effectiveRules(flow), request, async () => '', config)
  assert.equal(match.rule.id, 'filled')
  assert.equal(responseFor(match, request.request).status, 401)
  assert.equal(match.rule.response.delayMs, 1200)
  const environment = config.settings.environmentId
  flow.activeVariantId = 'default'
  assert.equal((await selectRule(effectiveRules(flow), request, async () => '', config)).rule.response.status, 200)
  assert.equal(config.settings.environmentId, environment)
  flow.activeVariantId = selected.id
  assert.deepEqual(validateConfig(JSON.parse(exportConfig(config))), config)
  assert.equal(readPostmanMock(postmanMockScript(flow, config)).rules.find(rule => rule.id === 'filled').response.status, 401)
})

test('response scenario enabled state, duplicates, deletion and precedence remain independent', async () => {
  const config = starterConfig(); const flow = config.scenarios[0]
  const selected = addResponseScenario(flow, 'Slow network')
  setRuleState(flow, 'filled', { enabled: false })
  assert.equal(effectiveRules(flow).find(rule => rule.id === 'filled').enabled, false)
  assert.equal(flow.rules.find(rule => rule.id === 'filled').enabled, true)
  const copy = addResponseScenario(flow, 'Slow network copy')
  setRuleState(flow, 'filled', { enabled: true })
  assert.equal(selected.overrides.filled.enabled, false)
  assert.equal(Object.hasOwn(copy.overrides, 'filled'), false)
  const match = await selectRule(effectiveRules(flow), request, async () => '', config)
  assert.equal(match.rule.id, 'filled', 'The first matching rule keeps priority')
  removeResponseScenario(flow, copy.id)
  removeResponseScenario(flow, selected.id)
  assert.throws(() => removeResponseScenario(flow, 'default'), /at least one/)
  assert.equal(activeResponseScenario(flow).id, 'default')
})

test('scenario validation rejects matching overrides and invalid responses, and prunes deleted routes', () => {
  const config = starterConfig(); const flow = config.scenarios[0]
  const scenario = addResponseScenario(flow, 'Custom')
  scenario.overrides.filled = { method: 'POST' }
  assert.throws(() => validateConfig(config), /unknown field/)
  scenario.overrides.filled = { response: { ...flow.rules[1].response, status: 0 } }
  assert.throws(() => validateConfig(config), /HTTP status/)
  scenario.overrides.filled = { enabled: false }
  flow.rules = flow.rules.filter(rule => rule.id !== 'filled')
  assert.throws(() => validateConfig(config), /missing rule/)
  pruneResponseScenarios(flow)
  assert.deepEqual(scenario.overrides, {})
  assert.doesNotThrow(() => validateConfig(config))
})

test('language-aware CSS formatting preserves strings and invalid source is rejected', async () => {
  const source = '.sample{content:"  preserve  ";color:red;--payload:"a;b:c"}'
  const formatted = await formatStructured(source, 'css')
  assert.ok(formatted.includes('"  preserve  "'))
  assert.ok(formatted.includes('"a;b:c"'))
  assert.ok(formatted.includes('\n'))
  await assert.rejects(formatStructured('.sample{', 'css'))
  assert.equal(await formatStructured('  plain text\n', 'text'), '  plain text\n')
})


test('splitting and merging apps retain response scenarios while pruning unreachable override IDs', () => {
  const workspace = readApplications(starterConfig())
  const original = workspace.applications[0]
  const flow = original.config.scenarios[0]
  const sourceEnv = original.config.environments[0]
  original.config.environments.push({ id: 'other-env', name: 'Other', baseUrls: ['https://other.example.test'] })
  const rule = flow.rules.find(rule => rule.id === 'filled')
  rule.environmentScope = 'selected'; rule.environmentIds = [sourceEnv.id]
  addResponseScenario(flow, 'Disabled cart')
  setRuleState(flow, rule.id, { enabled: false })
  splitApplication(workspace, { name: 'Other app', environmentIds: ['other-env'] })
  const split = workspace.applications[1]
  assert.equal(split.config.scenarios[0].rules.some(rule => rule.id === 'filled'), false)
  assert.deepEqual(activeResponseScenario(split.config.scenarios[0]).overrides, {})
  assert.equal(activeResponseScenario(flow).overrides.filled.enabled, false)
  assert.doesNotThrow(() => readApplications(workspace))
  mergeApplications(workspace, split.id, original.id)
  assert.doesNotThrow(() => readApplications(workspace))
  assert.equal(activeResponseScenario(workspace.applications[0].config.scenarios[0]).overrides.filled.enabled, false)
})
