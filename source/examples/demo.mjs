import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 4319;
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MockRoute Checkout Demo</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f8f9fc;color:#17213a;margin:0;padding:24px}
main{max-width:640px;margin:8vh auto;background:white;border:1px solid #dbe2ef;border-radius:16px;padding:clamp(16px,5vw,40px)}
h1{margin:0;letter-spacing:-.045em;font-size:clamp(26px,6vw,42px)}
p{margin:6px 0 18px;color:#53617a}
.controls{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;border:0;background:#244cda;color:white;border-radius:7px;padding:8px 11px;cursor:pointer}
pre{white-space:pre-wrap;overflow-wrap:anywhere;border-radius:9px;padding:13px;background:#edf2ff}
</style>
</head>
<body><main>
<h1>Checkout demo</h1>
<p>Start MockRoute in this tab. Switch scenarios, then repeat a request to see the response change.</p>
<div class="controls">
<button data-action="cart">Load cart</button>
<button data-action="valid">Apply SAVE10</button>
<button data-action="expired">Apply EXPIRED</button>
</div>
<pre id="result" aria-live="polite">Choose a request above.</pre>
</main>
<script>
const result = document.querySelector('#result');
let version = 0;
for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', async () => {
    const run = ++version;
    const action = button.dataset.action;
    result.textContent = 'Loading…';
    try {
      const response = action === 'cart' ? await fetch('/api/cart') : await fetch('/api/coupon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupon: action === 'valid' ? 'SAVE10' : 'EXPIRED' })
      });
      const body = await response.json();
      if (run === version) result.textContent = 'HTTP ' + response.status + '\\n' + JSON.stringify(body, null, 2);
    } catch (error) {
      if (run === version) result.textContent = 'Request failed: ' + error.message;
    }
  });
}
</script></body></html>`;

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${host}:${port}`);
  const json = (code, body) => {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  } else if (request.method === 'GET' && pathname === '/api/cart') {
    json(200, { items: [{ id: 'live-1', name: 'Notebook', quantity: 1 }], total: 8 });
  } else if (request.method === 'POST' && pathname === '/api/coupon') {
    try {
      let contents = '';
      for await (const chunk of request) {
        contents += chunk;
        if (contents.length > 8192) {
          json(413, { message: 'Request body is too large.' });
          return;
        }
      }
      const body = JSON.parse(contents);
      json(200, { accepted: true, coupon: body?.coupon ?? null, source: 'demo server' });
    } catch {
      json(400, { message: 'Expected a JSON request body.' });
    }
  } else {
    json(404, { message: 'Route not found.' });
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Open http://${host}:${port}/ in your test browser.`));
