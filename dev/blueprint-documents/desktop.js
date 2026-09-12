"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createLocalFiles } = require("./local-files");
const { createReferenceSnapshot } = require("./reference-adapter");
const { positionEvidence } = require("./reference-fixtures");
const { suiteScene } = require("./suite-scene");
const { ProjectDocument, Construction } = require("./construction");
const MeshTransfer = require("./mesh-transfer");
const { exportBlueprint } = require("./blueprint-export");

async function createDocumentWindow(electron, options = {}) {
  const { app, BrowserWindow, ipcMain, session: electronSession, dialog } = electron;
  if (app.isPackaged && !(options.packagedDesigner === true && require("node:fs").existsSync(path.join(app.getAppPath(),"blueprint-designer.json")))) throw new Error("Blueprint Designer is not included in this build.");
  if (app.commandLine.hasSwitch("no-sandbox") || app.commandLine.hasSwitch("disable-renderer-sandbox")) throw new Error("This viewport requires application sandboxing; disabling flags are refused.");
  const assembly = options.mode === "assembly";
  const page = pathToFileURL(path.join(__dirname, assembly ? "assembly.html" : "index.html")).href + (options.packagedDesigner ? "?start=empty" : "");
  const uiFiles = assembly ? ["assembly.html", "assembly.css", "assembly-renderer.js", "assembly-viewport.js", "scene-model.js", "mesh-transfer.js", "construction-renderer.js", "foundation-snap.js", "connection-data.js", "connected-snap.js"] : ["index.html", "renderer.js", "view-state.js", "viewport.js", "style.css"];
  const allowed = new Set(uiFiles.map(file => pathToFileURL(path.join(__dirname, file)).href));
  allowed.add(page);
  const isolatedSession = electronSession.fromPartition("blueprint-document-development", { cache: false });
  isolatedSession.webRequest.onBeforeRequest((request, callback) => {
    const permitted = allowed.has(request.url);
    options.onRequest?.({ url: request.url, permitted });
    callback({ cancel: !permitted });
  });
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    title: "AlphaNine Dune Suite — Blueprint Documents",
    width: 1320, height: 850, minWidth: 960, minHeight: 650, show: options.show !== false,
    backgroundColor: "#030303", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), session: isolatedSession,
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  options.onWindow?.(window);
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  const files = createLocalFiles();
  const projectFiles = createLocalFiles(undefined, ProjectDocument);
  let project = null, projectSession = null;
  const dialogs = options.dialogs || dialog;
  let opened;
  let initialSource = assembly ? options.initialSource : null;
  let busy = false;
  const channels = ["blueprint-document:open", "blueprint-document:save-copy", "blueprint-document:reference-fixture", "blueprint-document:project"];
  async function mayDiscard() {
    if (!project?.snapshot().dirty) return true;
    const answer = await dialogs.showMessageBox(window, { type: "question", buttons: ["Keep working", "Discard changes"], defaultId: 0, cancelId: 0, message: "This construction project has unsaved changes.", detail: "Save a project copy before leaving if you want to keep them." });
    return answer.response === 1;
  }
  async function openPath(filePath) {
    project = null; projectSession = null;
    opened = undefined;
    const candidate = await files.open(filePath);
    const reference = createReferenceSnapshot(candidate.document, positionEvidence(candidate.document.toBuffer()));
    opened = candidate;
    let scene = null, sceneError = null;
    if (assembly) {
      try { scene = suiteScene(candidate.document, options.geometryCatalog); scene.entries = MeshTransfer.pack(scene.entries); }
      catch (error) { sceneError = error.message; }
    }
    return { source: opened.source, ...opened.summary, reference, ...(assembly ? { scene, sceneError } : {}) };
  }
  function handler(operation) {
    return async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
        throw new Error("Document operation rejected for an untrusted window.");
      }
      if (busy) return { error: "A file operation is already in progress." };
      busy = true;
      try { return await operation(...args); }
      catch (error) { return { error: error.message }; }
      finally { busy = false; }
    };
  }
  ipcMain.handle(channels[0], handler(async () => {
    if (!await mayDiscard()) return { canceled: true };
    if (initialSource) { const source = initialSource; initialSource = null; return openPath(source); }
    const result = await dialogs.showOpenDialog(window, { title: "Open local blueprint", properties: ["openFile"], filters: [{ name: "Blueprint JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    // Clear a previous document on an unsuccessful replacement so Save Copy
    // cannot accidentally save the previous file after a failed open.
    return openPath(result.filePaths[0]);
  }));
  ipcMain.handle(channels[2], handler(async () => { if (!await mayDiscard()) return { canceled: true }; return openPath(path.join(__dirname, "fixtures", "reference-points.json")); }));
  ipcMain.handle(channels[1], handler(async () => {
    if (project || !opened) throw new Error("Open a valid local blueprint first. Construction projects are not game blueprints.");
    const basename = path.basename(opened.source).replace(/\.json$/i, "");
    const result = await dialogs.showSaveDialog(window, {
      title: "Save blueprint copy to a new file", defaultPath: path.join(path.dirname(opened.source), `${basename} - copy.json`),
      filters: [{ name: "Blueprint JSON", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return files.saveCopy(opened, result.filePath);
  }));
  function projectResult(includeCatalog = false, selection = []) {
    const scene = project.scene(options.geometryCatalog);
    if (!includeCatalog) delete scene.entries;
    else scene.entries = MeshTransfer.pack(scene.entries);
    return { project: project.snapshot(), scene, selection };
  }
  ipcMain.handle(channels[3], handler(async (action, payload) => {
    if (!assembly) throw Error("Construction is unavailable in this window.");
    if (JSON.stringify(payload ?? null).length > 1024 * 1024) throw Error("Project command is too large.");
    if (action === "new" || action === "open") {
      if (!await mayDiscard()) return { canceled: true };
      let candidate = null;
      if (action === "open") {
        const result = await dialogs.showOpenDialog(window, { title: "Open AlphaNine construction project", properties: ["openFile"], filters: [{ name: "AlphaNine project", extensions: ["a9project"] }] });
        if (result.canceled || !result.filePaths.length) return { canceled: true };
        // Validate a replacement completely before replacing the current project.
        candidate = await projectFiles.open(result.filePaths[0]);
      }
      const next = new Construction(options.geometryCatalog, candidate?.document);
      projectSession = candidate || projectFiles.create(next.document()); project = next; opened = undefined;
      return projectResult(true);
    }
    if (!project) throw Error("Create or open a construction project first.");
    if (action === "command") return projectResult(false, project.command(payload));
    if (action === "export") {
      const exported = exportBlueprint(project.document(), options.geometryCatalog);
      const name = project.snapshot().name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/[. ]+$/, "") || "New blueprint";
      const result = await dialogs.showSaveDialog(window, { title: "Export game blueprint", defaultPath: name + ".json", filters: [{ name: "Suite game blueprint", extensions: ["json"] }] });
      if (result.canceled || !result.filePath) return { canceled: true };
      if (path.extname(result.filePath).toLowerCase() !== ".json") throw Error("Export the blueprint with a .json extension.");
      const saved = await files.saveCopy(files.create(exported.document), result.filePath);
      return { ...saved, pieces: exported.pieces };
    }
    if (action === "save") {
      const result = await dialogs.showSaveDialog(window, { title: "Save construction project to a new file", defaultPath: "New base.a9project", filters: [{ name: "AlphaNine project (not a game blueprint)", extensions: ["a9project"] }] });
      if (result.canceled || !result.filePath) return { canceled: true };
      if (path.extname(result.filePath).toLowerCase() !== ".a9project") throw Error("Save Project uses the .a9project extension. Use Export Blueprint for game JSON.");
      const saved = await projectFiles.saveCopy(projectSession, result.filePath, project.document());
      project.markSaved(); return { ...saved, project: project.snapshot() };
    }
    throw Error("Unsupported project operation.");
  }));
  let closing = false;
  window.on("close", event => {
    if (closing || !project?.snapshot().dirty) return;
    event.preventDefault();
    if (busy) return;
    busy = true; mayDiscard().then(ok => { if (ok) { closing = true; window.close(); } }).catch(() => {}).finally(() => { busy = false; });
  });
  window.on("closed", () => { opened = undefined; project = null; channels.forEach(channel => ipcMain.removeHandler(channel)); });
  await window.loadURL(page);
  return window;
}

module.exports = { createDocumentWindow };
