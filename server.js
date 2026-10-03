const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionMonitor } = require('./src/sessions');

const POLL_MS = 1500;
const HEARTBEAT_MS = 15_000;
const INDEX = path.join(__dirname, 'public', 'index.html');

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// Kill is destructive: reject other sites (DNS rebinding via Host, CSRF via a header browsers won't send cross-origin).
function isTrusted(req, port) {
  const hostOk = [`agent-hq.localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
  if (!hostOk) return false;
  return req.method === 'GET' || req.headers['x-agent-hq'] === '1';
}

function createServer(monitor) {
  const clients = new Set();
  let last = '[]';

  function poll() {
    if (!clients.size) return; // nobody watching: stay idle
    try {
      const json = JSON.stringify(monitor.snapshot());
      if (json === last) return;
      last = json;
      for (const res of clients) res.write(`data: ${json}\n\n`);
    } catch (e) {
      console.error('snapshot failed:', e);
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!isTrusted(req, server.address().port)) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/(kill|open-folder)$/);

    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, monitor.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        clients.add(res);
        last = JSON.stringify(monitor.snapshot());
        res.write(`data: ${last}\n\n`);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && action) {
        const [, id, verb] = action;
        const result = verb === 'kill' ? await monitor.kill(id) : await monitor.openFolder(id);
        poll();
        return send(res, 200, result || { ok: true });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  const timers = [
    setInterval(poll, POLL_MS),
    setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, HEARTBEAT_MS),
  ];
  server.on('close', () => timers.forEach(clearInterval));
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4319;
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const server = createServer(createSessionMonitor({ home }));
  // Launched at every login, so a second copy should bow out quietly rather than crash.
  server.on('error', e => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.log(`Agent HQ is already running on port ${port}.`);
    process.exit(0);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Agent HQ watching ${home}\n→ http://agent-hq.localhost:${port}`));
}

module.exports = { createServer, isTrusted };
