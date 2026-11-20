// Run the backend without Electron (browser mode / development).
//   node server/standalone.js            -> serves dist/ and opens it in Chrome app mode
//   DI_DEV=1 node server/standalone.js   -> API only, fixed port + token for `vite dev`

import { spawn } from 'node:child_process';
import { startServer } from './server.js';

const dev = !!process.env.DI_DEV;
const srv = await startServer({
  port: Number(process.env.DI_PORT || (dev ? 7781 : 0)),
  token: dev ? 'dev-token-dev-token-dev-token-dev-token-dev-token' : undefined,
  devOrigin: dev ? 'http://localhost:5173' : undefined,
});

const appUrl = `${srv.url}?t=${srv.token}`;
if (dev) {
  console.log(`[docker-inspector] API listening on ${srv.url} (dev mode)`);
} else {
  console.log(`[docker-inspector] Open ${appUrl}`);
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

process.on('SIGINT', () => { srv.close(); process.exit(0); });
process.on('SIGTERM', () => { srv.close(); process.exit(0); });
