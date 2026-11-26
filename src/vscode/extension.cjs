const vscode = require('vscode');

let app;
exports.activate = async context => {
  app = await import('./host.mjs');
  app.activate(vscode, context);
};
exports.deactivate = () => app?.deactivate();
