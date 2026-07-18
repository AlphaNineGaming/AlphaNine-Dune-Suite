const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaNineSuite", {
  desktop: true,
  chooseSshKey: () => ipcRenderer.invoke("choose-ssh-key"),
  chooseServerInstallFolder: () => ipcRenderer.invoke("choose-server-install-folder"),
  chooseDatabaseBackupFolder: () => ipcRenderer.invoke("choose-database-backup-folder"),
  chooseDatabaseBackupFile: () => ipcRenderer.invoke("choose-database-backup-file"),
  chooseBlueprintModelPackFolder: () => ipcRenderer.invoke("choose-blueprint-model-pack-folder"),
  openPath: (targetPath) => ipcRenderer.invoke("open-path", targetPath),
  installSelfUpdate: (update) => ipcRenderer.invoke("self-update-install", update),
  onSelfUpdateProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("self-update-progress", listener);
    return () => ipcRenderer.removeListener("self-update-progress", listener);
  }
});
