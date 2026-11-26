import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureResponse, captureScenario } from '../src/chromium/capture.mjs';
import { postmanMockScript, readPostmanMock } from '../src/chromium/postman-mock.mjs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import { starterConfig, validateConfig } from '../src/core/config.mjs';
import { responseFor, ruleBelongsToSite, selectRule } from '../src/core/matcher.mjs';

function entry(status, mimeType = 'application/json') {
  return {
    request: { method: 'POST', url: 'https://api.example.test/orders?mode=qa' },
    response: { status, headers: [{ name: 'Content-Type', value: mimeType }] }
  };
}

test('recorded scenarios choose the latest API response per method and endpoint', async () => {
  const older = { ...entry(200), _resourceType: 'XHR' };
  const latest = { ...entry(201), _resourceType: 'Fetch' };
  latest.request.url += '&page=2';
  latest.request.postData = { text: '{"recorded":true}' };
  const image = { ...entry(200, 'image/png'), _resourceType: 'Image' };
  const reads = [];
  const { rules, skipped } = await captureScenario([{ entry: latest, id: 3 }, { entry: older, id: 1 }, { entry: image, id: 4 }],
    async row => { reads.push(row); return ['{"latest":true}']; });
  assert.deepEqual(reads, [latest]);
  assert.equal(skipped, 0);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].endpointOnly, true);
  assert.equal(rules[0].requestBody, undefined);
  assert.equal(rules[0].response.status, 201);
  assert.deepEqual(rules[0].response.body, { latest: true });
});

test('an exported Postman script round-trips and serves its mock over HTTP', async t => {
  const scenario = starterConfig().scenarios[0];
  const script = postmanMockScript(scenario);
  assert.deepEqual(readPostmanMock(script), scenario);
  const module = { exports: {} };
  runInNewContext(script, { require: createRequire(import.meta.url), module, URL, Buffer, setTimeout });
  const server = module.exports;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/cart')).status, 200);
  assert.equal((await fetch(base + '/api/coupon', { method: 'POST', body: '{"coupon":"EXPIRED"}' })).status, 422);
  assert.equal((await fetch(base + '/api/coupon', { method: 'POST', body: '{"coupon":"OTHER"}' })).status, 404);
});

test('Postman handler accepts a plain request body and import accepts wrapped collections', async () => {
  const collection = { info: { name: 'Mock API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Order', request: { method: 'POST', url: '{{mockUrl}}/order', body: { mode: 'raw', raw: '{"id":7}' } },
      response: [{ code: 777, body: 'Matched' }] }] };
  const scenario = readPostmanMock(JSON.stringify({ collection }), 'https://example.test/app');
  assert.equal(scenario.rules[0].url, 'https://example.test/order');
  let handler;
  const script = postmanMockScript(scenario);
  runInNewContext(script, { URL, pm: {}, setTimeout, require: name => {
    assert.equal(name, 'http');
    return { createServer: fn => { handler = fn; } };
  } });
  let status, body;
  await handler({ method: 'POST', url: '/order', body: { id: 7 }, headers: {} }, {
    writeHead: value => { status = value; },
    end: value => { body = value; }
  });
  assert.equal(status, 777);
  assert.equal(body, 'Matched');
  assert.deepEqual(readPostmanMock('```javascript\n' + script + '\n```'), scenario);
});

test('captured JSON formats the response for editing and uses the original status and URL', () => {
  const text = '{ "items": [] }\n';
  const capture = captureResponse(entry(422), text);
  assert.equal(capture.text, JSON.stringify(JSON.parse(text), null, 2));
  assert.equal(capture.rule.url, 'https://api.example.test/orders?mode=qa');
  assert.equal(capture.rule.method, 'POST');
  assert.deepEqual(capture.rule.response, { kind: 'json', status: 422, headers: { 'content-type': 'application/json' } });
});

test('captured UTF-8 text can be saved and replayed without adding JSON quotes', () => {
  const text = '  नमस्ते 🎧\n';
  const captured = captureResponse(entry(200, 'text/plain; charset=utf-8'), Buffer.from(text).toString('base64'), 'base64');
  const config = starterConfig();
  config.scenarios[0].rules.unshift({
    ...captured.rule, enabled: true, id: 'captured',
    response: { ...captured.rule.response, delayMs: 0, cors: false, body: captured.text }
  });
  const [rule] = validateConfig(config).scenarios[0].rules;
  const response = responseFor({ rule, preflight: false }, { method: rule.method, headers: {} });
  assert.equal(rule.response.kind, 'text');
  assert.equal(response.body, text);
});

test('bodyless responses preserve status and binary or missing bodies report an error', () => {
  assert.equal(captureResponse(entry(204)).rule.response.status, 204);
  assert.throws(() => captureResponse(entry(200, 'image/png'), 'AA==', 'base64'), /binary/);
  assert.throws(() => captureResponse(entry(200)), /did not retain/);
});

test('captured API rules match Fetch and XHR with the same query and JSON payload', async () => {
  const request = entry(200);
  request.request.url = 'https://api.example.test/orders?tag=one&mode=qa&tag=two';
  request.request.postData = { text: '{"items":[1,2],"customer":{"id":7}}' };
  request._resourceType = 'fetch';
  const { rule } = captureResponse(request, '{}', undefined, 'https://app.example.test/');
  assert.equal(rule.response.cors, true);
  assert.equal(rule.url, request.request.url);
  const enabled = { ...rule, enabled: true, site: 'app.example.test' };
  const event = {
    resourceType: 'Fetch',
    request: { method: 'POST', url: 'https://api.example.test/orders?mode=qa&tag=one&tag=two' }
  };
  const body = async () => '{"customer":{"id":7},"items":[1,2]}';
  assert.equal((await selectRule([enabled], event, body)).rule, enabled);
  assert.equal((await selectRule([enabled], { ...event, resourceType: 'XHR' }, body)).rule, enabled);
  assert.equal(await selectRule([enabled], { ...event, resourceType: 'Image' }, body), null);
  assert.equal(await selectRule([enabled], event, async () => '{"items":[1,2],"customer":{"id":7,"extra":true}}'), null);
  event.request.url = event.request.url.replace('mode=qa', 'mode=prod');
  assert.equal(await selectRule([enabled], event, body), null);
  assert.equal(ruleBelongsToSite(enabled, 'app.example.test'), true);
  assert.equal(ruleBelongsToSite(enabled, 'api.example.test'), false);
  assert.equal(ruleBelongsToSite(rule, 'api.example.test'), true);
});

test('Postman export preserves URLs and bodies and omits credential headers', async () => {
  const { postmanCollection } = await import('../src/chromium/postman.mjs');
  const request = entry(200);
  request.request.headers = [{ name: 'Authorization', value: 'secret' }, { name: 'Accept', value: 'application/json' }];
  request.request.postData = { text: '{"ok":true}' };
  const collection = postmanCollection([request]);
  assert.match(collection.info.schema, /v2\.1\.0/);
  assert.equal(collection.item[0].request.url, request.request.url);
  assert.deepEqual(collection.item[0].request.header, [{ key: 'Accept', value: 'application/json' }]);
  assert.equal(collection.item[0].request.body.raw, '{\n  "ok": true\n}');
});


test('partial request search accepts case-insensitive fragments and decoded query values', async () => {
  const { compileSearch, requestMatches, requestSearchText } = await import('../src/chromium/request-filters.mjs');
  const text = requestSearchText('https://qecore.github.io/api/orders?city=S%C3%A3o%20Paulo');
  const values = ['Fetch', 'GET', 2, 'qecore.github.io'];
  const filters = [new Set(['Fetch', 'XHR']), new Set(), new Set([2]), new Set()];
  assert.equal(requestMatches(text, values, compileSearch('QECORE /api/or são -missing'), filters), true);
  assert.equal(requestMatches(text, values, compileSearch('%C3%A3o'), filters), true);
  assert.equal(requestMatches(text, values, compileSearch('qecore'), [new Set(['Image'])]), false);
  assert.equal(requestMatches(text, values, compileSearch('qecore -paulo'), filters), false);
  assert.equal(requestMatches(text, values, compileSearch('/SÃO.*Paulo$/i', true), filters), true);
  assert.equal(requestMatches(text, values, compileSearch('/SÃO.*Paulo$/', true), filters), false);
  assert.throws(() => compileSearch('[', true), SyntaxError);
});


test('Postman includes recorded response examples and cURL safely quotes request data', async () => {
  const { curlCommand, postmanCollection } = await import('../src/chromium/postman.mjs');
  const captured = entry(201);
  captured.request.headers = [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cookie', value: 'hidden' }];
  captured.request.postData = { text: JSON.stringify({ name: "O'Reilly", value: '$(whoami)' }) };
  captured.response.headers.push({ name: 'Set-Cookie', value: 'hidden' });
  const text = '{"ok":true}';
  const [item] = postmanCollection([captured], [[Buffer.from(text).toString('base64'), 'base64']]).item;
  assert.equal(item.response[0].body, text);
  assert.equal(item.response[0].code, 201);
  assert.deepEqual(item.response[0].originalRequest, item.request);
  const replay = item.request.description.split('\n\n')[1].split('\n').map(line => line.slice(4)).join('\n');
  assert.equal(replay, curlCommand(captured.request));
  assert.ok(!item.response[0].originalRequest.description.includes('hidden'));
  assert.equal(item.response[0].header.length, 1);
  assert.equal(Object.hasOwn(postmanCollection([captured]).item[0].response[0], 'body'), false);
  const command = curlCommand(captured.request);
  assert.ok(command.includes("--url 'https://api.example.test/orders?mode=qa'"));
  assert.ok(command.includes("O'\\''Reilly"));
  assert.ok(command.includes('$(whoami)'));
  assert.ok(!command.includes('hidden'));
});


test('Postman saves the actual recorded API bodies, including mislabeled and larger responses', async () => {
  const { Recorder } = await import('../src/chromium/recorder.mjs');
  const { postmanCollection } = await import('../src/chromium/postman.mjs');
  const output = [];
  const sample = JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024), unicode: 'été' });
  const recorder = new Recorder(async (method, { requestId }) => {
    assert.equal(method, 'Network.getResponseBody');
    return requestId === 'large' ? { body: sample, base64Encoded: false } : { body: '', base64Encoded: false };
  }, row => output.push(row));
  for (const [requestId, status, mimeType] of [['large', 200, 'application/octet-stream'], ['empty', 200, ''], ['no-content', 204, '']]) {
    recorder.event('Network.requestWillBeSent', { requestId, type: 'Fetch', request: {
      method: 'GET', url: 'https://api.example.test/' + requestId
    } });
    recorder.event('Network.responseReceived', { requestId, response: { status, mimeType } });
    recorder.event('Network.loadingFinished', { requestId });
  }
  await new Promise(resolve => setImmediate(resolve));
  const bodies = await Promise.all(output.map(async row => {
    const saved = await recorder.body(row.id);
    return saved ? [saved.text, saved.encoding] : [];
  }));
  const result = JSON.parse(JSON.stringify(postmanCollection(output, bodies))).item;
  assert.equal(result.length, 3);
  assert.equal(result[0].response[0].body, sample);
  assert.equal(result[1].response[0].body, '');
  assert.equal(result[2].response[0].body, '');
});
