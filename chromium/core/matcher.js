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

function baseMatches(rule, request, resourceType, method) {
  if (!rule.enabled || (rule.method !== '*' && rule.method !== method)) return false;
  if (rule.resource !== 'any' && rule.resource !== resourceType &&
      !(rule.resource === 'api' && (apiTypes.has(resourceType) || resourceType === 'Preflight'))) return false;
  if (rule.endpointOnly) {
    const expected = new URL(rule.url);
    const actual = new URL(request.url);
    return expected.origin === actual.origin && expected.pathname === actual.pathname;
  }
  return rule.exactUrl
    ? normalizedQueryUrl(rule.url) === normalizedQueryUrl(request.url)
    : globMatches(rule.url, request.url);
}

function parameterGroups(parameters = []) {
  const groups = [[]];
  for (const parameter of parameters) {
    if (parameter.join === 'or' && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(parameter);
  }
  return groups;
}

export async function selectRule(rules, event, readPostData) {
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
  for (const rule of rules) {
    if (!baseMatches(rule, request, resourceType, request.method)) continue;
    // Generic wildcard rules do not consume browser preflights.
    if (preflightMethod && rule.method !== 'OPTIONS') continue;
    if (Object.hasOwn(rule, 'requestBody') && !jsonMatches(rule.requestBody, await readBody(), rule.requestBodyMode === 'exact')) continue;
    for (const group of parameterGroups(rule.parameters)) {
      if (!queryMatches(group)) continue;
      const conditions = group.filter(({ source }) => source === 'body');
      if (!conditions.length) return { rule, preflight: false };
      const payload = await readBody();
      if (conditions.every(({ key, value }) => jsonMatches(value, bodyParameter(payload, key), true))) {
        return { rule, preflight: false };
      }
    }
  }
  if (preflightMethod) {
    const rule = rules.find(candidate => candidate.response.cors && parameterGroups(candidate.parameters).some(queryMatches) && (apiTypes.has(candidate.resource)
      ? baseMatches(candidate, request, candidate.resource, preflightMethod)
      : baseMatches(candidate, request, resourceType, preflightMethod)));
    if (rule) return { rule, preflight: true };
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
    headers: [...headers].map(([name, value]) => ({ name, value })),
    body
  };
}

export function portableMatcherSource() {
  return [
    `const apiTypes = new Set(${JSON.stringify([...apiTypes])});`,
    ...[globMatches, jsonMatches, headerValue, normalizedQueryUrl, bodyParameter, baseMatches,
      parameterGroups, selectRule, responseFor].map(fn => fn.toString())
  ].join('\n\n');
}
