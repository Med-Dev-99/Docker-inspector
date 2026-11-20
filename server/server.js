// Local HTTP + WebSocket server that powers the UI.
// Security: binds to 127.0.0.1 only, every API/WS call needs a per-launch random token,
// and Host/Origin headers are checked to defeat DNS-rebinding / cross-site requests.
// (Access to the Docker socket is root-equivalent, so this matters.)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer } from 'ws';
import * as docker from './docker.js';
import { Hub, hostInfo } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
  '.ico': 'image/x-icon', '.map': 'application/json',
};

function readReqBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Run a command in a running container and capture its output (non-TTY). */
async function execCapture(id, cmd, { maxBytes = 4 * 1024 * 1024, user } = {}) {
  const exec = await docker.post(`/containers/${id}/exec`, {
    AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, ...(user ? { User: user } : {}),
  });
  const res = await docker.rawRequest('POST', `/exec/${exec.Id}/start`, { body: { Detach: false, Tty: false } });
  const out = { stdout: [], stderr: [], bytes: 0, truncated: false };
  await new Promise((resolve) => {
    const demux = new docker.Demuxer((stream, buf) => {
      if (out.bytes + buf.length > maxBytes) { out.truncated = true; res.destroy(); return; }
      out.bytes += buf.length;
      out[stream].push(buf);
    });
    res.on('data', (c) => demux.push(c));
    res.on('end', resolve);
    res.on('close', resolve);
    res.on('error', resolve);
  });
  let exitCode = null;
  try { exitCode = (await docker.get(`/exec/${exec.Id}/json`)).ExitCode; } catch {}
  return {
    stdout: Buffer.concat(out.stdout),
    stderr: Buffer.concat(out.stderr).toString('utf8'),
    exitCode,
    truncated: out.truncated,
  };
}

// POSIX-sh directory lister that works with coreutils and busybox.
const LS_SCRIPT = `cd -- "$1" 2>/dev/null || { echo "cannot open directory" >&2; exit 2; }
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; else t=f; fi
  meta=$(stat -c '%s|%Y|%A|%U|%G' -- "$f" 2>/dev/null || echo '0|0|----------|?|?')
  tgt=""; [ "$t" = l ] && tgt=$(readlink -- "$f" 2>/dev/null)
  printf '%s|%s|%s|%s\\n' "$t" "$meta" "$tgt" "$f"
done`;

export async function startServer({ port = 0, token = crypto.randomBytes(24).toString('hex'), devOrigin } = {}) {
  const version = await docker.init();
  const info = await docker.get('/info').catch(() => ({}));
  const hub = new Hub();
  await hub.start();

  let actualPort = port;
  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, ...(devOrigin ? [new URL(devOrigin).host] : [])]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, ...(devOrigin ? [devOrigin] : [])]);

  const tokenOk = (t) => typeof t === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts().has(req.headers.host)) { res.writeHead(421); return res.end('Misdirected'); }
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname.startsWith('/api/')) {
        if (!tokenOk(req.headers['x-di-token'])) return sendJSON(res, 401, { message: 'Unauthorized' });
        if (req.headers.origin && !allowedOrigins().has(req.headers.origin)) return sendJSON(res, 403, { message: 'Forbidden origin' });
        return await handleApi(req, res, url);
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      if (!res.headersSent) sendJSON(res, e.status || 500, { message: e.message });
      else res.end();
    }
  });

  async function handleApi(req, res, url) {
    const p = url.pathname;

    if (p === '/api/meta') {
      return sendJSON(res, 200, {
        app: { name: pkg.productName, version: pkg.version },
        socket: docker.SOCKET_PATH,
        apiVersion: docker.getApiPrefix().slice(2),
        engine: version,
      });
    }
    if (p === '/api/host') return sendJSON(res, 200, hostInfo(info.DockerRootDir));
    if (p === '/api/stats/history') return sendJSON(res, 200, hub.history());
    if (p === '/api/events/recent') return sendJSON(res, 200, hub.events.slice(-500));

    let m;
    if ((m = p.match(/^\/api\/files\/([\w.-]+)\/list$/))) {
      const dir = url.searchParams.get('path') || '/';
      const r = await execCapture(m[1], ['/bin/sh', '-c', LS_SCRIPT, 'sh', dir]);
      if (r.exitCode && r.exitCode !== 0 && !r.stdout.length) return sendJSON(res, 400, { message: r.stderr.trim() || 'Unable to list directory (no /bin/sh in this image?)' });
      const entries = r.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
        const parts = line.split('|');
        const [type, size, mtime, mode, owner, group, target] = parts;
        const name = parts.slice(7).join('|');
        return { type, size: Number(size), mtime: Number(mtime) * 1000, mode, owner, group, target, name };
      });
      return sendJSON(res, 200, { path: dir, entries });
    }
    if ((m = p.match(/^\/api\/files\/([\w.-]+)\/read$/))) {
      const file = url.searchParams.get('path');
      const r = await execCapture(m[1], ['/bin/sh', '-c', 'head -c 524288 -- "$1"', 'sh', file], { maxBytes: 600 * 1024 });
      if (r.exitCode && r.exitCode !== 0) return sendJSON(res, 400, { message: r.stderr.trim() || 'Unable to read file' });
      const buf = r.stdout;
      const binary = buf.subarray(0, 8000).includes(0);
      return sendJSON(res, 200, { path: file, binary, size: buf.length, truncated: buf.length >= 524288, content: binary ? '' : buf.toString('utf8') });
    }

    if (p.startsWith('/api/engine/')) {
      const target = p.slice('/api/engine'.length) + url.search;
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readReqBody(req) : undefined;
      const headers = {};
      if (body && body.length) headers['Content-Type'] = req.headers['content-type'] || 'application/json';
      const upstream = await docker.rawRequest(req.method, target, { body: body && body.length ? body : undefined, headers });
      const out = { 'Cache-Control': 'no-store' };
      for (const h of ['content-type', 'content-disposition']) if (upstream.headers[h]) out[h] = upstream.headers[h];
      res.writeHead(upstream.statusCode, out);
      upstream.pipe(res);
      req.on('close', () => upstream.destroy());
      return;
    }

    sendJSON(res, 404, { message: 'Not found' });
  }

  function serveStatic(pathname, res) {
    let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('UI not built. Run `npm run build` first.');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  }

  // ------------------------------------------------------------------ websocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const originOk = !req.headers.origin || allowedOrigins().has(req.headers.origin);
    if (url.pathname !== '/ws' || !allowedHosts().has(req.headers.host) || !originOk || !tokenOk(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws));
  });

  function onClient(ws) {
    const topics = new Set();
    const sessions = new Map(); // sid -> { close(), input?, resize? }
    const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

    const onStats = (snap) => topics.has('stats') && send({ type: 'stats', ...snap });
    const onEvent = (ev) => topics.has('events') && send({ type: 'event', event: ev });
    hub.on('stats', onStats);
    hub.on('event', onEvent);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { type, sid } = msg;
      try {
        switch (type) {
          case 'sub': topics.add(msg.topic); break;
          case 'unsub': topics.delete(msg.topic); break;

          case 'logs.open': {
            const c = await docker.get(`/containers/${msg.id}/json`);
            // Keep stdout/stderr chunks in arrival order so the client sees a correctly interleaved stream.
            let pending = [];
            let timer = null;
            const flush = () => {
              timer = null;
              if (pending.length) { send({ type: 'logs.data', sid, chunks: pending }); pending = []; }
            };
            const handle = docker.followLogs(msg.id, {
              tail: msg.tail ?? 500, since: msg.since, timestamps: true, follow: true, tty: !!c.Config?.Tty,
            }, (stream, text) => {
              const last = pending[pending.length - 1];
              if (last && last[0] === stream) last[1] += text; else pending.push([stream, text]);
              if (!timer) timer = setTimeout(flush, 60);
            }, () => { flush(); send({ type: 'logs.end', sid }); });
            sessions.set(sid, { close: () => { clearTimeout(timer); handle.close(); } });
            break;
          }

          case 'exec.open': {
            const cmd = msg.cmd?.length ? msg.cmd : ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; elif command -v ash >/dev/null 2>&1; then exec ash; else exec sh; fi'];
            const exec = await docker.post(`/containers/${msg.id}/exec`, {
              AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd,
              Env: ['TERM=xterm-256color', `COLUMNS=${msg.cols || 80}`, `LINES=${msg.rows || 24}`],
              ...(msg.user ? { User: msg.user } : {}),
              ...(msg.workdir ? { WorkingDir: msg.workdir } : {}),
            });
            const sock = await docker.hijackExec(exec.Id, { tty: true });
            const dec = new StringDecoder('utf8');
            let closed = false;
            const resize = (cols, rows) => docker.post(`/exec/${exec.Id}/resize?h=${rows}&w=${cols}`).catch(() => {});
            sock.on('data', (d) => send({ type: 'exec.data', sid, data: dec.write(d) }));
            const finish = async () => {
              if (closed) return;
              closed = true;
              let code = null;
              try { code = (await docker.get(`/exec/${exec.Id}/json`)).ExitCode; } catch {}
              send({ type: 'exec.exit', sid, code });
              sessions.delete(sid);
            };
            sock.on('end', finish);
            sock.on('close', finish);
            sock.on('error', finish);
            sessions.set(sid, {
              close: () => { closed = true; sock.destroy(); },
              input: (data) => sock.write(data),
              resize,
            });
            send({ type: 'exec.ready', sid, execId: exec.Id });
            if (msg.cols && msg.rows) setTimeout(() => resize(msg.cols, msg.rows), 50);
            break;
          }
          case 'exec.input': sessions.get(sid)?.input?.(msg.data); break;
          case 'exec.resize': sessions.get(sid)?.resize?.(msg.cols, msg.rows); break;

          case 'close': sessions.get(sid)?.close(); sessions.delete(sid); break;
        }
      } catch (e) {
        send({ type: 'error', sid, message: e.message });
      }
    });

    ws.on('close', () => {
      hub.off('stats', onStats);
      hub.off('event', onEvent);
      for (const s of sessions.values()) s.close();
      sessions.clear();
    });
  }

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  actualPort = server.address().port;

  return {
    port: actualPort,
    token,
    url: `http://127.0.0.1:${actualPort}/`,
    close() { hub.stop(); wss.close(); server.close(); },
  };
}
