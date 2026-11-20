// Electron entry point: starts the local backend in-process and opens a frameless,
// macOS-styled window pointed at it. Keeps monitoring from the tray when the window is closed,
// so history and crash reports are recorded even when nobody is looking.

import { app, BrowserWindow, ipcMain, shell, nativeTheme, Notification, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.resolve(__dirname, '../build/icon.png');
const TRAY_ICON = path.resolve(__dirname, '../build/icons/32x32.png');
const LAUNCHER = path.resolve(__dirname, '../scripts/launch.sh');
const AUTOSTART = path.join(os.homedir(), '.config/autostart/docker-inspector.desktop');
const shotDir = process.env.DI_SHOT; // screenshot mode used for automated visual checks
const startHidden = process.argv.includes('--hidden');

app.setName('Docker Inspector');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let srv = null;
let tray = null;
let quitting = false;

// ------------------------------------------------------------------ settings
const DEFAULTS = { runInBackground: true, startAtLogin: false, notifications: true, backgroundHintShown: false };
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; }
  settings.startAtLogin = fs.existsSync(AUTOSTART);
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { console.warn('[docker-inspector] cannot save settings:', e.message); }
}
function applyStartAtLogin(on) {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
      fs.writeFileSync(AUTOSTART, `[Desktop Entry]
Type=Application
Name=Docker Inspector
Comment=Records container history and watches for crashes in the background
Exec="${LAUNCHER}" --hidden
Icon=docker-inspector
Terminal=false
X-GNOME-Autostart-enabled=true
`);
    } else {
      fs.rmSync(AUTOSTART, { force: true });
    }
  } catch (e) { console.warn('[docker-inspector] cannot update autostart entry:', e.message); }
}
function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  settings[key] = !!value;
  if (key === 'startAtLogin') applyStartAtLogin(settings.startAtLogin);
  saveSettings();
  updateTray();
  win?.webContents.send('settings', settings);
}

// ------------------------------------------------------------------ window
function showWindow(route) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (typeof route === 'string') win.webContents.send('navigate', route);
}

function notify(title, body, route) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: fs.existsSync(ICON) ? ICON : undefined });
  n.on('click', () => showWindow(route));
  n.show();
}

async function createWindow() {
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
  win.once('ready-to-show', () => { if (!shotDir && !startHidden) win.show(); });

  // Closing the window keeps monitoring in the background (tray) unless the user turned that off.
  win.on('close', (e) => {
    if (quitting || shotDir || !settings.runInBackground) return;
    e.preventDefault();
    win.hide();
    if (!settings.backgroundHintShown) {
      settings.backgroundHintShown = true;
      saveSettings();
      notify('Docker Inspector keeps watching', 'It records history and reports crashes in the background. Quit it from the tray icon or turn this off in Settings.');
    }
  });

  await win.loadURL(target);
  if (shotDir) runScreenshots(shotDir);
}

// ------------------------------------------------------------------ tray
function updateTray() {
  if (!tray) return;
  const unread = srv?.store ? srv.store.unackedCount() : 0;
  tray.setToolTip(unread ? `Docker Inspector - ${unread} new crash report${unread === 1 ? '' : 's'}` : 'Docker Inspector');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Docker Inspector', click: () => showWindow() },
    { label: unread ? `Crash reports (${unread} new)` : 'Crash reports', click: () => showWindow('/crashes') },
    { label: 'Doctor', click: () => showWindow('/doctor') },
    { label: 'Timeline', click: () => showWindow('/timeline') },
    { type: 'separator' },
    { label: 'Keep monitoring when closed', type: 'checkbox', checked: settings.runInBackground, click: (i) => setSetting('runInBackground', i.checked) },
    { label: 'Start at login', type: 'checkbox', checked: settings.startAtLogin, click: (i) => setSetting('startAtLogin', i.checked) },
    { label: 'Crash notifications', type: 'checkbox', checked: settings.notifications, click: (i) => setSetting('notifications', i.checked) },
    { type: 'separator' },
    { label: 'Quit Docker Inspector', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  if (tray || shotDir) return;
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.on('click', () => showWindow());
    updateTray();
  } catch (e) {
    console.warn('[docker-inspector] tray not available:', e.message);
  }
}

// ------------------------------------------------------------------ screenshots
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
  quitting = true;
  app.quit();
}

// ------------------------------------------------------------------ IPC
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:toggle-maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => win?.close());
ipcMain.handle('win:is-maximized', () => !!win?.isMaximized());
ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('notify', (_e, { title, body }) => notify(title, body));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) setSetting(k, v);
  return settings;
});

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  loadSettings();
  const dataDir = process.env.DI_DATA_DIR || path.join(app.getPath('userData'), 'data');
  try {
    const devUrl = process.env.DI_DEV_URL;
    srv = devUrl
      // Dev: fixed port + token so the Vite dev server can proxy /api and /ws to us.
      ? await startServer({ port: 7781, token: 'dev-token-dev-token-dev-token-dev-token-dev-token', devOrigin: new URL(devUrl).origin, dataDir })
      : await startServer({ port: 0, dataDir });
  } catch (e) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('Cannot connect to Docker',
      `Docker Inspector could not reach the Docker Engine.\n\n${e.message}\n\nMake sure Docker is running and your user is in the "docker" group.`);
    quitting = true;
    app.quit();
    return;
  }

  // Native notification for every new crash (and once more when it turns into a crash loop).
  srv.hub.on('crash', (c) => {
    updateTray();
    if (!c.notify || !settings.notifications || shotDir) return;
    const title = c.occurrences >= 3 ? `${c.name} is stuck in a crash loop` : `${c.name} crashed`;
    notify(title, `${c.title}. ${c.summary}`, c.id ? `/crashes/${c.id}` : '/crashes');
  });

  createTray();
  await createWindow();
});

app.on('window-all-closed', () => { srv?.close(); app.quit(); });
