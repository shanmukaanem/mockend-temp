import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { starterConfig } from '../src/core/config.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function panelFixture(t, host) {
  const directory = resolve(import.meta.dirname, '../build', host);
  const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png' };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    try {
      let bytes = await readFile(resolve(directory, '.' + pathname));
      if (host === 'vscode' && pathname === '/panel.html') {
        bytes = bytes.toString().replaceAll('@@ROOT@@', '').replaceAll('@@SOURCE@@', "'self'").replaceAll('@@NONCE@@', 'fixture');
      }
      response.writeHead(200, { 'content-type': mime[pathname.split('.').at(-1)] }).end(bytes);
    } catch {
      response.writeHead(404).end();
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
  const page = await browser.newPage({ viewport: { width: 620, height: 760 } });
  page.setDefaultTimeout(5000);
  return { page, origin: `http://127.0.0.1:${server.address().port}` };
}

async function checkFilterTray(page, prefix, screenshots) {
  const viewport = page.viewportSize();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 620, height: 320 });
  await page.mouse.move(0, 0);
  const trigger = page.locator(`#${prefix}filter-toggle`);
  const tray = page.locator(`#${prefix}request-filter-tree`);
  await trigger.hover();
  await tray.waitFor({ state: 'visible' });
  const tools = tray.locator('.filter-panel-tools');
  const before = await tools.boundingBox();
  const body = tray.locator('.filter-panel-content');
  assert.ok((await body.boundingBox()).y >= before.y + before.height - 1);
  await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
  if (await body.evaluate(node => node.scrollHeight > node.clientHeight)) assert.ok(await body.evaluate(node => node.scrollTop > 0));
  assert.equal((await tools.boundingBox()).y, before.y);
  assert.equal(await tray.evaluate(node => node.scrollTop), 0);
  assert.equal(await tools.evaluate(node => node.contains(document.elementFromPoint(node.getBoundingClientRect().left + 15, node.getBoundingClientRect().top + 12))), true);
  await page.screenshot({ path: resolve(screenshots, `${prefix || 'requests-'}filter-scrolled.png`), animations: 'disabled' });
  await body.evaluate(node => { node.scrollTop = 0; });
  const heading = tray.locator('summary').first();
  await heading.hover();
  assert.equal(await heading.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(230, 218, 196)');
  assert.equal(await tray.locator('.filter-facet > .filter-select-all').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: resolve(screenshots, `${prefix || 'requests-'}filter-header-hover.png`), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize(viewport);
  await page.mouse.move(0, 0);
  await trigger.hover();
}

test('request and rule tables split URLs and support independent filters', async t => {
  const { page, origin } = await panelFixture(t, 'chromium');
  const screenshots = resolve(import.meta.dirname, '../test-results');
  await mkdir(screenshots, { recursive: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let config = starterConfig(); let revision = 0;
  config.scenarios[0].rules[0].enabled = false;
  await page.exposeFunction('fixtureMockRouteMessage', async ({ action, data }) => {
    if (action === 'save') { config = data.config; revision++; }
    return { state: { revision, config, activity: [], connection: { available: { id: 9, url: 'https://example.test/', title: 'Test' } } } };
  });
  const original = '{"items":["original"]}';
  await page.addInitScript(content => {
    localStorage.setItem('mockend.group-rules', 'true');
    const entry = (id, method, path, status, resource) => ({
      id, request: { method, url: 'https://example.test' + path, ...(method === 'POST' && { postData: { text: '{"order":3}' } }) },
      response: { status, content: { mimeType: 'application/json' } }, _resourceType: resource
    });
    window.chrome ??= {};
    window.chrome.windows = { getCurrent: async () => ({ id: 4 }) };
    window.chrome.runtime = {
      sendMessage: message => window.fixtureMockRouteMessage(message),
      connect: () => {
        let listener;
        let stops = 0;
        window.addEventListener('fixture-site', event => listener({ type: 'site', tab: { id: 9, url: event.detail } }));
        return {
          onMessage: { addListener: callback => { listener = callback; } },
          onDisconnect: { addListener() {} },
          postMessage: message => {
            if (message.type === 'start') {
              if (message.windowId !== 4) throw new Error('Unexpected browser window');
              listener({ type: 'reset', tab: { id: 9, url: 'https://example.test/' } });
              listener({ type: 'status', status: 'recording' });
              if (sessionStorage.getItem('fixture-emitted')) return;
              sessionStorage.setItem('fixture-emitted', '1');
              for (const row of [
                entry(1, 'GET', '/logo.png', 304, 'image'),
                { ...entry(2, 'GET', '/api/orders?mode=qa', 200, 'fetch'), _mocked: true, _mockRule: 'Cart with items', _mockRuleId: 'filled', _mockScenarioId: 'checkout' },
                entry(3, 'POST', '/api/orders', 404, 'xhr')
              ]) listener({ type: 'request', row });
            } else if (message.type === 'stop') {
              listener({ type: 'status', status: 'stopped' });
              if (++stops === 1) return;
              listener({ type: 'site', tab: { id: 9, url: 'https://other.test/' } });
              const foreign = entry(4, 'GET', '/external', 200, 'fetch');
              foreign.request.url = 'https://other.test/external';
              listener({ type: 'request', row: foreign });
              const related = entry(5, 'GET', '/related', 200, 'fetch');
              related.request.url = 'https://api-other.test/related';
              listener({ type: 'request', row: related });
            } else if (message.type === 'body') {
              listener({ type: 'body', token: message.token, body: { text: message.id === 2 ? content : message.id === 5
                ? JSON.stringify({ meta: { details: { entries: Array.from({ length: 150 }, (_, i) => i) } } }, null, 2)
                : '{"message":"missing"}' } });
            }
          }
        };
      }
    };
  }, original);

  await page.goto(`${origin}/panel.html`);
  await page.getByText('Recording active tab').waitFor();
  const rows = page.locator('#request-rows tr:visible');
  await page.locator('#endpoint-scope-toggle').click();
  const fileEndpoints = page.locator('#endpoint-scope-menu .facet-options label').filter({ hasText: /\.[a-z]+$/i });
  assert.ok(await fileEndpoints.evaluateAll(labels => labels.every(label => !label.querySelector('input').checked)));

  await page.locator('#endpoint-scope-menu').getByRole('checkbox', { name: 'Select all endpoint filters', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.locator('#request-count').getByText('(3)', { exact: true }).waitFor();
  const requestTable = page.locator('#requests-view table');
  await page.waitForFunction(() => document.querySelector('#requests-view table')?.dataset.sized === 'true');
  const columnWidths = await requestTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
  assert.ok(columnWidths[2] > columnWidths[1], 'URL columns have more room than methods');
  assert.ok(columnWidths[2] <= 420 && columnWidths[1] <= 110);
  for (const width of [620, 900, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await requestTable.locator('col').evaluateAll(cols => [1, 2, 4, 5].map(index => parseFloat(cols[index].style.width))), [1, 2, 4, 5].map(index => columnWidths[index]));
    const fit = await page.locator('#requests-view .request-table').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth, table: node.querySelector('table').offsetWidth, widths: [...node.querySelectorAll('col')].map(col => col.style.width) }));
    assert.ok(fit.scroll <= fit.client, JSON.stringify({ width, ...fit }));
    const actions = await page.locator('#request-rows .request-row-actions').first().boundingBox();
    assert.ok(actions.x >= 10 && actions.x + actions.width <= width - 10);
  }
  await page.setViewportSize({ width: 790, height: 900 });
  await page.locator('body').evaluate(node => node.style.setProperty('--panel-zoom', '1.25'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#requests-view .request-table').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: resolve(screenshots, 'requests-fit-790.png'), animations: 'disabled' });
  await page.locator('body').evaluate(node => node.style.removeProperty('--panel-zoom'));
  await page.setViewportSize({ width: 620, height: 760 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const [label, index] of [['Method', 1], ['Base URL / Path', 2], ['Type', 4]]) {
    const divider = page.getByRole('separator', { name: `Resize ${label} column`, exact: true }).first();
    const before = Number(await divider.getAttribute('aria-valuenow'));
    const movement = Math.min(10, Number(await divider.getAttribute('aria-valuemax')) - before);
    const neighbors = await requestTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), before + movement);
    const resized = await requestTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
    assert.equal(resized[index + 1], neighbors[index + 1] - movement);
    for (let other = 0; other < resized.length; other++) if (other !== index && other !== index + 1) assert.equal(resized[other], neighbors[other]);
    assert.equal(await requestTable.locator('col').nth(index).evaluate(node => parseFloat(node.style.width)), before + movement);
    await page.setViewportSize({ width: 900, height: 760 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), before + movement);
    await page.setViewportSize({ width: 620, height: 760 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await divider.dblclick();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), before);
  }
  const requestDivider = page.getByRole('separator', { name: 'Resize ID column', exact: true }).first();
  await requestDivider.scrollIntoViewIfNeeded();
  const dividerBox = await requestDivider.boundingBox();
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x + dividerBox.width / 2 - 10, dividerBox.y + dividerBox.height / 2);
  await page.mouse.up();
  const manualWidth = Number(await requestDivider.getAttribute('aria-valuenow'));
  assert.equal(manualWidth, Math.max(Number(await requestDivider.getAttribute('aria-valuemin')), columnWidths[0] - 10));
  const stableWidths = await requestTable.locator('col').evaluateAll(cols => cols.map(col => col.style.width));
  for (const column of ['method', 'status', 'endpoint', 'id', 'id']) {
    await page.locator(`#requests-view [data-sort="${column}"]`).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await requestTable.locator('col').evaluateAll(cols => cols.map(col => col.style.width)), stableWidths);
    assert.deepEqual(await page.locator('#requests-view .column-resize').first().evaluate(node => ({ opacity: getComputedStyle(node, '::after').opacity, shadow: getComputedStyle(node, '::after').boxShadow })), { opacity: '0.35', shadow: 'none' });
  }
  await page.locator('#request-query').fill('no-such-request');
  assert.equal(await page.locator('#request-empty').isVisible(), true);
  assert.equal(await page.locator('#request-empty').evaluate(node => Boolean(node.closest('table'))), true);
  await page.locator('#requests-view .request-table').evaluate(node => { node.scrollLeft = node.scrollWidth; });
  const emptyLeft = await page.locator('#request-empty-text').evaluate(node => node.getBoundingClientRect().left);
  const viewportLeft = await page.locator('#requests-view .request-table').evaluate(node => node.getBoundingClientRect().left);
  assert.ok(Math.abs(emptyLeft - viewportLeft) <= 1);
  await page.locator('#request-query').fill('');
  await page.locator('#requests-view .request-table').evaluate(node => { node.scrollLeft = 0; });
  await page.locator('#path-scope-toggle').hover();
  await page.locator('#path-scope-toggle').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
  const pathMenu = page.locator('#path-scope-menu');
  await page.waitForFunction(() => document.querySelector('#path-scope-toggle').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.locator('#path-scope-toggle small').evaluate(node => getComputedStyle(node).color === getComputedStyle(node.closest('button')).color), true);
  const allPaths = pathMenu.getByRole('checkbox', { name: 'Select all path filters' });
  const checkboxStyle = node => {
    const style = getComputedStyle(node);
    return [style.width, style.height, style.borderRadius, style.backgroundColor];
  };
  const selectedCheckboxStyle = await allPaths.evaluate(checkboxStyle);
  const trayInsets = await pathMenu.evaluate(menu => {
    const header = menu.querySelector('.scope-menu-header');
    const option = menu.querySelector('.facet-options label');
    const checkbox = option.querySelector('input');
    const row = option.getBoundingClientRect();
    const check = checkbox.getBoundingClientRect();
    const bulk = getComputedStyle(header.querySelector('label'));
    return {
      widths: [header.getBoundingClientRect().width, row.width],
      rowPadding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(key => getComputedStyle(option)[key]),
      headerPadding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(key => getComputedStyle(header.querySelector('span'))[key]),
      checkboxPadding: [bulk.paddingTop, bulk.paddingRight, bulk.paddingBottom, bulk.paddingLeft],
      checkInsets: [check.top - row.top, row.right - check.right, row.bottom - check.bottom]
    };
  });
  assert.equal(trayInsets.widths[0], trayInsets.widths[1]);
  assert.deepEqual(trayInsets.rowPadding, ['8px', '8px', '8px', '8px']);
  assert.deepEqual(trayInsets.headerPadding, trayInsets.rowPadding);
  assert.deepEqual(trayInsets.checkboxPadding, trayInsets.rowPadding);
  assert.deepEqual(trayInsets.checkInsets, [8, 8, 8]);
  const pathSearch = pathMenu.getByRole('searchbox', { name: 'Search Path', exact: true });
  const beforeOptionSearch = await rows.count();
  await pathSearch.fill('/api');
  assert.equal(await pathMenu.locator('.facet-options label:visible').count(), 1);
  assert.equal(await rows.count(), beforeOptionSearch);
  await pathSearch.fill('');
  await page.screenshot({ path: resolve(screenshots, 'path-tray.png'), animations: 'disabled' });
  assert.equal(await allPaths.isChecked(), true);
  await pathMenu.getByRole('checkbox', { name: '/api', exact: true }).uncheck();
  assert.equal(await rows.count(), 1);
  await pathMenu.getByRole('checkbox', { name: 'No path', exact: true }).uncheck();
  assert.equal(await rows.count(), 0);
  await allPaths.check();
  assert.equal(await rows.count(), 3);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#request-filter-tree #path-scope-menu').count(), 0);
  await page.locator('#base-url-toggle').hover();
  await page.waitForFunction(() => document.querySelector('#base-url-toggle').getAttribute('aria-expanded') === 'true');
  const currentBase = page.locator('#base-url-options label').first();
  assert.deepEqual(await currentBase.evaluate(node => ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(key => getComputedStyle(node)[key])), ['8px', '8px', '8px', '8px']);
  assert.equal(await currentBase.locator('small').evaluate(node => getComputedStyle(node).display), 'block');
  const baseSearch = page.locator('#base-url-menu').getByRole('searchbox', { name: 'Search Base URLs' });
  await baseSearch.fill('no-such-origin');
  assert.equal(await page.locator('#base-url-options label:visible').count(), 0);
  assert.equal(await baseSearch.isVisible(), true);
  await baseSearch.fill('');
  assert.ok(await page.locator('#base-url-options label:visible').count() > 0);
  await page.screenshot({ path: resolve(screenshots, 'base-url-tray.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#request-rows .record-delete').count(), 0);

  const request = rows.filter({ has: page.getByRole('button', { name: 'View POST /api/orders' }) });
  assert.equal(await request.locator('td').nth(2).innerText(), 'example.test\n/api');
  assert.equal(await request.locator('.endpoint-label').innerText(), 'orders');
  const split = request.locator('.request-row-actions');
  assert.deepEqual(await split.locator('button').allTextContents(), ['cURL', 'Mock']);
  assert.equal(await split.evaluate(node => getComputedStyle(node).opacity), '1');
  const curlBox = await split.locator('.request-curl').boundingBox();
  const mockBox = await split.locator('.request-mock').boundingBox();
  assert.equal(curlBox.x, mockBox.x);
  assert.ok(Math.abs(curlBox.y + curlBox.height - mockBox.y) < 1);
  assert.equal(await request.locator('td').last().locator('.request-row-actions').count(), 1);
  assert.equal(await requestTable.locator('th').last().locator('.column-resize').count(), 0);
  assert.deepEqual(await rows.evaluateAll(records => [...new Set(records.map(row => row.offsetHeight))]), [44]);
  await page.locator('#request-query').fill('/logo');
  assert.equal(await page.locator('#invert-results').getAttribute('aria-pressed'), 'false');
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.locator('.request-url small').textContent(), '');
  await page.locator('#invert-results').click();
  assert.equal(await rows.count(), 2);
  await page.locator('#request-query').fill('');
  assert.equal(await page.locator('#invert-results').isVisible(), false);
  assert.equal(await rows.count(), 3);
  await page.locator('#filter-toggle').hover();
  await page.waitForFunction(() => document.querySelector('#filter-toggle').getAttribute('aria-expanded') === 'true');
  await checkFilterTray(page, '', screenshots);
  assert.equal(await page.locator('#request-facets summary').filter({ hasText: 'Endpoint' }).count(), 0);
  const optionCheck = page.locator('#request-facets').getByRole('checkbox', { name: 'Fetch/XHR', exact: true });
  await optionCheck.check();
  const filterBadge = await page.locator('#filter-count').boundingBox();
  const filterIcon = await page.locator('#filter-toggle svg').boundingBox();
  assert.ok(filterBadge.height <= 10 && filterBadge.x >= filterIcon.x + filterIcon.width);
  assert.deepEqual(await optionCheck.evaluate(checkboxStyle), selectedCheckboxStyle);
  await optionCheck.uncheck();
  await page.keyboard.press('Escape');
  await page.locator('#endpoint-scope-toggle').hover();
  const endpointMenu = page.locator('#endpoint-scope-menu');
  await endpointMenu.getByRole('searchbox', { name: 'Search Endpoint' }).fill('orders');
  assert.equal(await endpointMenu.locator('.facet-options label:visible').count(), 1);
  await endpointMenu.getByRole('searchbox', { name: 'Search Endpoint' }).fill('');
  await endpointMenu.getByRole('checkbox', { name: 'orders', exact: true }).uncheck();
  assert.equal(await rows.count(), 1);
  await endpointMenu.getByRole('checkbox', { name: 'Select all endpoint filters' }).check();
  await endpointMenu.getByRole('checkbox', { name: 'Select all endpoint filters' }).uncheck();
  await endpointMenu.getByRole('checkbox', { name: 'orders', exact: true }).check();
  assert.equal(await rows.count(), 2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const rules = page.locator('#rules tr.rule');
  assert.equal(await rules.count(), 2);
  await page.locator('#clear-rules').hover();
  await page.locator('#clear-rules').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
  assert.equal(await page.locator('#clear-rules').evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('#path-scope-toggle').evaluate(node => { const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--hover-ink)'; node.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; }));
  await page.mouse.move(0, 0);
  assert.notEqual(await page.locator('#clear-rules').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 32, 32)');
  for (const index of [0, 1, 0, 1]) {
    await rules.nth(index).locator('td').nth(1).hover();
    assert.equal(await page.locator('#rules tr[data-hovered]').count(), 1);
    assert.equal(await rules.nth(index).getAttribute('data-hovered'), '');
    assert.equal(await rules.nth(1 - index).locator('td').nth(1).evaluate(node => getComputedStyle(node).backgroundColor === 'rgb(230, 218, 196)'), false);
  }
  await page.mouse.move(0, 0);
  assert.equal(await page.locator('#rules tr[data-hovered]').count(), 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const ruleTable = page.locator('#rules-view table');
  const stableRuleWidths = await ruleTable.locator('col').evaluateAll(cols => cols.map(col => col.style.width));
  for (const column of ['method', 'status', 'id']) {
    await page.locator(`#rules-view [data-rule-sort="${column}"]`).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await ruleTable.locator('col').evaluateAll(cols => cols.map(col => col.style.width)), stableRuleWidths);
  }
  await page.locator('#rules-view .request-table').evaluate(node => { node.scrollLeft = 0; });
  await page.locator('#rules-request-query').fill('no-such-rule');
  assert.equal(await page.locator('#no-rules').isVisible(), true);
  assert.equal(await page.locator('#no-rules').evaluate(node => Boolean(node.closest('table'))), true);
  await page.screenshot({ path: resolve(screenshots, 'empty-rules.png'), animations: 'disabled' });
  await page.locator('#rules-request-query').fill('');
  await page.locator('#rules-request-query').fill('Cart with items');
  assert.equal(await rules.count(), 1);
  const hiddenBefore = config.scenarios[0].rules.find(rule => rule.id !== 'filled').enabled;
  const bulkSwitch = page.locator('#toggle-filtered-mocks');
  assert.equal(await bulkSwitch.evaluate(node => Boolean(node.closest('th'))), false);
  const bulk = async enabled => { await bulkSwitch.click(); await page.locator('#bulk-mock-menu').getByRole('button', { name: new RegExp('^' + (enabled ? 'Enable' : 'Disable') + ' filtered') }).click(); };
  await bulk(false);
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').enabled, false);
  assert.equal(config.scenarios[0].rules.find(rule => rule.id !== 'filled').enabled, hiddenBefore);
  await bulk(true);
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').enabled, true);
  await page.locator('#rules-request-query').fill('');
  assert.equal(config.scenarios[0].rules.find(rule => rule.id !== 'filled').enabled, hiddenBefore, 'Removing a filter must not enable previously hidden mocks');
  await bulk(true);
  assert.ok(config.scenarios[0].rules.every(rule => rule.enabled));
  await bulk(false);
  assert.ok(config.scenarios[0].rules.every(rule => !rule.enabled));
  await bulk(true);
  await page.getByRole('button', { name: 'Enable Expired coupon', exact: true }).click();
  await page.locator('#rules-request-query').fill('Cart with items');
  await page.locator('#rules-invert-results').click();
  assert.equal(await rules.getByRole('button', { name: 'Edit Expired coupon', exact: true }).count(), 1);
  await page.locator('#rules-invert-results').click();
  const flowCount = config.scenarios.length;
  const pickerBeforeEdit = await page.locator('#scenario').boundingBox();
  await page.getByRole('button', { name: 'New Flow', exact: true }).click();
  const editBox = await page.locator('#scenario-form input[name="name"]').boundingBox();
  assert.ok(Math.abs(editBox.width - pickerBeforeEdit.width) <= 1 && editBox.height === pickerBeforeEdit.height);
  await page.screenshot({ path: resolve(screenshots, 'flow-editor.png'), animations: 'disabled' });
  await page.getByRole('textbox', { name: 'New Flow name', exact: true }).fill('Abandoned Flow');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#scenario-form').isVisible(), false);
  assert.equal(config.scenarios.length, flowCount);
  await rules.getByRole('button', { name: 'Delete Cart with items', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete this rule?', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  assert.equal(config.scenarios[0].rules.length, 2);
  assert.equal(await rules.locator('td').nth(3).innerText(), '127.0.0.1:4319\n/api');
  assert.equal(await rules.locator('td').nth(4).innerText(), 'cart');
  await page.locator('#rules-request-query').fill('[');
  await page.locator('#rules-regex-toggle').click();
  assert.equal(await page.locator('#rules-request-query-error').isVisible(), false);
  assert.equal(await page.locator('.toast[data-key="rules-request-query-error"]').isVisible(), true);
  assert.equal(await rules.count(), 0);
  assert.equal(await page.locator('#rules-invert-results').isDisabled(), true);
  await page.locator('#rules-regex-toggle').click();
  await page.locator('#rules-request-query').fill('');
  await page.locator('#rules-filter-toggle').hover();
  await page.waitForFunction(() => document.querySelector('#rules-filter-toggle').getAttribute('aria-expanded') === 'true');
  await checkFilterTray(page, 'rules-', screenshots);
  assert.equal(await page.locator('#rules-request-facets summary').filter({ hasText: 'Endpoint' }).count(), 0);
  assert.equal(await page.locator('#rules-endpoint-scope-toggle').count(), 1);
  await page.locator('#rules-request-facets').getByRole('checkbox', { name: 'Excluded', exact: true }).check();
  assert.equal(await rules.count(), 1);
  await page.locator('#rules-clear-filters').click();
  await page.keyboard.press('Escape');
  await page.locator('[data-rule-sort="status"]').click();
  assert.deepEqual(await rules.locator('.request-code').allTextContents(), ['200', '422']);
  assert.equal(await rules.first().evaluate(row => getComputedStyle(row).display), 'table-row');
  assert.equal(await rules.getByRole('button', { name: /^Duplicate/ }).count(), 0);
  assert.equal(await rules.locator('svg, .duplicate-icon').count(), 0);
  assert.equal(await rules.count(), 2);
  assert.equal(config.scenarios[0].rules.length, 2);
  await rules.first().locator('.rule-state-pill').click();
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').enabled, false);
  await rules.first().locator('.rule-state-pill').click();
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').enabled, true);
  await page.setViewportSize({ width: 360, height: 760 });
  assert.deepEqual(await page.locator('#rules-url-only-toggle').evaluate(node => [node.offsetWidth, node.offsetHeight]), await page.locator('#rules-regex-toggle').evaluate(node => [node.offsetWidth, node.offsetHeight]));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await rules.evaluateAll(records => [...new Set(records.map(row => row.offsetHeight))]), [44]);
  const envPicker = page.getByRole('combobox', { name: 'Env', exact: true });
  assert.equal(await envPicker.inputValue(), '');
  assert.equal(await envPicker.locator('option:checked').textContent(), 'Save Env');
  assert.equal(await page.locator('#manage-environments').count(), 0);
  await envPicker.click();
  assert.equal(await page.getByLabel('Env name (required)', { exact: true }).inputValue(), 'example.test');
  assert.equal(await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).inputValue(), 'https://example.test');
  await page.getByLabel('Env name (required)', { exact: true }).fill('QA');
  await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).fill('https://qa.example.org/');
  await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).click();
  assert.equal(await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
  await page.screenshot({ path: resolve(screenshots, 'focused-env-input.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  assert.deepEqual(config.environments[0].baseUrls, ['https://qa.example.org', 'https://example.test']);
  assert.equal(config.environments.length, 1);
  await page.locator('#mock-environment').selectOption(config.environments[0].id);
  assert.equal(config.settings.environmentId, config.environments[0].id);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await rules.first().getByRole('button', { name: 'Edit Cart with items', exact: true }).click();
  assert.equal(await page.locator('#rule-base-url').count(), 0);
  assert.match(await page.locator('#rule-environment-preview').textContent(), /qa.example.org/);
  await page.locator('#response-status-toggle').click();
  assert.equal(await page.locator('#http-status-menu').getByRole('option', { name: '404 Not Found', exact: true }).count(), 1);
  await page.getByRole('searchbox', { name: 'Search or add HTTP status' }).fill('599 Controlled rejection');
  await page.getByRole('button', { name: 'Use 599 Controlled rejection', exact: true }).click();
  assert.equal(await page.locator('#status-name-field').count(), 0);
  const statusBox = await page.locator('#response-status-toggle').boundingBox();
  assert.ok(statusBox.width >= 50 && statusBox.x + statusBox.width <= 360);
  await page.screenshot({ path: resolve(screenshots, 'custom-status-editor.png'), animations: 'disabled' });
  await page.locator('#save-rule').click();
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').response.statusText, 'Controlled rejection');
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').environmentScope, 'selected');
  const editedRule = rules.filter({ has: page.getByRole('button', { name: 'Edit Cart with items', exact: true }) });
  assert.ok((await editedRule.locator('td').nth(3).innerText()).includes('qa.example.org'));
  const sourceEnvironment = config.environments.find(env => env.baseUrls.includes('http://127.0.0.1:4319'));
  await envPicker.selectOption(sourceEnvironment.id);
  assert.equal(config.settings.environmentId, sourceEnvironment.id);
  assert.equal(await envPicker.locator('option[value="*"]').count(), 0);
  config.environments[0].baseUrls = config.environments[0].baseUrls.filter(base => base !== 'https://example.test');
  config.environments[0].baseUrls.push('https://example.test');
  revision++;
  await page.waitForFunction(() => !document.querySelector('#mock-environment option[value="@save"]'));
  assert.notEqual(await envPicker.locator('option:checked').textContent(), 'Save Env');
  config.environments[0].baseUrls.pop();
  revision++;
  await page.waitForFunction(() => document.querySelector('#mock-environment option[value="@save"]'));
  assert.ok((await editedRule.locator('td').nth(3).getAttribute('title')).includes('127.0.0.1:4319'));
  const groupedEnvCount = config.environments.length;
  await envPicker.selectOption('@save');
  assert.equal(await page.locator('#environment-capture-preview').isVisible(), true);
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  assert.equal(config.environments.length, groupedEnvCount);
  assert.ok(config.environments.find(env => env.id === sourceEnvironment.id).baseUrls.includes('https://example.test'));
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const nameDivider = page.locator('#rules-view').getByRole('separator', { name: 'Resize Name column', exact: true });
  await page.setViewportSize({ width: 1280, height: 760 });
  await nameDivider.focus();
  await page.keyboard.press('End');
  const pairBefore = await ruleTable.locator('col').evaluateAll(cols => [1, 2].map(index => parseFloat(cols[index].style.width)));
  await page.keyboard.press('Home');
  const pairAfter = await ruleTable.locator('col').evaluateAll(cols => [1, 2].map(index => parseFloat(cols[index].style.width)));
  assert.equal(pairBefore[0] + pairBefore[1], pairAfter[0] + pairAfter[1]);
  const minimumName = pairAfter[0];
  await page.keyboard.press('ArrowLeft');
  assert.equal(await ruleTable.locator('col').nth(1).evaluate(node => parseFloat(node.style.width)), minimumName);
  assert.equal(await page.locator('#rules-view th').nth(1).locator('button').evaluate(node => node.scrollWidth <= node.clientWidth), true);

  await nameDivider.dblclick();
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForFunction(() => Number(document.querySelector('#rules-view colgroup').children[1].style.width.replace('px', '')) <= 360);
  config.scenarios[0].rules.find(rule => rule.id === 'filled').name = 'Long recorded response '.repeat(4);
  revision++;
  await page.getByRole('button', { name: /^Edit Long recorded response/ }).first().waitFor();
  await page.waitForFunction(() => parseFloat(document.querySelector('#rules-view colgroup').children[1].style.width) === Number(document.querySelector('#rules-view th:nth-child(2) .column-resize').getAttribute('aria-valuemin')));
  const deleteButton = rules.first().getByRole('button', { name: /^Delete/ });
  assert.equal(await deleteButton.textContent(), '');
  assert.equal(await deleteButton.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(174, 40, 62)');
  assert.equal(await page.locator('#record-toggle .control-label').isVisible(), false);
  assert.equal(await page.locator('#record-toggle .activity-dot').isVisible(), true);
  const compactWidth = (await page.locator('#record-toggle').boundingBox()).width;
  const envWidth = (await envPicker.boundingBox()).width;
  for (const width of [620, 900]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal((await page.locator('#record-toggle').boundingBox()).width, compactWidth);
    assert.equal((await envPicker.boundingBox()).width, envWidth);
    assert.equal(await page.locator('#record-toggle .control-label').isVisible(), false);
  }
  await page.setViewportSize({ width: 360, height: 760 });
  assert.equal(await page.locator('#requests-view th').count(), 6);
  assert.equal(await page.locator('#rules-view th').count(), 10);
  assert.equal(await page.getByRole('columnheader', { name: 'Actions' }).count(), 0);
  await envPicker.selectOption('@manage');
  assert.equal(await page.locator('#settings-view').isVisible(), true);
  const envCount = config.environments.length;
  await page.locator('#new-environment').click();
  await page.getByLabel('Env name (required)', { exact: true }).fill('Abandoned Env');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#environment-form').isVisible(), false);
  assert.equal(config.environments.length, envCount);
  assert.equal(await envPicker.inputValue(), sourceEnvironment.id);
  await page.reload();
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.waitForFunction(width => JSON.parse(localStorage.getItem('mockend.columns.requests.v4'))[0] === width, manualWidth);
  assert.equal(await page.locator('#request-rows tr').count(), 3);
  await page.screenshot({ path: resolve(screenshots, 'requests-compact.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#rules-view table')?.dataset.sized === 'true');
  await page.screenshot({ path: resolve(screenshots, 'rules-compact.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 760 });
  assert.equal(await page.locator('#rules-view th').last().locator('.column-resize').count(), 0);
  assert.ok(await page.locator('#rules-view .request-table').evaluate(container => Math.abs(container.querySelector('table').offsetWidth - container.clientWidth) <= 1));
  assert.equal(await rules.first().locator('td').first().evaluate(node => parseFloat(getComputedStyle(node).paddingInlineStart)), 8);
  assert.equal(await page.locator('.mock-split').count(), 0);
  const captionInset = await page.locator('.scenario-tools').evaluate(node => {
    return node.querySelector('.section-title').getBoundingClientRect().left - node.getBoundingClientRect().left;
  });
  assert.equal(captionInset, 10);
  assert.equal(await page.locator('#record-toggle .control-label').isVisible(), true);
  assert.equal(await page.locator('#record-toggle .activity-dot').isVisible(), true);
  assert.equal(await page.locator('#scenario-toolbar .transfer-trigger').count(), 3);
  assert.equal(await page.locator('#new-scenario').evaluate(node => getComputedStyle(node).fontSize), await page.locator('.transfer-label').first().evaluate(node => getComputedStyle(node).fontSize));
  const scenarioBox = await page.locator('#scenario').boundingBox();
  const downloadBox = await page.locator('#transfer-download').boundingBox();
  assert.ok(Math.abs(scenarioBox.y - downloadBox.y) < 2);
  const splitStyle = await page.locator('.transfer-controls').evaluate(group => {
    const buttons = [...group.querySelectorAll(':scope > button')];
    const boxes = buttons.map(button => button.getBoundingClientRect());
    const line = getComputedStyle(group.querySelector('.split-divider'), '::before');
    return { joined: boxes.slice(1).every((box, index) => Math.abs(box.left - boxes[index].right) <= 1), top: parseFloat(line.top), bottom: parseFloat(line.bottom), border: getComputedStyle(buttons[1]).borderLeftWidth, motion: getComputedStyle(group, '::before').transitionProperty };
  });
  assert.equal(splitStyle.joined, true);

  for (const width of [320, 620, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    assert.ok(await page.locator('.workspace-bar .workspace-tabs').evaluateAll(groups => groups.every(group => {
      const buttons = [...group.querySelectorAll(':scope > button')].filter(node => node.getClientRects().length);
      return buttons.slice(1).every((node, index) => Math.abs(node.getBoundingClientRect().left - buttons[index].getBoundingClientRect().right) < .5);
    })), `Tab segments join without gaps at ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 760 });
  assert.equal(await page.locator('.workspace-bar .workspace-tabs').evaluate(node => getComputedStyle(node, '::before').borderRadius), '0px');
  assert.equal(await page.locator('.workspace-bar .workspace-tabs > .split-divider:not([hidden])').count(), 0, 'Selected middle tab hides its independent left and right dividers');
  assert.equal(await page.locator('.workspace-bar .workspace-tabs > button').evaluateAll(nodes => nodes.every(node => getComputedStyle(node, '::after').content === 'none')), true);


  assert.ok(splitStyle.top >= 3 && splitStyle.bottom >= 3);
  assert.equal(splitStyle.border, '0px');
  assert.match(splitStyle.motion, /inset-inline/);

  await page.locator('#transfer-download').hover();
  assert.equal(await page.locator('#transfer-download-menu').evaluate(node => node.matches(':popover-open')), true);
  const hoveredDividers = await page.locator('.transfer-controls').evaluate(group => {
    const probe = document.createElement('span'); probe.style.color = 'var(--separator-ink)'; group.append(probe);
    const resting = getComputedStyle(probe).color; probe.remove();
    return { resting, lines: ['transfer-download', 'transfer-upload'].map(id => getComputedStyle(document.getElementById(id).previousElementSibling, '::before').backgroundColor) };
  });
  assert.ok(hoveredDividers.lines.every(color => color === hoveredDividers.resting), JSON.stringify(hoveredDividers));

  await page.waitForFunction(() => document.querySelector('#transfer-download').getAttribute('aria-expanded') === 'true');
  await page.locator('#transfer-download').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
  assert.notEqual(await page.locator('#transfer-download').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.getByRole('button', { name: 'Export Mockend', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Export Postman Specs', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#transfer-download-menu').evaluate(node => node.matches(':popover-open')), false);
  await page.locator('#transfer-download').press('Enter');
  await page.waitForFunction(() => document.querySelector('#transfer-download').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.getByRole('button', { name: 'Flows — unavailable', exact: true }).isDisabled(), true);
  await page.screenshot({ path: resolve(screenshots, 'transfer-menu.png'), animations: 'disabled' });
  const [specDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Postman Specs', exact: true }).click()
  ]);
  assert.equal(specDownload.suggestedFilename(), 'mockend.openapi.json');
  assert.equal(JSON.parse(await readFile(await specDownload.path(), 'utf8')).openapi, '3.0.3');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: resolve(screenshots, 'rules-wide.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.locator('#requests-view .request-table').evaluate(node => { node.scrollLeft = 0; });
  assert.ok(await page.locator('#requests-view .request-table').evaluate(container => Math.abs(container.querySelector('table').offsetWidth - container.clientWidth) <= 1));
  await page.screenshot({ path: resolve(screenshots, 'requests-wide.png'), animations: 'disabled' });
  const panes = [];
  const headings = [];
  for (const [name, selector] of [['Requests', '#requests-view'], ['Rules', '#rules-view'], ['Settings', '#settings-view']]) {
    await page.getByRole('button', { name, exact: true }).click();
    panes.push(await page.locator(selector).boundingBox());
    headings.push(await page.locator(selector).locator('.request-heading, .rules-head, .page-heading').evaluate(node => {
      const rect = node.getBoundingClientRect();
      const pane = node.parentElement.getBoundingClientRect();
      return { x: rect.x - pane.x, y: rect.y - pane.y, width: rect.width, height: rect.height };
    }));
    assert.equal(await page.locator('.scenario-tools').isVisible(), name !== 'Settings');
    if (name === 'Settings') {
      const hierarchy = await page.locator('#settings-view').evaluate(node => ({
        page: parseFloat(getComputedStyle(node.querySelector('h2')).fontSize),
        sections: [...node.querySelectorAll('.settings-group h3')].map(title => parseFloat(getComputedStyle(title).fontSize)),
        label: parseFloat(getComputedStyle(node.querySelector('label')).fontSize)
      }));
      assert.ok(hierarchy.sections.every(size => hierarchy.page === size && size > hierarchy.label));
      await page.screenshot({ path: resolve(screenshots, 'settings-hierarchy.png'), animations: 'disabled' });
    }
  }
  assert.deepEqual(panes[0], panes[1]);
  assert.equal(panes[1].width, panes[2].width);
  assert.equal(panes[1].y + panes[1].height, panes[2].y + panes[2].height);
  assert.deepEqual(headings[0], headings[1]);
  assert.deepEqual(headings[1], headings[2]);
  assert.equal(await page.locator('.scenario-tools').evaluate(node => node.parentElement === document.body), true);
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 760 });
  const viewport = page.locator('#requests-view .request-table');
  await viewport.hover();
  assert.equal(await page.locator('.overlay-scrollbar:not([hidden])').count(), 0);
  const scrollCheck = await viewport.evaluate(async node => {
    node.dispatchEvent(new Event('scroll'));
    await new Promise(requestAnimationFrame);
    const rail = document.querySelector('.overlay-scrollbar.horizontal');
    const outside = rail.getBoundingClientRect().top >= node.getBoundingClientRect().bottom;
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    const end = node.scrollLeft;
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    const home = node.scrollLeft;
    node.dispatchEvent(new Event('scrollend'));
    return { outside, end, home, hidden: rail.hidden };
  });
  assert.equal(scrollCheck.outside, true);
  assert.ok(scrollCheck.end > 0);
  assert.equal(scrollCheck.home, 0);
  assert.equal(scrollCheck.hidden, true);
  assert.equal(await viewport.evaluate(node => node.offsetWidth - node.clientWidth), 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  config.scenarios[0].rules.find(rule => rule.id === 'filled').name = 'Cart with items';
  revision++;
  await page.getByRole('button', { name: 'Edit Cart with items', exact: true }).waitFor();
  const header = page.locator('#rules-view th').nth(1);
  const sort = header.locator('[data-rule-sort]');
  await sort.hover();
  const insets = await header.evaluate(cell => {
    const label = cell.querySelector('button').getBoundingClientRect();
    const bounds = cell.getBoundingClientRect();
    const resize = cell.querySelector('.column-resize');
    const separator = resize.getBoundingClientRect();
    const line = getComputedStyle(resize, '::after');
    return { left: label.left - bounds.left, top: label.top - bounds.top, bottom: bounds.bottom - label.bottom, right: bounds.right - label.right, separator: bounds.right - (separator.left + parseFloat(line.left) + parseFloat(line.width) / 2) };
  });
  assert.equal(insets.top, insets.bottom);
  assert.ok(Math.abs(insets.left - insets.right) <= .5, JSON.stringify(insets));
  assert.ok(insets.right > insets.separator);
  assert.ok(insets.right - insets.separator >= 1);
  assert.deepEqual(await header.locator('button').evaluate(node => [getComputedStyle(node).paddingInlineStart, getComputedStyle(node).paddingInlineEnd]), ['5px', '5px']);
  assert.ok(await ruleTable.locator('col').nth(8).evaluate(node => parseFloat(node.style.width)) >= 44);
  assert.equal(await page.locator('#rules-view th').nth(8).locator('.column-resize').count(), 1);
  assert.equal(await page.locator('#rules-view .column-resize').count(), 9);
  const envDivider = page.locator('#rules-view th').nth(8).getByRole('separator');
  const envBefore = await ruleTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
  await envDivider.focus(); await page.keyboard.press('Home');
  const envAfter = await ruleTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
  assert.equal(envAfter[8], Number(await envDivider.getAttribute('aria-valuemin')));
  assert.equal(envAfter[8] + envAfter[9], envBefore[8] + envBefore[9]);
  assert.deepEqual(envAfter.slice(0, 8), envBefore.slice(0, 8));
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await ruleTable.locator('col').nth(8).evaluate(node => parseFloat(node.style.width)), envAfter[8]);

  assert.equal(await page.locator('#rules-view th').first().locator('[data-rule-sort] > span').evaluate(node => getComputedStyle(node).marginInlineStart), '6px');
  const idHeadingFit = await page.locator('#rules-view th').first().locator('button').evaluate(node => {
    const original = node.style.fontFamily;
    const fits = [getComputedStyle(node).fontFamily, 'Arial', 'monospace'].map(font => {
      node.style.fontFamily = font;
      return { font, size: getComputedStyle(node).fontSize, text: node.textContent, scroll: node.scrollWidth, client: node.clientWidth };
    });
    node.style.fontFamily = original;
    return fits;
  });
  assert.ok(idHeadingFit.every(value => value.scroll <= value.client), JSON.stringify(idHeadingFit));
  assert.equal(await page.locator('#rules-view th').first().evaluate(node => getComputedStyle(node).borderTopLeftRadius), '8px');
  const heights = await page.locator('#scenario-toolbar > button, #scenario-toolbar .transfer-trigger, .rules-head > button, .rules-head .url-selectors button').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => node.offsetHeight));
  assert.deepEqual([...new Set(heights)], [24]);
  await page.mouse.move(0, 0);
  await page.locator('#rules-view .request-table').evaluate(node => { node.scrollLeft = 0; });
  for (const dismiss of await page.getByRole('button', { name: 'Dismiss notification', exact: true }).all()) if (await dismiss.isVisible()) await dismiss.evaluate(node => node.click());
  await page.evaluate(() => document.activeElement?.blur());
  assert.ok(await page.locator('#rules .rule-state-pill').evaluateAll(pills => pills.every(pill => pill.scrollWidth <= pill.clientWidth)), 'Mock state labels remain fully readable beside delete');
  await page.screenshot({ path: resolve(import.meta.dirname, '../publishing/rules.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.locator('#requests-view .request-table').evaluate(node => { node.scrollLeft = 0; });
  await page.screenshot({ path: resolve(import.meta.dirname, '../publishing/requests.png'), animations: 'disabled' });
  const badge = page.locator('#request-rows .method-badge').first();
  assert.deepEqual(await badge.evaluate(node => ({ height: node.offsetHeight, radius: getComputedStyle(node).borderRadius })), { height: 18, radius: '4px' });
  assert.equal(await page.locator('#target-summary').evaluate(node => node.getBoundingClientRect().left), 10);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.locator('#scenario').hover();
  await page.waitForFunction(() => document.querySelector('#scenario').getAttribute('aria-expanded') === 'true');
  await page.locator('#scenario').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
  assert.notEqual(await page.locator('#scenario').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  const icons = await page.locator('#scenario-options .scenario-action svg').evaluateAll(nodes => nodes.map(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]));
  const flowActionStyles = await page.locator('#scenario-options .scenario-action').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).backgroundColor, node.offsetWidth, node.offsetHeight]));
  assert.ok(flowActionStyles.every(style => style[0] === 'rgba(0, 0, 0, 0)' && style[1] === 22 && style[2] === 22));
  assert.ok(icons.length >= 3 && icons.every(([width, height]) => width === 12 && height === 12));
  const centers = await page.evaluate(() => {
    const center = node => { const box = node.getBoundingClientRect(); return box.x + box.width / 2; };
    return {
      outside: ['new-scenario', 'transfer-clipboard', 'transfer-download'].map(id => center(document.getElementById(id))),
      inside: [...document.querySelector('.scenario-option').querySelectorAll('.scenario-action')].map(center)
    };
  });
  for (let index = 1; index < centers.inside.length; index++) assert.ok(Math.abs(centers.inside[index] - centers.inside[index - 1] - 22) <= 1, JSON.stringify(centers));
  const intrinsic = await page.locator('#scenario-options').evaluate(node => {
    const choices = [...node.querySelectorAll('.scenario-choice')];
    return choices.map(choice => ({ width: choice.getBoundingClientRect().width, scroll: choice.scrollWidth, client: choice.clientWidth }));
  });
  assert.ok(intrinsic.every(choice => choice.scroll <= choice.client), JSON.stringify(intrinsic));

  const inactiveFlow = page.locator('.scenario-option').filter({ has: page.locator('.scenario-choice[aria-pressed="false"]') }).first();
  await inactiveFlow.locator('.scenario-choice').hover();
  const rowSurfaces = await inactiveFlow.evaluate(row => ({ row: getComputedStyle(row).backgroundColor, children: [...row.querySelectorAll('button, .scenario-actions')].map(node => getComputedStyle(node).backgroundColor), inset: row.getBoundingClientRect().right - row.querySelector('.scenario-actions').getBoundingClientRect().right }));
  assert.ok(rowSurfaces.children.every(color => color === 'rgba(0, 0, 0, 0)'), JSON.stringify(rowSurfaces));
  assert.ok(rowSurfaces.inset >= 6);
  assert.equal(await inactiveFlow.locator('.split-divider').first().evaluate(node => getComputedStyle(node, '::before').backgroundColor), hoveredDividers.resting);
  await page.screenshot({ path: resolve(screenshots, 'flows-menu.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  assert.equal(await page.locator('#add-rule').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(230, 218, 196)');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  assert.equal(await page.locator('#rule-ingress-preview').textContent(), '');
  assert.equal(await page.locator('#rule-endpoint-preview').textContent(), '');
  assert.equal(await page.locator('#rule-name').evaluate(node => getComputedStyle(node).paddingInlineStart), '0px');
  assert.equal(await page.locator('#rule-name').evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('#rule-url').evaluate(node => getComputedStyle(node).backgroundColor));
  await page.locator('#rule-name').fill('Editor alignment');
  await page.locator('#rule-name').click();
  assert.equal(await page.locator('#rule-name').evaluate(node => document.activeElement === node), true);
  const edges = await page.locator('#rule-form').evaluate(form => ['#rule-title', '.route-fields', '#rule-tabs', '#response-section'].map(selector => form.querySelector(selector).getBoundingClientRect().left));
  assert.ok(edges.every(left => Math.abs(left - edges[0]) <= 1));
  assert.ok(await page.locator('.rule-origin-value').count() > 0);
  assert.equal(await page.locator('#close-rule').isVisible(), true);
  await page.locator('#response-status-toggle').click();
  const dropdownStyle = await page.evaluate(() => {
    const control = document.querySelector('#response-status-toggle');
    const tray = document.querySelector('#http-status-menu');
    const select = document.querySelector('#rule-form select');
    const style = getComputedStyle(tray);
    const picker = getComputedStyle(select, '::picker(select)');
    return {
      shared: control.classList.contains('dropdown-control') && tray.classList.contains('dropdown-menu'),
      width: Math.abs(control.getBoundingClientRect().width - tray.getBoundingClientRect().width),
      popup: [style.padding, style.borderRadius, style.backgroundColor, style.boxShadow],
      native: [picker.padding, picker.borderRadius, picker.backgroundColor, picker.boxShadow]
    };
  });
  assert.equal(dropdownStyle.shared, true);
  assert.equal(await page.locator('#response-status-toggle').evaluate(node => getComputedStyle(node).paddingInlineEnd), '6px');
  assert.ok(dropdownStyle.width <= 1, JSON.stringify(dropdownStyle));
  assert.deepEqual(dropdownStyle.native, dropdownStyle.popup);
  await page.screenshot({ path: resolve(screenshots, 'http-status-dropdown.png'), animations: 'disabled' });
  await page.getByRole('searchbox', { name: 'Search or add HTTP status' }).fill('1000 Invalid');
  await page.getByRole('searchbox', { name: 'Search or add HTTP status' }).press('Enter');
  assert.equal(await page.locator('#response-status').inputValue(), '200');
  assert.equal(await page.locator('.toast[data-key="http-status"]').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#rule-dialog').isVisible(), true);
  await page.screenshot({ path: resolve(screenshots, 'rule-editor.png'), animations: 'disabled' });
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  await page.getByRole('button', { name: '+ Add parameter', exact: true }).click();
  const removeBox = await page.locator('.parameter-remove').boundingBox();
  const crossBox = await page.locator('.parameter-remove svg').boundingBox();
  assert.ok(Math.abs(removeBox.x + removeBox.width / 2 - crossBox.x - crossBox.width / 2) <= 1);
  assert.ok(Math.abs(removeBox.y + removeBox.height / 2 - crossBox.y - crossBox.height / 2) <= 1);
  assert.equal(await page.locator('.parameter-grip svg').evaluate(node => node.getBoundingClientRect().width), 12);
  const arrows = await page.locator('#rule-form').evaluate(form => {
    const native = getComputedStyle(form.querySelector('[name="urlMode"]'), '::picker-icon');
    const editable = getComputedStyle(form.querySelector('.parameter-picker-toggle'), '::after');
    return [native, editable].map(style => [style.width, style.height, style.borderRightWidth, style.transform]);
  });
  assert.deepEqual(arrows[0], arrows[1]);
  await page.screenshot({ path: resolve(screenshots, 'request-parameter-editor.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  if (await page.locator('#rule-dialog').isVisible()) await page.keyboard.press('Escape');
  assert.equal(await page.locator('#group-rules, .rule-group-row').count(), 0);
  const sample = structuredClone(config.scenarios[0].rules[0]);
  config.scenarios[0].rules.push(...Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(sample), id: `scroll-${index}`, name: `Scrollable rule ${index + 1}` })));
  revision++;
  await page.waitForFunction(() => document.querySelectorAll('#rules tr.rule').length === 22);
  await page.setViewportSize({ width: 360, height: 300 });
  for (const [name, selector] of [['Requests', '#requests-view'], ['Rules', '#rules-view']]) {
    await page.getByRole('button', { name, exact: true }).click();
    const tableViewport = page.locator(`${selector} .request-table`);
    await tableViewport.evaluate(node => { node.scrollTop = node.scrollHeight; node.scrollLeft = node.scrollWidth; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sticky = await tableViewport.evaluate(node => {
      const first = node.querySelector('th');
      const last = node.querySelector('th:last-child');
      const style = getComputedStyle(node);
      return {
        top: first.getBoundingClientRect().top - node.getBoundingClientRect().top,
        scrolled: node.scrollTop > 0 && node.scrollLeft > 0,
        corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
        bottom: [getComputedStyle(first).borderBottomLeftRadius, getComputedStyle(last).borderBottomRightRadius]
      };
    });
    assert.equal(sticky.scrolled, true);
    assert.ok(Math.abs(sticky.top) <= 1, JSON.stringify({ name, sticky }));
    assert.deepEqual(sticky.corners, ['8px', '8px', '0px', '0px']);
    assert.deepEqual(sticky.bottom, ['0px', '0px']);
    await page.screenshot({ path: resolve(screenshots, `${name.toLowerCase()}-scrolled-header.png`), animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
});


for (const host of ['chromium', 'vscode']) test(`${host} Env setup manages service URLs and keeps inspection separate from activation`, async t => {
  const { page, origin } = await panelFixture(t, host);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let config = starterConfig(); let revision = 0;
  config.environments = [
    { id: 'qa', name: 'QA', baseUrls: ['https://accounts.qa.example.com', 'https://orders.qa.example.com', 'https://payments.qa.example.com'],
      services: { 'https://accounts.qa.example.com': 'Accounts', 'https://orders.qa.example.com': 'Orders', 'https://payments.qa.example.com': 'Payments' } },
    { id: 'staging', name: 'Staging', baseUrls: ['https://api.staging.example.com', 'https://orders.staging.example.com'] },
    { id: 'local', name: 'Local', baseUrls: ['http://localhost:3000'] }
  ];
  config.settings.environmentId = 'qa';
  await page.exposeFunction('environmentFixture', ({ action, data }) => {
    if (action === 'save') { config = data.config; revision++; }
    return { config, revision, activity: [], connection: { available: null, active: null } };
  });
  await page.addInitScript(host => {
    if (host === 'vscode') window.acquireVsCodeApi = () => ({ async postMessage(message) {
      const value = await window.environmentFixture(message);
      window.dispatchEvent(new MessageEvent('message', { data: { id: message.id, value } }));
    } });
    else {
      window.chrome ??= {}; window.chrome.windows = { getCurrent: async () => ({ id: 1 }) };
      window.chrome.runtime = { sendMessage: async message => ({ state: await window.environmentFixture(message) }),
        connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }) };
    }
  }, host);
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.goto(`${origin}/panel.html`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Environments', exact: true });
  assert.equal(await nav.getByRole('button').count(), 3);
  assert.equal(await page.locator('#environment-url-rows tr[data-origin]').count(), 3);
  assert.equal(await nav.getByRole('button', { name: 'QA', exact: true }).getByText('Active').count(), 1);
  assert.equal(await nav.getByRole('button', { name: 'QA', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 32, 32)');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const duplicatedValues = await page.locator('select').evaluateAll(selects => selects.filter(select => select.getClientRects().length).flatMap(select => {
    const value = select.querySelector('selectedcontent');
    if (!value) return [];
    const context = document.createElement('canvas').getContext('2d');
    context.font = getComputedStyle(value).font;
    const expected = Math.max(value.clientWidth, Math.ceil(context.measureText(value.textContent).width));
    return value.scrollWidth > expected + 2 ? [{ id: select.id, text: value.textContent, actual: value.scrollWidth, expected }] : [];
  }));
  assert.deepEqual(duplicatedValues, []);

  assert.equal(await nav.getByRole('button', { name: 'QA', exact: true }).locator('small').evaluate(node => getComputedStyle(node).color), await nav.getByRole('button', { name: 'QA', exact: true }).evaluate(node => getComputedStyle(node).color));
  await nav.getByRole('button', { name: 'QA', exact: true }).hover();
  await nav.getByRole('button', { name: 'QA', exact: true }).evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
  assert.equal(await nav.getByRole('button', { name: 'QA', exact: true }).locator('small').evaluate(node => getComputedStyle(node).color === getComputedStyle(node.closest('button')).color), true);
  await page.mouse.move(0, 0);

  const layout = await page.locator('.environment-workspace').evaluate(node => {
    const list = node.querySelector('nav').getBoundingClientRect(); const detail = node.querySelector('section').getBoundingClientRect();
    return { sideBySide: list.right <= detail.left, aligned: list.top === detail.top };
  });
  assert.deepEqual(layout, { sideBySide: true, aligned: true });
  assert.equal(await page.locator('#environment-actions[popover], #environment-actions-toggle').count(), 0);
  const actionGroup = page.getByRole('group', { name: 'Environment actions', exact: true });
  assert.equal(await actionGroup.getByRole('button').count(), 3);
  assert.equal(await page.locator('#rename-environment .control-label').isVisible(), false);
  assert.equal(await page.locator('#rename-environment svg').isVisible(), true);
  assert.equal(await page.locator('.environment-url-table').getByRole('separator').count(), 2);
  const serviceDivider = page.locator('.environment-url-table').getByRole('separator').first();
  await serviceDivider.focus(); await page.keyboard.press('Home');
  assert.equal(await serviceDivider.getAttribute('aria-valuenow'), await serviceDivider.getAttribute('aria-valuemin'));

  for (const width of [320, 360, 480, 620, 1000]) {
    await page.setViewportSize({ width, height: 620 });
    const sizes = await actionGroup.evaluate(group => {
      const bounds = group.getBoundingClientRect();
      const pane = group.closest('.environment-detail').getBoundingClientRect();
      const buttons = [...group.querySelectorAll('button')].map(node => {
        const box = node.getBoundingClientRect();
        return { x: box.x, right: box.right, width: box.width, height: box.height, labels: getComputedStyle(node.querySelector('.control-label')).display !== 'none' };
      });
      return { buttons, paneWidth: group.closest('.environment-detail').clientWidth - parseFloat(getComputedStyle(group.closest('.environment-detail')).paddingLeft) - parseFloat(getComputedStyle(group.closest('.environment-detail')).paddingRight), inside: bounds.left >= pane.left && bounds.right <= pane.right, pageFits: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.equal(sizes.inside, true, `Env actions fit at ${width}px`);
    assert.equal(sizes.pageFits, true, `Page fits at ${width}px`);
    assert.ok(await page.locator('.environment-heading > button').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)), `Header buttons fit their labels at ${width}px`);
    assert.ok(sizes.buttons.every(button => button.width >= 24 && button.height === 24));
    for (let index = 1; index < sizes.buttons.length; index++) assert.ok(Math.abs(sizes.buttons[index].x - sizes.buttons[index - 1].right) < 1);
    if (sizes.paneWidth < 440) assert.ok(sizes.buttons.every(button => button.width === 24 && !button.labels), JSON.stringify({ width, ...sizes }));
    else assert.ok(sizes.buttons.filter((_, index) => index !== 1).every(button => button.labels));
    await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/env-actions-${host}-${width}.png`), animations: 'disabled' });
  }
  assert.equal(await page.locator('#settings-title').evaluate(node => getComputedStyle(node).fontSize), await page.locator('#rules-title').evaluate(node => getComputedStyle(node).fontSize));
  assert.equal(await page.locator('#environment-url-rows td').first().evaluate(node => getComputedStyle(node).fontSize), '11px');
  await page.setViewportSize({ width: 1000, height: 850 });
  await nav.getByRole('button', { name: 'Staging', exact: true }).click();
  assert.equal(config.settings.environmentId, 'qa');
  await page.getByRole('button', { name: 'Set active Env', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#mock-environment').value === 'staging');
  await nav.getByRole('button', { name: 'QA', exact: true }).click();
  await page.getByRole('button', { name: '+ Add base URL', exact: true }).click();
  const form = page.getByRole('form', { name: 'Base URL details', exact: true });
  const url = form.getByLabel('Base URL (required)', { exact: true });
  await form.getByLabel('Service name (optional)', { exact: true }).fill('Inventory');
  await url.fill('https://inventory.qa.example.com');
  assert.equal(await page.locator('#save-environment-url').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 32, 32)');
  await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/env-setup-${host}-wide.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 850 });
  await page.waitForFunction(() => { const tray = document.querySelector('.environment-url-table'); return tray.scrollWidth <= tray.clientWidth; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(await page.locator('.environment-url-table').evaluate(node => node.scrollWidth <= node.clientWidth), JSON.stringify(await page.locator('.environment-url-table').evaluate(node => ({client: node.clientWidth, scroll: node.scrollWidth, cols: [...node.querySelectorAll('col')].map(col => col.style.width)}))));
  await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/env-setup-${host}-compact.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 1000, height: 850 });
  await url.fill('https://inventory.qa.example.com/path');
  await form.getByRole('button', { name: 'Add URL', exact: true }).click();
  assert.equal(await url.evaluate(node => node === document.activeElement && !node.validity.valid), true);
  assert.equal(config.environments[0].baseUrls.length, 3);
  await url.fill('https://inventory.qa.example.com/');
  await url.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(await form.isVisible(), true, 'IME confirmation does not submit a new URL');
  await url.press('Enter');
  await form.waitFor({ state: 'hidden' });
  assert.equal(config.environments[0].services['https://inventory.qa.example.com'], 'Inventory');
  assert.equal(config.settings.environmentId, 'staging');
  await page.getByRole('button', { name: 'Edit base URL https://inventory.qa.example.com', exact: true }).click();
  assert.equal(await form.isVisible(), false);
  const edited = page.locator('tr[data-origin="https://inventory.qa.example.com"]');
  await edited.getByRole('textbox', { name: 'Service name for https://inventory.qa.example.com', exact: true }).fill('Inventory API');
  await edited.getByRole('textbox', { name: 'Base URL for https://inventory.qa.example.com', exact: true }).fill('https://stock.qa.example.com');
  assert.equal(await edited.locator('[contenteditable]').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  const editor = edited.locator('[contenteditable]').first();
  await editor.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Save base URL https://inventory.qa.example.com', exact: true }).evaluate(node => node === document.activeElement), true);
  await editor.focus();
  assert.deepEqual(await editor.evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, top: getComputedStyle(node).borderTopWidth, bottom: getComputedStyle(node).borderBottomWidth })), { outline: 'none', top: '0px', bottom: '1px' });

  await page.getByRole('button', { name: 'Edit base URL https://orders.qa.example.com', exact: true }).click();
  const otherEdit = page.getByRole('textbox', { name: 'Service name for https://orders.qa.example.com', exact: true });
  await otherEdit.fill('Unsaved Orders');
  await page.setViewportSize({ width: 320, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const rowHeights = await page.locator('#environment-url-rows tr[data-origin]').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  assert.equal(new Set(rowHeights).size, 1, JSON.stringify(rowHeights));
  await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/env-inline-${host}-320.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Save base URL https://inventory.qa.example.com', exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.getByRole('button', { name: 'Edit base URL https://stock.qa.example.com', exact: true }).waitFor();
  assert.equal(await otherEdit.innerText(), 'Unsaved Orders');
  await otherEdit.focus(); await page.keyboard.press('Escape');
  assert.equal(config.environments[0].services['https://orders.qa.example.com'], 'Orders');
  assert.equal(config.environments[0].services['https://stock.qa.example.com'], 'Inventory API');
  assert.equal(config.environments[0].services['https://inventory.qa.example.com'], undefined);
  await page.getByRole('button', { name: '+ Add base URL', exact: true }).click();
  await url.fill('https://stock.qa.example.com');
  await form.getByRole('button', { name: 'Add URL', exact: true }).click();
  assert.match(await url.evaluate(node => node.validationMessage), /already in this Env/);
  await page.keyboard.press('Escape');
  assert.equal(await form.isVisible(), false);
  assert.equal(config.environments[0].baseUrls.length, 4);
  await page.getByRole('button', { name: 'Delete base URL https://stock.qa.example.com', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete URL', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#environment-url-rows tr[data-origin]').length === 3);
  assert.equal(config.environments[0].services['https://stock.qa.example.com'], undefined);
  await page.getByRole('button', { name: 'Rename Env', exact: true }).click();
  await page.getByRole('textbox', { name: 'Env name (required)', exact: true }).fill('QA Team');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Save name', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'QA Team', exact: true }).waitFor();
  assert.equal(config.environments[0].services['https://accounts.qa.example.com'], 'Accounts');
  await page.getByRole('button', { name: '+ New environment', exact: true }).click();
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  assert.equal(await page.getByLabel('Env name (required)', { exact: true }).evaluate(node => node === document.activeElement), true);
  await page.getByLabel('Env name (required)', { exact: true }).fill('PROD');
  await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).fill('https://api.example.com');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Save Env', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'PROD', exact: true }).waitFor();
  assert.equal(config.environments.find(env => env.id === config.settings.environmentId).name, 'PROD');
  await page.getByRole('button', { name: 'Delete Env', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(config.environments.length, 4);
  await page.locator('#environment-actions').getByRole('button', { name: 'Delete Env', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Env', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#environment-list button').length === 3);
  assert.equal(config.settings.environmentId, 'qa');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await nav.getByRole('button', { name: 'QA Team', exact: true }).click();
  assert.equal(await page.locator('#environment-url-rows').getByText('Accounts', { exact: true }).count(), 1);
  await nav.getByRole('button', { name: 'Local', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Delete base URL http://localhost:3000', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Cart with items', exact: true }).click();
  const envControl = page.locator('#rule-environment-scope');
  const envMenu = page.getByRole('group', { name: 'Rule Envs', exact: true });
  assert.equal(await page.locator('#rule-base-url').count(), 0);
  await envControl.click();
  await envMenu.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  await envMenu.getByRole('checkbox', { name: 'Local', exact: true }).uncheck();
  assert.equal(await envControl.getAttribute('value'), 'selected');
  assert.deepEqual(await envMenu.locator('.rule-env-choices input:checked').evaluateAll(nodes => nodes.map(node => node.value)), ['qa', 'staging']);
  const sameWidth = await envMenu.evaluate(node => Math.abs(node.getBoundingClientRect().width - document.querySelector('#rule-environment-scope').getBoundingClientRect().width));
  assert.ok(sameWidth <= 1);
  await page.keyboard.press('Escape');
  await page.locator('#save-rule').click();
  const targeted = config.scenarios[0].rules.find(rule => rule.id === 'filled');
  assert.equal(targeted.environmentScope, 'selected');
  assert.deepEqual(targeted.environmentIds, ['qa', 'staging']);
  await page.getByRole('button', { name: 'Edit Cart with items', exact: true }).click();
  await envControl.click();
  assert.equal(await envMenu.getByRole('checkbox', { name: 'QA Team', exact: true }).isChecked(), true);
  assert.equal(await envMenu.getByRole('checkbox', { name: 'Staging', exact: true }).isChecked(), true);
  assert.equal(await envMenu.getByRole('checkbox', { name: 'Local', exact: true }).isChecked(), false);
  await envMenu.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.locator('#save-rule').click();
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').environmentScope, 'all');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rule name', exact: true }).fill('Multi Env endpoint');
  await page.locator('#rule-url').fill('/api/very-long-endpoint-name-to-test-clipping');
  for (const width of [320, 360, 620, 1000]) {
    await page.setViewportSize({ width, height: 850 });
    const fields = await page.locator('#rule-form .route-fields > *').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, width: box.width };
    }));
    assert.equal(fields.length, 5);
    assert.equal(await page.locator('#rule-base-fields [contenteditable]').count(), 1);
    assert.deepEqual(await page.locator('.route-fields').evaluate(node => [...node.children].map(child => child.className)), ['rule-base-fields', 'route-path', 'route-endpoint', 'rule-env-field', 'rule-active-field']);
    if (width >= 1000) assert.equal(new Set(fields.map(field => field.y)).size, 1);
    assert.ok(await page.locator('nav.workspace-tabs > button').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).every(node => node.offsetHeight === 24)));
    assert.ok(fields.every(field => field.width > 0 && field.x >= 0 && field.right <= width));
    await envControl.click();
    assert.ok(await envMenu.evaluate(node => Math.abs(node.getBoundingClientRect().width - document.querySelector('#rule-environment-scope').getBoundingClientRect().width)) <= 1);
    await page.keyboard.press('Escape');
    await envMenu.waitFor({ state: 'hidden' });
    assert.equal(await envMenu.getByRole('checkbox', { name: 'Select all', exact: true }).isVisible(), false);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/rule-env-${host}-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 320, height: 850 });
  const clippedOrigin = page.locator('.rule-origin-value').first();
  await clippedOrigin.evaluate(node => node.style.width = '42px');
  const originText = await clippedOrigin.textContent();
  await clippedOrigin.hover();
  await page.waitForFunction(() => document.querySelector('.styled-tooltip').matches(':popover-open'));
  assert.ok((await page.locator('.styled-tooltip').textContent()).includes(originText));
  await envControl.click();
  const all = envMenu.getByRole('checkbox', { name: 'Select all', exact: true });
  await all.check(); await all.uncheck();
  await envMenu.getByRole('checkbox', { name: 'Local', exact: true }).check();
  assert.equal(await envMenu.locator('.rule-env-choices input').first().getAttribute('value'), 'local');
  await page.keyboard.press('Escape');
  await page.locator('#save-rule').click();
  assert.deepEqual(config.scenarios[0].rules.find(rule => rule.name === 'Multi Env endpoint').environmentIds, ['local']);
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rule name', exact: true }).fill('Generated conditions');
  await page.locator('#rule-url').fill('/api/v1/orders/search');
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  assert.equal(await page.locator('#rule-tabs.split-buttons').count(), 1);
  assert.equal(await page.locator('[aria-label="JSON matching"].split-buttons').count(), 1);
  await page.getByRole('button', { name: 'Paste example JSON', exact: true }).click();
  await page.getByRole('textbox', { name: 'Example request JSON', exact: true }).fill('{invalid');
  assert.equal(await page.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  await page.getByRole('textbox', { name: 'Example request JSON', exact: true }).fill('{"status":"pending","page":1}');
  assert.equal(await page.locator('#example-condition-preview').textContent(), '2 conditions generated automatically');
  await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/add-rule-example-${host}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.locator('.parameter-row').count(), 2);
  assert.deepEqual(await page.getByLabel('Parameter name or JSON path', { exact: true }).evaluateAll(nodes => nodes.map(node => node.value)), ['status', 'page']);
  assert.deepEqual(await page.locator('.parameter-comparison').allTextContents(), ['Equals', 'Equals']);
  for (const width of [320, 360, 620, 1000]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.locator('.parameter-row').evaluateAll(rows => rows.every(row => { const box = row.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && row.scrollWidth <= row.clientWidth; })), `Matching conditions fit at ${width}px`);
    assert.ok(await page.locator('.parameter-row').evaluateAll(rows => rows.every(row => {
      const field = row.querySelector('.parameter-picker').getBoundingClientRect();
      const value = row.querySelector('input[aria-label="Expected value"]').getBoundingClientRect();
      return value.width >= 64 && value.height >= 24 && (value.top >= field.bottom || value.left >= field.right);
    })), `Expected values remain visible without overlapping fields at ${width}px`);
    await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/add-rule-conditions-${host}-${width}.png`), animations: 'disabled' });
  }
  await page.locator('#save-rule').click();
  assert.deepEqual(config.scenarios[0].rules.find(rule => rule.name === 'Generated conditions').parameters, [
    { source: 'body', key: '/status', value: 'pending' }, { source: 'body', key: '/page', value: 1 }
  ]);


  await page.locator('#rules-filter-toggle').click();
  const tray = page.locator('#rules-request-filter-tree');
  const headers = () => tray.locator('.filter-facet:not([hidden]) summary').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [box.x, box.y]; }));
  const headerPositions = await headers();
  await tray.getByRole('checkbox', { name: 'GET', exact: true }).check();
  assert.deepEqual(await headers(), headerPositions, 'Selecting a filter keeps the tray headings still');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.locator('#rules-filter-toggle').click();
  assert.equal(await page.locator('#rules-request-filter-tree').getByRole('checkbox', { name: 'GET', exact: true }).isChecked(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  assert.equal(await page.locator('[name="urlMode"]').inputValue(), 'endpoint');
  await page.getByRole('textbox', { name: 'Rule name', exact: true }).fill('Smart response');
  await page.locator('#rule-url').fill('/alpha/users');
  await page.getByRole('textbox', { name: 'Response JSON', exact: true }).fill('<!doctype html><html><body>QA</body></html>');
  assert.equal(await page.locator('#rule-url').inputValue(), 'users');
  assert.equal(await page.getByRole('radio', { name: 'HTML', exact: true }).isChecked(), true);
  for (const width of [320, 620, 1000]) {
    await page.setViewportSize({ width, height: 850 });
    const slots = () => page.locator('.response-controls').evaluate(node => [...node.children].map(child => { const box = child.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; }));
    const positions = await slots();
    for (const format of ['Text', 'HTML', 'Empty', 'Error', 'JSON']) {
      await page.getByRole('radio', { name: format, exact: true }).check();
      assert.deepEqual(await slots(), positions, `Response fields stay in place for ${format} at ${width}px`);
      assert.equal(await page.locator('#status-field').isVisible(), true);
    }
    const actions = await page.locator('#save-rule').boundingBox();
    const body = await page.locator('#response-section').boundingBox();
    assert.ok(Math.abs(actions.x + actions.width - body.x - body.width) <= 1, 'Save actions stay at the content right edge');
  }
  await page.getByRole('radio', { name: 'Text', exact: true }).check();
  await page.locator('#response-body').fill('{"still":"text"}');
  assert.equal(await page.getByRole('radio', { name: 'Text', exact: true }).isChecked(), true, 'A manual type override survives body changes');
  await page.getByRole('radio', { name: 'Empty', exact: true }).check();
  assert.equal(await page.locator('#body-field').isVisible(), false);
  await page.getByRole('radio', { name: 'HTML', exact: true }).check();
  await page.locator('#response-body').fill('<h1>QA</h1>');
  const baseOverride = page.locator('#rule-base-fields [contenteditable]').first();
  const displayedBase = await baseOverride.innerText();
  await baseOverride.focus();
  assert.equal(await baseOverride.innerText(), displayedBase, 'Focusing Base URL retains the displayed domain');
  assert.equal(await baseOverride.evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('#rule-url').evaluate(node => getComputedStyle(node).backgroundColor));
  const originalBase = 'https://' + displayedBase;
  await baseOverride.fill('https://renamed.qa.example.com');
  await baseOverride.press('Tab');

  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  const resourceOverride = page.getByRole('combobox', { name: 'Request type', exact: true });
  assert.equal(await resourceOverride.evaluate(node => Boolean(node.closest('.rule-superheader'))), true);
  await resourceOverride.selectOption('any');
  await page.getByRole('tab', { name: 'Response', exact: true }).click();
  await page.locator('#save-rule').click();
  const smart = config.scenarios[0].rules.find(rule => rule.name === 'Smart response');
  assert.ok(config.environments.some(env => env.baseUrls.includes('https://renamed.qa.example.com')));
  assert.ok(!config.environments.some(env => env.baseUrls.includes(originalBase)), 'A direct Base URL edit updates its selected Env on save');

  assert.equal(smart.matchMode, 'endpoint'); assert.equal(smart.resource, 'any');
  assert.equal(smart.response.kind, 'text'); assert.equal(smart.response.format, 'html');
  assert.match(smart.response.headers['content-type'], /^text\/html/);
  await page.getByRole('button', { name: 'Edit Smart response', exact: true }).click();
  await page.locator('.route-advanced').evaluate(node => node.open = true);
  await page.locator('[name="urlMode"]').selectOption('path');
  assert.equal(await page.locator('#rule-url').inputValue(), '/alpha/users');
  await page.locator('[name="urlMode"]').selectOption('exact');
  assert.match(await page.locator('#rule-url').inputValue(), /^https?:\/\//);
  await page.locator('#rule-url').fill('https://external.test/alpha/users?x=1');
  assert.equal(await page.locator('#rule-environment-scope').isDisabled(), true);
  await page.locator('#save-rule').click();
  assert.equal(config.scenarios[0].rules.find(rule => rule.name === 'Smart response').url, 'https://external.test/alpha/users?x=1');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rule name', exact: true }).fill('Ambiguous search');
  await page.locator('#rule-url').fill('/orders/search');
  await page.locator('#save-rule').click();
  const conflictDialog = page.getByRole('dialog', { name: 'Endpoint conflict', exact: true });
  await conflictDialog.waitFor();
  await conflictDialog.getByRole('button', { name: 'Use Full path', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name="urlMode"]').value === 'path');
  assert.equal(await page.locator('[name="urlMode"]').inputValue(), 'path');
  assert.equal(await page.locator('#rule-url').inputValue(), '/orders/search');
  await page.locator('#save-rule').click();
  assert.equal(config.scenarios[0].rules.find(rule => rule.name === 'Ambiguous search').matchMode, 'path');
  assert.deepEqual(errors, []);
});
