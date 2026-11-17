import { MAX_RESPONSE_BYTES, validateConfig, validateHeaders } from '../core/config.mjs';
import { portableMatcherSource } from '../core/matcher.mjs';

const scenarioPrefix = 'const mockendScenario = JSON.parse(';

export function postmanMockScript(scenario) {
  const snapshot = JSON.stringify(JSON.stringify(scenario));
  const endpoints = new Set();
  for (const rule of scenario.rules) {
    if (!rule.enabled) continue;
    const path = /^https?:\/\/[^/?]+(\/[^?]*)/.exec(rule.url)?.[1];
    if (path && !/[\s*]/.test(path) && /^[A-Z]+$/.test(rule.method)) endpoints.add(`// @endpoint ${rule.method} ${path}`);
  }
  return `// Mockend scenario for Postman Mocks. Run: postman mock run <file>.js
${[...endpoints].join('\n')}
const http = require('http');
const URL = globalThis.URL || require('url').URL;
${scenarioPrefix}${snapshot});
${portableMatcherSource()}

const mockOrigin = 'http://mockend.local';
const routes = mockendScenario.rules.map(rule => {
  const parts = /^((?:https?|\\*):\\/\\/[^/?]+)(.*)$/.exec(rule.url);
  return {
    authority: parts?.[1],
    rule: { ...rule, resource: 'any', url: parts ? mockOrigin + (parts[2] || '/') : rule.url }
  };
});

function requestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString());
    return Promise.resolve(JSON.stringify(req.body));
  }
  if (typeof req.on !== 'function' || req.readableEnded || req.method === 'GET' || req.method === 'HEAD') {
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) => {
    let body = '';
    if (typeof req.setEncoding === 'function') req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2 * 1024 * 1024) reject(new RangeError('Request body is too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const headersIn = req.headers || {};
    const source = headerValue(headersIn, 'x-mockend-origin');
    const rules = routes.filter(({ authority }) => !source || !authority || globMatches(authority, source)).map(({ rule }) => rule);
    const incoming = new URL(req.url, mockOrigin);
    const request = { method: req.method, url: mockOrigin + incoming.pathname + incoming.search, headers: headersIn };
    let bodyRead;
    const match = await selectRule(rules, { resourceType: 'Fetch', request }, () => bodyRead ??= requestBody(req));
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Mockend rule matched' }));
      return;
    }
    if (!match.preflight && match.rule.response.delayMs) {
      await new Promise(resolve => setTimeout(resolve, match.rule.response.delayMs));
    }
    if (!match.preflight && match.rule.response.kind === 'error') {
      if (typeof res.destroy === 'function') res.destroy();
      else { res.writeHead(502); res.end(); }
      return;
    }
    const { status, headers, body } = responseFor(match, request);
    res.writeHead(status, Object.fromEntries(headers.map(({ name, value }) => [name, value])));
    res.end(body);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Mockend handler failed', detail: error.message }));
  }
});

if (typeof module !== 'undefined') module.exports = server;
if (typeof pm === 'undefined' && typeof process !== 'undefined' && process.versions?.node &&
    typeof module !== 'undefined' && require.main === module) {
  server.listen(Number(process.env.PORT || 4319), '127.0.0.1');
}
`;
}

function collectionScenario(collection, baseUrl) {
  if (!Array.isArray(collection.item) || !String(collection.info?.schema).includes('/collection/v2.')) {
    throw new Error('Choose a Postman collection JSON or a Mockend-generated Postman mock script.');
  }
  const variables = new Map((collection.variable ?? []).map(({ key, value }) => [key, value]));
  const resolve = value => value.replace(/\{\{([^{}]+)\}\}/g, (token, key, index) =>
    variables.get(key) || (index === 0 && baseUrl ? new URL(baseUrl).origin : token));
  const rules = [];
  const queue = [...collection.item];
  for (const item of queue) {
    if (Array.isArray(item.item)) queue.push(...item.item);
    for (const example of item.response ?? []) {
      const request = example.originalRequest ?? item.request;
      const raw = typeof request?.url === 'string' ? request.url : request?.url?.raw;
      const method = request?.method?.toUpperCase();
      const status = example.code;
      if (!raw || !method || !Number.isInteger(status) || status < 100 || status > 999) continue;
      const resolved = resolve(raw);
      if (resolved.includes('{{')) continue;
      let url;
      try { url = new URL(resolved, baseUrl); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) continue;
      url.hash = '';
      const headers = {};
      for (const { key, value, disabled } of example.header ?? []) {
        if (disabled || typeof key !== 'string') continue;
        try { validateHeaders({ [key]: value }, 'Postman response'); }
        catch { continue; }
        Object.defineProperty(headers, key.toLowerCase(), { value, enumerable: true, configurable: true });
      }
      const response = { kind: 'text', status, headers, delayMs: 0, cors: false };
      if (status >= 200 && method !== 'HEAD' && ![204, 205, 304].includes(status)) {
        const body = typeof example.body === 'string' ? example.body : '';
        if (new TextEncoder().encode(body).length > MAX_RESPONSE_BYTES) continue;
        response.body = body;
      }
      const rule = {
        id: crypto.randomUUID(), name: String(example.name || item.name || `${method} ${url.pathname}`).slice(0, 100),
        enabled: true, method, url: url.href, exactUrl: true, resource: 'any', response
      };
      if (request.body?.mode === 'raw') {
        try { rule.requestBody = JSON.parse(request.body.raw); rule.requestBodyMode = 'exact'; } catch { /* Non-JSON bodies are not predicates. */ }
      }
      rules.push(rule);
    }
  }
  if (!rules.length) throw new Error('No usable saved HTTP response examples were found. Collection URLs must resolve to HTTP or HTTPS.');
  return { id: crypto.randomUUID(), name: String(collection.info.name || 'Postman mocks').slice(0, 100), rules };
}

export function readPostmanMock(text, baseUrl) {
  const content = text.trim().replace(/^```[\w-]*\s*\n([\s\S]*)\n```$/, '$1').trim();
  const line = content.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith(scenarioPrefix));
  let scenario;
  if (line?.endsWith(');')) scenario = JSON.parse(JSON.parse(line.slice(scenarioPrefix.length, -2)));
  else {
    let parsed;
    try { parsed = JSON.parse(content); } catch {
      throw new Error('Paste a Mockend-generated mock script or import a Postman collection with saved response examples.');
    }
    scenario = collectionScenario(parsed.collection ?? parsed, baseUrl);
  }
  return validateConfig({
    version: 1, activeScenarioId: scenario.id, settings: { bypassServiceWorker: true }, scenarios: [scenario]
  }).scenarios[0];
}
