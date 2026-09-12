"use strict";
// Standalone development entry: never loads electron/main.js or server.js.
const electron = require("electron");
const { createDocumentWindow } = require("./desktop");
if (electron.app.isPackaged) {
  electron.app.exit(1);
} else {
  electron.app.setName("AlphaNine Blueprint Documents Development");
  electron.app.whenReady().then(() => {
    if (!process.argv.includes("--assembly")) return createDocumentWindow(electron);
    const { localPath } = require("./local-files"), { loadCatalog } = require("./geometry-catalog");
    const argument = name => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);
    const catalogPath = localPath(argument("--geometry-catalog"));
    const geometryCatalog = loadCatalog(catalogPath);
    const initialSource = argument("--blueprint");
    return createDocumentWindow(electron, { mode: "assembly", geometryCatalog, initialSource: initialSource ? localPath(initialSource) : null });
  }).catch(error => {
    console.error(error.message);
    electron.app.exit(1);
  });
  electron.app.on("window-all-closed", () => electron.app.quit());
}
