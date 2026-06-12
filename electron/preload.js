const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaNineSuite", {
  desktop: true,
  chooseSshKey: () => ipcRenderer.invoke("choose-ssh-key")
});
