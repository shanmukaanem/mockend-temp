import assert from 'node:assert/strict';
import { test } from 'node:test';
import { starterConfig, validateConfig, exportConfig } from '../src/core/config.mjs';
import { selectRule, ruleUrls, responseFor } from '../src/core/matcher.mjs';
import { postmanMockScript, readPostmanMock } from '../src/chromium/postman-mock.mjs';

function fixture(scope = 'active') {
  const config = starterConfig();
  config.environments = [
    { id: 'local', name: 'Local', baseUrls: ['http://localhost:4319', 'http://127.0.0.1:4319'] },
    { id: 'qa', name: 'QA', baseUrls: ['https://qa.example.org'] },
    { id: 'staging', name: 'Staging', baseUrls: ['https://staging.example.org'] }
  ];
  config.settings.environmentId = 'qa';
  const rule = config.scenarios[0].rules[1];
  rule.url = 'https://source.example.org/api/v1/cart?mode=qa';
  rule.exactUrl = true;
  rule.environmentScope = scope;
  config.scenarios[0].rules = [rule];
  return { config, rule };
}
async function match(rule, config, url, method = 'GET', body = '') {
  return selectRule([rule], { resourceType: 'Fetch', request: { url, method, headers: {} } }, async () => body, config);
}

test('environment selection rebases origins and responds to changes without recreating rules', async () => {
  const { config, rule } = fixture();
  validateConfig(config);
  assert.ok(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=qa'));
  assert.equal(await match(rule, config, 'https://staging.example.org/api/v1/cart?mode=qa'), null);
  assert.equal(await match(rule, config, 'https://qa.example.org/other/cart?mode=qa'), null);
  assert.equal(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=other'), null);
  assert.equal(await match(rule, config, 'https://unconfigured.example.org/api/v1/cart?mode=qa'), null);
  const original = rule.url;
  config.settings.environmentId = 'local';
  assert.ok(await match(rule, config, 'http://localhost:4319/api/v1/cart?mode=qa'));
  assert.equal(await match(rule, config, 'http://localhost:4320/api/v1/cart?mode=qa'), null);
  assert.equal(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=qa'), null);
  config.settings.environmentId = '*';
  assert.ok(await match(rule, config, 'https://staging.example.org/api/v1/cart?mode=qa'));
  assert.equal(rule.url, original);
});

test('all, selected and original rule scopes have distinct target sets', async () => {
  const { config, rule } = fixture('all');
  assert.equal(ruleUrls(rule, config).length, 4);
  assert.ok(await match(rule, config, 'https://staging.example.org/api/v1/cart?mode=qa'));
  rule.environmentScope = 'selected'; rule.environmentIds = ['qa', 'local'];
  assert.equal(ruleUrls(rule, config).length, 3);
  assert.equal(await match(rule, config, 'https://staging.example.org/api/v1/cart?mode=qa'), null);
  rule.environmentScope = 'original'; delete rule.environmentIds;
  assert.ok(await match(rule, config, rule.url));
  assert.equal(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=qa'), null);
  rule.environmentScope = 'all'; config.environments = [];
  assert.equal(await match(rule, config, 'https://source.example.org/api/v1/cart?mode=qa'), null);
});

test('No Env uses saved URLs and selecting an Env retargets only following rules', async () => {
  const { config, rule } = fixture();
  delete config.settings.environmentId;
  assert.deepEqual(ruleUrls(rule, config), [rule.url]);
  assert.ok(await match(rule, config, rule.url));
  assert.equal(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=qa'), null);
  config.settings.environmentId = 'qa';
  assert.ok(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=qa'));
  rule.environmentScope = 'selected'; rule.environmentIds = ['qa'];
  delete config.settings.environmentId;
  assert.ok(await match(rule, config, 'https://qa.example.org/api/v1/cart?mode=qa'));
});

test('environment scopes preserve JSON, parameter, method, wildcard and endpoint matching', async () => {
  const { config, rule } = fixture();
  rule.method = 'POST'; rule.requestBody = { customer: 7 }; rule.requestBodyMode = 'exact';
  const target = 'https://qa.example.org/api/v1/cart?mode=qa';
  assert.ok(await match(rule, config, target, 'POST', '{"customer":7}'));
  assert.equal(await match(rule, config, target, 'GET', '{"customer":7}'), null);
  assert.equal(await match(rule, config, target, 'POST', '{"customer":8}'), null);
  delete rule.requestBody; delete rule.requestBodyMode; delete rule.exactUrl;
  rule.url = 'https://source.example.org/api/*';
  rule.parameters = [{ source: 'query', key: 'mode', value: 'qa' }];
  assert.ok(await match(rule, config, target, 'POST'));
  assert.equal(await match(rule, config, target.replace('mode=qa', 'mode=prod'), 'POST'), null);
  rule.endpointOnly = true; rule.url = 'https://source.example.org/api/v1/cart';
  assert.ok(await match(rule, config, target + '&page=2', 'POST'));
  assert.equal(await match(rule, config, target.replace('/cart?', '/other?'), 'POST'), null);
});

test('CORS preflights resolve the same environment targets', async () => {
  const { config, rule } = fixture(); rule.method = 'POST'; rule.response.cors = true;
  const request = { method: 'OPTIONS', url: 'https://qa.example.org/api/v1/cart?mode=qa', headers: { origin: 'https://web.qa.example.org', 'access-control-request-method': 'POST' } };
  const matched = await selectRule([rule], { resourceType: 'Other', request }, async () => '', config);
  assert.ok(matched?.preflight);
  assert.equal(responseFor(matched, request).status, 204);
  request.url = request.url.replace('qa.example.org', 'staging.example.org');
  assert.equal(await selectRule([rule], { resourceType: 'Other', request }, async () => '', config), null);
});

test('environment validation supports old backups and rejects invalid origins and dangling references', () => {
  validateConfig(starterConfig());
  const { config, rule } = fixture();
  assert.deepEqual(validateConfig(JSON.parse(exportConfig(config))), config);
  config.environments[0].baseUrls = ['https://qa.example.org/api'];
  assert.throws(() => validateConfig(config), /origin/);
  config.environments[0].baseUrls = ['https://user:password@example.org'];
  assert.throws(() => validateConfig(config), /origin/);
  config.environments[0].baseUrls = ['http://localhost:4319'];
  rule.environmentScope = 'selected'; rule.environmentIds = ['missing'];
  assert.throws(() => validateConfig(config), /selected environments/);
  rule.environmentIds = ['qa']; config.settings.environmentId = 'missing';
  assert.throws(() => validateConfig(config), /existing environment/);
});

test('Postman mock exports freeze resolved targets and remain portable without environment setup', () => {
  const { config } = fixture('all');
  const scenario = config.scenarios[0];
  const script = postmanMockScript(scenario, config);
  const imported = readPostmanMock(script);
  assert.equal(imported.rules.length, 4);
  assert.ok(imported.rules.every(rule => !rule.environmentScope && !rule.environmentIds));
  assert.ok(imported.rules.some(rule => rule.url === 'https://qa.example.org/api/v1/cart?mode=qa'));
  assert.equal(scenario.rules.length, 1);
});

test('the running interceptor uses the latest selected environment for each request', async () => {
  const { Interceptor } = await import('../src/core/interceptor.mjs');
  const { config } = fixture();
  const calls = [];
  const engine = new Interceptor({ send: async (method, params) => { calls.push([method, params]); }, getConfig: () => config, onActivity() {} });
  await engine.start();
  const pause = async (id, host) => {
    engine.event('Fetch.requestPaused', { requestId: id, resourceType: 'Fetch', request: { method: 'GET', url: `${host}/api/v1/cart?mode=qa`, headers: {} } });
    await new Promise(resolve => setImmediate(resolve));
  };
  await pause('qa-match', 'https://qa.example.org');
  config.settings.environmentId = 'staging';
  await pause('qa-pass', 'https://qa.example.org');
  await pause('staging-match', 'https://staging.example.org');
  assert.ok(calls.some(([method, params]) => method === 'Fetch.fulfillRequest' && params.requestId === 'qa-match'));
  assert.ok(calls.some(([method, params]) => method === 'Fetch.continueRequest' && params.requestId === 'qa-pass'));
  assert.ok(calls.some(([method, params]) => method === 'Fetch.fulfillRequest' && params.requestId === 'staging-match'));
  await engine.stop();
});

test('environment exports keep route IDs unique across existing and long rule IDs', () => {
  const { config, rule } = fixture('all');
  config.scenarios[0].rules = [
    { ...rule, id: 'mockend-env-1' },
    { ...rule, id: 'a'.repeat(79) + '1' },
    { ...rule, id: 'a'.repeat(79) + '2' }
  ];
  const imported = readPostmanMock(postmanMockScript(config.scenarios[0], config));
  assert.equal(imported.rules.length, 12);
  assert.equal(new Set(imported.rules.map(item => item.id)).size, 12);
  for (const original of config.scenarios[0].rules) {
    assert.ok(imported.rules.some(item => item.id === original.id));
  }
});


test('optional service labels survive backups without changing Env URL matching', async () => {
  const { config, rule } = fixture();
  config.environments[1].services = { 'https://qa.example.org': 'Accounts' };
  const restored = validateConfig(JSON.parse(exportConfig(config)));
  assert.deepEqual(restored.environments[1].services, { 'https://qa.example.org': 'Accounts' });
  assert.ok(await match(rule, restored, 'https://qa.example.org/api/v1/cart?mode=qa'));
  const invalid = structuredClone(config);
  invalid.environments[1].services['https://unknown.example.org'] = 'Unknown';
  assert.throws(() => validateConfig(invalid), /existing base URL/);
  invalid.environments[1].services = { 'https://qa.example.org': ' ' };
  assert.throws(() => validateConfig(invalid), /name of 1/);
});
