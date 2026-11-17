const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const credentials = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:api[-_]?key|auth[-_]?token|access[-_]?token|csrf[-_]?token).*)$/i;

const safeHeaders = values => (values ?? []).filter(({ name }) => !credentials.test(name));
const postmanHeaders = values => safeHeaders(values).map(({ name, value }) => ({ key: name, value }));

export function decodeBody(text, encoding) {
  if (typeof text !== 'string') return undefined;
  if (!encoding) return text;
  if (encoding !== 'base64') return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(text), char => char.charCodeAt(0))); }
  catch { return undefined; }
}

export function postmanCollection(entries, bodies = []) {
  return {
    info: { name: 'Mockend requests', schema },
    item: entries.map(({ request, response }, index) => {
      const url = new URL(request.url);
      const command = curlCommand(request);
      const description = 'Replay with cURL (Bash, zsh, or Git Bash)\n\n' +
        command.split('\n').map(line => '    ' + line).join('\n');
      const item = {
        method: request.method,
        header: postmanHeaders(request.headers),
        url: request.url,
        description
      };
      const postData = request.postData;
      if (typeof postData?.text === 'string') {
        let raw = postData.text;
        let language;
        try {
          raw = JSON.stringify(JSON.parse(raw), null, 2);
          language = 'json';
        } catch { /* Keep non-JSON bodies as captured. */ }
        item.body = { mode: 'raw', raw, ...(language && { options: { raw: { language } } }) };
      } else if (postData?.params?.length) {
        const mode = postData.mimeType?.startsWith('multipart/') ? 'formdata' : 'urlencoded';
        item.body = { mode, [mode]: postData.params.filter(field => !field.fileName)
          .map(({ name, value }) => ({ key: name, value: value ?? '', type: 'text' })) };
      }
      const exported = { name: `${request.method} ${url.pathname}`, request: item };
      if (response?.status >= 100) {
        const [text, encoding] = bodies[index] ?? [];
        const noBody = response.status < 200 || request.method === 'HEAD' || [204, 205, 304].includes(response.status);
        const body = noBody ? '' : decodeBody(text, encoding);
        const mime = response.headers?.find(header => header.name.toLowerCase() === 'content-type')?.value || response.content?.mimeType;
        const language = /(?:^|[+/])json(?:[;\s]|$)/i.test(mime ?? '') ? 'json' : 'text';
        const status = response.statusText || `HTTP ${response.status}`;
        exported.response = [{
          name: `Captured ${response.status}`,
          _postman_previewlanguage: language,
          originalRequest: item,
          status,
          code: response.status,
          header: postmanHeaders(response.headers),
          ...(body === undefined ? {} : { body })
        }];
      }
      return exported;
    })
  };
}

const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const transportHeaders = /^(?:content-length|transfer-encoding|connection|host|accept-encoding)$/i;

export function curlCommand(request) {
  const args = ['curl', '--request', shellQuote(request.method), '--url', shellQuote(request.url)];
  for (const { name, value } of safeHeaders(request.headers)) {
    if (!transportHeaders.test(name)) args.push('--header', shellQuote(`${name}: ${value}`));
  }
  const postData = request.postData;
  if (typeof postData?.text === 'string') {
    args.push('--data-binary', shellQuote(postData.text));
  } else if (postData?.params?.length) {
    const multipart = postData.mimeType?.startsWith('multipart/');
    for (const { name, value, fileName } of postData.params) {
      if (!fileName) args.push(multipart ? '--form-string' : '--data-urlencode', shellQuote(`${name}=${value ?? ''}`));
    }
  }
  return args.join(' ');
}
