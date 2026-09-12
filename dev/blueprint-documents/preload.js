"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// This window has no general Suite bridge or arbitrary path/network IPC.
contextBridge.exposeInMainWorld("blueprintDocuments", Object.freeze({
  theme: () => ipcRenderer.invoke("blueprint-document:theme"),
  onTheme: callback => { const listener = (_event, theme) => callback(theme); ipcRenderer.on("blueprint-document:theme-changed", listener); return () => ipcRenderer.removeListener("blueprint-document:theme-changed", listener); },
  open: () => ipcRenderer.invoke("blueprint-document:open"),
  saveCopy: () => ipcRenderer.invoke("blueprint-document:save-copy"),
  openReferenceFixture: () => ipcRenderer.invoke("blueprint-document:reference-fixture"),
  project: (action, payload) => ipcRenderer.invoke("blueprint-document:project", action, payload),
  runtime: Object.freeze({ sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true })
}));
