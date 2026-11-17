import { MAX_RESPONSE_BYTES, RESOURCE_TYPES } from '../core/config.mjs';

const encoder = new TextEncoder();
const textualMime = /^(?:text\/|application\/(?:[\w.-]+\+)?(?:json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded)(?:\s*;|$)|image\/svg\+xml(?:\s*;|$))/i;

export function capturedResource(entry) {
  const type = String(entry._resourceType ?? entry.request._resourceType ?? entry.response._resourceType ?? '').toLowerCase();
  return RESOURCE_TYPES.find(resource => resource.toLowerCase() === type) ??
    (/(?:json|graphql)/i.test(entry.response.content?.mimeType ?? '') ? 'api' : 'any');
}

export function captureResponse(entry, content, encoding, siteUrl) {
  const url = new URL(entry.request.url);
  const method = entry.request.method.toUpperCase();
  const status = entry.response.status;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('This request URL cannot be used as an exact mock rule.');
  }
  url.hash = '';
  if (url.href.length > 2048) throw new Error('The request URL exceeds the rule limit.');
  if (!Number.isInteger(status) || status < 100 || status > 999) throw new Error('This request has no mockable HTTP status.');
  const mime = entry.response.headers?.find(header => header.name.toLowerCase() === 'content-type')?.value;
  const detectedMime = mime || entry.response.content?.mimeType;
  const headers = mime && /^[\t\x20-\x7e\x80-\xff]+$/.test(mime) ? { 'content-type': mime } : {};
  const type = capturedResource(entry);
  const resource = ['XHR', 'Fetch'].includes(type) ? 'api' : type;
  const rule = {
    name: `${method} ${url.pathname}${url.search}`.slice(0, 100),
    method, url: url.href, exactUrl: true, resource,
    response: { kind: 'json', status, headers }
  };
  if (resource === 'api' && siteUrl && new URL(siteUrl).origin !== url.origin) rule.response.cors = true;
  const postData = entry.request.postData?.text;
  if (typeof postData === 'string' && postData.length <= 2 * 1024 * 1024) {
    try {
      rule.requestBody = JSON.parse(postData);
      rule.requestBodyMode = 'exact';
    } catch { /* The JSON predicate is available for valid JSON payloads. */ }
  }
  if (status < 200 || method === 'HEAD' || [204, 205, 304].includes(status)) return { rule };
  if (typeof content !== 'string') throw new Error('Chrome did not retain the response body. Repeat the request while Mockend is recording.');
  if (detectedMime && !textualMime.test(detectedMime)) throw new Error('This response is binary. Mockend can edit JSON and text responses.');
  if (encoding === 'base64' && content.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4) {
    throw new Error('The response exceeds the 1 MiB mock limit.');
  }
  let text = content;
  if (encoding) {
    if (encoding !== 'base64') throw new Error('This response uses an unsupported encoding.');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content), char => char.charCodeAt(0))); }
    catch { throw new Error('This response could not be decoded as UTF-8 text.'); }
  }
  if (encoder.encode(text).length > MAX_RESPONSE_BYTES) throw new Error('The response exceeds the 1 MiB mock limit.');
  try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { rule.response.kind = 'text'; }
  return { rule, text };
}

export async function captureScenario(captures, readBody, siteUrl) {
  const latest = new Map();
  for (const { entry, id } of captures) {
    if (!['api', 'Fetch', 'XHR'].includes(capturedResource(entry))) continue;
    const url = new URL(entry.request.url);
    const key = `${entry.request.method} ${url.origin}${url.pathname}`;
    if (!latest.has(key) || latest.get(key).id < id) latest.set(key, { id, entry });
  }
  const ordered = [...latest.values()].sort((a, b) => b.id - a.id);
  const rules = [];
  let skipped = 0;
  await Promise.all(ordered.map(async ({ entry }, index) => {
    try {
      const [text, encoding] = await readBody(entry);
      const captured = captureResponse(entry, text, encoding, siteUrl);
      const { name, method, url, resource, response } = captured.rule;
      if (captured.text !== undefined) response.body = response.kind === 'json' ? JSON.parse(captured.text) : captured.text;
      response.delayMs = 0;
      response.cors ??= false;
      rules[index] = { name, method, url, resource, response, enabled: true, endpointOnly: true,
        ...(siteUrl && { site: new URL(siteUrl).hostname }) };
    } catch {
      skipped++;
    }
  }));
  return { rules: rules.filter(Boolean), skipped };
}
