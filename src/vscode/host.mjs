import { randomBytes } from 'node:crypto';
import { Controller } from '../core/controller.mjs';
import { MAX_CONFIG_BYTES, exportConfig } from '../core/config.mjs';
import { createIntegratedBrowser } from './browser.mjs';

let platform;

export function activate(vscode, context) {
  let panel;
  const publish = recording => { void panel?.postMessage({ recording }); };
  platform = createIntegratedBrowser(vscode, publish);
  const controller = new Controller({
    platform,
    storage: {
      get: key => context.globalState.get(key),
      set: (key, value) => context.globalState.update(key, value)
    }
  });
  const provider = {
    async resolveWebviewView(view) {
      const webview = view.webview;
      panel = webview;
      const base = context.extensionUri;
      webview.options = { enableScripts: true, localResourceRoots: [base] };
      const file = vscode.Uri.joinPath(base, 'panel.html');
      const nonce = randomBytes(24).toString('base64');
      const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      const root = webview.asWebviewUri(base).toString().replace(/\/$/, '');
      webview.html = source.replaceAll('@@ROOT@@', root).replaceAll('@@SOURCE@@', webview.cspSource)
        .replaceAll('@@NONCE@@', nonce).replaceAll('@@HOST@@', 'vscode');
      const receiver = webview.onDidReceiveMessage(async message => {
        if (!Number.isSafeInteger(message?.id) || typeof message.action !== 'string') return;
        try {
          if (message.action === 'recording') {
            const { type, url, id, token } = message.data;
            if (type === 'sync') platform.syncRecording();
            if (type === 'start') await controller.dispatch('start', { url, recordingOnly: true });
            if (type === 'stop') platform.pauseRecording();
            if (type === 'body') publish({ type: 'body', token, body: await platform.body(id) });
            await webview.postMessage({ id: message.id, value: true });
          } else if (message.action === 'open-app') {
            await platform.stop();
            const value = await controller.dispatch('start', { url: message.data.url, recordingOnly: true });
            await webview.postMessage({ id: message.id, value });
          } else if (message.action === 'download') {
            const { name, text } = message.data;
            if (!/^mock(?:end|route)[\w.-]*\.(json|js)$/.test(name) || typeof text !== 'string') throw new Error('Invalid download.');
            const path = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), name),
              filters: name.endsWith('.js') ? { JavaScript: ['js'] } : { JSON: ['json'] }
            });
            if (path) await vscode.workspace.fs.writeFile(path, new TextEncoder().encode(text));
            await webview.postMessage({ id: message.id, value: Boolean(path) });
          } else if (message.action === 'clipboard') {
            await vscode.env.clipboard.writeText(message.data.text);
            await webview.postMessage({ id: message.id, value: true });
          } else if (message.action === 'copy-scenarios') {
            const state = await controller.dispatch('state');
            await vscode.env.clipboard.writeText(exportConfig(state.config));
            await webview.postMessage({ id: message.id, value: true });
          } else if (message.action === 'import') {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } });
            if (files?.[0] && (await vscode.workspace.fs.stat(files[0])).size > MAX_CONFIG_BYTES) throw new Error('The configuration file exceeds 4 MiB.');
            const value = files?.[0] ? new TextDecoder().decode(await vscode.workspace.fs.readFile(files[0])) : undefined;
            await webview.postMessage({ id: message.id, value });
          } else {
            const value = await controller.dispatch(message.action, message.data);
            await webview.postMessage({ id: message.id, value });
          }
        } catch (error) {
          await webview.postMessage({ id: message.id, error: error.message });
        }
      });
      view.onDidDispose(() => {
        if (panel === webview) panel = undefined;
        receiver.dispose();
      });
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mockend.control', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('mockend.open', () => vscode.commands.executeCommand('mockend.control.focus')),
    vscode.commands.registerCommand('mockend.stop', () => controller.dispatch('stop'))
  );
}

export function deactivate() {
  return platform?.dispose();
}
