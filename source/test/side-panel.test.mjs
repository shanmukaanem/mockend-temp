import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { starterConfig } from '../src/core/config.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('the side panel starts recording, filters requests and opens a selected response', async t => {
  const directory = resolve(import.meta.dirname, '../build/chromium');
  const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png' };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    try {
      const bytes = await readFile(resolve(directory, '.' + pathname));
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

  await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
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
  const scroll = await page.locator('.request-table').evaluate(table => {
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
  assert.deepEqual(actionsLayout, { aligned: true, height: 47 });
  const typeHeader = page.getByRole('columnheader', { name: 'Type' });
  await typeHeader.getByRole('button').click();
  assert.deepEqual(await rows.locator('.type-badge').allTextContents(), ['Fetch/XHR', 'Fetch/XHR', 'Mocked', 'Image']);
  const endpointHeader = page.getByRole('columnheader', { name: 'Endpoint' });
  const endpointBox = await endpointHeader.boundingBox();
  await page.mouse.click(endpointBox.x + endpointBox.width - 2, endpointBox.y + 2);
  assert.equal(await endpointHeader.getAttribute('aria-sort'), 'ascending');
  const statusHeader = page.getByRole('columnheader', { name: 'Status' });
  const tableBox = await page.locator('.request-table table').boundingBox();
  const actionsBox = await page.getByRole('columnheader', { name: 'Actions' }).boundingBox();
  assert.ok(Math.abs(actionsBox.x + actionsBox.width - tableBox.x - tableBox.width) < 1);
  for (const width of [320, 400, 588, 870]) {
    await page.setViewportSize({ width, height: 760 });
    assert.ok((await endpointHeader.boundingBox()).width >= 95);
  }
  await page.setViewportSize({ width: 620, height: 760 });
  const statusBox = await statusHeader.boundingBox();
  await page.mouse.click(statusBox.x + statusBox.width - 2, statusBox.y + statusBox.height - 2);
  assert.deepEqual(await rows.locator('.request-code').allTextContents(), ['200', '304', '404']);
  await page.getByRole('button', { name: 'Status', exact: true }).press('Enter');
  assert.deepEqual(await rows.locator('.request-code').allTextContents(), ['404', '304', '200']);
  await page.getByRole('button', { name: 'Regex search' }).click();
  await page.getByLabel('Search requests and responses').fill('[invalid');
  await page.locator('#request-query-error').waitFor();
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
  const pillLayout = () => page.locator('.request-table, #clear-filters').evaluateAll(items =>
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
    ['Add GET to filter', 'Add Fetch/XHR to filter', 'Add Mocked to filter', 'Add 200 to filter', 'Add URL to filter']);
  await page.getByRole('button', { name: 'Add URL to filter', exact: true }).click();
  await page.locator('#filter-toggle').click();
  const removeUrl = page.getByRole('button', { name: /^Remove url filter / });
  await removeUrl.click();
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
  assert.equal(downloaded.suggestedFilename(), 'mockroute.postman_collection.json');
  assert.deepEqual(JSON.parse(await readFile(await downloaded.path(), 'utf8')), collection);
  await page.getByRole('button', { name: 'Copy cURL for POST /api/orders' }).click();
  await page.getByText('cURL command copied.', { exact: true }).waitFor();
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
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '{\n  "message": "missing"\n}');
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
    assert.equal(bounds[0].height, 26);
    assert.ok(bounds[1].width > 35);
    assert.ok(bounds.at(-1).x + bounds.at(-1).width < width);
  }
  await page.setViewportSize(viewport);
  await methodPicker.click();
  await page.getByRole('option', { name: 'PATCH', exact: true }).click();
  assert.equal(await methodPicker.inputValue(), 'PATCH');
  assert.deepEqual(await methodPicker.locator('option').allTextContents(),
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  await methodPicker.selectOption('OPTIONS');
  assert.equal(await methodPicker.evaluate(node => node.title || node.dataset.tooltip), 'OPTIONS');
  assert.equal(await methodPicker.evaluate(select => {
    const content = select.querySelector('selectedcontent');
    return content.textContent === 'OPTIONS' && content.scrollWidth <= content.clientWidth;
  }), true);
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
  assert.deepEqual([...new Set(parameterHeights)], [26]);
  assert.equal(await page.locator('#rule-request-tab').evaluate(node => getComputedStyle(node).boxShadow), 'none');
  await page.locator('#rule-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#rule-dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('Search requests and responses').fill('mode=qa');
  assert.equal(await rows.count(), 1);
  assert.equal(await page.locator('.request-table').evaluate(container => container.clientHeight - container.querySelector('table').offsetHeight), 0);
  if (process.env.MOCKROUTE_TEST_SHOTS) await page.screenshot({ path: process.env.MOCKROUTE_TEST_SHOTS + '/requests.png' });
  await rows.first().locator('.request-mock').click();
  const response = page.getByLabel('Response JSON', { exact: true });
  const responsePane = page.locator('#body-field .code-pane');
  await response.waitFor();
  assert.equal(await responsePane.locator('.fold-ellipsis').count(), 0);
  await responsePane.getByRole('button', { name: 'Collapse lines 2–4' }).click();
  assert.equal(await responsePane.locator('.code-gutter').textContent(), '1\n2\n5');
  await responsePane.getByRole('button', { name: 'Copy Response JSON' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), original);
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
  const heights = await page.locator('.response-controls :is(select[name="kind"], input[type="number"])')
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
  await page.getByRole('button', { name: 'Increase HTTP status' }).click();
  assert.equal(await page.getByLabel('HTTP status', { exact: true }).inputValue(), '201');
  await page.getByRole('button', { name: 'Decrease HTTP status' }).click();
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
  await page.locator('#error-body:popover-open').waitFor();
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
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await response.inputValue());
  assert.equal(await page.locator('#save-rule').isEnabled(), true);
  await page.getByRole('button', { name: 'Save and start mocking' }).click();
  await page.getByText('Rule saved. Mocking is active. Retry the request.', { exact: true }).filter({ visible: true }).waitFor();
  assert.deepEqual(config.scenarios[0].rules[0].response.body, { items: ['updated'] });
  assert.equal(await page.locator('#toggle').textContent(), 'Stop mocking');
  await page.getByRole('button', { name: 'Mock GET /api/orders' }).click();
  await response.waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const groupButton = page.getByRole('button', { name: 'Group by API' });
  await groupButton.click();
  assert.ok(await page.locator('.rule-group').count());
  await groupButton.click();
  await page.locator('#add-rule').click();
  assert.equal(await page.getByLabel('Request URL').inputValue(), 'https://example.test/');
  await page.locator('#rule-dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.locator('#toggle:visible').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Rules', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.request-table').evaluate(node => getComputedStyle(node).scrollbarWidth), 'thin');
  await page.getByRole('button', { name: 'Copy scenarios' }).click();
  await page.getByText('Scenarios copied.').waitFor();
  assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())), config);
  const picker = page.locator('#scenario');
  const rename = page.getByRole('button', { name: 'Rename Demo · Checkout', exact: true });
  await picker.click();
  const choice = page.getByRole('button', { name: 'Demo · Checkout', exact: true });
  assert.equal(await choice.getAttribute('title'), 'Demo · Checkout');
  assert.equal(await choice.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
  await rename.click();
  assert.equal(await page.locator('#scenario-label').textContent(), 'Rename scenario');
  assert.equal(await picker.isVisible(), false);
  await page.getByRole('textbox', { name: 'Rename scenario' }).fill('Checkout QA');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#scenario-status').getByText('Saved').waitFor();
  await page.locator('#feedback').waitFor({ state: 'hidden', timeout: 5500 });
  assert.equal(await page.locator('#scenario-name').textContent(), 'Checkout QA');
  if (process.env.MOCKROUTE_TEST_SHOTS) await page.screenshot({ path: process.env.MOCKROUTE_TEST_SHOTS + '/rules.png' });
  const cards = page.locator('#rules .rule');
  assert.equal(await cards.count(), 3);
  const cart = cards.filter({ has: page.getByRole('button', { name: 'Edit Cart with items' }) });
  assert.equal(await cart.locator('.rule-endpoint .request-code').textContent(), '200');
  assert.equal(await cards.getByRole('button', { name: /^Move / }).count(), 0);
  const ruleSwitch = cart.getByRole('switch', { name: 'Enable Cart with items' });
  await ruleSwitch.uncheck();
  await cart.getByText('Off', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Enable Cart with items');
  await ruleSwitch.check();
  await cart.getByText('On', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Enable Cart with items');

  assert.equal((await cards.nth(0).boundingBox()).y, (await cards.nth(1).boundingBox()).y);
  assert.equal(await cards.first().evaluate(card => getComputedStyle(card).backgroundColor), 'rgb(255, 250, 240)');
  const titles = await page.locator('#scenario-label, #rules-title').evaluateAll(elements =>
    elements.map(element => ({ x: element.getBoundingClientRect().left, size: getComputedStyle(element).fontSize })));
  assert.deepEqual(titles[0], titles[1]);
  assert.equal(await page.locator('#base-url-toggle').isVisible(), false);
  await page.getByRole('button', { name: /Delete GET \/api\/orders/ }).click();
  await page.getByRole('button', { name: 'Delete rule', exact: true }).click();
  await page.locator('#rule-count').getByText('(2)', { exact: true }).waitFor();
  await page.locator('#clear-rules').click();
  const confirm = page.getByRole('dialog', { name: 'Clear all rules?' });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(config.scenarios[0].rules.length, 2);
  await page.locator('#clear-rules').click();
  await confirm.getByRole('button', { name: 'Clear rules' }).click();
  await page.getByText('No rules in this scenario').waitFor();
  assert.equal(config.scenarios[0].rules.length, 0);
  assert.equal(config.scenarios[1].rules.length, 1);
  const rulesPanel = page.getByRole('region', { name: 'Rules', exact: true });
  await rulesPanel.getByRole('button', { name: 'New scenario' }).click();
  await page.getByRole('textbox', { name: 'New scenario name' }).fill('New QA');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await picker.getByText('New QA').waitFor();
  assert.deepEqual(config.scenarios.find(scenario => scenario.id === config.activeScenarioId).rules, []);
  await picker.click();
  await page.getByRole('button', { name: 'Delete New QA', exact: true }).click();
  await page.getByRole('button', { name: 'Delete scenario', exact: true }).click();
  await picker.getByText('Checkout QA').waitFor();
  await picker.click();
  await page.getByRole('button', { name: 'Demo · Empty cart', exact: true }).click();
  await picker.getByText('Demo · Empty cart').waitFor();
  await rulesPanel.getByRole('button', { name: 'Import rules JSON from file' }).waitFor();
  const imported = starterConfig();
  imported.scenarios = [{ ...imported.scenarios[0], name: 'Imported QA' }];
  await page.locator('#import-file').setInputFiles({
    name: 'mockroute-scenarios.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported))
  });
  await page.getByRole('button', { name: 'Replace configuration' }).click();
  const importedStatus = page.locator('#scenario-file-status').getByText('Imported 1 scenario.');
  await importedStatus.waitFor();
  assert.equal(await page.locator('#scenario-name').textContent(), 'Imported QA');
  await rulesPanel.getByRole('button', { name: 'Paste rules JSON' }).click();
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
  assert.deepEqual(motion, { indicator: 'transform', pane: 'translateX(-12px)' });
  assert.equal(await page.getByRole('button', { name: 'Activity', exact: true }).count(), 0);
  assert.equal(await page.getByText('Imported 1 scenario.').filter({ visible: true }).count(), 0);
  await page.waitForFunction(() => document.querySelector('#scenario-file-status').textContent === '');
  assert.equal(await page.locator('#record-toggle').evaluate(button => getComputedStyle(button, '::before').animationName), 'status-blink');
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
  const dot = () => recorder.evaluate(button => getComputedStyle(button, '::before').backgroundColor);
  assert.equal(await page.locator('.capture-controls #toggle').count(), 1);
  assert.equal(await recorder.getAttribute('data-state'), 'recording');
  assert.equal(await dot(), 'rgb(192, 47, 61)');
  await page.getByRole('button', { name: 'Pause recording' }).click();
  await page.getByText('Recording paused').waitFor();
  assert.equal(await recorder.getAttribute('data-state'), 'stopped');
  assert.equal(await dot(), 'rgb(132, 119, 106)');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByText('Recording active tab').waitFor();
  await query.fill('');
  await page.getByRole('button', { name: 'Pause recording' }).click();
  await page.getByRole('button', { name: 'View GET /external' }).waitFor();
  assert.equal(await rows.count(), 1);
  await page.locator('#base-url-toggle').click();
  const baseMenu = page.locator('#base-url-menu');
  const selectAllBases = baseMenu.getByRole('checkbox', { name: 'Select all', exact: true });
  assert.ok((await selectAllBases.boundingBox()).y < (await baseMenu.getByRole('checkbox', { name: /^Current Base URL/ }).boundingBox()).y);
  await baseMenu.getByRole('checkbox', { name: 'https://api-other.test', exact: true }).check();
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
  await page.reload();
  await page.getByRole('button', { name: 'View POST /api/orders' }).waitFor();
  assert.equal(await query.inputValue(), '/api/orders');
  assert.equal(await page.getByRole('button', { name: 'Search URLs only' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), 2);
  await page.getByRole('button', { name: 'Mock Scenario', exact: true }).click();
  const scenarioName = page.getByRole('textbox', { name: 'Rename scenario' });
  await scenarioName.fill('Recorded QA');
  await page.locator('#scenario-form').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#scenario-name').getByText('Recorded QA').waitFor();
  assert.equal(config.scenarios.find(scenario => scenario.id === config.activeScenarioId).rules.length, 2);
  await page.getByRole('button', { name: 'Copy Postman mock' }).click();
  await page.getByText('Postman mock copied.').waitFor();
  const postmanMock = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(postmanMock, /postman mock run/);
  await page.getByRole('button', { name: 'Paste Postman mock' }).click();
  await page.getByLabel('Mockend-exported script or Postman collection JSON').fill(postmanMock);
  await page.locator('#paste-postman-mock-dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await scenarioName.waitFor();
  assert.equal(await scenarioName.inputValue(), 'Recorded QA');
  await page.locator('#scenario-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(errors, []);
});
