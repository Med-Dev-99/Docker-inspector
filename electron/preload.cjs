// Bridge between the sandboxed renderer and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximizeChange: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('win:maximized', h);
    return () => ipcRenderer.off('win:maximized', h);
  },
  onFocusChange: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('win:focused', h);
    return () => ipcRenderer.off('win:focused', h);
  },
  openExternal: (url) => ipcRenderer.send('open-external', url),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
