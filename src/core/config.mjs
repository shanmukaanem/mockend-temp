export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const RESOURCE_TYPES = ['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'Other'];
export const HTTP_METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const NETWORK_ERRORS = ['Failed', 'Aborted', 'TimedOut', 'ConnectionRefused', 'InternetDisconnected', 'NameNotResolved', 'ConnectionReset'];

const encoder = new TextEncoder();
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const forbiddenHeaders = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade', 'trailer', 'proxy-connection']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function requireThat(condition, path, message) {
  if (!condition) throw new Error(`${path} ${message}`);
}

function shape(value, keys, path) {
  requireThat(plain(value), path, 'must be an object.');
  for (const key of Object.keys(value)) requireThat(keys.includes(key), path, `has an unknown field “${key}”.`);
}

function uniqueIds(items, path) {
  requireThat(new Set(items.map(item => item.id)).size === items.length, path, 'contains duplicate IDs.');
}

export function validateHeaders(headers, path) {
  requireThat(plain(headers), path, 'must be an object of header names and string values.');
  const seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    requireThat(token.test(name) && !forbiddenHeaders.has(lower), path, `contains an unsupported header “${name}”.`);
    requireThat(!seen.has(lower), path, `contains a duplicate header “${name}”.`);
    requireThat(typeof value === 'string' && /^[\t\x20-\x7e\x80-\xff]*$/.test(value), path, `has an invalid value for “${name}”.`);
    seen.add(lower);
  }
}

function validateRule(rule, path, environments) {
  shape(rule, ['id', 'name', 'enabled', 'method', 'url', 'resource', 'requestBody', 'requestBodyMode', 'parameters', 'exactUrl', 'endpointOnly', 'site', 'environmentScope', 'environmentIds', 'response'], path);
  requireThat(rule.environmentScope === undefined || ['original', 'active', 'all', 'selected'].includes(rule.environmentScope), path, 'needs a valid environment scope.');
  if (rule.environmentScope && rule.environmentScope !== 'original') {
    requireThat(/^(?:https?|\*):\/\/[^/?]+/.test(rule.url) || /^\/(?!\/)/.test(rule.url), path, 'needs an endpoint path or source URL for environment matching.');
  }
  if (rule.environmentScope === 'selected') {
    requireThat(Array.isArray(rule.environmentIds) && rule.environmentIds.length > 0 &&
      new Set(rule.environmentIds).size === rule.environmentIds.length && rule.environmentIds.every(value => environments.some(env => env.id === value)), path, 'needs existing selected environments.');
  } else requireThat(rule.environmentIds === undefined, path, 'uses environment IDs only with selected environments.');
  requireThat(id(rule.id), path, 'needs a valid ID.');
  requireThat(label(rule.name), path, 'needs a name of 1–100 characters.');
  requireThat(typeof rule.enabled === 'boolean', path, 'needs an enabled flag.');
  requireThat(rule.method === '*' || (typeof rule.method === 'string' && token.test(rule.method) && rule.method === rule.method.toUpperCase()), path, 'needs an uppercase HTTP method or *.');
  requireThat(typeof rule.url === 'string' && rule.url.length <= 2048 && !/\s|#/.test(rule.url) &&
    (rule.url === '*' || /^(https?|\*):\/\/[^/]+/.test(rule.url) || (/^\/(?!\/)/.test(rule.url) && ['active', 'all', 'selected'].includes(rule.environmentScope))), path, 'needs an Env endpoint path or HTTP(S) URL without spaces or fragments.');
  requireThat(rule.exactUrl === undefined || typeof rule.exactUrl === 'boolean', path, 'needs a boolean exact URL flag.');
  requireThat(rule.endpointOnly === undefined || (typeof rule.endpointOnly === 'boolean' && !(rule.endpointOnly && rule.exactUrl)), path, 'needs one URL matching mode.');
  if (rule.parameters !== undefined) {
    requireThat(!Object.hasOwn(rule, 'requestBody') && Array.isArray(rule.parameters) && rule.parameters.length <= 30, path,
      'supports at most 30 parameter matches in parameter mode.');
    for (const parameter of rule.parameters) {
      shape(parameter, ['source', 'key', 'value', 'join'], path);
      requireThat(parameter.join === undefined || ['and', 'or'].includes(parameter.join), path, 'has an invalid parameter operator.');
      requireThat(['query', 'body'].includes(parameter.source) && typeof parameter.key === 'string' && parameter.key.length > 0 &&
        parameter.key.length <= 2048 && (parameter.source === 'query' ? typeof parameter.value === 'string'
          : /^(?:\/(?:[^~]|~[01])*)+$/.test(parameter.key) && Object.hasOwn(parameter, 'value')), path, 'has an invalid parameter match.');
    }
  }
  requireThat(rule.site === undefined || (typeof rule.site === 'string' && rule.site.length <= 255 && /^[a-z0-9.:[\]-]+$/i.test(rule.site)), path, 'needs a site hostname.');
  requireThat(rule.requestBodyMode === undefined || (['subset', 'exact'].includes(rule.requestBodyMode) && Object.hasOwn(rule, 'requestBody')), path, 'needs a JSON body and valid body matching mode.');
  if (rule.exactUrl || rule.endpointOnly || !rule.url.includes('*')) {
    let parsed;
    const relative = rule.url.startsWith('/');
    try { parsed = new URL(rule.url, relative ? 'https://mockend.invalid' : undefined); } catch { /* reported below */ }
    requireThat(parsed && !parsed.username && !parsed.password && (relative ? parsed.pathname + parsed.search === rule.url : parsed.href === rule.url), path,
      `needs a canonical URL${parsed && !parsed.username && !parsed.password ? ` such as ${parsed.href}` : ''}.`);
  }
  requireThat(['api', 'any', ...RESOURCE_TYPES].includes(rule.resource), path, 'needs a supported request type.');
  const response = rule.response;
  const responsePath = `${path}.response`;
  shape(response, ['kind', 'status', 'statusText', 'headers', 'body', 'error', 'delayMs', 'cors'], responsePath);
  requireThat(inRange(response.delayMs, 0, 30000), responsePath, 'needs a delay from 0 to 30,000 ms.');
  if (response.kind === 'error') {
    requireThat(NETWORK_ERRORS.includes(response.error), responsePath, 'needs a supported network error.');
    requireThat(Object.keys(response).every(key => ['kind', 'error', 'delayMs'].includes(key)), responsePath, 'has fields that only apply to HTTP responses.');
    return;
  }
  requireThat(['json', 'text'].includes(response.kind) && !Object.hasOwn(response, 'error'), responsePath, 'needs kind “json”, “text”, or “error”.');
  requireThat(inRange(response.status, 100, 999), responsePath, 'needs an HTTP status from 100 to 999.');
  requireThat(response.statusText === undefined || (typeof response.statusText === 'string' && /^[\x20-\x7e]{1,100}$/.test(response.statusText) && response.statusText.trim().length > 0), responsePath, 'needs a status name of 1–100 printable ASCII characters.');
  requireThat(typeof response.cors === 'boolean', responsePath, 'needs a CORS flag.');
  validateHeaders(response.headers, `${responsePath}.headers`);
  const noBody = response.status < 200 || [204, 205, 304].includes(response.status) || rule.method === 'HEAD';
  requireThat(noBody || Object.hasOwn(response, 'body'), responsePath, 'needs a response body (null is valid for JSON).');
  if (Object.hasOwn(response, 'body')) {
    requireThat(!noBody, responsePath, 'cannot include a body for this status or method.');
    requireThat(response.kind !== 'text' || typeof response.body === 'string', responsePath, 'needs a text body.');
    const body = response.kind === 'text' ? response.body : JSON.stringify(response.body);
    requireThat(encoder.encode(body).length <= MAX_RESPONSE_BYTES, responsePath, 'exceeds the 1 MiB body limit.');
  }
}

export function validateConfig(config) {
  const serialized = JSON.stringify(config);
  requireThat(serialized && encoder.encode(serialized).length <= MAX_CONFIG_BYTES, 'Configuration', 'exceeds the 4 MiB limit or is empty.');
  // Round-trip JSON so persisted objects and runtime objects have identical behavior.
  const value = JSON.parse(serialized);
  shape(value, ['version', 'activeScenarioId', 'settings', 'scenarios', 'environments'], 'Configuration');
  requireThat(value.version === 1, 'Configuration', 'needs version 1.');
  shape(value.settings, ['bypassServiceWorker', 'environmentId'], 'Settings');
  requireThat(typeof value.settings.bypassServiceWorker === 'boolean', 'Settings', 'needs a service worker bypass flag.');
  const environments = value.environments ?? [];
  requireThat(Array.isArray(environments) && environments.length <= 50, 'Environments', 'supports up to 50 environments.');
  for (const env of environments) {
    shape(env, ['id', 'name', 'baseUrls', 'services'], 'Environment');
    requireThat(id(env.id) && label(env.name), 'Environment', 'needs a valid ID and name.');
    requireThat(Array.isArray(env.baseUrls) && env.baseUrls.length > 0 && env.baseUrls.length <= 30 && new Set(env.baseUrls).size === env.baseUrls.length, 'Environment', 'needs 1–30 unique base URLs.');
    for (const origin of env.baseUrls) {
      let url; try { url = new URL(origin); } catch { /* validated below */ }
      requireThat(typeof origin === 'string' && origin.length <= 2048 && url && /^https?:$/.test(url.protocol) && !url.username && !url.password && origin === url.origin,
        'Environment base URL', 'must be an HTTP(S) origin without a path, query, credentials, or fragment.');
    }
    if (env.services !== undefined) {
      requireThat(plain(env.services), 'Environment services', 'must map base URLs to service names.');
      for (const [origin, name] of Object.entries(env.services)) requireThat(env.baseUrls.includes(origin) && label(name),
        'Environment service', 'needs an existing base URL and a name of 1-100 characters.');
    }
  }
  uniqueIds(environments, 'Environments');
  requireThat(value.settings.environmentId === undefined || value.settings.environmentId === '*' || environments.some(env => env.id === value.settings.environmentId), 'Settings', 'needs an existing environment or all environments.');
  requireThat(Array.isArray(value.scenarios) && value.scenarios.length >= 1 && value.scenarios.length <= 50,
    'Configuration', 'must contain 1–50 flows.');
  for (const [index, scenario] of value.scenarios.entries()) {
    const path = `Flow ${index + 1}`;
    shape(scenario, ['id', 'name', 'rules'], path);
    requireThat(id(scenario.id) && label(scenario.name), path, 'needs a valid ID and name of 1–100 characters.');
    requireThat(Array.isArray(scenario.rules) && scenario.rules.length <= 200, path, 'may contain up to 200 rules.');
    scenario.rules.forEach((rule, ruleIndex) => validateRule(rule, `${path}, rule ${ruleIndex + 1}`, environments));
    uniqueIds(scenario.rules, `${path} rules`);
  }
  uniqueIds(value.scenarios, 'Flows');
  requireThat(value.scenarios.some(scenario => scenario.id === value.activeScenarioId), 'Configuration', 'needs an existing active flow.');
  return value;
}

export function exportConfig(config) {
  const formatted = JSON.stringify(config, null, 2) + '\n';
  return encoder.encode(formatted).length <= MAX_CONFIG_BYTES ? formatted : JSON.stringify(config);
}

export function emptyConfig() {
  return { version: 1, activeScenarioId: 'default', settings: { bypassServiceWorker: true },
    scenarios: [{ id: 'default', name: 'Default', rules: [] }] };
}

export function starterConfig() {
  const cart = { enabled: true, method: 'GET', url: 'http://127.0.0.1:4319/api/cart', resource: 'api' };
  const json = (status, body, delayMs = 0) => ({ kind: 'json', status, body, delayMs, headers: {}, cors: false });
  return {
    version: 1,
    activeScenarioId: 'checkout',
    settings: { bypassServiceWorker: true },
    scenarios: [
      {
        id: 'checkout', name: 'Demo · Checkout',
        rules: [
          {
            ...cart, id: 'expired', name: 'Expired coupon', method: 'POST', url: 'http://127.0.0.1:4319/api/coupon',
            requestBody: { coupon: 'EXPIRED' },
            response: json(422, { code: 'COUPON_EXPIRED', message: 'This coupon has expired.' }, 350)
          },
          {
            ...cart, id: 'filled', name: 'Cart with items',
            response: json(200, { items: [{ id: 'mock-1', name: 'Canvas tote', quantity: 2 }], total: 24 })
          }
        ]
      },
      {
        id: 'empty', name: 'Demo · Empty cart',
        rules: [{ ...cart, id: 'no-items', name: 'Empty cart', response: json(200, { items: [], total: 0 }, 250) }]
      },
      {
        id: 'offline', name: 'Demo · Offline',
        rules: [{ ...cart, id: 'network', name: 'Disconnected cart', response: { kind: 'error', error: 'InternetDisconnected', delayMs: 600 } }]
      }
    ]
  };
}
