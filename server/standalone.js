// Run the backend without Electron (browser mode, development and containers).
//
//   node server/standalone.js            serve dist/ and open it in Chrome app mode
//   DI_DEV=1 node server/standalone.js   API only, fixed port + token for `vite dev`
//
// Environment (all optional):
//   DI_HOST           interface to bind            (default 127.0.0.1; the container image uses 0.0.0.0)
//   DI_PORT           TCP port                     (default random; the container image uses 7780)
//   DI_TOKEN          fixed access token, >= 16 chars (default: random on every start, printed to the log)
//   DI_ALLOWED_HOSTS  comma-separated host:port values browsers use to reach the app, e.g. localhost:7780
//   DI_NO_OPEN        do not try to open a browser window

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import { SOCKET_PATH } from './docker.js';

const dev = !!process.env.DI_DEV;
const fail = (msg) => { console.error(`[docker-inspector] ${msg}`); process.exit(1); };

const token = dev ? 'dev-token-dev-token-dev-token-dev-token-dev-token' : (process.env.DI_TOKEN || undefined);
if (!dev && token !== undefined && token.length < 16) {
  fail('DI_TOKEN is too short: use at least 16 characters, e.g. `openssl rand -hex 24`.');
}
const extraHosts = (process.env.DI_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
const port = Number(process.env.DI_PORT || (dev ? 7781 : 0));
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`Invalid DI_PORT "${process.env.DI_PORT}".`);

let srv;
try {
  srv = await startServer({
    port,
    host: process.env.DI_HOST || '127.0.0.1',
    token,
    devOrigin: dev ? 'http://localhost:5173' : undefined,
    extraHosts,
  });
} catch (e) {
  let hint = '';
  if (/EACCES|EPERM/.test(e.message) && SOCKET_PATH.startsWith('/')) {
    // Most common container problem: the process is not in the socket's group.
    try {
      const st = fs.statSync(SOCKET_PATH);
      hint = `\n  ${SOCKET_PATH} is owned by uid ${st.uid} / gid ${st.gid} (mode ${(st.mode & 0o777).toString(8)}); ` +
        `this process runs as uid ${process.getuid()} / gid ${process.getgid()} (groups: ${process.getgroups().join(', ') || 'none'}).` +
        `\n  In Docker Compose set DOCKER_GID=${st.gid} in .env so the container user joins that group.`;
    } catch {}
  } else if (/ENOENT|ECONNREFUSED/.test(e.message)) {
    hint = `\n  Is the Docker engine running and reachable at ${SOCKET_PATH}? (override with DOCKER_HOST)`;
  }
  fail(`Cannot start: ${e.message}${hint}`);
}

// The address a browser should use: the first allowed public host if given, else the bound address.
const base = extraHosts.length ? `http://${extraHosts[0]}/` : srv.url;
const appUrl = `${base}?t=${srv.token}`;

if (dev) {
  console.log(`[docker-inspector] API listening on ${srv.url} (dev mode)`);
} else {
  console.log(`[docker-inspector] Listening on port ${srv.port}${process.env.DI_HOST ? ` (${process.env.DI_HOST})` : ''}`);
  console.log(`[docker-inspector] Open ${appUrl}`);
  if (!process.env.DI_TOKEN) console.log('[docker-inspector] The token is random and changes on every start. Set DI_TOKEN for a stable URL.');
  if (!process.env.DI_NO_OPEN) {
    for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser']) {
      try {
        const p = spawn(bin, [`--app=${appUrl}`, '--class=DockerInspector'], { detached: true, stdio: 'ignore' });
        p.on('error', () => {});
        p.unref();
        break;
      } catch {}
    }
  }
}

const stop = () => { srv.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
