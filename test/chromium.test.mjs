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
  await panel.locator('#import-file').setInputFiles(resolve(import.meta.dirname, '../examples/checkout-scenarios.json'));
  await panel.getByRole('button', { name: 'Replace configuration' }).click();
  await panel.getByText('Cart with items', { exact: true }).waitFor();
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
  await other.evaluate(() => { document.title = 'Other app tab'; });
  await other.bringToFront();
  await panel.locator('#target-title').filter({ hasText: 'Other app tab' }).waitFor();
  await panel.getByRole('button', { name: 'Start mocking' }).waitFor();
  const otherResult = await other.evaluate(async () => (await fetch('/api/cart')).json());
  assert.equal(otherResult.items[0].name, 'Notebook');
  await other.close();
  await app.bringToFront();
  await panel.locator('#target-title').filter({ hasText: 'MockRoute Checkout Demo' }).waitFor();
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

  await panel.getByRole('button', { name: 'New Flow' }).click();
  await panel.getByRole('textbox', { name: 'New Flow name' }).fill('Custom QA');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByRole('button', { name: 'Add rule' }).click();
  await panel.getByLabel('Rule name').fill('Unexpected Unicode');
  await panel.locator('.route-advanced > summary').click();
  await panel.getByRole('combobox', { name: 'URL matching', exact: true }).selectOption('pattern');
  await panel.getByLabel('Request URL').fill('http://127.0.0.1:4319/api/cart*');
  await panel.locator('#response-status-toggle').click();
  await panel.getByRole('searchbox', { name: 'Search or add HTTP status' }).fill('503 QA Maintenance');
  await panel.getByRole('button', { name: 'Use 503 QA Maintenance', exact: true }).click();
  await panel.getByLabel('Response JSON', { exact: true }).fill('{"message":"नमस्ते 🎧"}');
  await panel.getByRole('button', { name: 'Save rule' }).click();
  await panel.getByText('Unexpected Unicode').waitFor();
  await click('Load cart', 'नमस्ते 🎧');
  assert.match(await app.locator('#result').textContent(), /HTTP 503/);
  assert.equal(await app.evaluate(async () => (await fetch('/api/cart')).statusText), 'QA Maintenance');

  await panel.getByRole('button', { name: 'Stop mocking' }).click();
  await panel.getByRole('button', { name: 'Start mocking' }).waitFor();
  await click('Load cart', 'Notebook');
  await panel.reload();
  await panel.getByRole('button', { name: 'Rules', exact: true }).click();
  await panel.getByText('Unexpected Unicode').waitFor();
  assert.equal(await panel.locator('#scenario-name').textContent(), 'Custom QA');
  assert.deepEqual(errors, []);
});

test('Record pauses and resumes real capture independently of mocking in both themes', { timeout: 30000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': request.url === '/' ? 'text/html' : 'application/json' });
    response.end(request.url === '/' ? '<title>Recording fixture</title>' : '{"ok":true}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'mockend-record-toggle-'));
  let context;
  t.after(async () => { await context?.close(); await rm(profile, { recursive: true, force: true }); });
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'], headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent('serviceworker')];
  const extensionId = new URL(worker.url()).hostname;
  const app = await context.newPage(); await app.goto(origin);
  const tabId = await worker.evaluate(async address => (await chrome.tabs.query({})).find(tab => tab.url === address + '/').id, origin);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html?tab=${tabId}`);
  const record = panel.locator('#record-toggle'); const mocking = panel.locator('#toggle');
  const paused = () => panel.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
  const recording = () => panel.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  const fetchApi = path => app.evaluate(async url => (await fetch(url)).json(), path);
  await recording(); await record.click(); await paused();
  await panel.locator('#clear-requests').evaluate(button => { if (!button.disabled) button.click(); });
  await panel.waitForFunction(() => document.querySelector('#request-count').textContent === '(0)');
  await fetchApi('/api/paused');
  await record.click(); await recording();
  await fetchApi('/api/recorded');
  await panel.getByRole('button', { name: 'View GET /api/recorded' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'View GET /api/paused' }).count(), 0);
  await mocking.click(); await panel.getByRole('button', { name: 'Stop mocking', exact: true }).waitFor();
  await record.click(); await paused(); await fetchApi('/api/paused-while-mocking');
  await record.click(); await recording(); await fetchApi('/api/resumed');
  await panel.getByRole('button', { name: 'View GET /api/resumed' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'View GET /api/paused-while-mocking' }).count(), 0);
  assert.equal(await mocking.getAttribute('aria-pressed'), 'true');
  assert.equal(await record.getAttribute('aria-pressed'), 'true');
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  await panel.mouse.move(0, 0);
  for (const scheme of ['dark', 'light']) {
    await panel.evaluate(value => {
      const picker = document.getElementById('color-scheme'); picker.value = value; picker.dispatchEvent(new Event('change'));
    }, scheme);
    await panel.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const styles = await panel.locator('.activity-control').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button); const indicator = button.querySelector('.activity-control-switch');
      return { width: button.offsetWidth, height: button.offsetHeight, background: style.backgroundColor,
        radius: style.borderRadius, knob: getComputedStyle(indicator, '::before').transform };
    }));
    assert.deepEqual(styles[0], styles[1], 'Record and Mocking share button and switch geometry');
    if (scheme === 'dark') assert.equal(await panel.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 0, 0)');
    await panel.setViewportSize({ width: 320, height: 760 });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: resolve(import.meta.dirname, `../test-results/record-toggle-${scheme}.png`), animations: 'allow' });
  }
  await record.click(); await paused(); await mocking.click();
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
  await panel.getByRole('tab', { name: 'Headers & CORS' }).click();
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

test('Chromium interception serves a matching API request without contacting the origin', { timeout: 30000 }, async t => {
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
  const banner = app.locator(`[id="${interceptor.banner.id}"]`).getByRole('status');
  assert.equal(await app.locator(`[id="${interceptor.banner.id}"]`).count(), 1, 'Flow indicator mounts on the existing page');
  await banner.filter({ hasText: config.scenarios[0].name }).waitFor({ timeout: 5000 });
  const originalName = config.scenarios[0].name;
  config.scenarios[0].name = 'QA <script>flow</script>';
  await interceptor.banner.update();
  assert.equal(await banner.textContent(), 'Mockend \u00b7 QA <script>flow</script>');
  assert.equal(await app.locator(`[id="${interceptor.banner.id}"] script`).count(), 0);
  await app.reload();
  assert.ok(await app.evaluate(id => Boolean(document.getElementById(id)), interceptor.banner.id), JSON.stringify(await app.evaluate(() => ({ ready: document.readyState, hooks: Object.keys(globalThis).filter(key => key.startsWith('mockend-flow-')) }))));
  await banner.filter({ hasText: 'QA <script>flow</script>' }).waitFor({ timeout: 5000 });
  config.scenarios[0].name = originalName;
  await interceptor.banner.update();

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
  const { addResponseScenario, setRuleState } = await import('../src/core/variants.mjs');
  const flow = config.scenarios[0];
  const serverError = addResponseScenario(flow, 'Server error');
  setRuleState(flow, rule.id, { response: { ...rule.response, status: 500, body: { error: 'scenario failure' }, delayMs: 80 } });
  const started = Date.now();
  assert.deepEqual(await callApi('qa'), [500, { error: 'scenario failure' }]);
  assert.ok(Date.now() - started >= 60);
  assert.equal(rule.response.status, 422);
  await interceptor.banner.update();
  await banner.filter({ hasText: 'Server error' }).waitFor();
  setRuleState(flow, rule.id, { enabled: false });
  assert.deepEqual(await callApi('qa'), [200, { from: 'origin' }]);
  assert.equal(rule.enabled, true);
  flow.activeVariantId = 'default';
  assert.deepEqual(await callApi('qa'), [422, rule.response.body]);
  assert.ok(serverError.overrides[rule.id].enabled === false);
  await interceptor.stop();
  assert.equal(await banner.count(), 0);
});
