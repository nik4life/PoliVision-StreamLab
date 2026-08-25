const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('streamLab', {
  chooseFile: () => ipcRenderer.invoke('streamlab:choose-file'),
  start: (config) => ipcRenderer.invoke('streamlab:start', config),
  stop: () => ipcRenderer.invoke('streamlab:stop'),
  getStatus: () => ipcRenderer.invoke('streamlab:get-status'),
  getEncoder: () => ipcRenderer.invoke('streamlab:get-encoder'),
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('streamlab:status', handler);
    return () => ipcRenderer.removeListener('streamlab:status', handler);
  },
});
