'use strict';
const http = require('node:http');

function forwardingHeaders(headers) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
  String(headers.connection || '').split(',').forEach(token => blocked.add(token.trim().toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function reply(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: message }, null, 2) + '\n';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost:4000'); }
  catch { req.resume(); return reply(res, 400, 'Invalid URL.'); }
  const match = /^\/(books|students)(?:\/[^/]+)?$/.exec(url.pathname);
  if (!match || url.search) {
    req.resume(); return reply(res, 404, 'Route not found. Use /books or /students with an optional id.');
  }
  const port = match[1] === 'books' ? 3001 : 3002;
  const upstream = http.request({ hostname: '127.0.0.1', port,
    path: url.pathname, method: req.method, headers: forwardingHeaders(req.headers) }, backend => {
    res.writeHead(backend.statusCode, forwardingHeaders(backend.headers));
    backend.on('error', () => reply(res, 502, 'Backend response failed.'));
    backend.pipe(res);
  });
  const deadline = setTimeout(() => upstream.destroy(new Error('Backend timeout')), 5000);
  const cleanup = () => clearTimeout(deadline);
  res.on('finish', cleanup);
  res.on('close', () => { cleanup(); upstream.destroy(); });
  upstream.on('error', () => {
    cleanup();
    req.unpipe(upstream);
    req.resume();
    reply(res, 502, 'Backend service unavailable or timed out.');
  });
  req.on('aborted', () => upstream.destroy());
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
});
server.requestTimeout = 10000;
server.on('error', error => { console.error('Gateway failed:', error.message); process.exitCode = 1; });
server.listen(4000, 'localhost', () => console.log('API Gateway: http://localhost:4000'));
