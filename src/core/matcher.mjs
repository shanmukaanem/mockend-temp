const apiTypes = new Set(['Fetch', 'XHR']);

export function globMatches(pattern, input) {
  let p = 0;
  let i = 0;
  let star = -1;
  let retry = 0;
  while (i < input.length) {
    if (pattern[p] === '*') {
      star = p++;
      retry = i;
    } else if (pattern[p] === input[i]) {
      p++;
      i++;
    } else if (star >= 0) {
      p = star + 1;
      i = ++retry;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function jsonMatches(expected, actual, exact) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((value, index) => jsonMatches(value, actual[index], exact));
  }
  if (expected && typeof expected === 'object') {
    return Boolean(actual && typeof actual === 'object' && !Array.isArray(actual)) &&
      (!exact || Object.keys(expected).length === Object.keys(actual).length) &&
      Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && jsonMatches(value, actual[key], exact));
  }
  return expected === actual;
}

export function headerValue(headers, name) {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function normalizedQueryUrl(value) {
  const url = new URL(value);
  url.searchParams.sort();
  return url.href;
}

function bodyParameter(value, pointer) {
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export function ruleBelongsToSite(rule, hostname) {
  if (!hostname) return false;
  if (rule.site) return rule.site === hostname;
  const authority = /^(?:https?|\*):\/\/([^/]+)/.exec(rule.url)?.[1];
  if (!authority) return false;
  const host = authority.replace(/[?#].*$/, '').replace(/:\d+$/, '');
  return globMatches(host.toLowerCase(), hostname);
}

/** Resolve explicit matching modes without changing legacy endpointOnly (full-path) rules. */
export function matchingMode(rule) {
  return rule.matchMode ?? (rule.endpointOnly ? 'path' : rule.exactUrl ? 'exact' : 'pattern');
}

/** Return the final non-empty path segment, preserving encoded characters. */
export function endpointName(value) {
  const path = new URL(value, 'https://mockend.invalid').pathname;
  return path.split('/').filter(Boolean).at(-1) ?? '';
}

/**
 * Find ambiguous APIs within a selected Env using configured routes and observed requests.
 * Source-Env endpointPath anchors prevent an unrelated path from being mocked on its first visit.
 * @param {object} rule Candidate endpoint rule.
 * @param {object} config App configuration.
 * @param {{url: string, method: string}[]} routes Captured or currently observed API routes.
 * @param {object[]} [configured] Known app routes, including disabled mocks.
 * @returns {string[]} Conflicting concrete URLs, or an empty array.
 */
export function endpointConflicts(rule, config = {}, routes = [], configured = config.scenarios?.flatMap(flow => flow.rules) ?? []) {
  if (matchingMode(rule) !== 'endpoint') return [];
  const targets = ruleUrls(rule, config);
  const origins = new Set(targets.map(url => new URL(url).origin));
  const name = endpointName(rule.url);
  const buckets = (config.environments ?? []).map(env => env.baseUrls.filter(base => origins.has(base))).filter(bases => bases.length);
  if (!buckets.length) buckets.push([...origins]);
  const compatible = method => rule.method === '*' || method === '*' || rule.method === method;
  for (const bases of buckets) {
    const found = new Set(); const observed = new Set(); const paths = new Set();
    const add = (url, actual = false) => {
      try {
        const parsed = new URL(url);
        if (!bases.includes(parsed.origin) || endpointName(url) !== name || parsed.pathname.includes('*')) return;
        paths.add(parsed.pathname); found.add(parsed.origin + parsed.pathname);
        if (actual) observed.add(parsed.origin);
      } catch { /* Wildcard authorities are not concrete APIs. */ }
    };
    if (rule.endpointPath && (!rule.endpointOrigin || bases.includes(rule.endpointOrigin))) {
      if (rule.endpointOrigin) add(rule.endpointOrigin + rule.endpointPath, true);
      else for (const base of bases) add(base + rule.endpointPath);
    }
    for (const candidate of configured) {
      if (candidate.id === rule.id || !compatible(candidate.method)) continue;
      if (rule.resource !== 'any' && candidate.resource !== 'any' && rule.resource !== candidate.resource && !(['api', 'Fetch', 'XHR'].includes(rule.resource) && ['api', 'Fetch', 'XHR'].includes(candidate.resource))) continue;
      if (matchingMode(candidate) === 'endpoint' && !candidate.endpointPath) continue;
      for (const url of ruleUrls(candidate, config)) add(url);
    }
    for (const route of routes) if (compatible(route.method)) add(route.url, true);
    if (paths.size > 1 || observed.size > 1) return [...found];
  }
  return [];
}

/** Resolve Env origins while keeping explicit Exact URL rules absolute. */
export function ruleUrls(rule, config = {}) {
  if (rule.matchMode === 'exact') return [rule.url];
  const scope = rule.environmentScope ?? 'original';
  const relative = rule.url.startsWith('/');
  if (relative && scope === 'active' && !config.settings?.environmentId) return [];
  if (!relative && (scope === 'original' || (scope === 'active' && !config.settings?.environmentId))) return [rule.url];
  const suffix = relative ? rule.url : /^(?:https?|\*):\/\/[^/?]+(.*)$/.exec(rule.url)?.[1];
  if (suffix === undefined) return [];
  const environments = (config.environments ?? []).filter(env => scope === 'all' ||
    (scope === 'selected' ? rule.environmentIds?.includes(env.id)
      : !config.settings?.environmentId || config.settings.environmentId === '*' || env.id === config.settings.environmentId));
  return [...new Set(environments.flatMap(env => env.baseUrls.map(origin => origin + (suffix || '/'))))];
}

function baseMatches(rule, request, resourceType, method, config) {
  if (!rule.enabled || (rule.method !== '*' && rule.method !== method)) return false;
  if (rule.resource !== 'any' && rule.resource !== resourceType &&
      !(rule.resource === 'api' && (apiTypes.has(resourceType) || resourceType === 'Preflight'))) return false;
  return ruleUrls(rule, config).some(url => {
    const mode = matchingMode(rule);
    if (mode === 'path' || mode === 'endpoint') {
      const expected = new URL(url);
      const actual = new URL(request.url);
      return expected.origin === actual.origin && (mode === 'endpoint' ? endpointName(url) === endpointName(request.url) : expected.pathname === actual.pathname);
    }
    if (rule.matchMode === 'pattern' && !url.includes('?')) { const actual = new URL(request.url); return globMatches(url, actual.origin + actual.pathname); }
    return matchingMode(rule) === 'exact' ? normalizedQueryUrl(url) === normalizedQueryUrl(request.url) : globMatches(url, request.url);
  });
}

function parameterGroups(parameters = []) {
  const groups = [[]];
  for (const parameter of parameters) {
    if (parameter.join === 'or' && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(parameter);
  }
  return groups;
}

/**
 * Select a matching rule or report an ambiguous Endpoint without applying a mock.
 * Callers must forward conflicts and surface their warning, rather than fulfill them.
 * @returns {Promise<{rule: object, preflight: boolean} | {conflict: string, urls: string[]} | null>}
 */
export async function selectRule(rules, event, readPostData, config = {}, routes = []) {
  const request = event.request;
  if (!/^https?:\/\//.test(request.url)) return null;
  const preflightMethod = request.method === 'OPTIONS' && headerValue(request.headers, 'access-control-request-method');
  const resourceType = preflightMethod ? 'Preflight' : event.resourceType;
  let body;
  let bodyRead = false;
  let query;
  const queryMatches = group => group.every(({ source, key, value }) =>
    source !== 'query' || (query ??= new URL(request.url).searchParams).getAll(key).includes(value)
  );
  const readBody = async () => {
    if (!bodyRead) {
      bodyRead = true;
      try {
        const raw = await readPostData();
        if (typeof raw === 'string' && raw.length <= 2 * 1024 * 1024) body = JSON.parse(raw);
      } catch { /* A missing or non-JSON payload does not match a JSON predicate. */ }
    }
    return body;
  };
  const result = (rule, preflight = false) => {
    if (matchingMode(rule) !== 'endpoint') return { rule, preflight };
    const conflicts = endpointConflicts(rule, config, [...routes, { url: request.url, method: preflightMethod || request.method }], config.scenarios ? undefined : rules);
    return conflicts.length ? { conflict: `Endpoint conflict: ${endpointName(rule.url)}. Use Full path or Exact URL to distinguish these APIs.`, urls: conflicts } : { rule, preflight };
  };
  for (const rule of rules) {
    if (!baseMatches(rule, request, resourceType, request.method, config)) continue;
    // Generic wildcard rules do not consume browser preflights.
    if (preflightMethod && rule.method !== 'OPTIONS') continue;
    if (Object.hasOwn(rule, 'requestBody') && !jsonMatches(rule.requestBody, await readBody(), rule.requestBodyMode === 'exact')) continue;
    for (const group of parameterGroups(rule.parameters)) {
      if (!queryMatches(group)) continue;
      const conditions = group.filter(({ source }) => source === 'body');
      if (!conditions.length) return result(rule);
      const payload = await readBody();
      if (conditions.every(({ key, value }) => jsonMatches(value, bodyParameter(payload, key), true))) {
        return result(rule);
      }
    }
  }
  if (preflightMethod) {
    const rule = rules.find(candidate => candidate.response.cors && parameterGroups(candidate.parameters).some(queryMatches) && (apiTypes.has(candidate.resource)
      ? baseMatches(candidate, request, candidate.resource, preflightMethod, config)
      : baseMatches(candidate, request, resourceType, preflightMethod, config)));
    if (rule) return result(rule, true);
  }
  return null;
}

export function logUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 350);
  } catch {
    return '(invalid URL)';
  }
}

export function responseFor(match, request) {
  const { rule, preflight } = match;
  const response = rule.response;
  const headers = new Map(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  const origin = headerValue(request.headers, 'origin');
  if (response.cors && origin && (origin === 'null' || /^https?:\/\/[^\s]+$/.test(origin))) {
    if (!headers.has('access-control-allow-origin')) headers.set('access-control-allow-origin', origin);
    if (!headers.has('access-control-allow-credentials')) headers.set('access-control-allow-credentials', 'true');
    const vary = headers.get('vary') ?? '';
    const varyTokens = vary.split(',').map(value => value.trim().toLowerCase());
    if (!varyTokens.includes('*') && !varyTokens.includes('origin')) headers.set('vary', vary ? `${vary}, Origin` : 'Origin');
    if (preflight) {
      const method = headerValue(request.headers, 'access-control-request-method');
      const requestedHeaders = headerValue(request.headers, 'access-control-request-headers');
      if (!headers.has('access-control-allow-methods')) headers.set('access-control-allow-methods', method);
      if (requestedHeaders && !headers.has('access-control-allow-headers')) headers.set('access-control-allow-headers', requestedHeaders);
    }
  }
  let body;
  if (!preflight && request.method !== 'HEAD' && Object.hasOwn(response, 'body')) {
    body = response.kind === 'text' ? response.body : JSON.stringify(response.body);
    if (!headers.has('content-type')) headers.set('content-type', response.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  }
  if (preflight) {
    // A synthesized OPTIONS response has no redirect, cookie, or entity headers.
    for (const name of [...headers.keys()]) {
      if (!name.startsWith('access-control-') && !['cache-control', 'vary'].includes(name)) headers.delete(name);
    }
  }
  return {
    status: preflight ? 204 : response.status,
    ...(!preflight && response.statusText ? { statusText: response.statusText } : {}),
    headers: [...headers].map(([name, value]) => ({ name, value })),
    body
  };
}

export function portableMatcherSource() {
  return [
    `const apiTypes = new Set(${JSON.stringify([...apiTypes])});`,
    ...[matchingMode, endpointName, endpointConflicts, globMatches, jsonMatches, headerValue, normalizedQueryUrl, bodyParameter, ruleUrls, baseMatches,
      parameterGroups, selectRule, responseFor].map(fn => fn.toString())
  ].join('\n\n');
}
