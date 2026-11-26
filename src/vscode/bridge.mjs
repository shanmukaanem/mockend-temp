const vscode = acquireVsCodeApi();
const pending = new Map();
let onRecording;
let id = 0;
window.addEventListener('message', ({ data }) => {
  if (data?.recording) onRecording?.(data.recording);
  const item = pending.get(data?.id);
  if (!item) return;
  if (data.error) item.reject(new Error(data.error));
  else item.resolve(data.value);
});

export function request(action, data) {
  const key = ++id;
  const timeout = { import: 600000, download: 600000, start: 600000, recording: 600000, 'open-app': 75000 }[action] ?? 45000;
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
export const saveFile = (name, text) => request('download', { name, text });
export const copyToClipboard = text => request('clipboard', { text });
export const connectRecording = onMessage => {
  onRecording = onMessage;
  return { postMessage: data => request('recording', data) };
};
