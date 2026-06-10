const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickKeyFile: () => ipcRenderer.invoke('pick-key-file'),
  connectVps: (vps) => ipcRenderer.invoke('connect-vps', vps),
  connectRouter: (router) => ipcRenderer.invoke('connect-router', router),
  installServer: (config) => ipcRenderer.invoke('install-server', config),
  installRouter: (config) => ipcRenderer.invoke('install-router', config),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onEvent: (cb) => ipcRenderer.on('install-event', (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('install-log', (_e, data) => cb(data)),
});
