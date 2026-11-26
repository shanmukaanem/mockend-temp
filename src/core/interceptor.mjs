import { logUrl, responseFor, selectRule } from './matcher.mjs';

const fetchPatterns = [
  { urlPattern: 'http://*', requestStage: 'Request' },
  { urlPattern: 'https://*', requestStage: 'Request' }
];
const childFilter = [
  { type: 'iframe' }, { type: 'worker' }, { type: 'shared_worker' }, { exclude: true }
];
const trackedRequestsPerSession = 1000;

function encodeBody(body) {
  const bytes = new TextEncoder().encode(body);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function wait(ms, signal) {
  if (!ms || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function getPostData(send, event, session) {
  const { request, networkId } = event;
  if (typeof request.postData === 'string') return request.postData;
  if (request.postDataEntries?.length && request.postDataEntries.every(entry => typeof entry.bytes === 'string')) {
    const entries = request.postDataEntries.map(entry => atob(entry.bytes));
    const length = entries.reduce((total, entry) => total + entry.length, 0);
    if (length > 2 * 1024 * 1024) return undefined;
    const bytes = Uint8Array.from(entries.join(''), byte => byte.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  if (request.hasPostData && networkId) {
    return (await send('Network.getRequestPostData', { requestId: networkId }, session))?.postData;
  }
}

export class Interceptor {
  constructor({ send, getConfig, onActivity, onMock, onForward, autoAttach = false }) {
    this.send = send;
    this.getConfig = getConfig;
    this.onActivity = onActivity;
    this.onMock = onMock;
    this.onForward = onForward;
    this.autoAttach = autoAttach;
    this.abort = new AbortController();
    this.sessions = new Set();
    this.forwarded = new Map();
    this.tasks = new Set();
    this.stopping = undefined;
  }

  async start() {
    this.bypassServiceWorker = this.getConfig().settings.bypassServiceWorker;
    await this.enable(undefined);
    if (this.autoAttach) await this.attachChildren(undefined);
  }

  async enable(session) {
    this.sessions.add(session);
    // Some Chromium worker targets lack one or more Network commands.
    await this.send('Network.enable', { maxPostDataSize: 2 * 1024 * 1024 }, session).catch(() => {});
    await this.send('Network.setCacheDisabled', { cacheDisabled: true }, session).catch(() => {});
    if (this.bypassServiceWorker) {
      await this.send('Network.setBypassServiceWorker', { bypass: true }, session).catch(() => {});
    }
    if (!this.abort.signal.aborted) await this.send('Fetch.enable', { patterns: fetchPatterns }, session);
  }

  attachChildren(session) {
    return this.send('Target.setAutoAttach', {
      autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: childFilter
    }, session);
  }

  event(method, params, session) {
    let task;
    if (method === 'Fetch.requestPaused') task = this.handleRequest(params, session);
    if (this.autoAttach && method === 'Target.attachedToTarget') task = this.handleChild(params);
    if (method === 'Target.detachedFromTarget') {
      this.sessions.delete(params.sessionId);
      this.forwarded.delete(params.sessionId);
    }
    if (method === 'Network.responseReceived' || method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.observeForwarded(method, params, session);
    }
    if (task) {
      this.tasks.add(task);
      const done = () => this.tasks.delete(task);
      task.then(done, done);
    }
  }

  async handleChild({ sessionId, waitingForDebugger }) {
    try {
      if (!this.abort.signal.aborted) {
        await this.enable(sessionId);
        if (!this.abort.signal.aborted) await this.attachChildren(sessionId);
      }
    } catch {
      // A child may close before its setup finishes. The parent remains attached.
    } finally {
      if (waitingForDebugger) await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  observeForwarded(method, params, session) {
    const requests = this.forwarded.get(session);
    const entry = requests?.get(params.requestId);
    if (!entry || this.abort.signal.aborted) return;
    if (method === 'Network.responseReceived') {
      entry.status = params.response.status;
      entry.mimeType = params.response.mimeType;
      return;
    }
    requests.delete(params.requestId);
    const failed = method === 'Network.loadingFailed';
    const outcome = failed
      ? params.canceled ? 'Request canceled' : 'Upstream request failed'
      : 'Passed through';
    this.onActivity({
      time: Date.now(), method: entry.method, url: entry.url, outcome,
      status: entry.status, mimeType: entry.mimeType, error: failed ? params.errorText : undefined
    });
  }

  async handleRequest(event, session) {
    const { requestId, request, resourceType, networkId } = event;
    const proceed = () => this.send('Fetch.continueRequest', { requestId }, session);
    const signal = this.abort.signal;
    const report = (outcome, rule, status) => this.onActivity({
      time: Date.now(), method: request.method, url: logUrl(request.url), outcome,
      rule: rule?.name, status
    });
    if (signal.aborted) {
      await proceed().catch(() => {});
      return;
    }
    let match;
    let forwarded;
    let requests = this.forwarded.get(session);
    let postData;
    const readPostData = () => postData ??= getPostData(this.send, event, session);
    // Redirect hops can reuse the same Network ID. Track the most recent leg.
    requests?.delete(networkId);
    try {
      const config = this.getConfig();
      const scenario = config.scenarios.find(item => item.id === config.activeScenarioId);
      match = await selectRule(scenario.rules, event, readPostData, config);
      if (!match) {
        const isApi = resourceType === 'Fetch' || resourceType === 'XHR';
        if (isApi && !signal.aborted) this.onForward?.(event, session);
        if (isApi && networkId && !signal.aborted) {
          if (!requests) {
            requests = this.forwarded.get(session) ?? new Map();
            this.forwarded.set(session, requests);
          }
          forwarded = { method: request.method, url: logUrl(request.url) };
          requests.set(networkId, forwarded);
          if (requests.size > trackedRequestsPerSession) requests.delete(requests.keys().next().value);
        }
        await proceed();
        if (isApi && !networkId && !signal.aborted) report('Passed through');
        return;
      }
      const { rule, preflight } = match;
      if (!preflight) await wait(rule.response.delayMs, signal);
      if (signal.aborted) {
        await proceed();
        return;
      }
      if (rule.response.kind === 'error') {
        const command = this.send('Fetch.failRequest', { requestId, errorReason: rule.response.error }, session);
        this.onMock?.(event, session, command, { ruleName: rule.name, ruleId: rule.id, scenarioId: scenario.id, error: rule.response.error, readPostData });
        await command;
        report('Network error', rule, rule.response.error);
        return;
      }
      const response = responseFor(match, request);
      const command = this.send('Fetch.fulfillRequest', {
        requestId, responseCode: response.status, responseHeaders: response.headers,
        ...(response.statusText ? { responsePhrase: response.statusText } : response.status >= 600 ? { responsePhrase: 'Mock response' } : {}),
        ...(response.body === undefined ? {} : { body: encodeBody(response.body) })
      }, session);
      this.onMock?.(event, session, command, { ...response, ruleName: rule.name, ruleId: rule.id, scenarioId: scenario.id, readPostData });
      await command;
      report(preflight ? 'Preflight mocked' : 'Mocked', rule, response.status);
    } catch {
      if (forwarded && requests.get(networkId) === forwarded) requests.delete(networkId);
      if (!match || signal.aborted) {
        await proceed().catch(() => {});
        return;
      }
      // A rejected mock must not send the matched request to the real API.
      await this.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, session).catch(() => {});
      report('Interception failed', match.rule);
    }
  }

  stop() {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  async finish() {
    this.abort.abort();
    this.forwarded.clear();
    await Promise.allSettled([...this.tasks]);
    const disable = async session => {
      await this.send('Fetch.disable', {}, session).catch(() => {});
      if (this.bypassServiceWorker) {
        await this.send('Network.setBypassServiceWorker', { bypass: false }, session).catch(() => {});
      }
      await this.send('Network.setCacheDisabled', { cacheDisabled: false }, session).catch(() => {});
    };
    await Promise.allSettled([...this.sessions].map(disable));
    if (this.autoAttach) {
      await this.send('Target.setAutoAttach', { autoAttach: false, flatten: true, waitForDebuggerOnStart: false }).catch(() => {});
    }
    this.sessions.clear();
  }
}
