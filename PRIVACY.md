# Mockend privacy policy

Effective November 26, 2026.

Mockend is a local API recording and mocking developer tool. It does not operate a hosted service, send telemetry, show ads, sell data, or transmit recordings or configuration to its developer.

When you connect a browser tab, Mockend can read request URLs, methods, headers, bodies, response headers and bodies, and tab titles. These can contain credentials, personal information, and other sensitive data. Mockend processes them on your computer to display traffic and match or replace responses. Your app continues to contact its configured servers for requests that are not mocked.

Saved mock rules, Flows, and Env settings use the browser's local extension storage or VS Code's local extension storage. Request history and view preferences use local IndexedDB and local storage in the browser extension or VS Code webview when that storage is available. If persistent storage is unavailable, recording data is kept for the current session. Browser recording buffers are bounded; use Clear to remove records. Delete rules, Flows, and Env entries in the interface to remove saved configuration. Storage cleanup on uninstall depends on the browser or editor. Clear saved data before uninstalling if you need it removed; exported files remain wherever you saved them.

App profiles store their names, optional launch URLs, Envs, Flows, and settings locally. Request histories are separated by app profile and origin. Merge and split actions rearrange this local configuration; complete workspace backups contain every app. On upgrading older configurations, Mockend retains the original configuration in local extension storage when a backup write succeeds. This backup is not sent anywhere and remains until local extension data is cleared.

Data leaves Mockend only when you choose to copy, download, export, or share it. Postman transfers generate local files or clipboard content; they do not sign in to or upload to Postman. Review exported content before sharing it. Mockend omits common credential headers in recorded-request exports, but this is not a guarantee that an export contains no secrets.

The browser permissions support these features: debugger attaches recording and response interception to the selected tab; tabs identifies that tab; storage saves local settings; sidePanel displays the interface; clipboardWrite supports explicit copy actions. All executable extension code is bundled locally.

For questions, open an issue at https://github.com/shanmukaanem/mockend-temp/issues. Avoid including credentials or private recordings in public issues.
