const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaNineSuite", {
  desktop: true,
  chooseSshKey: () => ipcRenderer.invoke("choose-ssh-key"),
  chooseServerInstallFolder: () => ipcRenderer.invoke("choose-server-install-folder"),
  chooseDatabaseBackupFolder: () => ipcRenderer.invoke("choose-database-backup-folder"),
  chooseDatabaseBackupFile: () => ipcRenderer.invoke("choose-database-backup-file"),
  openPath: (targetPath) => ipcRenderer.invoke("open-path", targetPath)
});
