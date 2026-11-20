// Renders public/icon.svg to PNGs with Chromium (gradients + shadows intact).
// Usage: npm run icon
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'public/icon.svg')).toString('base64');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(root, 'build/icons'), { recursive: true });
  const S = 512;
  const win = new BrowserWindow({ width: S, height: S, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img src="data:image/svg+xml;base64,${svg}" width="${S}" height="${S}" style="display:block"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
  for (const size of [512, 256, 128, 64, 48, 32]) {
    const png = (size === S ? img : img.resize({ width: size, height: size, quality: 'best' })).toPNG();
    fs.writeFileSync(path.join(root, `build/icons/${size}x${size}.png`), png);
    if (size === S) fs.writeFileSync(path.join(root, 'build/icon.png'), png);
  }
  console.log('Icons written to build/icons/');
  app.quit();
});
