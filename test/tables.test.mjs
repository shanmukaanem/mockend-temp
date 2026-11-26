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
  await page.locator('#request-count').getByText('(3)', { exact: true }).waitFor();
  const requestTable = page.locator('#requests-view table');
  await page.waitForFunction(() => document.querySelector('#requests-view table')?.dataset.sized === 'true');
  const columnWidths = await requestTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
  assert.ok(columnWidths[2] > columnWidths[1], 'URL columns have more room than methods');
  assert.ok(columnWidths[2] <= 420 && columnWidths[1] <= 110);
  for (const width of [620, 900, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await requestTable.locator('col').evaluateAll(cols => [1, 2, 4, 5].map(index => parseFloat(cols[index].style.width))), [76, 160, 84, 88]);
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
    const neighbors = await requestTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), before + 10);
    const resized = await requestTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
    assert.equal(resized[index + 1], neighbors[index + 1] - 10);
    for (let other = 0; other < resized.length; other++) if (other !== index && other !== index + 1) assert.equal(resized[other], neighbors[other]);
    assert.equal(await requestTable.locator('col').nth(index).evaluate(node => parseFloat(node.style.width)), before + 10);
    await page.setViewportSize({ width: 900, height: 760 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(Number(await divider.getAttribute('aria-valuenow')), before + 10);
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
  assert.equal(manualWidth, Math.max(40, columnWidths[0] - 10));
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
  await page.screenshot({ path: resolve(screenshots, 'base-url-tray.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#request-rows .record-delete').count(), 0);

  const request = rows.filter({ has: page.getByRole('button', { name: 'View POST /api/orders' }) });
  assert.equal(await request.locator('td').nth(2).innerText(), 'https://example.test\n/api');
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
  assert.equal(await page.locator('#clear-rules').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 30, 26)');
  await page.mouse.move(0, 0);
  assert.notEqual(await page.locator('#clear-rules').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 30, 26)');
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
  await page.locator('#toggle-filtered-mocks').click();
  await page.getByRole('button', { name: 'Enable filtered mocks', exact: true }).waitFor();
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').enabled, false);
  assert.equal(config.scenarios[0].rules.find(rule => rule.id !== 'filled').enabled, hiddenBefore);
  await page.getByRole('button', { name: 'Enable filtered mocks', exact: true }).click();
  await page.getByRole('button', { name: 'Disable filtered mocks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Enable all mocks', exact: true }).click();
  await page.getByRole('button', { name: 'Disable all mocks', exact: true }).waitFor();
  assert.ok(config.scenarios[0].rules.every(rule => rule.enabled));
  await page.getByRole('button', { name: 'Disable all mocks', exact: true }).click();
  await page.getByRole('button', { name: 'Enable all mocks', exact: true }).waitFor();
  assert.ok(config.scenarios[0].rules.every(rule => !rule.enabled));
  await page.getByRole('button', { name: 'Enable all mocks', exact: true }).click();
  await page.getByRole('button', { name: 'Disable all mocks', exact: true }).waitFor();
  await page.locator('#rules-request-query').fill('');
  await page.getByRole('switch', { name: 'Enable Expired coupon', exact: true }).uncheck();
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
  assert.equal(await rules.locator('td').nth(3).innerText(), 'http://127.0.0.1:4319\n/api');
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
  await page.locator('#rules-request-facets').getByRole('checkbox', { name: 'Off', exact: true }).check();
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
  await rules.first().getByRole('switch').uncheck();
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').enabled, false);
  await rules.first().getByRole('switch').check();
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
  assert.equal(await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(230, 218, 196)');
  assert.equal(await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
  await page.screenshot({ path: resolve(screenshots, 'focused-env-input.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  assert.deepEqual(config.environments[0].baseUrls, ['https://qa.example.org', 'https://example.test']);
  assert.equal(config.environments.length, 1);
  await page.locator('#mock-environment').selectOption(config.environments[0].id);
  assert.equal(config.settings.environmentId, config.environments[0].id);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await rules.first().getByRole('button', { name: 'Edit Cart with items', exact: true }).click();
  await page.locator('#rule-environment-scope').selectOption('active');
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
  assert.equal(config.scenarios[0].rules.find(rule => rule.id === 'filled').environmentScope, 'active');
  const editedRule = rules.filter({ has: page.getByRole('button', { name: 'Edit Cart with items', exact: true }) });
  assert.ok((await editedRule.locator('td').nth(3).innerText()).includes('https://qa.example.org'));
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
  assert.ok((await editedRule.locator('td').nth(3).innerText()).includes('http://127.0.0.1:4319'));
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
  await nameDivider.dblclick();
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForFunction(() => Number(document.querySelector('#rules-view colgroup').children[1].style.width.replace('px', '')) <= 360);
  config.scenarios[0].rules.find(rule => rule.id === 'filled').name = 'Long recorded response '.repeat(4);
  revision++;
  await page.getByRole('button', { name: /^Edit Long recorded response/ }).first().waitFor();
  await page.waitForFunction(() => document.querySelector('#rules-view colgroup').children[1].style.width === '64px');
  const deleteButton = rules.first().getByRole('button', { name: /^Delete/ });
  assert.equal(await deleteButton.textContent(), '');
  assert.equal(await deleteButton.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(174, 40, 62)');
  assert.equal(await page.locator('#record-toggle .control-label').isVisible(), false);
  assert.equal(await page.locator('#record-toggle svg').isVisible(), true);
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
  assert.equal(await page.locator('.mock-split').evaluate(node => getComputedStyle(node).flexGrow), '0');
  const captionInset = await page.locator('.scenario-tools').evaluate(node => {
    return node.querySelector('.section-title').getBoundingClientRect().left - node.getBoundingClientRect().left;
  });
  assert.equal(captionInset, 10);
  assert.equal(await page.locator('#record-toggle .control-label').isVisible(), true);
  assert.equal(await page.locator('#record-toggle svg').isVisible(), true);
  assert.equal(await page.locator('#scenario-toolbar .transfer-trigger').count(), 3);
  assert.equal(await page.locator('#new-scenario').evaluate(node => getComputedStyle(node).fontSize), await page.locator('.transfer-label').first().evaluate(node => getComputedStyle(node).fontSize));
  const scenarioBox = await page.locator('#scenario').boundingBox();
  const downloadBox = await page.locator('#transfer-download').boundingBox();
  assert.ok(Math.abs(scenarioBox.y - downloadBox.y) < 2);
  await page.locator('#transfer-download').hover();
  assert.equal(await page.locator('#transfer-download-menu').evaluate(node => node.matches(':popover-open')), true);
  await page.waitForFunction(() => document.querySelector('#transfer-download').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.locator('#transfer-download').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 30, 26)');
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
    const separator = cell.querySelector('.column-resize').getBoundingClientRect();
    return { top: label.top - bounds.top, bottom: bounds.bottom - label.bottom, right: bounds.right - label.right, separator: bounds.right - (separator.left + separator.width / 2) };
  });
  assert.equal(insets.top, insets.bottom);
  assert.ok(insets.right > insets.separator);
  assert.ok(insets.right - insets.separator >= 1);
  assert.equal(await header.locator('button').evaluate(node => parseFloat(getComputedStyle(node).paddingInlineStart)), 6);
  assert.equal(await ruleTable.locator('col').nth(8).evaluate(node => parseFloat(node.style.width)), 44);
  assert.equal(await page.locator('#rules-view th').nth(8).locator('.column-resize').count(), 1);
  assert.equal(await page.locator('#rules-view .column-resize').count(), 9);
  const envDivider = page.locator('#rules-view th').nth(8).getByRole('separator');
  const envBefore = await ruleTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
  await envDivider.focus(); await page.keyboard.press('Shift+ArrowLeft');
  const envAfter = await ruleTable.locator('col').evaluateAll(cols => cols.map(col => parseFloat(col.style.width)));
  assert.equal(envAfter[8], envBefore[8] - 1);
  assert.equal(envAfter[9], envBefore[9] + 1);
  assert.deepEqual(envAfter.slice(0, 8), envBefore.slice(0, 8));
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await ruleTable.locator('col').nth(8).evaluate(node => parseFloat(node.style.width)), 44);

  assert.equal(await page.locator('#rules-view th').first().locator('[data-rule-sort] > span').evaluate(node => getComputedStyle(node).marginInlineStart), '6px');
  assert.equal(await page.locator('#rules-view th').first().locator('button').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.locator('#rules-view th').first().evaluate(node => getComputedStyle(node).borderTopLeftRadius), '8px');
  const heights = await page.locator('#scenario-toolbar > button, #scenario-toolbar .transfer-trigger, .rules-head > button, .rules-head .url-selectors button').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => node.offsetHeight));
  assert.deepEqual([...new Set(heights)], [24]);
  await page.mouse.move(0, 0);
  await page.locator('#rules-view .request-table').evaluate(node => { node.scrollLeft = 0; });
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
  assert.equal(await page.locator('#scenario').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 30, 26)');
  const icons = await page.locator('#scenario-options .scenario-action svg').evaluateAll(nodes => nodes.map(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]));
  const flowActionStyles = await page.locator('#scenario-options .scenario-action').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).backgroundColor, node.offsetWidth, node.offsetHeight]));
  assert.ok(flowActionStyles.every(style => style[0] === 'rgb(230, 218, 196)' && style[1] === 22 && style[2] === 22));
  assert.ok(icons.length >= 3 && icons.every(([width, height]) => width === 12 && height === 12));
  const centers = await page.evaluate(() => {
    const center = node => { const box = node.getBoundingClientRect(); return box.x + box.width / 2; };
    return {
      outside: ['new-scenario', 'transfer-clipboard', 'transfer-download'].map(id => center(document.getElementById(id))),
      inside: [...document.querySelector('.scenario-option').querySelectorAll('.scenario-action')].map(center)
    };
  });
  for (let index = 1; index < centers.inside.length; index++) assert.ok(Math.abs(centers.inside[index] - centers.inside[index - 1] - 26) <= 1);
  const intrinsic = await page.locator('#scenario-options').evaluate(node => {
    const choices = [...node.querySelectorAll('.scenario-choice')];
    return choices.map(choice => ({ width: choice.getBoundingClientRect().width, scroll: choice.scrollWidth, client: choice.clientWidth }));
  });
  assert.ok(intrinsic.every(choice => choice.scroll <= choice.client), JSON.stringify(intrinsic));
  await page.screenshot({ path: resolve(screenshots, 'flows-menu.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  assert.equal(await page.locator('#add-rule').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(230, 218, 196)');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  assert.equal(await page.locator('#rule-ingress-preview').textContent(), '');
  assert.equal(await page.locator('#rule-endpoint-preview').textContent(), '');
  assert.equal(await page.locator('#rule-name').evaluate(node => getComputedStyle(node).paddingInlineStart), '8px');
  await page.locator('#rule-name').fill('Editor alignment');
  await page.locator('#edit-rule-name').hover();
  assert.equal(await page.locator('#edit-rule-name').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 30, 26)');
  await page.locator('#edit-rule-name').click();
  assert.equal(await page.locator('#rule-name').evaluate(node => document.activeElement === node), true);
  const edges = await page.locator('#rule-form').evaluate(form => ['#rule-title', '.route-fields', '.rule-url-parts', '.rule-environment-controls', '#rule-tabs', '#response-section'].map(selector => form.querySelector(selector).getBoundingClientRect().left));
  assert.ok(edges.every(left => Math.abs(left - edges[0]) <= 1));
  const parts = await page.locator('.rule-url-parts > span').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })));
  assert.ok(Math.abs(parts[0].width - parts[1].width) <= 1 && Math.abs(parts[1].width - parts[2].width) <= 1);
  await page.locator('#response-status-toggle').click();
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
    assert.ok(Math.abs(sticky.top) <= 1);
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
  assert.equal(await page.locator('#environment-url-rows tr').count(), 3);
  assert.equal(await nav.getByRole('button', { name: 'QA', exact: true }).getByText('Active').count(), 1);
  assert.equal(await nav.getByRole('button', { name: 'QA', exact: true }).locator('small').evaluate(node => getComputedStyle(node).color), await page.locator('.environment-manager > .environment-heading p').evaluate(node => getComputedStyle(node).color));
  await nav.getByRole('button', { name: 'QA', exact: true }).hover();
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
    else assert.ok(sizes.buttons.every(button => button.labels));
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
  await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/env-setup-${host}-wide.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.environment-url-table').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: resolve(import.meta.dirname, `../test-results/env-setup-${host}-compact.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 1000, height: 850 });
  await url.fill('https://inventory.qa.example.com/path');
  await form.getByRole('button', { name: 'Add URL', exact: true }).click();
  assert.equal(await url.evaluate(node => node === document.activeElement && !node.validity.valid), true);
  assert.equal(config.environments[0].baseUrls.length, 3);
  await url.fill('https://inventory.qa.example.com/');
  await form.getByRole('button', { name: 'Add URL', exact: true }).click();
  await form.waitFor({ state: 'hidden' });
  assert.equal(config.environments[0].services['https://inventory.qa.example.com'], 'Inventory');
  assert.equal(config.settings.environmentId, 'staging');
  await page.getByRole('button', { name: 'Edit base URL https://inventory.qa.example.com', exact: true }).click();
  assert.equal(await form.isVisible(), false);
  const edited = page.locator('tr[data-origin="https://inventory.qa.example.com"]');
  await edited.getByRole('textbox', { name: 'Service name for https://inventory.qa.example.com', exact: true }).fill('Inventory API');
  await edited.getByRole('textbox', { name: 'Base URL for https://inventory.qa.example.com', exact: true }).fill('https://stock.qa.example.com');
  assert.equal(await edited.locator('[contenteditable]').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: 'Edit base URL https://orders.qa.example.com', exact: true }).click();
  const otherEdit = page.getByRole('textbox', { name: 'Service name for https://orders.qa.example.com', exact: true });
  await otherEdit.fill('Unsaved Orders');
  await page.setViewportSize({ width: 320, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const rowHeights = await page.locator('#environment-url-rows tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
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
  await page.waitForFunction(() => document.querySelectorAll('#environment-url-rows tr').length === 3);
  assert.equal(config.environments[0].services['https://stock.qa.example.com'], undefined);
  await page.getByRole('button', { name: 'Rename Env', exact: true }).click();
  await page.getByLabel('Env name (required)', { exact: true }).fill('QA Team');
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  await page.getByRole('heading', { name: 'QA Team', exact: true }).waitFor();
  assert.equal(config.environments[0].services['https://accounts.qa.example.com'], 'Accounts');
  await page.getByRole('button', { name: '+ New environment', exact: true }).click();
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  assert.equal(await page.getByLabel('Env name (required)', { exact: true }).evaluate(node => node === document.activeElement), true);
  await page.getByLabel('Env name (required)', { exact: true }).fill('PROD');
  await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).fill('https://api.example.com');
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
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
  assert.deepEqual(errors, []);
});
