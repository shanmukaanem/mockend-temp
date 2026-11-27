import { Controller } from '../core/controller.mjs';
import { Interceptor } from '../core/interceptor.mjs';
import { DebugSessions } from './debug-sessions.mjs';
import { Recorder } from './recorder.mjs';

const sessions = new DebugSessions();
const clients = new Set();
let queue = Promise.resolve();
function schedule(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

let active;
let notice = '';

const describe = tab => ({ id: tab.id, title: tab.title || 'Browser tab', url: tab.url ?? '' });
const isWeb = url => /^https?:\/\//.test(url);
const panelUrl = chrome.runtime.getURL('panel.html');
function panelContext(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return;
  const url = new URL(sender.url);
  if (url.href.split(/[?#]/, 1)[0] !== panelUrl) return;
  if (!url.searchParams.has('tab')) return {};
  const tabId = Number(url.searchParams.get('tab'));
  if (Number.isInteger(tabId) && tabId > 0 && Number.isInteger(sender.tab?.windowId)) {
    return { tabId, windowId: sender.tab.windowId };
  }
}

async function currentTab(windowId, tabId) {
  if (tabId === undefined) return (await chrome.tabs.query({ active: true, windowId }))[0];
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return tab?.windowId === windowId ? tab : undefined;
}

function recorderFor(entry) {
  entry.recorder ??= new Recorder(entry.send, row => {
    for (const client of clients) {
      const recordingHere = client.recording && client.entry === entry;
      const mockingHere = row._mocked && !client.recording && client.targetTabId === entry.target.tabId;
      if (!recordingHere && !mockingHere) continue;
      client.recorder = entry.recorder;
      client.send({ type: 'request', row });
    }
  }, () => entry.clients.size > 0);
  return entry.recorder;
}

const platform = {
  refresh() { return active?.entry.engine?.banner.update(''); },
  async state() {
    return {
      mode: 'chromium', active: active?.ready ? active.tab : null, available: null,
      notice
    };
  },

  start({ tabId }, getConfig, onActivity) {
    return schedule(async () => {
      if (!Number.isInteger(tabId)) throw new Error('Select an HTTP(S) app tab first.');
      if (active?.tab.id === tabId && active.ready) return;
      const tab = await chrome.tabs.get(tabId);
      if (!isWeb(tab.url ?? '')) throw new Error('Select an HTTP(S) app tab first.');
      await stopMocking();
      const entry = await sessions.acquire(tabId);
      if (entry.clients.size) await sessions.captureChildren(entry, false);
      const recorder = recorderFor(entry);
      const engine = new Interceptor({
        send: entry.send, getConfig, onActivity, autoAttach: true,
        onMock: (...args) => recorder.markMock(...args),
        onForward: (...args) => recorder.markForward(...args)
      });
      entry.engine = engine;
      active = { tab: describe(tab), windowId: tab.windowId, entry, ready: false };
      try {
        await engine.start();
        if (active?.entry !== entry) throw new Error('The browser disconnected during setup.');
        active.ready = true;
        notice = '';
      } catch (error) {
        if (active?.entry === entry) await stopMocking();
        throw new Error(`Could not start mocking. ${error.message}`);
      }
    });
  },

  stop() { return schedule(stopMocking); }

};

async function stopMocking() {
  if (active) {
    const { entry } = active;
    await entry.engine.stop();
    entry.engine = undefined;
    active = undefined;
    if (entry.clients.size) await sessions.captureChildren(entry, true);
    else await sessions.release(entry);
  }
  notice = '';
}

async function stopRecording(client) {
  const entry = client.entry;
  client.entry = undefined;
  if (!entry) return;
  entry.clients.delete(client);
  await sessions.release(entry);
}

async function recordCurrentTab(client) {
  if (client.closed || !client.recording) return;
  const tab = await currentTab(client.windowId, client.tabId);
  if (client.closed || !client.recording) return;
  if (client.entry && client.entry.target.tabId === tab?.id && isWeb(tab.url ?? '')) {
    client.send({ type: 'status', status: 'recording' });
    return;
  }
  await stopRecording(client);
  client.recorder = undefined;
  client.targetTabId = tab?.id;
  client.send({ type: 'reset', tab: tab && isWeb(tab.url ?? '') ? describe(tab) : null });
  if (!tab || !isWeb(tab.url ?? '')) {
    client.send({ type: 'status', status: 'waiting', message: 'Open an HTTP(S) tab to start recording.' });
    return;
  }
  try {
    const entry = await sessions.acquire(tab.id);
    if (client.closed || !client.recording) {
      await sessions.release(entry);
      return;
    }
    client.entry = entry;
    client.recorder = recorderFor(entry);
    entry.clients.add(client);
    if (!entry.engine && entry.clients.size === 1) {
      await entry.send('Network.enable', {});
      await sessions.captureChildren(entry, true);
    }
    if (client.entry === entry) client.send({ type: 'status', status: 'recording' });
  } catch (error) {
    await stopRecording(client);
    client.recording = false;
    client.send({ type: 'status', status: 'stopped', message: `Could not record this tab. ${error.message}` });
  }
}

function refreshRecording(client) {
  void schedule(() => recordCurrentTab(client)).catch(error => {
    client.send({ type: 'status', status: 'stopped', message: error.message });
  });
}

const controller = new Controller({
  platform,
  storage: {
    async get(key) { return (await chrome.storage.local.get(key))[key]; },
    set(key, value) { return chrome.storage.local.set({ [key]: value }); }
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => sessions.event(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => {
  const entry = sessions.detach(source.tabId);
  if (!entry) return;
  if (active?.entry === entry) {
    active = undefined;
    void entry.engine.stop();
    notice = reason === 'target_closed' ? 'The mocked tab closed.' : 'The browser disconnected. Start mocking to reconnect.';
  }
  for (const client of entry.clients) {
    client.entry = undefined;
    client.recording = false;
    client.send({ type: 'status', status: 'stopped', message: 'Recording stopped because Chrome disconnected the tab.' });
  }
  entry.clients.clear();
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (active?.tab.id === tabId && (change.url || change.title)) active.tab = describe(tab);
  if (change.url || change.title) for (const client of clients) {
    const followsTab = client.tabId === undefined ? tab.active : client.tabId === tabId;
    if (!followsTab || client.windowId !== tab.windowId) continue;
    if (!client.recording) {
      client.targetTabId = tabId;
      client.send({ type: 'site', tab: isWeb(tab.url ?? '') ? describe(tab) : null });
      continue;
    }
    if (client.entry?.target.tabId === tabId && isWeb(tab.url ?? '')) {
      client.send({ type: 'site', tab: describe(tab) });
    } else if (change.url) refreshRecording(client);
  }
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const previous = active;
  if (previous?.windowId === windowId && Number.isInteger(tabId) && previous.tab.id !== tabId) {
    void schedule(async () => {
      if (active !== previous) return;
      const next = await chrome.tabs.get(tabId).catch(() => undefined);
      const mockPanel = `${panelUrl}?tab=${previous.tab.id}`;
      if (next?.url !== mockPanel && next?.pendingUrl !== mockPanel) await stopMocking();
    }).catch(() => {});
  }
  for (const client of clients) {
    if (client.windowId !== windowId || client.tabId !== undefined) continue;
    if (client.recording) refreshRecording(client);
    else void currentTab(windowId).then(tab => {
      if (!client.recording && tab?.id === tabId) {
        client.targetTabId = tabId;
        client.send({ type: 'site', tab: isWeb(tab.url ?? '') ? describe(tab) : null });
      }
    }).catch(() => {});
  }
});

chrome.runtime.onConnect.addListener(port => {
  const context = panelContext(port.sender ?? {});
  if (port.name !== 'mockroute-recording' || !context) return;
  const client = { tabId: context.tabId, send(message) {
    if (!client.closed) try { port.postMessage(message); } catch { /* The panel is closing. */ }
  } };
  clients.add(client);
  port.onMessage.addListener(message => {
    if (message.type === 'start' && Number.isInteger(message.windowId)) {
      client.windowId = context.windowId ?? message.windowId;
      client.recording = true;
      refreshRecording(client);
    } else if (message.type === 'stop') {
      client.recording = false;
      void schedule(() => stopRecording(client)).then(() => {
        if (!client.recording) client.send({ type: 'status', status: 'stopped' });
      });
    } else if (message.type === 'body') {
      void Promise.resolve(client.recorder?.body(message.id)).then(body => {
        client.send({ type: 'body', token: message.token, body });
      });
    }
  });
  port.onDisconnect.addListener(() => {
    client.closed = true;
    clients.delete(client);
    void schedule(() => stopRecording(client));
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const context = panelContext(sender);
  if (!context || message?.app !== 'mockroute') return false;
  const windowId = context.windowId ?? (Number.isInteger(message.windowId) ? message.windowId : chrome.windows.WINDOW_ID_CURRENT);
  const dispatch = async () => {
    if (message.action === 'open-app') {
      const url = new URL(message.data?.url);
      if (!isWeb(url.href) || url.username || url.password) throw new Error('Enter an HTTP(S) app URL without credentials.');
      const current = await currentTab(windowId, context.tabId);
      const tab = current && isWeb(current.url ?? '') ? await chrome.tabs.update(current.id, { url: url.href })
        : await chrome.tabs.create({ windowId, url: url.href });
      const state = await controller.dispatch('state');
      state.connection.available = describe(tab);
      state.connection.active = null;
      return state;
    }
    if (message.action === 'shortcut-settings') {
      const browserUrl = /\bEdg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
      await chrome.tabs.create({ windowId, url: `${browserUrl}://extensions/shortcuts` });
      return;
    }
    if (message.action === 'open-tab') {
      const tab = await currentTab(windowId, context.tabId);
      if (!tab || !isWeb(tab.url ?? '')) throw new Error('Select an app tab before opening Mockend in a new tab.');
      await chrome.tabs.create({ windowId: tab.windowId, url: `${panelUrl}?tab=${tab.id}` });
      if (context.tabId === undefined && chrome.sidePanel.close) {
        await chrome.sidePanel.close({ windowId: tab.windowId }).catch(() => {});
        openPanels.delete(tab.windowId);
      }
      return;
    }
    if (message.action === 'start') {
      const tab = await currentTab(windowId, context.tabId);
      if (!tab || tab.id !== message.data?.tabId) throw new Error('The target tab changed. Select it again before starting.');
    }
    const state = await controller.dispatch(message.action, message.data);
    const tab = await currentTab(windowId, context.tabId).catch(() => undefined);
    state.connection.available = tab && isWeb(tab.url ?? '') ? describe(tab) : null;
    if (state.connection.active?.id !== state.connection.available?.id) state.connection.active = null;
    if (context.tabId !== undefined) {
      state.connection.standalone = true;
    }
    return state;
  };
  dispatch().then(state => sendResponse({ state }), error => sendResponse({ error: error.message }));
  return true;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const openPanels = new Set();
chrome.sidePanel.onOpened?.addListener(({ windowId }) => openPanels.add(windowId));
chrome.sidePanel.onClosed?.addListener(({ windowId }) => openPanels.delete(windowId));
chrome.windows.onRemoved?.addListener(windowId => openPanels.delete(windowId));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!['open-mockend', 'toggle-mockend-fallback', 'toggle-mockend-global'].includes(command)) return;
  try {
    const windowId = Number.isInteger(tab?.windowId) ? tab.windowId : (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
    if (!Number.isInteger(windowId)) return;
    const connected = [...clients].some(client => client.windowId === windowId && client.tabId === undefined);
    if (chrome.sidePanel.close && (openPanels.has(windowId) || (!chrome.sidePanel.onClosed && connected))) {
      await chrome.sidePanel.close({ windowId });
      openPanels.delete(windowId);
    } else {
      await chrome.sidePanel.open({ windowId });
      openPanels.add(windowId);
    }
  } catch (error) {
    console.warn('Unable to toggle Mockend panel:', error.message);
  }
});
