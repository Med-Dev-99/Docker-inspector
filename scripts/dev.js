// Development: Vite (hot reload) + Electron, with the backend running inside Electron on :7781.
import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const vite = spawn('npx', ['vite'], { stdio: ['ignore', 'pipe', 'inherit'], env });
let started = false;
vite.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (!started && /Local:/.test(d.toString())) {
    started = true;
    const el = spawn('npx', ['electron', '.'], { stdio: 'inherit', env: { ...env, DI_DEV_URL: 'http://localhost:5173/' } });
    el.on('exit', () => { vite.kill(); process.exit(0); });
  }
});
process.on('SIGINT', () => { vite.kill(); process.exit(0); });
