import assert from 'node:assert/strict';
import { test } from 'node:test';
import { urlParts } from '../src/core/url-parts.mjs';
import { compileSearch, requestMatches } from '../src/chromium/request-filters.mjs';

test('URL fields separate origins, ingress and final segments without queries', () => {
  for (const [url, baseUrl, ingress, endpoint] of [
    ['https://example.com/api/v1/orders?page=2#top', 'https://example.com', '/api/v1', 'orders'],
    ['https://example.org/users/', 'https://example.org', '/', 'users'],
    ['http://localhost:4319/', 'http://localhost:4319', '/', '/'],
    ['http://[::1]:4319/api/users', 'http://[::1]:4319', '/api', 'users'],
    ['https://*.example.org/api/*?x=1', 'https://*.example.org', '/api', '*'],
    ['/v2/a%20b?next=/other', '', '/v2', 'a%20b'],
    ['https://example.com?next=/api/users', 'https://example.com', '/', '/']
  ]) assert.deepEqual(urlParts(url), { baseUrl, ingress, endpoint });
});

test('URL facets combine independently with request-style search and metadata', () => {
  const values = ['Fetch/XHR', 'GET', [2, 'http:200'], 'https://example.org', '/api/v1', 'orders', 'On'];
  const selections = [[], ['GET', 'POST'], [], ['https://example.org'], ['/api/v1'], ['orders'], ['On']].map(values => new Set(values));
  assert.equal(requestMatches(['Order list /api/v1/orders'], values, compileSearch('order -failed'), selections), true);
  selections[4] = new Set(['/other']);
  assert.equal(requestMatches(['Order list'], values, compileSearch(''), selections), false);
});
