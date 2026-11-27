import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntegratedBrowser } from '../src/vscode/browser.mjs';
import { starterConfig } from '../src/core/config.mjs';

function events() {
  const callbacks = new Set();
  return {
    listen(callback) {
      callbacks.add(callback);
      return { dispose: () => callbacks.delete(callback) };
    },
    emit(...args) { return [...callbacks].map(callback => callback(...args)); }
  };
}

function cartRequest(requestId = 'cart-1') {
  return {
    requestId, resourceType: 'Fetch',
    request: { method: 'GET', url: 'http://127.0.0.1:4319/api/cart' }
  };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('Chromium host starts only the selected tab, reloads scenarios, and handles child targets', async () => {
  const oldChrome = globalThis.chrome;
  const listeners = Object.fromEntries(['message', 'detach', 'event', 'updated', 'connect', 'activated', 'command'].map(key => [key, events()]));
  const commands = [];
  const openedPanels = [];
  const openedTabs = [];
  const closedPanels = [];
  const stored = { 'mockroute.configuration.v1': starterConfig() };
  const tab = { id: 32, windowId: 4, url: 'http://127.0.0.1:4319/', title: 'Checkout' };
  const extensionUrl = path => `chrome-extension://fixture/${path}`;
  const panelUrl = extensionUrl('panel.html');
  const otherTab = { ...tab, id: 41 };
  let selectedTab = tab;
  globalThis.chrome = {
    windows: { WINDOW_ID_CURRENT: -2, getLastFocused: async () => ({ id: 4 }) },
    sidePanel: { setPanelBehavior: async () => {}, open: async options => openedPanels.push(options), close: async options => {
      closedPanels.push(options);
    } },
    commands: { onCommand: { addListener: listeners.command.listen } },
    storage: { local: {
      get: async key => ({ [key]: stored[key] }),
      set: async changes => Object.assign(stored, structuredClone(changes))
    } },
    runtime: {
      id: 'fixture', getURL: extensionUrl,
      onMessage: { addListener: listeners.message.listen }, onConnect: { addListener: listeners.connect.listen }
    },
    tabs: {
      create: async options => openedTabs.push(options),
      query: async () => [selectedTab], get: async id => id === otherTab.id ? otherTab : tab,
      onUpdated: { addListener: listeners.updated.listen }, onActivated: { addListener: listeners.activated.listen }
    },
    debugger: {
      attach: async target => commands.push({ target, method: 'attach' }),
      detach: async target => commands.push({ target, method: 'detach' }),
      sendCommand: async (target, method, params) => {
        commands.push({ target, method, params });
        if (method === 'Network.getResponseBody') return { body: '{"recorded":true}', base64Encoded: false };
      },
      onEvent: { addListener: listeners.event.listen },
      onDetach: { addListener: listeners.detach.listen }
    }
  };
  const request = (action, data, sender = { id: 'fixture', url: panelUrl }) => new Promise((resolve, reject) => {
    listeners.message.emit({ app: 'mockroute', windowId: 4, action, data },
      sender,
      response => response.error ? reject(new Error(response.error)) : resolve(response.state));
  });
  try {
    await import('../src/chromium/background.mjs');
    listeners.command.emit('other-command', { windowId: 4 });
    await Promise.all(listeners.command.emit('open-mockend', { windowId: 4 }));
    await Promise.all(listeners.command.emit('toggle-mockend-global'));
    await Promise.all(listeners.command.emit('toggle-mockend-global'));
    listeners.message.emit({ app: 'mockroute', action: 'page-shortcut' }, { id: 'fixture', url: tab.url, tab }, () => {});
    listeners.message.emit({ app: 'mockroute', action: 'page-shortcut' }, { id: 'different', url: tab.url, tab }, () => {});
    assert.deepEqual(openedPanels, [{ windowId: 4 }, { windowId: 4 }]);
    assert.deepEqual(closedPanels, [{ windowId: 4 }]);
    closedPanels.length = 0;
    const [handled] = listeners.message.emit({ app: 'mockroute', action: 'state' }, { id: 'different', url: panelUrl }, () => assert.fail());
    assert.equal(handled, false);
    const initial = await request('state');
    assert.equal(initial.connection.available.id, tab.id);
    await request('open-tab');
    assert.deepEqual(openedTabs, [{ windowId: 4, url: panelUrl + '?tab=32' }]);
    assert.deepEqual(closedPanels, [{ windowId: 4 }]);
    await request('shortcut-settings');
    assert.deepEqual(openedTabs.at(-1), { windowId: 4, url: 'chrome://extensions/shortcuts' });
    listeners.command.emit('toggle-mockend-fallback', { windowId: 4 });
    await nextTurn();
    assert.deepEqual(openedPanels.at(-1), { windowId: 4 });
    listeners.command.emit('toggle-mockend-fallback', { windowId: 4 });
    await nextTurn();
    assert.deepEqual(closedPanels, [{ windowId: 4 }, { windowId: 4 }]);
    selectedTab = otherTab;
    const standalone = { id: 'fixture', url: openedTabs[0].url, tab: { windowId: 4 } };
    const standaloneState = await request('state', {}, standalone);
    assert.equal(standaloneState.connection.standalone, true);
    assert.equal(standaloneState.connection.available.id, tab.id);
    await assert.rejects(request('start', { tabId: otherTab.id }, standalone), /target tab changed/);
    selectedTab = tab;
    const incoming = events();
    const disconnected = events();
    const recorded = [];
    listeners.connect.emit({
      name: 'mockroute-recording', sender: { id: 'fixture', url: panelUrl },
      onMessage: { addListener: incoming.listen }, onDisconnect: { addListener: disconnected.listen },
      postMessage: message => recorded.push(message)
    });
    incoming.emit({ type: 'start', windowId: 4 });
    await nextTurn();
    assert.equal(recorded.at(-1).status, 'recording');
    const acknowledgements = recorded.filter(message => message.type === 'status').length;
    incoming.emit({ type: 'start', windowId: 4 });
    await nextTurn();
    assert.equal(recorded.filter(message => message.type === 'status').length, acknowledgements + 1, 'Repeated starts acknowledge the current state instead of leaving the control pending');
    assert.equal(recorded.at(-1).status, 'recording');
    const navigated = { ...tab, active: true, url: 'https://opstrellis.com/' };
    listeners.updated.emit(tab.id, { url: navigated.url }, navigated);
    assert.equal(recorded.at(-1).type, 'site');
    assert.equal(recorded.at(-1).tab.url, navigated.url);
    assert.equal(recorded.filter(message => message.type === 'reset').length, 1);
    assert.ok(commands.some(call => call.method === 'Network.enable' && call.params.maxResourceBufferSize >= 4 * 1024 * 1024));
    assert.ok(!commands.some(call => call.method === 'Fetch.enable'));
    const source = { tabId: tab.id };
    listeners.event.emit(source, 'Network.requestWillBeSent', { ...cartRequest('request'), type: 'Fetch' });
    listeners.event.emit(source, 'Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'application/octet-stream' } });
    listeners.event.emit(source, 'Network.loadingFinished', { requestId: 'request' });
    await nextTurn();
    const row = recorded.find(message => message.type === 'request').row;
    assert.equal(row.response.status, 200);
    incoming.emit({ type: 'body', id: row.id, token: 1 });
    await nextTurn();
    assert.equal(recorded.at(-1).body.text, '{"recorded":true}');
    await assert.rejects(request('start', { tabId: 4 }), /target tab changed/);
    assert.equal((await request('start', { tabId: tab.id }, standalone)).connection.active.id, tab.id);

    listeners.event.emit({ tabId: 99 }, 'Fetch.requestPaused', cartRequest('outside'));
    listeners.event.emit({ tabId: tab.id }, 'Target.attachedToTarget', { sessionId: 'frame', waitingForDebugger: true });
    await nextTurn();
    assert.ok(commands.some(call => call.target.sessionId === 'frame' && call.method === 'Runtime.runIfWaitingForDebugger'));
    listeners.event.emit({ tabId: tab.id, sessionId: 'frame' }, 'Fetch.requestPaused', cartRequest('in-frame'));
    await nextTurn();
    const mock = commands.find(call => call.method === 'Fetch.fulfillRequest');
    assert.equal(mock.params.requestId, 'in-frame');
    assert.equal(mock.target.sessionId, 'frame');
    assert.equal(JSON.parse(Buffer.from(mock.params.body, 'base64')).items[0].name, 'Canvas tote');
    const snapshot = await request('state');
    assert.equal(snapshot.activity[0].outcome, 'Mocked');
    const small = await request('state', { revision: snapshot.revision, activityVersion: snapshot.activityVersion });
    assert.ok(!Object.hasOwn(small, 'config') && !Object.hasOwn(small, 'activity'));

    incoming.emit({ type: 'stop' });
    await nextTurn();
    const sendNetworkResult = (requestId, mock) => {
      const event = cartRequest(requestId);
      listeners.event.emit(source, 'Network.requestWillBeSent', { ...event, type: 'Fetch' });
      if (mock) listeners.event.emit(source, 'Fetch.requestPaused', { ...event, networkId: requestId });
    };
    sendNetworkResult('mock-while-paused', true);
    sendNetworkResult('unmocked-while-paused', false);
    await nextTurn();
    for (const requestId of ['mock-while-paused', 'unmocked-while-paused']) {
      listeners.event.emit(source, 'Network.responseReceived', { requestId, response: { status: 200, mimeType: 'application/json' } });
      listeners.event.emit(source, 'Network.loadingFinished', { requestId });
    }
    await nextTurn();
    const requests = recorded.filter(message => message.type === 'request').map(message => message.row);
    assert.deepEqual(requests.map(row => row._mocked), [undefined, true, true]);
    assert.equal(requests[1]._mockRule, 'Cart with items');
    assert.equal(requests[1]._mockRuleId, 'filled');
    assert.equal(requests[1]._mockScenarioId, 'checkout');
    incoming.emit({ type: 'body', id: requests[1].id, token: 2 });
    await nextTurn();
    assert.equal(JSON.parse(recorded.at(-1).body.text).items[0].name, 'Canvas tote');
    incoming.emit({ type: 'start', windowId: 4 });
    await nextTurn();

    const changed = structuredClone(snapshot.config);
    changed.activeScenarioId = 'offline';
    changed.scenarios[2].rules[0].response.delayMs = 0;
    await request('save', { config: changed, revision: snapshot.revision });
    listeners.event.emit({ tabId: tab.id }, 'Fetch.requestPaused', cartRequest('failure'));
    await nextTurn();
    assert.ok(commands.some(call => call.method === 'Fetch.failRequest' && call.params.errorReason === 'InternetDisconnected'));
    assert.equal(stored['mockroute.configuration.v1'].applications[0].config.activeScenarioId, 'offline');
    assert.equal((await request('stop')).connection.active, null);
    assert.ok(commands.some(call => call.method === 'Fetch.disable'));
    assert.ok(!commands.some(call => call.method === 'detach'));
    assert.equal(commands.filter(call => call.method === 'attach').length, 1);
    selectedTab = otherTab;
    listeners.activated.emit({ windowId: 4 });
    await nextTurn();
    assert.ok(commands.some(call => call.method === 'detach' && call.target.tabId === tab.id));
    assert.ok(commands.some(call => call.method === 'attach' && call.target.tabId === otherTab.id));
    await request('start', { tabId: otherTab.id });
    selectedTab = tab;
    listeners.activated.emit({ tabId: tab.id, windowId: 4 });
    await nextTurn();
    assert.equal((await request('state')).connection.active, null);
    assert.ok(commands.some(call => call.method === 'Fetch.disable' && call.target.tabId === otherTab.id));
    disconnected.emit();
    await nextTurn();
    assert.equal(commands.at(-1).method, 'detach');
    assert.equal(commands.at(-1).target.tabId, tab.id);
  } finally {
    globalThis.chrome = oldChrome;
  }
});

test('VS Code host subscribes before navigation, mocks the first request, and closes its own session', async () => {
  const oldSocket = globalThis.WebSocket;
  const started = events();
  const terminated = events();
  const calls = [];
  const activity = [];
  const publications = [];
  let socket;
  let root;
  class DebugSocket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    constructor(url) {
      super();
      socket = this;
      assert.equal(url.href, 'ws://127.0.0.1:9001/session-token');
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(text) {
      const { id, method, params } = JSON.parse(text);
      calls.push({ method, params });
      queueMicrotask(() => {
        if (method === 'Page.navigate') this.message({ method: 'Fetch.requestPaused', params: cartRequest('startup') });
        const result = method === 'Network.getResponseBody' ? { body: '{"recorded":true}' } : {};
        this.message({ id, result });
      });
    }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  globalThis.WebSocket = DebugSocket;
  let promptResult;
  let prompts = 0;
  const vscode = { window: {
    async showInputBox(options) {
      prompts++;
      assert.equal(options.title, 'Open Mockend Integrated Browser');
      assert.equal(options.validateInput('localhost:3000'), undefined);
      assert.match(options.validateInput('file:///tmp/app'), /HTTP\(S\)/);
      return promptResult;
    }
  }, debug: {
    onDidStartDebugSession: started.listen,
    onDidTerminateDebugSession: terminated.listen,
    async startDebugging(_workspace, config) {
      assert.equal(config.type, 'editor-browser');
      assert.equal(config.url, 'about:blank');
      root = { id: 'root', type: config.type, name: config.name, configuration: config,
        customRequest: async () => { throw new Error('No browser thread at root'); }
      };
      const target = {
        id: 'tab', configuration: {}, parentSession: root,
        async customRequest(method) {
          assert.equal(method, 'requestCDPProxy');
          return { host: '127.0.0.1', port: 9001, path: '/session-token' };
        }
      };
      started.emit(root);
      started.emit(target);
      return true;
    },
    async stopDebugging(session) {
      assert.equal(session, root);
      calls.push({ method: 'stopDebugging' });
      terminated.emit(session);
    }
  } };
  const browser = createIntegratedBrowser(vscode, entry => publications.push(entry));
  try {
    await browser.start({ url: '', recordingOnly: true }, starterConfig, () => {});
    assert.equal((await browser.state()).available, null);
    assert.equal(calls.length, 0);
    assert.equal(publications.at(-1).status, 'stopped');
    promptResult = 'http://127.0.0.1:4319/';
    await browser.start({ url: ' ' }, starterConfig, row => activity.push(row));
    assert.equal(prompts, 2);
    await nextTurn();
    assert.equal((await browser.state()).active.url, 'http://127.0.0.1:4319/');
    const methods = calls.map(call => call.method);
    assert.ok(methods.indexOf('JsDebug.subscribe') < methods.indexOf('Fetch.enable'));
    assert.ok(methods.indexOf('Fetch.enable') < methods.indexOf('Page.navigate'));
    assert.equal(calls.find(call => call.method === 'Fetch.fulfillRequest').params.requestId, 'startup');
    assert.equal(activity[0].outcome, 'Mocked');
    const mocked = publications.find(({ row }) => row?._mocked)?.row;
    assert.equal(mocked._mockRule, 'Cart with items');
    assert.ok((await browser.body(mocked.id)).text.includes('mock-1'));
    await browser.stopMocking();
    assert.equal((await browser.state()).active, null);
    assert.ok((await browser.state()).available);
    const sendRequest = requestId => {
      socket.message({ method: 'Network.requestWillBeSent', params: { ...cartRequest(requestId), type: 'Fetch' } });
      socket.message({ method: 'Network.responseReceived', params: { requestId, response: { status: 200, mimeType: 'application/json' } } });
      socket.message({ method: 'Network.loadingFinished', params: { requestId } });
    };
    browser.pauseRecording();
    sendRequest('paused');
    await nextTurn();
    assert.equal(publications.filter(({ type }) => type === 'request').length, 1);
    await browser.start({ recordingOnly: true }, starterConfig, () => {});
    assert.equal(prompts, 2, 'An existing browser session should be reused without a URL prompt');
    sendRequest('unmocked');
    await nextTurn();
    const recorded = publications.filter(({ type }) => type === 'request').at(-1).row;
    assert.equal((await browser.body(recorded.id)).text, '{"recorded":true}');
    assert.equal(calls.filter(call => call.method === 'Page.navigate').length, 1);
    await browser.stop();
    assert.equal(calls.at(-1).method, 'stopDebugging');
    assert.equal((await browser.state()).active, null);
  } finally {
    await browser.dispose();
    globalThis.WebSocket = oldSocket;
  }
});
