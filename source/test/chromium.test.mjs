import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { starterConfig } from '../src/core/config.mjs';
import { Interceptor } from '../src/core/interceptor.mjs';
import { Recorder } from '../src/chromium/recorder.mjs';
import { captureResponse } from '../src/chromium/capture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = resolve(import.meta.dirname, '../build/chromium');

test('unpacked extension applies real browser mocks and supports the rule editor', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mockroute-chromium-'));
  let context;
  t.after(async () => { await context?.close(); await rm(profile, { recursive: true, force: true }); });
  const demo = spawn(process.execPath, [resolve(import.meta.dirname, '../examples/demo.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => demo.kill());
  await Promise.race([
    once(demo.stdout, 'data'),
    once(demo.stderr, 'data').then(([error]) => { throw new Error(String(error)); })
  ]);

  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent('serviceworker')];
  const extensionId = new URL(worker.url()).hostname;
  const errors = [];
  const panel = await context.newPage();
  await panel.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
  panel.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.getByRole('button', { name: 'Rules', exact: true }).click();
  await panel.getByText('Cart with items').waitFor();
  const app = await context.newPage();
  await app.goto('http://127.0.0.1:4319/');
  await app.bringToFront();
  const click = async (label, expected) => {
    await app.getByRole('button', { name: label, exact: true }).click();
    await app.locator('#result').filter({ hasText: expected }).waitFor();
  };
  await click('Load cart', 'Notebook');

  await panel.getByText('MockRoute Checkout Demo', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Start mocking' }).evaluate(button => button.click());
  await panel.getByRole('button', { name: 'Stop mocking' }).waitFor();
  await click('Load cart', 'Canvas tote');
  await click('Apply EXPIRED', 'COUPON_EXPIRED');
  await click('Apply SAVE10', 'demo server');
  await panel.getByRole('button', { name: 'Requests', exact: true }).click();
  await panel.getByRole('button', { name: 'Filters', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Mocked', exact: true }).check();
  await panel.keyboard.press('Escape');
  const mockedRows = panel.locator('#request-rows tr:visible');
  await mockedRows.filter({ hasText: '422' }).getByText('Mocked', { exact: true }).waitFor();
  assert.equal(await mockedRows.count(), 2);
  await panel.getByRole('button', { name: 'Rules', exact: true }).click();

  const other = await context.newPage();
  await other.goto('http://127.0.0.1:4319/');
  await other.bringToFront();
  await panel.getByRole('button', { name: 'Start mocking' }).waitFor();
  const otherResult = await other.evaluate(async () => (await fetch('/api/cart')).json());
  assert.equal(otherResult.items[0].name, 'Notebook');
  await other.close();
  await app.bringToFront();
  await panel.getByRole('button', { name: 'Start mocking' }).evaluate(button => button.click());
  await panel.getByRole('button', { name: 'Stop mocking' }).waitFor();

  const picker = panel.locator('#scenario');
  await picker.click();
  await panel.getByRole('button', { name: 'Demo · Empty cart', exact: true }).click();
  await picker.getByText('Demo · Empty cart').waitFor();
  await click('Load cart', '"items": []');
  await picker.click();
  await panel.getByRole('button', { name: 'Demo · Offline', exact: true }).click();
  await panel.getByText('Disconnected cart').waitFor();
  await click('Load cart', 'Request failed:');

  await panel.getByRole('button', { name: 'New scenario' }).click();
  await panel.getByRole('textbox', { name: 'New scenario name' }).fill('Custom QA');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByRole('button', { name: 'Add rule' }).click();
  await panel.getByLabel('Rule name').fill('Unexpected Unicode');
  await panel.getByLabel('Request URL').fill('http://127.0.0.1:4319/api/cart*');
  await panel.getByLabel('HTTP status').fill('503');
  await panel.getByLabel('Response JSON', { exact: true }).fill('{"message":"नमस्ते 🎧"}');
  await panel.getByRole('button', { name: 'Save rule' }).click();
  await panel.getByText('Unexpected Unicode').waitFor();
  await click('Load cart', 'नमस्ते 🎧');
  assert.match(await app.locator('#result').textContent(), /HTTP 503/);

  await panel.getByRole('button', { name: 'Stop mocking' }).click();
  await panel.getByRole('button', { name: 'Start mocking' }).waitFor();
  await click('Load cart', 'Notebook');
  await panel.reload();
  await panel.getByRole('button', { name: 'Rules', exact: true }).click();
  await panel.getByText('Unexpected Unicode').waitFor();
  assert.equal(await panel.locator('#scenario-name').textContent(), 'Custom QA');
  assert.deepEqual(errors, []);
});

test('cross-origin POST is fulfilled by Chromium before reaching the real API', { timeout: 30000 }, async t => {
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Cross-origin fixture</title>');
    } else {
      response.writeHead(500).end('Mock was bypassed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const profile = await mkdtemp(join(tmpdir(), 'mockroute-cors-'));
  let context;
  t.after(async () => { await context?.close(); await rm(profile, { recursive: true, force: true }); });
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const panel = await context.newPage();
  await panel.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/panel.html`);
  await panel.getByRole('button', { name: 'Rules', exact: true }).click();
  const app = await context.newPage();
  await app.goto(`http://127.0.0.1:${port}/`);
  await app.bringToFront();
  await panel.getByRole('button', { name: 'Add rule' }).click();
  let apiHits = 0;
  const api = createServer((_request, response) => {
    apiHits++;
    response.writeHead(500).end('Mock was bypassed');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => api.close());
  const target = `http://127.0.0.1:${api.address().port}/api/test`;
  await panel.getByLabel('Rule name').fill('Cross-origin JSON');
  await panel.getByLabel('Request URL').fill(target);
  await panel.getByLabel('Method', { exact: true }).selectOption('POST');
  await panel.getByLabel('Response JSON', { exact: true }).fill('{"mock":true}');
  await panel.getByText('Headers and CORS').click();
  await panel.getByText('Allow requesting origin on this mock').click();
  await panel.getByRole('button', { name: 'Save rule' }).click();
  await panel.getByText('Cross-origin JSON', { exact: true }).waitFor();
  await panel.getByText('Cross-origin fixture', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Start mocking' }).evaluate(button => button.click());
  await panel.getByRole('button', { name: 'Stop mocking' }).waitFor();
  const data = await app.evaluate(async url => {
    const response = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: '{}'
    });
    return response.json();
  }, target);
  assert.deepEqual(data, { mock: true });
  assert.equal(apiHits, 0);
});

test('Chromium interception serves a matching API request without contacting the origin', { timeout: 15000 }, async t => {
  let originHits = 0;
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/missing')) {
      originHits++;
      response.writeHead(404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Not found</title>');
    } else if (request.url.startsWith('/api/')) {
      originHits++;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"from":"origin"}');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>MockRoute interception fixture</title>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true
  });
  t.after(() => browser.close());
  const app = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.goto(base);
  const cdp = await app.context().newCDPSession(app);
  const config = starterConfig();
  const rule = config.scenarios[0].rules[0];
  rule.url = `${base}/api/checkout?mode=qa`;
  rule.exactUrl = true;
  rule.requestBodyMode = 'exact';
  rule.response.delayMs = 0;
  const activity = [];
  const captured = [];
  const recorder = new Recorder((method, params) => cdp.send(method, params), row => captured.push(row));
  const interceptor = new Interceptor({
    send: (method, params) => cdp.send(method, params),
    getConfig: () => config,
    onActivity: row => activity.push(row),
    onMock: (...args) => recorder.markMock(...args),
    onForward: (...args) => recorder.markForward(...args)
  });
  for (const method of ['Fetch.requestPaused', 'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed']) {
    cdp.on(method, params => {
      interceptor.event(method, params);
      recorder.event(method, params);
    });
  }
  await interceptor.start();

  const callApi = mode => app.evaluate(async mode => {
    const response = await fetch('/api/checkout?mode=' + mode, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coupon: 'EXPIRED' })
    });
    return [response.status, await response.json()];
  }, mode);
  assert.deepEqual(await callApi('qa'), [422, rule.response.body]);
  assert.equal(originHits, 0);
  assert.equal(activity[0].outcome, 'Mocked');
  assert.deepEqual(await callApi('real'), [200, { from: 'origin' }]);
  assert.equal(originHits, 1);
  const path = '/api/missing?sort=-created_date&limit=10';
  const status = path => app.evaluate(async path => {
    const response = await fetch(path);
    await response.text();
    return response.status;
  }, path);
  assert.equal(await status(path), 404);
  await app.waitForFunction(path => performance.getEntriesByName(location.origin + path).length > 0, path);
  assert.equal(originHits, 2);
  assert.deepEqual(activity.slice(1).map(row => [row.outcome, row.status, row.mimeType]), [
    ['Passed through', 200, 'application/json'],
    ['Passed through', 404, 'text/html']
  ]);
  const apiRows = captured.filter(row => row.request.url.includes('/api/'));
  assert.deepEqual(apiRows.map(row => [row._mocked, row.response.status]), [[true, 422], [undefined, 200], [undefined, 404]]);
  assert.deepEqual(JSON.parse((await recorder.body(apiRows[0].id)).text), rule.response.body);
  const upstream = apiRows[2];
  assert.equal(upstream._forwarded, true);
  const draft = captureResponse(upstream, (await recorder.body(upstream.id)).text);
  assert.equal(draft.rule.url, base + path);
  const replacement = {
    ...draft.rule, id: 'replace-error', enabled: true,
    response: { ...draft.rule.response, body: draft.text, delayMs: 0, cors: false }
  };
  config.scenarios[0].rules.unshift(replacement);
  assert.equal(await status('/api/missing?limit=10&sort=-created_date'), 404);
  assert.equal(captured.filter(row => row._mockRule === replacement.name).at(-1).response.status, 404);
  replacement.response = { kind: 'json', status: 200, body: { items: [] }, delayMs: 0, cors: false, headers: {} };
  assert.equal(await status(path), 200);
  assert.equal(captured.filter(row => row._mockRule === replacement.name).at(-1).response.status, 200);
  assert.equal(originHits, 2);
  assert.equal(await status('/api/missing?sort=-created_date&limit=11'), 404);
  assert.equal(originHits, 3);
  await interceptor.stop();
});
