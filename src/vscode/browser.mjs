import { randomUUID } from 'node:crypto';
import { Recorder, RECORDING_NETWORK_OPTIONS } from '../chromium/recorder.mjs';
import { Interceptor } from '../core/interceptor.mjs';
import { CdpConnection, proxyUrl, withTimeout } from './cdp.mjs';

const debugName = 'Mockend Integrated Browser';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const recordingEvents = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Page.frameNavigated'];

export function createIntegratedBrowser(vscode, publish = () => {}) {
  let active;
  let notice = '';

  function tab(entry) {
    return entry ? { title: 'Integrated test browser', url: entry.url } : null;
  }

  function recordingStatus() {
    publish({ type: 'status', status: active?.recording ? 'recording' : 'stopped' });
  }

  async function stopDebugging(session) {
    if (!session) return;
    await withTimeout(vscode.debug.stopDebugging(session), 5000, 'VS Code is still closing the test browser.').catch(() => {});
  }

  function disconnected(entry, message) {
    if (active !== entry) return;
    active = undefined;
    entry.connection?.close();
    notice = message;
    recordingStatus();
    void entry.engine?.stop();
    void stopDebugging(entry.root);
  }

  const onTerminate = vscode.debug.onDidTerminateDebugSession(session => {
    if (active && (session.id === active.root?.id || session.id === active.target?.id)) {
      disconnected(active, 'The integrated test browser disconnected.');
    }
  });

  async function launch(entry) {
    const runId = randomUUID();
    const candidates = new Map();
    const started = vscode.debug.onDidStartDebugSession(session => {
      const related = session.configuration.mockrouteRunId === runId ||
        (session.parentSession && candidates.has(session.parentSession.id)) ||
        (!session.parentSession && session.type === 'editor-browser' && session.name === debugName);
      if (!related) return;
      candidates.set(session.id, session);
      if (!session.parentSession) entry.root = session;
    });

    try {
      const launched = await withTimeout(vscode.debug.startDebugging(undefined, {
        name: debugName, type: 'editor-browser', request: 'launch', url: 'about:blank',
        mockrouteRunId: runId, sourceMaps: false, skipFiles: []
      }, { suppressDebugView: true, suppressDebugStatusbar: true }), 12000, 'VS Code timed out opening the integrated browser.');
      if (!launched) throw new Error('VS Code could not launch its integrated browser debugger.');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && active === entry) {
        const sessions = [...candidates.values()].reverse();
        const results = await Promise.all(sessions.map(async session => {
          try {
            const info = await withTimeout(session.customRequest('requestCDPProxy'), 1800, 'The debugger is still starting.');
            return { session, url: proxyUrl(info) };
          } catch {
            return undefined;
          }
        }));
        const target = results.find(Boolean);
        if (target) return target;
        await sleep(250);
      }
      throw new Error('The integrated browser debugger did not provide a connection. Update VS Code and retry.');
    } finally {
      started.dispose();
    }
  }

  const platform = {
    refresh() { return active?.engine?.banner.update(''); },
    async state() {
      const available = tab(active?.ready ? active : null);
      return { mode: 'vscode', available, active: active?.ready && active.engine ? available : null, notice };
    },

    syncRecording() {
      publish({ type: 'reset', tab: tab(active) });
      recordingStatus();
    },

    pauseRecording() {
      if (active) active.recording = false;
      recordingStatus();
    },

    async body(id) {
      return active?.recorder?.body(id);
    },

    async stopMocking() {
      const entry = active;
      if (!entry?.engine) return;
      await entry.engine.stop();
      entry.engine = undefined;
    },

    async start({ url, recordingOnly }, getConfig, onActivity) {
      async function enableMocking(entry, send) {
        if (entry.engine) return;
        const engine = new Interceptor({
          send, getConfig, onActivity,
          onMock: (...args) => entry.recorder.markMock(...args),
          onForward: (...args) => entry.recorder.markForward(...args)
        });
        entry.engine = engine;
        try {
          await engine.start();
        } catch (error) {
          await engine.stop();
          entry.engine = undefined;
          throw error;
        }
      }

      if (active?.ready) {
        if (recordingOnly) {
          active.recording = true;
          recordingStatus();
        } else await enableMocking(active, active.send);
        return;
      }
      let appUrl = url;
      if (typeof appUrl !== 'string' || !appUrl.trim()) {
        appUrl = await vscode.window.showInputBox({
          title: 'Open Mockend Integrated Browser',
          prompt: 'Enter the app URL to record or mock.',
          placeHolder: 'example.com or localhost:3000',
          ignoreFocusOut: true,
          validateInput(value) {
            try { parseAppUrl(value); return undefined; }
            catch (error) { return error.message; }
          }
        });
        if (appUrl === undefined) {
          recordingStatus();
          return;
        }
      }
      const destination = parseAppUrl(appUrl);
      if (active) await platform.stop();
      const entry = { url: destination.href, ready: false, recording: true };
      active = entry;
      try {
        const { session, url: endpoint } = await launch(entry);
        if (active !== entry) throw new Error('The integrated browser closed during setup.');
        entry.target = session;
        entry.connection = new CdpConnection(endpoint, (method, params, sessionId) => {
          if (active !== entry) return;
          if (method === 'Page.frameNavigated' && !params.frame.parentId && /^https?:\/\//i.test(params.frame.url)) {
            entry.url = params.frame.url;
            publish({ type: 'site', tab: tab(entry) });
          }
          entry.engine?.event(method, params, sessionId);
          entry.recorder?.event(method, params, sessionId);
        }, () => disconnected(entry, 'Lost connection to the integrated browser.'));
        await withTimeout(entry.connection.open, 5000, 'The integrated browser connection timed out.');
        const send = (method, params, sessionId, timeout) => entry.connection.send(method,
          method === 'Network.enable' ? { ...RECORDING_NETWORK_OPTIONS, ...params } : params, sessionId, timeout);
        entry.send = send;
        entry.recorder = new Recorder(send, row => {
          if (active === entry) publish({ type: 'request', row });
        }, () => entry.recording);
        await send('JsDebug.subscribe', { events: [...recordingEvents, 'Fetch.requestPaused'] });
        await send('Page.enable').catch(() => {});
        if (recordingOnly) await send('Network.enable');
        else await enableMocking(entry, send);
        platform.syncRecording();
        const result = await send('Page.navigate', { url: destination.href }, undefined, 35000);
        if (result?.errorText) throw new Error(result.errorText);
        if (active !== entry) throw new Error('The integrated browser closed during setup.');
        entry.ready = true;
        notice = '';
      } catch (error) {
        if (active === entry) await platform.stop();
        throw new Error(`Could not open the test browser. ${error.message}`);
      }
    },

    async stop() {
      const entry = active;
      if (!entry) {
        notice = '';
        return;
      }
      active = undefined;
      recordingStatus();
      await entry.engine?.stop();
      entry.connection?.close();
      await stopDebugging(entry.root ?? entry.target);
      notice = '';
    },

    dispose() {
      onTerminate.dispose();
      return platform.stop();
    }
  };
  return platform;
}

export function parseAppUrl(input) {
  let url;
  if (typeof input === 'string') {
    const value = input.trim();
    const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/i.test(value.replace(/^\/\//, ''));
    const explicit = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^:/?#]+:\d+(?=[/?#]|$)/.test(value);
    const scheme = local ? 'http:' : 'https:';
    if (value && !/[\s\\]/.test(value)) {
      try { url = new URL(explicit ? value : scheme + (value.startsWith('//') ? value : `//${value}`)); }
      catch { /* Validated below. */ }
    }
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP(S) app URL, such as example.com or localhost:3000.');
  }
  return url;
}
