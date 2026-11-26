import { RECORDING_NETWORK_OPTIONS } from './recorder.mjs';

// One debugger attachment per tab serves both the recorder and mock engine.
export class DebugSessions {
  entries = new Map();

  async acquire(tabId) {
    let entry = this.entries.get(tabId);
    if (entry) return entry;
    const target = { tabId };
    entry = {
      target, clients: new Set(),
      send: (method, params, sessionId) => {
        if (this.entries.get(tabId) !== entry) return Promise.reject(new Error('The browser tab is disconnected.'));
        const options = method === 'Network.enable'
          ? { ...RECORDING_NETWORK_OPTIONS, ...params }
          : params;
        return chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : target, method, options);
      }
    };
    await chrome.debugger.attach(target, '1.3');
    this.entries.set(tabId, entry);
    return entry;
  }

  async release(entry) {
    const { tabId } = entry.target;
    if (entry.engine || entry.clients.size || this.entries.get(tabId) !== entry) return;
    this.entries.delete(tabId);
    await chrome.debugger.detach(entry.target).catch(() => {});
  }

  async captureChildren(entry, enabled) {
    await entry.send('Target.setAutoAttach', { autoAttach: enabled, flatten: true, waitForDebuggerOnStart: false,
      filter: [{ type: 'iframe' }, { type: 'worker' }, { type: 'shared_worker' }, { exclude: true }] }).catch(() => {});
  }

  event(source, method, params) {
    const entry = this.entries.get(source.tabId);
    if (!entry) return;
    if (entry.engine) entry.engine.event(method, params, source.sessionId);
    else if (entry.clients.size && method === 'Target.attachedToTarget') {
      void entry.send('Network.enable', {}, params.sessionId).catch(() => {});
    }
    entry.recorder?.event(method, params, source.sessionId);
  }

  detach(tabId) {
    const entry = this.entries.get(tabId);
    this.entries.delete(tabId);
    return entry;
  }
}
