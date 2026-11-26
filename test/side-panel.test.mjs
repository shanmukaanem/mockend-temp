import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
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

async function transferAction(page, kind, provider, name) {
  await page.locator(`#transfer-${kind}`).click();
  const menu = page.locator(`#transfer-${kind}-menu`);
  await menu.getByRole('heading', { name: provider, exact: true }).waitFor();
  await menu.getByRole('button', { name, exact: true }).click();
}

test('the side panel starts recording, filters requests and opens a selected response', async t => {
  const { page, origin } = await panelFixture(t, 'chromium');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  let revision = 0;
  let config = starterConfig();
  let active = null;
  let openedTab = false;
  const available = { id: 9, title: 'Test app', url: 'https://example.test/' };
  await page.exposeFunction('fixtureMockRouteMessage', async ({ windowId, action, data }) => {
    assert.equal(windowId, 4);
    if (action === 'open-tab') openedTab = true;
    if (action === 'save') {
      assert.equal(data.revision, revision);
      config = data.config;
      revision++;
    }
    if (action === 'start') {
      assert.equal(data.tabId, 9);
      active = available;
    }
    return { state: { revision, config, activity: [], connection: { active, available } } };
  });
  const original = JSON.stringify({ items: ['original'] }, null, 2);
  await page.addInitScript(content => {
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
  await page.getByRole('button', { name: 'Open Mockend in new tab' }).click();
  assert.equal(openedTab, true);
  assert.equal(await page.getByRole('columnheader').first().getAttribute('aria-sort'), 'descending');
  await page.getByRole('button', { name: 'ID', exact: true }).click();
  assert.deepEqual(await rows.locator('.request-id').allTextContents(), ['1', '2', '3']);
  await page.getByRole('button', { name: 'ID', exact: true }).click();
  assert.deepEqual(await rows.locator('.request-id').allTextContents(), ['3', '2', '1']);
  assert.deepEqual(await rows.locator('.method-badge').evaluateAll(badges => badges.map(badge => badge.dataset.method)), ['POST', 'GET', 'GET']);
  assert.equal(await rows.locator('.request-code').evaluateAll(badges =>
    new Set(badges.map(badge => getComputedStyle(badge).backgroundColor)).size), 3);
  const initialViewport = page.viewportSize();
  const methodColumn = page.getByRole('columnheader', { name: 'Method' });
  const methodWidth = (await methodColumn.boundingBox()).width;
  await page.setViewportSize({ width: 320, height: 270 });
  assert.equal((await methodColumn.boundingBox()).width, methodWidth);
  const scroll = await page.locator('#requests-view .request-table').evaluate(table => {
    table.scrollTop = 200;
    const result = { offset: table.scrollTop, bottom: table.getBoundingClientRect().bottom, inset: table.offsetLeft };
    table.scrollTop = 0;
    return result;
  });
  assert.ok(scroll.offset > 0 && scroll.bottom <= 270 - scroll.inset + 1);
  await page.setViewportSize(initialViewport);
  await rows.first().hover();
  assert.equal(await rows.first().getAttribute('data-hovered'), '');
  await rows.last().hover();
  assert.equal(await rows.first().getAttribute('data-hovered'), null);
  await page.locator('#capture-title').hover();
  assert.equal(await page.locator('#request-rows tr[data-hovered]').count(), 0);
  const actionsLayout = await rows.first().evaluate(row => {
    const curl = row.querySelector('.request-curl').getBoundingClientRect();
    const mock = row.querySelector('.request-mock').getBoundingClientRect();
    return { aligned: curl.x === mock.x && Math.abs(curl.bottom - mock.top) < 1, height: row.offsetHeight };
  });
  assert.deepEqual(actionsLayout, { aligned: true, height: 44 });
  const typeHeader = page.getByRole('columnheader', { name: 'Type' });
  await typeHeader.getByRole('button').click();
  assert.deepEqual(await rows.locator('.type-badge').allTextContents(), ['Fetch/XHR', 'Fetch/XHR', 'Mocked', 'Image']);
  const endpointHeader = page.getByRole('columnheader', { name: 'Endpoint' });
  await endpointHeader.getByRole('button').click();
  assert.equal(await endpointHeader.getAttribute('aria-sort'), 'ascending');
  const statusHeader = page.getByRole('columnheader', { name: 'Status' });
  const tableBox = await page.locator('#requests-view .request-table table').boundingBox();
  const actionsBox = await page.getByRole('columnheader', { name: 'Status' }).boundingBox();
  assert.equal(await page.getByRole('columnheader', { name: 'Actions' }).count(), 0);
  assert.ok(actionsBox.width > 0 && tableBox.width > 0);
  for (const width of [320, 400, 588, 870]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok((await endpointHeader.boundingBox()).width >= 48);
    const pinned = await statusHeader.boundingBox();
    assert.ok(pinned.x + pinned.width <= width - 10);
  }
  await page.setViewportSize({ width: 620, height: 760 });
  await statusHeader.scrollIntoViewIfNeeded();
  await statusHeader.getByRole('button').click();
  assert.deepEqual(await rows.locator('.request-code').allTextContents(), ['200', '304', '404']);
  await page.getByRole('button', { name: 'Status', exact: true }).press('Enter');
  assert.deepEqual(await rows.locator('.request-code').allTextContents(), ['404', '304', '200']);
  await page.getByRole('button', { name: 'Regex search' }).click();
  await page.getByLabel('Search requests and responses').fill('[invalid');
  await page.locator('.toast[data-key="request-query-error"]').waitFor();
  await page.getByLabel('Search requests and responses').fill('/orders.*mode=qa$/i');
  assert.equal(await rows.count(), 1);
  await page.getByRole('button', { name: 'Regex search' }).click();
  const query = page.getByLabel('Search requests and responses');
  await query.fill('original');
  await page.getByText('(1/3)', { exact: true }).waitFor();
  assert.equal(await rows.locator('.request-id').textContent(), '2');
  await query.fill('"order":3');
  assert.equal(await rows.locator('.request-id').textContent(), '3');
  await rows.locator('.request-code').click();
  await page.getByRole('heading', { name: 'Request details' }).waitFor();
  await page.getByRole('button', { name: 'Close request details' }).click();
  await page.getByRole('button', { name: 'Clear request search' }).click();
  assert.equal(await query.inputValue(), '');
  await query.fill('AMP /API/ORD');
  assert.equal(await rows.count(), 2);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const filterOptions = page.getByRole('group', { name: 'Request filters' });
  const optionSearch = filterOptions.getByLabel('Search filter options');
  const type = filterOptions.locator('#request-facets details').first();
  const method = filterOptions.locator('#request-facets details').nth(1);
  assert.equal((await type.boundingBox()).y, (await method.boundingBox()).y);
  assert.equal(await page.locator('#request-host-facet').count(), 0);
  await type.locator('summary').press('Enter');
  assert.equal(await type.getAttribute('open'), null);
  await type.locator('summary').press('Enter');
  const allFilters = filterOptions.getByRole('checkbox', { name: 'Select all filters', exact: true });
  const typeBulk = filterOptions.getByRole('checkbox', { name: 'Select all type filters' });
  const summaryBox = await type.locator('summary').boundingBox();
  const checkboxBox = await typeBulk.boundingBox();
  assert.ok(Math.abs(summaryBox.y + summaryBox.height / 2 - checkboxBox.y - checkboxBox.height / 2) < 1);
  const clearFilters = page.getByRole('button', { name: 'Clear filters', exact: true });
  const pillLayout = () => page.locator('#requests-view .request-table, #clear-filters').evaluateAll(items =>
    items.map(item => { const { x, y } = item.getBoundingClientRect(); return [x, y]; }));
  const beforePills = await pillLayout();
  await allFilters.check();
  assert.deepEqual(await pillLayout(), beforePills);
  assert.ok(await clearFilters.isEnabled());
  assert.equal(await rows.count(), 2);
  await filterOptions.getByRole('checkbox', { name: 'Select all type filters' }).uncheck();
  assert.equal(await allFilters.evaluate(input => input.indeterminate), true);
  await allFilters.press('Space');
  await allFilters.uncheck();
  assert.equal(await page.locator('#filter-chips .filter-chip').count(), 0);
  await optionSearch.fill('fet');
  await filterOptions.getByRole('checkbox', { name: 'Select all matching type filters' }).check();
  assert.ok(await filterOptions.getByRole('checkbox', { name: 'Fetch/XHR', exact: true }).isChecked());
  assert.equal(await rows.count(), 2);
  await optionSearch.fill('xhr');
  assert.ok(await filterOptions.getByRole('checkbox', { name: 'Fetch/XHR', exact: true }).isVisible());
  await filterOptions.getByRole('button', { name: 'Clear filter search' }).click();
  assert.equal(await optionSearch.inputValue(), '');
  assert.deepEqual(await page.locator('#filter-chips .filter-chip').allTextContents(), ['Fetch/XHR']);
  const removeApi = page.getByRole('button', { name: 'Remove type filter Fetch/XHR' });
  assert.ok((await removeApi.boundingBox()).width >= 24);
  await removeApi.press('Enter');
  assert.equal(await removeApi.count(), 0);
  await filterOptions.getByRole('checkbox', { name: 'Mocked', exact: true }).check();
  assert.equal(await rows.count(), 1);
  await optionSearch.press('Escape');
  await rows.getByText('Mocked', { exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Add Fetch/XHR to filter', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add Mocked to filter', exact: true }).waitFor();
  assert.deepEqual(await page.locator('#request-actions button').allTextContents(),
    ['Add GET to filter', 'Add Fetch/XHR to filter', 'Add Mocked to filter', 'Add 200 to filter', 'Add Base URL to filter', 'Add Path to filter', 'Add Endpoint to filter', 'Add URL to filter']);
  await page.getByRole('button', { name: 'Add URL to filter', exact: true }).click();
  await page.locator('#filter-toggle').click();
  assert.equal(await page.getByRole('button', { name: /^Remove url filter / }).count(), 0);
  assert.equal(await page.locator('#filter-count').textContent(), '1');
  await optionSearch.press('Escape');
  await rows.getByText('Mocked', { exact: true }).click();
  await page.locator('#request-detail-mock').waitFor();
  await page.getByRole('button', { name: 'Mocked by Cart with items' }).click();
  await page.getByRole('heading', { name: 'Edit rule', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Rule name').inputValue(), 'Cart with items');
  await page.locator('#rule-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#filter-toggle').click();
  await page.getByRole('button', { name: 'Remove type filter Mocked' }).click();
  await optionSearch.press('Escape');
  await query.fill('/missing');
  await page.getByText('No matches. Remove a filter or try a shorter search.').waitFor();
  await page.getByRole('button', { name: 'Copy Collection', exact: true }).click();
  await page.getByText('No matching requests to copy.', { exact: false }).waitFor();
  await query.fill('mode=qa');
  assert.equal(await rows.count(), 1);
  assert.equal(await page.locator('#postman-status').isVisible(), false);
  await query.fill('/api/ord -mode=prod');
  await page.getByRole('button', { name: 'Copy Collection' }).click();
  await page.getByText('Copied 2 requests', { exact: false }).waitFor();
  assert.equal(await page.locator('#copy-postman-label').textContent(), 'Copied');
  assert.equal(await page.locator('#copy-postman svg').count(), 1);
  const collection = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.deepEqual(collection.item.map(item => item.request.method), ['POST', 'GET']);
  assert.equal(collection.item[1].request.url, 'https://example.test/api/orders?mode=qa');
  assert.equal(collection.item[1].response[0].body, original);
  assert.match(collection.item[1].response[0].originalRequest.description, /curl --request 'GET'.*mode=qa/);
  assert.equal(collection.item[0].response[0].code, 404);
  await page.waitForFunction(() => document.querySelector('#copy-postman-label').textContent === 'Copy');
  const collectionDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Collection' }).click();
  const downloaded = await collectionDownload;
  assert.equal(downloaded.suggestedFilename(), 'mockend.postman_collection.json');
  assert.deepEqual(JSON.parse(await readFile(await downloaded.path(), 'utf8')), collection);
  const tableTop = await page.locator('#requests-view .request-table').evaluate(node => node.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'Copy cURL for POST /api/orders' }).click();
  await page.getByText('cURL command copied.', { exact: true }).waitFor();
  assert.equal(await page.locator('#capture-status').isVisible(), false);
  assert.equal(await page.locator('#requests-view .request-table').evaluate(node => node.getBoundingClientRect().top), tableTop);
  assert.equal(await page.locator('.toast[data-key="capture-status"]').isVisible(), true);
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /curl --request 'POST'.*--data-binary/);
  await page.getByRole('button', { name: 'View POST /api/orders' }).click();
  await page.getByText('Request details').waitFor();
  assert.equal(await page.locator('#request-detail-type').textContent(), 'Fetch/XHR');
  assert.equal(await page.locator('#request-detail-status').textContent(), '404');
  assert.equal(await page.locator('#request-detail-body').textContent(), JSON.stringify({ order: 3 }, null, 2));
  await page.locator('#response-detail-body .json-key').getByText('"message"', { exact: true }).waitFor();
  assert.equal(await page.locator('#response-detail-body').textContent(), '{\n  "message": "missing"\n}');
  assert.equal(await page.locator('#request-detail-body .json-number').textContent(), '3');
  assert.ok((await page.locator('#response-detail-body').boundingBox()).y <
    (await page.locator('#request-detail-body').boundingBox()).y);
  await page.getByRole('button', { name: 'Copy response body', exact: true }).click();
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), '{\n  "message": "missing"\n}');
  assert.equal(await page.locator('#request-details .dialog-body').evaluate(node => getComputedStyle(node).overflowY), 'hidden');
  const previewPane = page.locator('#response-detail-body').locator('..');
  assert.equal(await previewPane.locator('.code-gutter').textContent(), '1\n2\n3');
  assert.equal(await previewPane.locator('.code-gutter').getAttribute('aria-hidden'), 'true');
  const previewScroll = await page.locator('#response-detail-body').evaluate(body => {
    const saved = body.innerHTML;
    body.textContent += '\nmore data'.repeat(200) + 'x'.repeat(1000);
    body.scrollLeft = 100;
    body.scrollTop = 100;
    const result = [body.scrollTop, body.closest('.dialog-body').scrollTop, body.scrollLeft];
    body.innerHTML = saved;
    return result;
  });
  assert.ok(previewScroll[0] > 0);
  assert.equal(previewScroll[1], 0);
  assert.ok(previewScroll[2] > 0);
  const closeDetails = page.getByRole('button', { name: 'Close request details' });
  assert.ok((await closeDetails.boundingBox()).width >= 32);
  await page.mouse.click(1, 1);
  await page.locator('#request-details').waitFor({ state: 'hidden' });
  const endpoint = page.getByRole('button', { name: 'View POST /api/orders' });
  assert.equal(await endpoint.evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: 'Mock POST /api/orders' }).click();
  await page.getByText('The captured response was HTTP 404.', { exact: false }).waitFor();
  const methodPicker = page.getByRole('combobox', { name: 'Method', exact: true });
  const name = page.getByRole('textbox', { name: 'Rule name' });
  await name.fill('');
  const nameBox = await name.boundingBox();
  const title = page.getByRole('heading', { name: 'Mock response' });
  const titleBox = await title.boundingBox();
  assert.ok(Math.abs(nameBox.y + nameBox.height / 2 - titleBox.y - titleBox.height / 2) < 1);
  assert.equal(await name.evaluate(input => getComputedStyle(input).fontSize),
    await title.evaluate(heading => getComputedStyle(heading).fontSize));
  const modes = page.getByRole('combobox', { name: 'URL matching' });
  const modesBox = await modes.boundingBox();
  const urlBox = await page.getByRole('textbox', { name: 'Request URL' }).boundingBox();
  assert.equal(modesBox.y, urlBox.y);
  await name.fill('POST /api/orders');
  assert.equal(await methodPicker.inputValue(), 'POST');
  const viewport = page.viewportSize();
  for (const width of [viewport.width, 320]) {
    await page.setViewportSize({ width, height: viewport.height });
    const bounds = await page.locator('.route-fields :is(select, input)').evaluateAll(controls =>
      controls.map(control => {
        const { x, y, width, height } = control.getBoundingClientRect();
        return { x, y, width, height };
      }));
    assert.equal(new Set(bounds.map(rect => rect.y)).size, 1);
    assert.equal(new Set(bounds.map(rect => rect.height)).size, 1);
    assert.equal(bounds[0].height, 24);
    assert.ok(bounds[1].width > 35);
    assert.ok(bounds.at(-1).x + bounds.at(-1).width < width);
  }
  await page.setViewportSize(viewport);
  await methodPicker.click();
  await page.getByRole('option', { name: 'PATCH', exact: true }).click();
  assert.equal(await methodPicker.inputValue(), 'PATCH');
  assert.deepEqual(await methodPicker.locator('option').allTextContents(),
    ['PATCH', 'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']);
  await methodPicker.selectOption('OPTIONS');
  assert.equal(await methodPicker.evaluate(node => node.title || node.dataset.tooltip), 'OPTIONS');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/select-options-containment.png'), animations: 'disabled' });
  const methodValue = await methodPicker.evaluate(select => {
    const content = select.querySelector('selectedcontent');
    return { text: content.textContent, value: select.value, scroll: content.scrollWidth, client: content.clientWidth, width: select.clientWidth };
  });
  assert.equal(methodValue.text, 'OPTIONS', JSON.stringify(methodValue));
  assert.ok(methodValue.scroll <= methodValue.client, JSON.stringify(methodValue));
  assert.equal(await methodPicker.locator('selectedcontent').evaluate(node => getComputedStyle(node).overflowX), 'hidden');
  await methodPicker.selectOption('POST');
  assert.equal(await modes.inputValue(), 'exact');
  await modes.selectOption('pattern');
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  assert.ok(await page.getByRole('radio', { name: 'Exact JSON' }).isChecked());
  assert.equal(await page.getByLabel('Request JSON', { exact: true }).inputValue(), JSON.stringify({ order: 3 }, null, 2));
  await page.getByRole('radio', { name: 'Parameters' }).check();
  await page.getByRole('button', { name: '+ Add parameter' }).click();
  assert.equal(await page.getByLabel('Parameter source').inputValue(), 'body');
  await page.getByLabel('Parameter source').selectOption('query');
  await page.getByLabel('Parameter name or JSON path').fill('limit');
  await page.getByLabel('Expected value', { exact: true }).fill('10');
  assert.equal(await modes.inputValue(), 'endpoint');
  await page.getByRole('button', { name: '+ Add parameter' }).click();
  await page.getByLabel('Parameter source').last().selectOption('body');
  await page.getByLabel('Condition operator').last().selectOption('or');
  const fieldPicker = page.getByLabel('Parameter name or JSON path').last();
  await fieldPicker.fill('ord');
  await page.getByRole('option', { name: 'order', exact: true }).click();
  assert.equal(await page.getByLabel('Expected value', { exact: true }).last().inputValue(), '3');
  await page.locator('#parameter-example-panel summary').click();
  await page.getByLabel('Example request JSON', { exact: true }).fill('{"customer":{"id":7,"name":"QA"}}');
  await fieldPicker.fill('customer id');
  await page.getByRole('option', { name: 'customer/id', exact: true }).waitFor();
  await fieldPicker.press('ArrowDown');
  await fieldPicker.press('Enter');
  assert.equal(await fieldPicker.inputValue(), 'customer/id');
  assert.equal(await page.getByLabel('Expected value', { exact: true }).last().inputValue(), '7');
  await page.getByRole('button', { name: 'Reorder condition' }).last().press('ArrowUp');
  assert.equal(await page.getByLabel('Parameter name or JSON path').first().inputValue(), 'customer/id');
  assert.equal(await page.getByLabel('Condition operator').last().inputValue(), 'or');
  const resource = page.getByLabel('Request type', { exact: false }).filter({ visible: true });
  assert.equal(await resource.inputValue(), 'api');
  assert.equal(await resource.locator('option:is([value="Fetch"], [value="XHR"])').count(), 0);
  const parameterHeights = await page.locator('.parameter-row :is(input, select):visible').evaluateAll(
    nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.deepEqual([...new Set(parameterHeights)], [24]);
  assert.equal(await page.locator('#rule-request-tab').evaluate(node => getComputedStyle(node).boxShadow), 'none');
  await page.locator('#rule-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#rule-dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('Search requests and responses').fill('mode=qa');
  assert.equal(await rows.count(), 1);
  assert.equal(await page.locator('#requests-view .request-table').evaluate(container => container.querySelector('table').offsetWidth >= container.clientWidth), true);
  if (process.env.MOCKROUTE_TEST_SHOTS) await page.screenshot({ path: process.env.MOCKROUTE_TEST_SHOTS + '/requests.png' });
  await rows.first().locator('.request-mock').click();
  const response = page.getByLabel('Response JSON', { exact: true });
  const responsePane = page.locator('#body-field .code-pane');
  await response.waitFor();
  assert.equal(await responsePane.locator('.fold-ellipsis').count(), 0);
  await responsePane.getByRole('button', { name: 'Collapse lines 2–4' }).click();
  assert.equal(await responsePane.locator('.code-gutter').textContent(), '1\n2\n5');
  await responsePane.getByRole('button', { name: 'Copy Response JSON' }).click();
  const codeToast = page.locator('.toast[data-key="code-copy"]');
  await codeToast.waitFor();
  assert.equal(await codeToast.evaluate(node => Boolean(node.closest('dialog[open]'))), true);
  await codeToast.getByRole('button', { name: 'Dismiss notification' }).click();
  await codeToast.waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), original);
  await responsePane.locator('.fold-ellipsis').click();
  try { await response.waitFor(); }
  catch (error) {
    throw new Error(`Editor did not open. ${await page.locator('#capture-status').textContent()}`, { cause: error });
  }
  assert.equal(await response.inputValue(), original);
  const editorHeight = (await response.boundingBox()).height;
  await response.fill(JSON.stringify(Array.from({ length: 150 }, (_, index) => index)));
  const codeExtent = await response.evaluate(input => ({
    remaining: input.closest('.dialog-body').getBoundingClientRect().bottom - input.getBoundingClientRect().bottom,
    scrolls: input.scrollHeight > input.clientHeight
  }));
  assert.ok(codeExtent.remaining >= 0 && codeExtent.remaining <= 16 && codeExtent.scrolls);
  await response.fill(JSON.stringify({ url: 'https://example.test/' + 'x'.repeat(1000) }));
  assert.equal(await response.getAttribute('wrap'), 'off');
  assert.equal(await response.evaluate(node => node.scrollWidth > node.clientWidth), true);
  await response.fill(original);
  await response.fill('{}');
  assert.ok((await response.boundingBox()).height < editorHeight);
  await response.fill(original);
  await response.selectText();
  assert.equal(await page.locator('#request-json-section').isVisible(), false);
  const heights = await page.locator('.response-controls :is(select[name="kind"], #response-status-toggle, input[type="number"]):visible')
    .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.equal(new Set(heights).size, 1);
  const requestSection = page.locator('#request-json-section');
  const requestTab = page.getByRole('tab', { name: 'Request', exact: true });
  const responseTab = page.getByRole('tab', { name: 'Response', exact: true });
  const headersTab = page.getByRole('tab', { name: 'Headers & CORS' });
  const footer = page.locator('#rule-form > .dialog-foot');
  const footerY = (await footer.boundingBox()).y;
  await requestTab.click();
  assert.equal((await requestSection.locator('.choice-group label').first().boundingBox()).height, heights[0]);
  assert.equal(await response.isVisible(), false);
  await requestTab.press('ArrowRight');
  assert.equal(await headersTab.getAttribute('aria-selected'), 'true');
  assert.ok(await page.getByLabel('Response headers', { exact: true }).isVisible());
  assert.equal((await footer.boundingBox()).y, footerY);
  await headersTab.press('Home');
  assert.equal(await responseTab.getAttribute('aria-selected'), 'true');
  await response.selectText();
  assert.deepEqual(await response.evaluate(input => [document.activeElement === input, input.selectionStart, input.selectionEnd]),
    [true, 0, original.length]);
  assert.equal(await page.getByRole('heading', { name: 'Mock response' }).count(), 1);
  assert.equal(await page.locator('main').isVisible(), false);
  if (process.env.MOCKROUTE_TEST_SHOTS) await page.screenshot({ path: process.env.MOCKROUTE_TEST_SHOTS + '/editor.png' });
  await page.mouse.click(1, 1);
  assert.equal(await page.locator('#rule-dialog').isVisible(), true);
  assert.equal(await page.locator('.rule-route').locator('#rule-url').count(), 1);
  await page.locator('#response-status-toggle').click();
  await page.locator('#http-status-menu').getByRole('option', { name: '201 Created', exact: true }).click();
  assert.equal(await page.locator('#response-status').inputValue(), '201');
  await page.locator('#response-status-toggle').click();
  await page.locator('#http-status-menu').getByRole('option', { name: '200 OK', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Increase HTTP status' }).count(), 0);
  const editor = page.locator('#rule-dialog');
  const cancelBox = await editor.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
  const saveBox = await editor.locator('#save-rule').boundingBox();
  assert.equal(cancelBox.width, saveBox.width);
  await response.fill('{}');
  await response.press('Home');
  await response.press('ArrowRight');
  await response.press('Enter');
  assert.equal(await response.inputValue(), '{\n}');
  await page.keyboard.insertText(' ');
  assert.equal(await response.inputValue(), '{\n }');
  await response.fill('{invalid');
  assert.equal(await response.getAttribute('aria-invalid'), 'true');
  await response.focus();
  await page.locator('.toast[data-key="rule-validation"]').waitFor();
  assert.equal(await page.locator('#error-body:popover-open').count(), 0);
  assert.equal(await page.locator('#error-body').textContent(), 'Response JSON must contain valid JSON.');
  assert.equal(await page.locator('#save-rule').isDisabled(), true);
  await response.fill('{"items":["updated"]}');
  assert.equal(await response.inputValue(), JSON.stringify({ items: ['updated'] }, null, 2));
  await response.fill('{"count":12}');
  await response.evaluate(input => input.setSelectionRange(input.value.indexOf('12') + 1, input.value.indexOf('12') + 1));
  await page.keyboard.insertText('3');
  assert.equal(await response.inputValue(), '{\n  "count": 132\n}');
  assert.equal(await response.evaluate(input => input.value.slice(input.selectionStart - 2, input.selectionStart)), '13');
  await response.fill('{"items":["updated"]}');
  assert.equal(await response.locator('..').locator('.json-key').textContent(), '"items"');
  await response.locator('..').getByRole('button', { name: 'Copy Response JSON' }).click();
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), await response.inputValue());
  assert.equal(await page.locator('#save-rule').isEnabled(), true);
  await page.getByRole('button', { name: 'Save and start mocking' }).click();
  await page.getByText('Rule saved. Mocking is active. Retry the request.', { exact: true }).filter({ visible: true }).waitFor();
  assert.deepEqual(config.scenarios[0].rules[0].response.body, { items: ['updated'] });
  assert.equal(await page.locator('#toggle').textContent(), 'Stop mocking');
  await page.getByRole('button', { name: 'Mock GET /api/orders' }).click();
  await response.waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Group by API' }).count(), 0);
  assert.equal(await page.locator('.rule-group-row').count(), 0);
  await page.locator('#add-rule').click();
  assert.equal(await page.getByLabel('Request URL').inputValue(), '/');
  await page.locator('#rule-dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.locator('#toggle:visible').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Rules', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#requests-view .request-table').evaluate(node => getComputedStyle(node).scrollbarWidth), 'none');
  await transferAction(page, 'clipboard', 'Mockend', 'Copy Mockend');
  await page.getByText('Flows copied.').waitFor();
  assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())), config);
  const picker = page.locator('#scenario');
  const rename = page.getByRole('button', { name: 'Rename Demo · Checkout', exact: true });
  await picker.click();
  const choice = page.getByRole('button', { name: 'Demo · Checkout', exact: true });
  assert.equal(await choice.getAttribute('title'), null);
  await choice.hover();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.styled-tooltip:popover-open').count(), 0);
  assert.equal(await choice.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
  await rename.click();
  assert.equal(await page.locator('#scenario-label').textContent(), 'Rename Flow');
  assert.equal(await picker.isVisible(), false);
  await page.getByRole('textbox', { name: 'Rename Flow' }).fill('Checkout QA');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast[data-key="scenario-status"]').getByText('Saved', { exact: true }).waitFor();
  await page.locator('#feedback').waitFor({ state: 'hidden', timeout: 5500 });
  assert.equal(await page.locator('#scenario-name').textContent(), 'Checkout QA');
  if (process.env.MOCKROUTE_TEST_SHOTS) await page.screenshot({ path: process.env.MOCKROUTE_TEST_SHOTS + '/rules.png' });
  const cards = page.locator('#rules .rule');
  assert.equal(await cards.count(), 3);
  const cart = cards.filter({ has: page.getByRole('button', { name: 'Edit Cart with items' }) });
  assert.equal(await cart.locator('.request-code').textContent(), '200');
  assert.equal(await cards.getByRole('button', { name: /^Move / }).count(), 0);
  const ruleSwitch = cart.getByRole('switch', { name: 'Enable Cart with items' });
  await ruleSwitch.uncheck();
  await cart.getByText('Off', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Enable Cart with items');
  await ruleSwitch.check();
  await cart.getByText('On', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Enable Cart with items');

  assert.ok((await cards.nth(0).boundingBox()).y < (await cards.nth(1).boundingBox()).y);
  assert.equal(await cards.first().evaluate(row => getComputedStyle(row).display), 'table-row');
  const titles = await page.locator('#scenario-label, #rules-title').evaluateAll(elements =>
    elements.map(element => ({ x: element.getBoundingClientRect().left, size: getComputedStyle(element).fontSize })));
  assert.deepEqual(titles[0], titles[1]);
  assert.equal(await page.locator('#base-url-toggle').isVisible(), false);
  await page.getByRole('button', { name: /Delete GET \/api\/orders/ }).click();
  await page.getByRole('button', { name: 'Delete rule', exact: true }).click();
  await page.locator('#rule-count').getByText('(2 / 2)', { exact: true }).waitFor();
  await page.locator('#clear-rules').click();
  const confirm = page.getByRole('dialog', { name: 'Clear all rules?' });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(config.scenarios[0].rules.length, 2);
  await page.locator('#clear-rules').click();
  await confirm.getByRole('button', { name: 'Clear rules' }).click();
  await page.getByText('No rules in this flow').waitFor();
  assert.equal(config.scenarios[0].rules.length, 0);
  assert.equal(config.scenarios[1].rules.length, 1);
  const rulesPanel = page.getByRole('region', { name: 'Rules', exact: true });
  await page.getByRole('button', { name: 'New Flow' }).click();
  await page.getByRole('textbox', { name: 'New Flow name' }).fill('New QA');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await picker.getByText('New QA').waitFor();
  assert.deepEqual(config.scenarios.find(scenario => scenario.id === config.activeScenarioId).rules, []);
  await picker.click();
  await page.getByRole('button', { name: 'Delete New QA', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Flow', exact: true }).click();
  await picker.getByText('Checkout QA').waitFor();
  await picker.click();
  await page.getByRole('button', { name: 'Demo · Empty cart', exact: true }).click();
  await picker.getByText('Demo · Empty cart').waitFor();
  await page.locator('#transfer-upload').waitFor();
  const imported = starterConfig();
  imported.scenarios = [{ ...imported.scenarios[0], name: 'Imported QA' }];
  await page.locator('#import-file').setInputFiles({
    name: 'mockroute-scenarios.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported))
  });
  await page.getByRole('button', { name: 'Replace configuration' }).click();
  const importedStatus = page.locator('.toast[data-key="scenario-file-status"]').getByText('Imported 1 flow.');
  await importedStatus.waitFor();
  assert.equal(await page.locator('#scenario-name').textContent(), 'Imported QA');
  await transferAction(page, 'clipboard', 'Mockend', 'Paste Mockend');
  await page.getByRole('textbox', { name: 'Rules JSON', exact: true }).fill(JSON.stringify([
    { ...imported.scenarios[0].rules[0], id: 'pasted-cart', name: 'Pasted cart' }
  ]));
  await page.locator('#paste-rules-dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await rulesPanel.getByRole('button', { name: 'Edit Pasted cart' }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Import rules JSON from file' }).isVisible(), false);
  await page.keyboard.press('Control+=');
  assert.equal(await page.locator('body').evaluate(body => getComputedStyle(body).zoom), '1.1');
  await page.keyboard.press('Control+-');
  assert.equal(await page.locator('body').evaluate(body => getComputedStyle(body).zoom), '1');
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+0');
  assert.equal(await page.locator('body').evaluate(body => getComputedStyle(body).zoom), '1');
  const site = await page.locator('.workspace-bar .target').boundingBox();
  const tabs = await page.locator('.workspace-bar .workspace-tabs').boundingBox();
  assert.ok(site.x + site.width <= tabs.x);
  const motion = await page.locator('nav.workspace-tabs').evaluate(nav => {
    nav.querySelector('[data-view="requests"]').click();
    return {
      indicator: getComputedStyle(nav, '::before').transitionProperty,
      pane: document.querySelector('#requests-view').getAnimations()[0]?.effect.getKeyframes()[0].transform
    };
  });
  assert.deepEqual(motion, { indicator: 'none', pane: undefined });
  assert.equal(await page.getByRole('button', { name: 'Activity', exact: true }).count(), 0);
  assert.equal(await page.getByText('Imported 1 flow.').filter({ visible: true }).count(), 0);
  assert.equal(await page.locator('#scenario-file-status').isVisible(), false);
  assert.equal(await page.locator('#record-toggle').evaluate(button => getComputedStyle(button, '::before').animationName), 'status-blink');
  assert.deepEqual(await page.locator('#record-toggle').evaluate(button => {
    const dot = getComputedStyle(button, '::before');
    return [dot.display, dot.backgroundColor, dot.width];
  }), ['block', 'rgb(229, 73, 82)', '4px']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#record-toggle').evaluate(button => getComputedStyle(button, '::before').animationName), 'none');
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  assert.equal(await page.locator('#requests-view').evaluate(pane => pane.getAnimations().length), 0);
  await page.setViewportSize({ width: 320, height: 640 });
  const header = await page.locator('.request-brand').boundingBox();
  const actions = await page.locator('.capture-controls').boundingBox();
  assert.ok(actions.y < header.y + header.height && header.x + header.width <= actions.x + 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#request-query').evaluate(input => getComputedStyle(input).borderTopWidth), '0px');
  await page.locator('#filter-toggle').click();
  assert.equal(await page.locator('#request-filter-tree').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await optionSearch.press('Escape');
  const recorder = page.locator('#record-toggle');
  const recordingStyle = () => recorder.evaluate(button => ({
    background: getComputedStyle(button).backgroundColor,
    shape: getComputedStyle(button.querySelector('path')).d
  }));
  assert.equal(await page.locator('.capture-controls #toggle').count(), 1);
  assert.equal(await recorder.getAttribute('data-state'), 'recording');
  const stopStyle = await recordingStyle();
  assert.equal(stopStyle.background, 'rgb(32, 30, 26)');
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByText('Recording paused').waitFor();
  assert.equal(await recorder.getAttribute('data-state'), 'stopped');
  await page.mouse.move(0, 0);
  const startStyle = await recordingStyle();
  assert.equal(startStyle.background, 'rgb(230, 218, 196)');
  assert.notEqual(startStyle.shape, stopStyle.shape);
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByText('Recording active tab').waitFor();
  await query.fill('');
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByRole('button', { name: 'View GET /external' }).waitFor();
  assert.equal(await rows.count(), 1);
  await page.locator('#base-url-toggle').click();
  const baseMenu = page.locator('#base-url-menu');
  const selectAllBases = baseMenu.getByRole('checkbox', { name: 'Select all', exact: true });
  assert.ok((await selectAllBases.boundingBox()).y < (await baseMenu.getByRole('checkbox', { name: /^Current Base URL/ }).boundingBox()).y);
  await selectAllBases.check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'View GET /related' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Add URL to filter', exact: true }).click();
  assert.equal(await rows.count(), 1);
  assert.ok(await rows.getByText('related', { exact: true }).isVisible());
  await page.locator('#base-url-toggle').click();
  assert.equal(await baseMenu.getByRole('checkbox', { name: 'https://api-other.test', exact: true }).isChecked(), true);
  await baseMenu.getByRole('checkbox', { name: /^Current Base URL/ }).check();
  assert.equal(await rows.count(), 2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mock GET /related' }).click();
  const dots = responsePane.getByRole('button', { name: /^Expand folded lines 4–/ });
  await dots.waitFor();
  await dots.click();
  await response.waitFor();
  await page.keyboard.press('Escape');
  await query.fill('/related');
  await page.locator('#clear-requests').click();
  assert.equal(await rows.count(), 0);
  await page.getByRole('button', { name: 'Clear request search' }).click();
  assert.equal(await rows.count(), 1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-site', { detail: 'https://example.test/' })));
  await page.getByRole('button', { name: 'View GET /logo.png' }).waitFor();
  assert.equal(await rows.count(), 3);
  await page.getByRole('button', { name: 'Search URLs only' }).click();
  await query.fill('"order":3');
  assert.equal(await rows.count(), 0);
  await page.getByRole('button', { name: 'Regex search' }).click();
  await query.fill('/api/orders');
  assert.equal(await rows.count(), 2);
  await page.waitForFunction(async () => {
    const request = indexedDB.open('mockend-requests', 1);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    try {
      const read = database.transaction('views').objectStore('views').get('https://example.test');
      const view = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = reject; });
      return view?.query === '/api/orders' && view.regex && view.urlOnly;
    } finally { database.close(); }
  });
  await page.reload();
  await page.getByRole('button', { name: 'View POST /api/orders' }).waitFor();
  assert.equal(await query.inputValue(), '/api/orders');
  assert.equal(await page.getByRole('button', { name: 'Search URLs only' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), 2);
  await page.getByRole('button', { name: 'Mock Flow', exact: true }).click();
  const scenarioName = page.getByRole('textbox', { name: 'Rename Flow' });
  await scenarioName.fill('Recorded QA');
  await page.locator('#scenario-form').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#scenario-name').getByText('Recorded QA').waitFor();
  assert.equal(config.scenarios.find(scenario => scenario.id === config.activeScenarioId).rules.length, 2);
  await transferAction(page, 'clipboard', 'Postman', 'Copy Postman Mocks');
  await page.getByText('Postman mock copied.').waitFor();
  const postmanMock = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(postmanMock, /postman mock run/);
  await transferAction(page, 'clipboard', 'Postman', 'Paste Postman');
  await page.getByLabel('Postman mock, collection, or OpenAPI JSON').fill(postmanMock);
  await page.locator('#paste-postman-mock-dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await scenarioName.waitFor();
  assert.equal(await scenarioName.inputValue(), 'Recorded QA');
  await page.locator('#scenario-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(errors, []);
});

test('the VS Code webview uses the Requests panel with independent recording and mocking controls', async t => {
  const { page, origin } = await panelFixture(t, 'vscode');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const tab = { title: 'Integrated test browser', url: 'https://example.test/' };
  let available = null;
  let active = null;
  let recordedAddress;
  const config = starterConfig();
  await page.exposeFunction('mockVsCode', ({ id, action, data }) => {
    const events = [];
    if (action === 'recording') {
      if (data.type === 'sync') events.push({ type: 'reset', tab: null }, { type: 'status', status: 'stopped' });
      if (data.type === 'start') {
        recordedAddress = data.url;
        available = tab;
        events.push({ type: 'reset', tab }, { type: 'status', status: 'recording' }, {
          type: 'request',
          row: { id: 1, _resourceType: 'Fetch', request: { url: tab.url + 'api/cart', method: 'GET' },
            response: { status: 200, content: { mimeType: 'application/json' } } }
        });
      }
      if (data.type === 'body') events.push({ type: 'body', token: data.token, body: { text: '{"items":[]}' } });
      return { events, reply: { id, value: true } };
    }
    if (action === 'start' && (data.url?.trim() || available)) active = tab;
    if (action === 'stop') {
      assert.equal(data.keepBrowser, true);
      active = null;
    }
    return { events, reply: { id, value: { config, revision: 0, connection: { active, available } } } };
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({
      async postMessage(message) {
        const result = await window.mockVsCode(message);
        for (const recording of result.events) window.dispatchEvent(new MessageEvent('message', { data: { recording } }));
        window.dispatchEvent(new MessageEvent('message', { data: result.reply }));
      }
    });
  });
  await page.goto(`${origin}/panel.html`);
  assert.deepEqual(await page.locator('nav.workspace-tabs button').allTextContents(), ['Requests', 'Rules', 'Settings']);
  await page.locator('#app-field').waitFor({ state: 'visible' });
  for (const width of [320, 620, 1024]) {
    await page.setViewportSize({ width, height: 760 });
    const input = await page.locator('#app-url').boundingBox();
    const tabs = await page.locator('nav.workspace-tabs').boundingBox();
    assert.ok(Math.abs(input.y + input.height / 2 - tabs.y - tabs.height / 2) < 2, JSON.stringify({ width, input, tabs }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 620, height: 760 });
  await page.getByRole('button', { name: 'Start mocking' }).click();
  assert.equal(await page.getByRole('button', { name: 'Start mocking' }).isEnabled(), true);
  assert.equal(await page.getByText('Mocking is active in the integrated test browser.', { exact: true }).isVisible(), false);
  await page.locator('#app-url').fill('example.test');
  await page.getByRole('button', { name: 'Start recording' }).click();
  const endpoint = page.getByRole('button', { name: 'View GET /api/cart' });
  await endpoint.click();
  await page.locator('#response-detail-body').getByText('"items"', { exact: true }).waitFor();
  assert.equal(recordedAddress, 'example.test');
  await page.getByRole('button', { name: 'Close request details' }).click();
  await page.locator('#filter-toggle').hover();
  await page.locator('#request-filter-tree').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#request-facets summary').filter({ hasText: 'Endpoint' }).count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('#endpoint-scope-toggle').hover();
  await page.locator('#endpoint-scope-menu').getByRole('checkbox', { name: 'cart', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('nav.workspace-tabs').evaluate(node => getComputedStyle(node).gap), '0px');
  await page.getByRole('button', { name: 'Mock GET /api/cart' }).click();
  await page.getByRole('button', { name: 'Save and start mocking' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Start mocking' }).click();
  await page.getByRole('button', { name: 'Stop mocking' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await endpoint.waitFor();
  assert.deepEqual(errors, []);
});

test('app profiles isolate requests and Envs, expose mapped URLs, and split/merge through the shared UI', async t => {
  const { Controller } = await import('../src/core/controller.mjs');
  const { page, origin } = await panelFixture(t, 'vscode');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const tab = { title: 'App browser', url: 'https://app.example.test/' };
  const stored = new Map([['mockroute.configuration.v1', starterConfig()]]);
  const controller = new Controller({ storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)) },
    platform: { state: async () => ({ mode: 'vscode', available: tab, active: null }), stop: async () => {}, start: async () => {} } });
  let backup;
  const appActions = [];
  await page.exposeFunction('mockVsCode', async ({ id, action, data }) => {
    appActions.push(action);
    let value = true;
    const events = [];
    try {
      if (action === 'recording') {
        if (data.type === 'sync') events.push({ type: 'reset', tab }, { type: 'status', status: 'stopped' });
        if (data.type === 'stop') events.push({ type: 'status', status: 'stopped' });
      } else if (action === 'download') backup = JSON.parse(data.text);
      else if (action === 'open-app') value = await controller.dispatch('state');
      else value = await controller.dispatch(action, data);
      return { events, reply: { id, value } };
    } catch (error) { return { events, reply: { id, error: error.message } }; }
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ async postMessage(message) {
      const result = await window.mockVsCode(message);
      for (const recording of result.events) window.dispatchEvent(new MessageEvent('message', { data: { recording } }));
      window.dispatchEvent(new MessageEvent('message', { data: result.reply }));
    } });
  });
  await page.goto(`${origin}/panel.html`);
  const apps = page.getByRole('combobox', { name: 'App / profile', exact: true });
  const manager = page.getByRole('dialog', { name: 'Manage apps', exact: true });
  const manage = async action => {
    if (!await manager.isVisible()) await apps.selectOption('@manage');
    await manager.locator(`[data-application-action="${action}"]`).click();
  };
  await page.waitForFunction(() => document.querySelector('#application').value === 'default' && document.querySelector('#mock-environment').options.length > 1);
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    for (const id of ['transfer-clipboard', 'transfer-download', 'transfer-upload']) {
      const centered = await page.locator(`#${id}`).evaluate(node => {
        const button = node.getBoundingClientRect();
        const glyph = node.querySelector('svg, .transfer-symbol').getBoundingClientRect();
        return [Math.abs(button.y + button.height / 2 - glyph.y - glyph.height / 2), Math.abs(button.x + button.width / 2 - glyph.x - glyph.width / 2)];
      });
      assert.ok(centered[0] <= 0.5, `${id} vertical ${centered[0]}`);
      if (width === 360) assert.ok(centered[1] <= 0.5, `${id} horizontal ${centered[1]}`);
    }
  }
  const nav = page.locator('nav.workspace-tabs');
  assert.equal(await nav.evaluate(node => getComputedStyle(node, '::before').display), 'block');
  await page.getByRole('button', { name: 'Requests', exact: true }).hover();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.getByRole('button', { name: 'Settings', exact: true }).hover();
  const transitions = await nav.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSTransition).map(animation => animation.effect.getTiming().duration));
  assert.ok(transitions.includes(150), JSON.stringify({ transitions, style: await nav.evaluate(node => ({ left: getComputedStyle(node, '::before').left, transition: getComputedStyle(node, '::before').transition, pointer: node.hasAttribute('data-pointer-motion') })) }));
  assert.equal(await page.getByRole('button', { name: 'Requests', exact: true }).getAttribute('aria-current'), 'page');
  await page.waitForFunction(() => {
    const nav = document.querySelector('nav.workspace-tabs');
    return Math.abs(parseFloat(getComputedStyle(nav, '::before').left) - nav.querySelector('[data-view="settings"]').offsetLeft) <= 1;
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await nav.evaluate(node => getComputedStyle(node, '::before').transitionProperty), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 620, height: 760 });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { recording: { type: 'request', row: {
    id: 1, _resourceType: 'Fetch', request: { url: 'https://app.example.test/api/profile', method: 'GET' }, response: { status: 200, content: { mimeType: 'application/json' } }
  } } } })));
  await page.getByRole('button', { name: 'View GET /api/profile', exact: true }).waitFor();
  assert.deepEqual(await apps.locator('option').allTextContents(), ['My App', 'Manage apps…']);
  await manage('@new');
  assert.equal(await page.getByLabel('App name (required)', { exact: true }).getAttribute('aria-invalid'), null);
  await page.getByRole('button', { name: 'Save app', exact: true }).click();
  assert.equal(await page.getByLabel('App name (required)', { exact: true }).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.getByLabel('App name (required)', { exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal((await controller.dispatch('state')).applications.length, 1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector('#managed-application'));
  await manage('@new');
  await page.getByLabel('App name (required)', { exact: true }).fill('Second app');
  assert.equal(await page.locator('#application-form').evaluate(form => form.checkValidity()), true);
  await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/application-create.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Save app', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#application').value !== 'default');
  assert.deepEqual(errors, []);
  assert.ok(appActions.includes('application-create'), appActions.join(', '));
  assert.equal((await controller.dispatch('state')).applications.length, 2);
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#request-rows tr').length === 0);
  assert.equal((await controller.dispatch('state')).config.scenarios[0].rules.length, 0);
  await apps.selectOption('default');
  await page.getByRole('button', { name: 'View GET /api/profile', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: '+ New environment', exact: true }).click();
  await page.getByLabel('Env name (required)', { exact: true }).fill('DEV');
  await page.locator('#environment-form').getByLabel('Base URL (required)', { exact: true }).fill('https://dev.example.test');
  await page.getByRole('button', { name: 'Save Env', exact: true }).click();
  const dev = (await controller.dispatch('state')).config.environments.find(env => env.name === 'DEV');
  await page.getByRole('combobox', { name: 'Env', exact: true }).selectOption(dev.id);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Cart with items', exact: true }).click();
  assert.equal(await page.getByLabel('Request URL', { exact: true }).inputValue(), '/api/cart');
  assert.equal(await page.getByRole('combobox', { name: 'Mapped base URL', exact: true }).count(), 0);
  assert.deepEqual(dev.baseUrls, ['https://dev.example.test', 'https://app.example.test']);
  assert.match(await page.locator('#rule-environment-preview').textContent(), /https:\/\/dev.example.test\/api\/cart/);
  await page.locator('#rule-environment-scope').click();
  const envOptions = page.getByRole('group', { name: 'Rule Envs', exact: true });
  await envOptions.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  assert.match(await page.locator('#rule-environment-preview').textContent(), /http:\/\/127.0.0.1:4319\/api\/cart/);
  assert.equal(await page.locator('#rule-environment-scope').getAttribute('value'), 'all');
  await page.keyboard.press('Escape');
  await page.locator('#rule-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await manage('@split');
  await page.getByLabel('App name (required)', { exact: true }).fill('DEV app');
  await page.locator('#application-envs').getByRole('checkbox', { name: /DEV/ }).check();
  await page.getByRole('button', { name: 'Save app', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#application option:checked').textContent === 'DEV app');
  const split = await controller.dispatch('state');
  assert.deepEqual(split.config.environments.map(env => env.name), ['DEV']);
  await manage('@merge');
  await page.getByRole('combobox', { name: 'Merge into app', exact: true }).selectOption('default');
  await page.getByRole('button', { name: 'Save app', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#application').value === 'default');
  assert.equal((await controller.dispatch('state')).config.environments.length, 2);
  assert.equal((await controller.dispatch('state')).config.scenarios.length, 6);
  await manage('@export');
  await page.waitForTimeout(50);
  assert.equal(backup.applications.length, 2);
  await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/manage-apps.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
});
