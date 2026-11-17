let windowId;
export async function request(action, data) {
  windowId ??= (await chrome.windows.getCurrent()).id;
  const reply = await chrome.runtime.sendMessage({ app: 'mockroute', windowId, action, data });
  if (!reply) throw new Error('Mockend did not receive a response from its background process.');
  if (reply.error) throw new Error(reply.error);
  return reply.state;
}

export async function saveFile(filename, contents, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
