export function proxyUrl(info) {
  const hosts = new Map([['127.0.0.1', '127.0.0.1'], ['localhost', 'localhost'], ['::1', '[::1]'], ['[::1]', '[::1]']]);
  const host = hosts.get(info?.host);
  if (!host || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 ||
      typeof info.path !== 'string' || !info.path.startsWith('/') || /^[/][\/\\]|[\\\x00-\x20#]/.test(info.path)) {
    throw new Error('VS Code did not return a valid local browser connection.');
  }
  return new URL(`ws://${host}:${info.port}${info.path}`);
}

export function withTimeout(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class CdpConnection {
  constructor(url, onEvent, onClose) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.open = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('The integrated browser connection failed.')), { once: true });
      this.socket.addEventListener('close', () => reject(new Error('The integrated browser connection closed.')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.id !== undefined) {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        if (data.error) pending.reject(new Error(data.error.message ?? 'The browser rejected a debugging command.'));
        else pending.resolve(data.result);
      } else if (data.method) {
        onEvent(data.method, data.params, data.sessionId);
      }
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('The integrated browser disconnected.'));
      this.pending.clear();
      onClose();
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 4500) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The integrated browser is disconnected.'));
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    return withTimeout(promise, timeoutMs, `Browser command timed out (${method}).`).finally(() => this.pending.delete(id));
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}
