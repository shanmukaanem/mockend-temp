import { randomUUID } from 'node:crypto';
import { Interceptor } from '../core/interceptor.mjs';
import { CdpConnection, proxyUrl, withTimeout } from './cdp.mjs';

const debugName = 'Mockend Integrated Browser';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createIntegratedBrowser(vscode) {
  let active;
  let notice = '';

  async function stopDebugging(session) {
    if (!session) return;
    await withTimeout(vscode.debug.stopDebugging(session), 5000, 'VS Code is still closing the test browser.').catch(() => {});
  }

  function disconnected(entry, message) {
    if (active !== entry) return;
    active = undefined;
    entry.connection?.close();
    notice = message;
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
    async state() {
      return { mode: 'vscode', active: active?.ready ? { title: 'Integrated test browser', url: active.url } : null, notice };
    },

    async start({ url }, getConfig, onActivity) {
      const destination = parseAppUrl(url);
      if (active) await platform.stop();
      const entry = { url: destination.href, ready: false };
      active = entry;
      try {
        const { session, url: endpoint } = await launch(entry);
        if (active !== entry) throw new Error('The integrated browser closed during setup.');
        entry.target = session;
        entry.connection = new CdpConnection(endpoint,
          (...event) => entry.engine?.event(...event),
          () => disconnected(entry, 'Lost connection to the integrated browser.')
        );
        await withTimeout(entry.connection.open, 5000, 'The integrated browser connection timed out.');
        await entry.connection.send('JsDebug.subscribe', { events: ['Fetch.requestPaused'] });
        const send = entry.connection.send.bind(entry.connection);
        entry.engine = new Interceptor({ send, getConfig, onActivity });
        await entry.engine.start();
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
  try { if (typeof input === 'string') url = new URL(input.trim()); } catch { /* validated below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP(S) app URL, such as http://localhost:3000/.');
  }
  return url;
}
