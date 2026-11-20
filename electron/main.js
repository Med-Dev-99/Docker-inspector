// Electron entry point: starts the local backend in-process and opens a frameless,
// macOS-styled window pointed at it.

import { app, BrowserWindow, ipcMain, shell, nativeTheme, Notification, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.resolve(__dirname, '../build/icon.png');

app.setName('Docker Inspector');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let srv = null;

async function createWindow() {
  const shotDir = process.env.DI_SHOT; // screenshot mode used for automated visual checks
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    title: 'Docker Inspector',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: !!shotDir,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);

  const devUrl = process.env.DI_DEV_URL;
  const target = devUrl ? `${devUrl}?t=${srv.token}` : `${srv.url}?t=${srv.token}`;

  // Keep navigation inside the app; open everything else in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(srv.url) && !(devUrl && url.startsWith(devUrl))) { e.preventDefault(); shell.openExternal(url); }
  });

  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  win.on('enter-full-screen', () => win.webContents.send('win:maximized', true));
  win.on('leave-full-screen', () => win.webContents.send('win:maximized', false));
  win.on('focus', () => win.webContents.send('win:focused', true));
  win.on('blur', () => win.webContents.send('win:focused', false));
  win.once('ready-to-show', () => { if (!shotDir) win.show(); });

  await win.loadURL(target);
  if (shotDir) runScreenshots(shotDir);
}

async function runScreenshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Entries are newline- (or comma-) separated; "route@@js" runs a snippet before capturing.
  const raw = process.env.DI_SHOT_ROUTES || '/';
  const routes = raw.includes('\n') ? raw.split('\n').filter(Boolean) : raw.split(',');
  const theme = process.env.DI_SHOT_THEME;
  if (theme) nativeTheme.themeSource = theme;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);
  for (const [i, entry] of routes.entries()) {
    const [r, js] = entry.split('@@');
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + r)}; void 0`);
    await wait(Number(process.env.DI_SHOT_WAIT || 2200));
    if (js) {
      const code = js.startsWith('file:') ? fs.readFileSync(js.slice(5), 'utf8') : js;
      try { await win.webContents.executeJavaScript(`(async () => { ${code} })().then(() => undefined, (e) => console.error(e))`); }
      catch (e) { console.error('screenshot snippet failed:', e.message); }
      await wait(900);
    }
    const img = await win.webContents.capturePage();
    const name = `${String(i).padStart(2, '0')}-${r.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'root'}.png`;
    fs.writeFileSync(path.join(dir, name), img.toPNG());
  }
  app.quit();
}

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:toggle-maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => win?.close());
ipcMain.handle('win:is-maximized', () => !!win?.isMaximized());
ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, icon: fs.existsSync(ICON) ? ICON : undefined, silent: true }).show();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  try {
    const devUrl = process.env.DI_DEV_URL;
    srv = devUrl
      // Dev: fixed port + token so the Vite dev server can proxy /api and /ws to us.
      ? await startServer({ port: 7781, token: 'dev-token-dev-token-dev-token-dev-token-dev-token', devOrigin: new URL(devUrl).origin })
      : await startServer({ port: 0 });
  } catch (e) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('Cannot connect to Docker',
      `Docker Inspector could not reach the Docker Engine.\n\n${e.message}\n\nMake sure Docker is running and your user is in the "docker" group.`);
    app.quit();
    return;
  }
  await createWindow();
});

app.on('window-all-closed', () => { srv?.close(); app.quit(); });
