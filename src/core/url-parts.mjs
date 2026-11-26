/** Split display/filter fields without changing the URL used for matching. */
export function urlParts(value) {
  const raw = String(value ?? '');
  // Preserve wildcard hosts and paths in rule patterns.
  const match = /^([a-z][a-z\d+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(raw);
  const baseUrl = match?.[1] ?? '';
  const pathname = match ? match[2] : raw.split(/[?#]/, 1)[0];
  const path = pathname.replace(/\/+$/, '');
  const slash = path.lastIndexOf('/');
  return { baseUrl, ingress: path.slice(0, Math.max(0, slash)) || '/', endpoint: path.slice(slash + 1) || '/' };
}
