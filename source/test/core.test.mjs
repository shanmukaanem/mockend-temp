import assert from 'node:assert/strict';
import { test } from 'node:test';
import { starterConfig, validateConfig } from '../src/core/config.mjs';
import { globMatches, logUrl, responseFor, selectRule } from '../src/core/matcher.mjs';
import { Controller } from '../src/core/controller.mjs';
import { Interceptor } from '../src/core/interceptor.mjs';
import { CdpConnection, proxyUrl } from '../src/vscode/cdp.mjs';
import { parseAppUrl } from '../src/vscode/browser.mjs';

const checkout = starterConfig().scenarios[0];
const coupon = checkout.rules[0];
const cart = checkout.rules[1];

function request(rule, overrides = {}, resourceType = 'Fetch') {
  return { requestId: '123', resourceType, request: { method: rule.method, url: rule.url, ...overrides } };
}

test('validates starter, duplicate IDs, response headers and bodyless statuses', () => {
  assert.deepEqual(validateConfig(starterConfig()), starterConfig());
  const config = starterConfig();
  config.scenarios[0].rules.push(config.scenarios[0].rules[0]);
  assert.throws(() => validateConfig(config), /duplicate IDs/);
  config.scenarios[0].rules.pop();
  config.scenarios[0].rules[0].response.headers['Content-Length'] = '4';
  assert.throws(() => validateConfig(config), /unsupported header/);
  config.scenarios[0].rules[0].response.headers = { 'X-Case': 'a', 'x-case': 'b' };
  assert.throws(() => validateConfig(config), /duplicate header/);
  config.scenarios[0].rules[0].response.headers = {};
  config.scenarios[0].rules[0].response.status = 204;
  assert.throws(() => validateConfig(config), /cannot include a body/);
  delete config.scenarios[0].rules[0].response.body;
  assert.equal(validateConfig(config).scenarios[0].rules[0].response.status, 204);
});

test('supports literal query strings, glob paths and optional JSON body predicates', async () => {
  assert.equal(globMatches('https://api.test/orders/*?q=1', 'https://api.test/orders/123?q=1'), true);
  assert.equal(globMatches('https://api.test/orders/*?q=1', 'https://api.test/orders/123?q=11'), false);
  assert.equal(globMatches('https://api.test/orders/*', 'https://apiXtest/orders/123'), false);
  const calls = [];
  const read = body => async () => { calls.push(body); return body; };
  const fallback = { ...coupon, id: 'fallback' };
  delete fallback.requestBody;
  const rules = [coupon, fallback];
  assert.equal((await selectRule(rules, request(coupon), read('{"coupon":"EXPIRED","extra":1}'))).rule.id, coupon.id);
  assert.equal((await selectRule(rules, request(coupon), read('{"coupon":"SAVE10"}'))).rule.id, 'fallback');
  assert.equal((await selectRule(rules, request(coupon), read('invalid'))).rule.id, 'fallback');
  assert.equal(await selectRule(rules, request(coupon, { method: 'GET' }), read('{}')), null);
  assert.equal(await selectRule(rules, request(coupon, {}, 'Document'), read('{}')), null);
  assert.equal(calls.length, 3);
  const exact = { ...coupon, requestBody: { nested: [{ item: null }] } };
  assert.equal((await selectRule([exact], request(exact), read('{"nested":[{"item":null,"other":true}]}'))).rule, exact);
  assert.equal(await selectRule([exact], request(exact), read('{"nested":[{"item":null},{}]}')), null);
});

test('parameter rules match selective query values and typed JSON fields', async () => {
  const config = starterConfig();
  config.scenarios[0].rules = [{
    ...cart, endpointOnly: true, method: 'POST', url: 'https://app.test/orders?captured=old',
    parameters: [
      { source: 'query', key: 'limit', value: '10' },
      { source: 'body', key: '/items/0/customer~1id', value: 7 }
    ]
  }];
  const [rule] = validateConfig(config).scenarios[0].rules;
  const event = request(rule, { url: 'https://app.test/orders?limit=10&other=new' });
  const json = async () => '{"items":[{"customer/id":7,"ignored":true}]}';
  assert.equal((await selectRule([rule], event, json)).rule, rule);
  assert.equal(await selectRule([rule], event, async () => '{"items":[{"customer/id":"7"}]}'), null);
  assert.equal(await selectRule([rule], request(rule, { url: 'https://app.test/orders?limit=11' }), json), null);
  assert.equal(await selectRule([rule], request(rule, { url: 'https://app.test/archive?limit=10' }), json), null);
  rule.parameters.push({ join: 'or', source: 'query', key: 'preview', value: 'true' });
  rule.parameters.push({ source: 'body', key: '/enabled', value: true });
  const preview = request(rule, { url: 'https://app.test/orders?preview=true' });
  assert.equal((await selectRule([rule], event, json)).rule, rule);
  assert.equal((await selectRule([rule], preview, async () => '{"enabled":true}')).rule, rule);
  assert.equal(await selectRule([rule], preview, async () => '{"enabled":false}'), null);
  assert.equal(await selectRule([rule], event, async () => '{"enabled":true}'), null);
  rule.response.cors = true;
  const preflight = { resourceType: 'Other', request: { ...preview.request, method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', Origin: 'https://another.test'
  } } };
  assert.equal((await selectRule([rule], preflight, async () => assert.fail('Preflight has no JSON body'))).preflight, true);
});

test('creates UTF-8 JSON responses, respects custom headers, and handles a CORS preflight', async () => {
  const rule = { ...coupon, response: { ...coupon.response, cors: true, body: { message: 'नमस्ते 🎧' }, headers: { 'X-QA': 'case' } } };
  const event = request(rule, { headers: { Origin: 'https://app.test' } });
  const direct = responseFor({ rule, preflight: false }, event.request);
  assert.deepEqual(JSON.parse(direct.body), rule.response.body);
  assert.ok(direct.headers.some(header => header.name === 'x-qa' && header.value === 'case'));
  assert.ok(direct.headers.some(header => header.name === 'access-control-allow-origin' && header.value === 'https://app.test'));
  event.request.method = 'OPTIONS';
  event.request.headers['Access-Control-Request-Method'] = 'POST';
  event.request.headers['Access-Control-Request-Headers'] = 'content-type';
  const preflight = responseFor(await selectRule([rule], event, () => ''), event.request);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.body, undefined);
  assert.ok(!preflight.headers.some(header => header.name === 'x-qa'));
  assert.ok(preflight.headers.some(header => header.name === 'access-control-allow-headers'));
  assert.equal(logUrl('https://foo:bar@app.test/api?token=123#fragment'), 'https://app.test/api');
});

test('controller rejects stale writes and storage failure leaves the previous scenario active', async () => {
  let fail = false;
  const controller = new Controller({
    storage: { get: async key => key.includes("configuration") ? starterConfig() : undefined, set: async () => { if (fail) throw new Error('Disk unavailable'); } },
    platform: { state: async () => ({}) }
  });
  const state = await controller.dispatch('state');
  state.config = structuredClone(state.config);
  state.config.activeScenarioId = 'empty';
  fail = true;
  await assert.rejects(controller.dispatch('save', state), /Disk unavailable/);
  assert.equal((await controller.dispatch('state')).config.activeScenarioId, 'checkout');
  fail = false;
  assert.equal((await controller.dispatch('save', state)).config.activeScenarioId, 'empty');
  await assert.rejects(controller.dispatch('save', state), /changed in another panel/);
});

test('activity survives reopening and Clear stays cleared', async () => {
  const saved = new Map();
  const storage = {
    get: async key => saved.get(key),
    set: async (key, value) => saved.set(key, structuredClone(value))
  };
  const platform = {
    state: async () => ({}),
    start: async (_target, _config, report) => report({ outcome: 'Mocked' })
  };
  const controller = new Controller({ storage, platform });
  await controller.dispatch('start');
  const reopened = new Controller({ storage, platform });
  assert.deepEqual((await reopened.dispatch('state')).activity, [{ outcome: 'Mocked' }]);
  await reopened.dispatch('clear');
  assert.deepEqual((await new Controller({ storage, platform }).dispatch('state')).activity, []);
});

test('stopping releases delayed requests before disabling Fetch', async () => {
  const calls = [];
  const config = starterConfig();
  config.scenarios[0].rules[1].response.delayMs = 30000;
  const engine = new Interceptor({
    send: async (method, params) => { calls.push([method, params]); },
    getConfig: () => config,
    onActivity: () => {}
  });
  await engine.start();
  engine.event('Fetch.requestPaused', request(cart));
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();
  const methods = calls.map(([method]) => method);
  assert.ok(methods.indexOf('Fetch.continueRequest') < methods.indexOf('Fetch.disable'));
  assert.ok(!methods.includes('Fetch.fulfillRequest'));
});

test('engine blocks the origin request if Chromium rejects the mock', async () => {
  const calls = [];
  const results = [];
  const engine = new Interceptor({
    send: async method => {
      calls.push(method);
      if (method === 'Fetch.fulfillRequest') throw new Error('mock rejected');
    },
    getConfig: starterConfig,
    onActivity: row => results.push(row)
  });
  await engine.start();
  engine.event('Fetch.requestPaused', request(cart));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('Fetch.failRequest'));
  assert.ok(!calls.includes('Fetch.continueRequest'));
  assert.equal(results[0].outcome, 'Interception failed');
  await engine.stop();
});

test('forwarded activity reports HTTP status or load failure for the matching debugger session', async () => {
  const results = [];
  const engine = new Interceptor({ send: async () => {}, getConfig: starterConfig, onActivity: row => results.push(row) });
  const event = { ...request(cart, { url: 'https://example.test/api/not-found?token=private' }), networkId: 'shared' };
  await engine.start();
  engine.event('Fetch.requestPaused', event);
  engine.event('Fetch.requestPaused', event, 'iframe');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(results, []);
  engine.event('Network.responseReceived', { requestId: 'shared', response: { status: 404, mimeType: 'text/html' } });
  engine.event('Network.loadingFailed', { requestId: 'shared', errorText: 'net::ERR_CONNECTION_RESET' }, 'iframe');
  engine.event('Network.loadingFinished', { requestId: 'shared' });
  assert.equal(results.length, 2);
  assert.equal(results[0].outcome, 'Upstream request failed');
  assert.equal(results[0].error, 'net::ERR_CONNECTION_RESET');
  assert.equal(results[1].outcome, 'Passed through');
  assert.equal(results[1].status, 404);
  assert.equal(results[1].mimeType, 'text/html');
  assert.equal(results[1].url, 'https://example.test/api/not-found');
  await engine.stop();
});

test('VS Code accepts only loopback debugger endpoints and safe app URLs', () => {
  assert.equal(proxyUrl({ host: '127.0.0.1', port: 8021, path: '/session/id' }).href, 'ws://127.0.0.1:8021/session/id');
  assert.equal(proxyUrl({ host: '::1', port: 8021, path: '/' }).href, 'ws://[::1]:8021/');
  for (const info of [
    { host: 'external.test', port: 8021, path: '/' },
    { host: 'localhost', port: 8021, path: '//external.test' },
    { host: 'localhost', port: 65536, path: '/' },
    { host: 'localhost', port: 8021, path: '/\\external.test' }
  ]) assert.throws(() => proxyUrl(info), /local browser connection/);
  assert.equal(parseAppUrl(' http://localhost:3000 ').href, 'http://localhost:3000/');
  assert.throws(() => parseAppUrl('javascript:alert(1)'), /HTTP/);
  assert.throws(() => parseAppUrl('https://alice:secret@example.com'), /HTTP/);
});

test('VS Code WebSocket transport sends CDP messages and routes session events', async () => {
  const NativeSocket = globalThis.WebSocket;
  class MockSocket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(text) {
      const command = JSON.parse(text);
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result: command }) }));
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: '7' }, sessionId: command.sessionId }) }));
      });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = MockSocket;
  try {
    const events = [];
    const connection = new CdpConnection('ws://localhost:8888/', (...event) => events.push(event), () => events.push(['close']));
    await connection.open;
    const response = await connection.send('Fetch.enable', { patterns: [] }, 'child');
    assert.equal(response.method, 'Fetch.enable');
    assert.equal(response.sessionId, 'child');
    assert.deepEqual(events[0], ['Fetch.requestPaused', { requestId: '7' }, 'child']);
    connection.close();
    assert.deepEqual(events[1], ['close']);
  } finally {
    globalThis.WebSocket = NativeSocket;
  }
});
