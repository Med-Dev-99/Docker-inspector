// Bridge between the sandboxed renderer and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximizeChange: listen('win:maximized'),
  onFocusChange: listen('win:focused'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  // Background monitoring / login item / notification settings (stored by the main process).
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: listen('settings'),
  // The main process asks the UI to open a page (tray menu, notification click).
  onNavigate: listen('navigate'),
});
