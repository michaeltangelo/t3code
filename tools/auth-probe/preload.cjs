const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("authProbe", {
  state: () => ipcRenderer.invoke("probe:state"),
  openExternal: (service) => ipcRenderer.invoke("probe:external", service),
  observe: (service, result) => ipcRenderer.invoke("probe:observe", service, result),
  restart: () => ipcRenderer.invoke("probe:restart"),
  export: () => ipcRenderer.invoke("probe:export"),
  onUpdate: (callback) => ipcRenderer.on("probe:update", (_event, state) => callback(state)),
});
