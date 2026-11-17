const vscode = acquireVsCodeApi();
const pending = new Map();
let id = 0;
window.addEventListener('message', ({ data }) => {
  const item = pending.get(data?.id);
  if (!item) return;
  if (data.error) item.reject(new Error(data.error));
  else item.resolve(data.value);
});

export function request(action, data) {
  const key = ++id;
  const timeout = { import: 600000, export: 600000, start: 75000 }[action] ?? 45000;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('VS Code did not respond. Try again.')), timeout);
    pending.set(key, { resolve, reject });
    vscode.postMessage({ id: key, action, data });
  }).finally(() => {
    clearTimeout(timer);
    pending.delete(key);
  });
}

export const openFile = () => request('import');
export const saveFile = () => request('export');
