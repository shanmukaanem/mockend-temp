
const MAX_ROWS = 150;
const MAX_PAYLOAD_CHARS = 1024 * 1024;
const MAX_EXPORT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const RECORDING_NETWORK_OPTIONS = {
  maxPostDataSize: MAX_PAYLOAD_CHARS,
  maxResourceBufferSize: MAX_EXPORT_BODY_BYTES,
  maxTotalBufferSize: MAX_BUFFER_BYTES
};
const encoder = new TextEncoder();
const apiTypes = new Set(['Fetch', 'XHR']);
const textual = /^(?:text\/|application\/(?:[\w.-]+\+)?(?:json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded)(?:\s*;|$)|image\/svg\+xml(?:\s*;|$))/i;
const headers = values => Object.entries(values ?? {}).map(([name, value]) => ({ name, value: String(value) }));

export class Recorder {
  pending = new Map();
  marks = new Map();
  rows = new Map();
  payloadSize = 0;
  serial = 0;

  constructor(send, publish, captureUnmocked = () => true) {
    this.send = send;
    this.publish = publish;
    this.captureUnmocked = captureUnmocked;
  }

  markNetwork({ networkId, request }, session, mark) {
    if (!networkId) return;
    const key = JSON.stringify([session, networkId]);
    const pending = this.pending.get(key);
    if (pending?.row.request.url === request.url && pending.row.request.method === request.method) {
      Object.assign(pending, mark);
      return pending;
    }
    this.marks.set(key, { url: request.url, method: request.method, mark });
    if (this.marks.size > 300) this.marks.delete(this.marks.keys().next().value);
  }

  markForward(event, session) {
    this.markNetwork(event, session, { forwarded: true });
  }

  markMock(event, session, command, { status, headers: responseHeaders = [], body, ruleName, ruleId, scenarioId, error, readPostData }) {
    const mocked = command.then(() => true, () => false);
    const pending = this.markNetwork(event, session, { mocked });
    const request = event.request;
    const row = {
      id: ++this.serial, _resourceType: event.resourceType, _mocked: true, _mockRule: ruleName,
      _mockRuleId: ruleId, _mockScenarioId: scenarioId,
      request: pending?.row.request ?? { url: request.url, method: request.method, headers: headers(request.headers) },
      response: { status: status ?? 0, headers: responseHeaders, content: {
        mimeType: responseHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value
      } }
    };
    if (error) row._networkError = error;
    if (typeof request.postData === 'string') this.setPostData(row, request.postData);
    const post = pending?.post ?? (request.hasPostData && !row.request.postData
      ? readPostData().then(value => this.setPostData(row, value)).catch(() => {})
      : undefined);
    void Promise.all([mocked, post]).then(([applied]) => {
      if (!applied) return;
      const capture = { row };
      this.remember(capture, body === undefined ? undefined : Promise.resolve({ body }));
      this.publish(row);
    });
  }

  event(method, data, session) {
    if (!method.startsWith('Network.')) return;
    const key = JSON.stringify([session, data.requestId]);
    const previous = this.pending.get(key);
    if (method === 'Network.requestWillBeSent') {
      if (previous && data.redirectResponse) {
        this.setResponse(previous, data.redirectResponse, data.type);
        this.finish(previous);
      }
      this.pending.delete(key);
      const request = data.request;
      if (!/^https?:\/\//i.test(request.url)) return;
      const row = {
        id: ++this.serial, _resourceType: data.type,
        request: { url: request.url, method: request.method, headers: headers(request.headers) },
        response: { status: 0, headers: [], content: {} }
      };
      const capture = { row, requestId: data.requestId, session };
      const mark = this.marks.get(key);
      this.marks.delete(key);
      if (mark?.url === request.url && mark.method === request.method) Object.assign(capture, mark.mark);
      this.pending.set(key, capture);
      if (this.pending.size > 300) this.pending.delete(this.pending.keys().next().value);
      if (request.postData !== undefined) this.setPostData(row, request.postData);
      else if (request.hasPostData) {
        capture.post = this.send('Network.getRequestPostData', { requestId: data.requestId }, session)
          .then(result => this.setPostData(row, result.postData)).catch(() => {});
      }
    } else if (previous && method === 'Network.responseReceived') {
      this.setResponse(previous, data.response, data.type);
    } else if (previous && ['Network.loadingFinished', 'Network.loadingFailed'].includes(method)) {
      this.pending.delete(key);
      if (method === 'Network.loadingFailed') previous.row._networkError = data.errorText;
      this.finish(previous, method === 'Network.loadingFinished');
    }
  }

  setPostData(row, text) {
    if (typeof text === 'string' && text.length <= MAX_PAYLOAD_CHARS) {
      row.request.postData = { text, mimeType: row.request.headers.find(header => header.name.toLowerCase() === 'content-type')?.value };
    }
  }

  setResponse({ row }, response, type) {
    row._resourceType = type ?? row._resourceType;
    row.response = { status: response.status, statusText: response.statusText, headers: headers(response.headers), content: { mimeType: response.mimeType } };
  }

  finish(capture, readBody = false) {
    const { row, requestId, session } = capture;
    if (!this.captureUnmocked()) return;
    if (capture.mocked) {
      void capture.mocked.then(mocked => {
        if (!mocked) {
          capture.mocked = undefined;
          this.finish(capture);
        }
      });
      return;
    }
    if (capture.forwarded) row._forwarded = true;
    // Start the body read immediately, before a redirect can reuse the request ID.
    const noBody = row.response.status < 200 || row.request.method === 'HEAD' || [204, 205, 304].includes(row.response.status);
    const mime = row.response.content.mimeType || row.response.headers.find(header => header.name.toLowerCase() === 'content-type')?.value;
    const body = readBody && !noBody && (apiTypes.has(row._resourceType) || textual.test(mime ?? ''))
      ? this.send('Network.getResponseBody', { requestId }, session)
      : undefined;
    this.remember(capture, body);
    void Promise.resolve(capture.post).then(() => {
      if (this.rows.has(row.id) && this.captureUnmocked()) this.publish(row);
    });
  }

  remember(capture, body) {
    const { row } = capture;
    if (body) {
      capture.body = body.then(result => {
        if (typeof result.body !== 'string' || !this.rows.has(row.id)) return;
        const encoding = result.base64Encoded ? 'base64' : '';
        const limit = encoding ? Math.ceil(MAX_EXPORT_BODY_BYTES / 3) * 4 : MAX_EXPORT_BODY_BYTES;
        if (result.body.length > limit || (!encoding && encoder.encode(result.body).length > limit)) return;
        const size = result.body.length * 2;
        if (this.payloadSize + size > MAX_BUFFER_BYTES) return;
        this.payloadSize += size;
        capture.size = size;
        return { text: result.body, encoding };
      }).catch(() => undefined);
    }
    this.rows.set(row.id, capture);
    if (this.rows.size > MAX_ROWS) {
      const [id, oldest] = this.rows.entries().next().value;
      this.payloadSize -= oldest.size ?? 0;
      this.rows.delete(id);
    }
  }

  async body(id) {
    return this.rows.get(id)?.body;
  }
}
