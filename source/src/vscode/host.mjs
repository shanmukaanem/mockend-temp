import { randomBytes } from 'node:crypto';
import { Controller } from '../core/controller.mjs';
import { MAX_CONFIG_BYTES, exportConfig } from '../core/config.mjs';
import { createIntegratedBrowser } from './browser.mjs';

let platform;

export function activate(vscode, context) {
  platform = createIntegratedBrowser(vscode);
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
          if (message.action === 'export') {
            const path = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), 'mockroute-scenarios.json'), filters: { JSON: ['json'] }
            });
            const state = await controller.dispatch('state');
            if (path) await vscode.workspace.fs.writeFile(path, new TextEncoder().encode(exportConfig(state.config)));
            await webview.postMessage({ id: message.id, value: Boolean(path) });
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
      view.onDidDispose(() => receiver.dispose());
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mockroute.control', provider),
    vscode.commands.registerCommand('mockroute.open', () => vscode.commands.executeCommand('mockroute.control.focus')),
    vscode.commands.registerCommand('mockroute.stop', () => controller.dispatch('stop'))
  );
}

export function deactivate() {
  return platform?.dispose();
}
