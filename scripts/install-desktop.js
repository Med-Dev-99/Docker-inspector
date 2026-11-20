// Installs a GNOME/freedesktop launcher so Docker Inspector shows up in the app grid.
// Usage: npm run install-desktop   (remove with: npm run install-desktop -- --uninstall)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = path.join(os.homedir(), '.local/share/applications');
const icons = path.join(os.homedir(), '.local/share/icons/hicolor');
const desktopFile = path.join(apps, 'docker-inspector.desktop');

if (process.argv.includes('--uninstall')) {
  fs.rmSync(desktopFile, { force: true });
  for (const d of fs.existsSync(icons) ? fs.readdirSync(icons) : []) fs.rmSync(path.join(icons, d, 'apps/docker-inspector.png'), { force: true });
  console.log('Removed Docker Inspector launcher.');
  process.exit(0);
}

fs.mkdirSync(apps, { recursive: true });
const iconDir = path.join(root, 'build/icons');
let iconName = path.join(root, 'build/icon.png');
if (fs.existsSync(iconDir)) {
  for (const f of fs.readdirSync(iconDir)) {
    const size = f.replace('.png', '');
    const dest = path.join(icons, size, 'apps');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(iconDir, f), path.join(dest, 'docker-inspector.png'));
  }
  iconName = 'docker-inspector';
}

fs.writeFileSync(desktopFile, `[Desktop Entry]
Type=Application
Name=Docker Inspector
GenericName=Docker Manager
Comment=Inspect, monitor and manage your Docker containers, images, volumes and networks
Exec=${path.join(root, 'scripts/launch.sh')}
Icon=${iconName}
Terminal=false
Categories=Development;System;Monitor;
Keywords=docker;container;compose;monitor;
StartupWMClass=docker-inspector
StartupNotify=true
`);
fs.chmodSync(desktopFile, 0o755);
try { execSync(`update-desktop-database ${apps}`, { stdio: 'ignore' }); } catch {}
try { execSync(`gtk-update-icon-cache -f -t ${icons}`, { stdio: 'ignore' }); } catch {}
console.log(`Installed launcher: ${desktopFile}\nOpen “Docker Inspector” from your app grid (you may need to log out/in once for the icon).`);
