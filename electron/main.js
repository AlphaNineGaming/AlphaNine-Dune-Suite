const { app, BrowserWindow, Menu, Tray, dialog, shell, utilityProcess } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const APP_PORT = Number(process.env.PORT || 8810);
const RECEIVER_DEFAULT_HOST = "127.0.0.1";
const RECEIVER_DEFAULT_PORT = 5055;
const START_TIMEOUT_MS = 45000;

app.setName("AlphaNine Dune Suite");
app.setAppUserModelId("com.alphanine.dunesuite");

let mainWindow = null;
let serverProcess = null;
let receiverProcess = null;
let tray = null;
let shuttingDown = false;
const childErrors = new Map();
const ALREADY_RUNNING_MESSAGE = "AlphaNine Dune Suite is already running. Close the existing elevated instance first.";

function appPath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

function userPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function logDirPath() {
  return userPath("logs");
}

function logPath(label) {
  return path.join(logDirPath(), `${label}.log`);
}

function appendLog(label, message) {
  try {
    ensureDir(logDirPath());
    const line = `[${new Date().toISOString()}] ${message}${os.EOL}`;
    fs.appendFileSync(logPath(label), line, "utf8");
  } catch {
    // Logging must never be the reason startup fails.
  }
}

function startupErrorMessage(error) {
  const details = error?.stack || error?.message || String(error);
  return [
    details,
    "",
    "Logs:",
    logPath("desktop"),
    logPath("suite"),
    logPath("receiver")
  ].join("\n");
}

function readEnvFile(filePath, override = false) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/%([^%]+)%/g, (_whole, key) => process.env[key] || _whole);
    if (override || !process.env[name]) process.env[name] = value;
  }
}

function createFirstRunFiles() {
  const dataDir = app.getPath("userData");
  ensureDir(dataDir);

  const envLocal = userPath(".env.local");
  if (!fs.existsSync(envLocal)) {
    const source = appPath(".env.example");
    const header = [
      "# AlphaNine Dune Suite local configuration",
      "# Edit this file for installed desktop app settings.",
      "# Secrets stay on this machine and are not committed.",
      ""
    ].join("\n");
    const body = fs.existsSync(source) ? fs.readFileSync(source, "utf8") : "";
    fs.writeFileSync(envLocal, `${header}${body}`, "utf8");
  }

  const configPath = userPath("config.json");
  if (!fs.existsSync(configPath)) {
    const example = appPath("config.example.json");
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, configPath);
    } else {
      fs.writeFileSync(configPath, JSON.stringify({
        setupComplete: false,
        serverType: "local-hyperv",
        host: "127.0.0.1",
        port: APP_PORT,
        vmName: "dune-awakening",
        vmIp: "",
        sshUser: "dune",
        sshKey: "",
        databaseHost: "",
        databasePort: 15432,
        databaseName: "dune",
        databaseUser: "postgres",
        databasePassword: "",
        receiverHost: "127.0.0.1",
        receiverPort: RECEIVER_DEFAULT_PORT,
        receiverToken: "",
        receiverSshHost: "",
        receiverSshUser: "dune",
        receiverSshKey: "",
        mapDefault: "HaggaBasin",
        logLevel: "info",
        updateRepo: "AlphaNineGaming/alphanine-dune-suite",
        panelTitle: "AlphaNine Dune Suite",
        panelSubtitle: "Unified local tools for your self-hosted server",
        serverInstallPath: "D:\\SteamLibrary\\steamapps\\common\\Dune Awakening Self-Hosted Server"
      }, null, 2), "utf8");
    }
  }
  process.env.ALPHANINE_CONFIG_PATH = configPath;
}

function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(userPath("config.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function loadEnvironment() {
  readEnvFile(appPath(".env"));
  readEnvFile(appPath(".env.local"), true);
  readEnvFile(userPath(".env"));
  readEnvFile(userPath(".env.local"), true);
  const cfg = readAppConfig();
  if (cfg.vmIp && !process.env.DUNE_RECEIVER_SSH_HOST) process.env.DUNE_RECEIVER_SSH_HOST = cfg.vmIp;
  if (cfg.receiverSshHost) process.env.DUNE_RECEIVER_SSH_HOST = cfg.receiverSshHost;
  if (cfg.receiverSshUser) process.env.DUNE_RECEIVER_SSH_USER = cfg.receiverSshUser;
  if (cfg.receiverSshKey) process.env.DUNE_RECEIVER_SSH_KEY = cfg.receiverSshKey;
  if (cfg.receiverHost) process.env.DUNE_RECEIVER_HOST = cfg.receiverHost;
  if (cfg.receiverPort) process.env.DUNE_RECEIVER_PORT = String(cfg.receiverPort);
  if (cfg.receiverToken) {
    process.env.DUNE_RECEIVER_TOKEN = cfg.receiverToken;
    process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN = process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN || cfg.receiverToken;
  }
  const receiverHost = process.env.DUNE_RECEIVER_HOST || RECEIVER_DEFAULT_HOST;
  const receiverPort = process.env.DUNE_RECEIVER_PORT || String(RECEIVER_DEFAULT_PORT);
  process.env.DUNE_ADMIN_GIVE_ITEM_URL = process.env.DUNE_ADMIN_GIVE_ITEM_URL || `http://${receiverHost}:${receiverPort}/api/give-item`;
  process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL = process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL || `http://${receiverHost}:${receiverPort}/health`;
  process.env.PORT = String(APP_PORT);
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    ...extra
  };
}

function pipeChildLogs(child, label) {
  if (child.stdout) {
    child.stdout.on("data", (chunk) => appendLog(label, String(chunk).trimEnd()));
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => appendLog(label, String(chunk).trimEnd()));
  }
}

function childCwd() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
}

function spawnDevelopmentNodeScript(scriptPath, label, extraEnv = {}) {
  const child = spawn("node", [scriptPath], {
    cwd: childCwd(),
    env: childEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  pipeChildLogs(child, label);
  child.on("error", (error) => {
    childErrors.set(label, error.message);
    appendLog(label, `spawn error: ${error.stack || error.message}`);
    appendLog("desktop", `${label} spawn error: ${error.stack || error.message}`);
  });
  child.on("spawn", () => {
    appendLog(label, `${label} started with node. pid=${child.pid || ""}`);
  });
  return child;
}

function forkPackagedNodeScript(scriptPath, label, extraEnv = {}) {
  const child = utilityProcess.fork(scriptPath, [], {
    cwd: childCwd(),
    env: childEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: `AlphaNine ${label}`
  });
  pipeChildLogs(child, label);
  child.on("error", (type, location, report) => {
    const message = `${type || "UtilityProcessError"} ${location || ""}`.trim();
    childErrors.set(label, message);
    appendLog(label, `utility process error: ${message}\n${report || ""}`.trim());
    appendLog("desktop", `${label} utility process error: ${message}`);
  });
  child.on("spawn", () => {
    appendLog(label, `${label} started with Electron utilityProcess. pid=${child.pid || ""}`);
  });
  return child;
}

function spawnNodeScript(scriptPath, label, extraEnv = {}) {
  ensureDir(logDirPath());
  appendLog("desktop", `Starting ${label}: ${scriptPath}`);
  if (!fs.existsSync(scriptPath)) {
    const error = new Error(`${label} script was not found: ${scriptPath}`);
    childErrors.set(label, error.message);
    appendLog("desktop", error.message);
    throw error;
  }
  const child = app.isPackaged
    ? forkPackagedNodeScript(scriptPath, label, extraEnv)
    : spawnDevelopmentNodeScript(scriptPath, label, extraEnv);
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      const message = `${label} exited with code ${code || ""} ${signal || ""}`.trim();
      childErrors.set(label, message);
      appendLog(label, message);
      appendLog("desktop", message);
    }
  });
  return child;
}

function requestOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForUrl(url, timeoutMs = START_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await requestOk(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

function receiverConfig() {
  const host = process.env.DUNE_RECEIVER_HOST || RECEIVER_DEFAULT_HOST;
  const port = Number(process.env.DUNE_RECEIVER_PORT || RECEIVER_DEFAULT_PORT);
  const healthUrl = process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL || `http://${host}:${port}/health`;
  const giveUrl = process.env.DUNE_ADMIN_GIVE_ITEM_URL || `http://${host}:${port}/api/give-item`;
  return { host, port, healthUrl, giveUrl };
}

function shouldStartReceiver() {
  if (String(process.env.DUNE_RECEIVER_DISABLED || "").toLowerCase() === "true") return false;
  return Boolean(process.env.DUNE_RECEIVER_SSH_HOST);
}

async function startReceiverIfNeeded() {
  if (!shouldStartReceiver()) {
    appendLog("desktop", "Receiver auto-start skipped. Suite will start in degraded/Dry Run mode until receiver is configured and online.");
    return { ok: false, degraded: true, skipped: true, reason: "Receiver auto-start is not configured." };
  }
  const cfg = receiverConfig();
  process.env.DUNE_ADMIN_GIVE_ITEM_URL = process.env.DUNE_ADMIN_GIVE_ITEM_URL || cfg.giveUrl;
  process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL = process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL || cfg.healthUrl;
  if (!process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN && process.env.DUNE_RECEIVER_TOKEN) {
    process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN = process.env.DUNE_RECEIVER_TOKEN;
  }

  if (await requestOk(cfg.healthUrl)) {
    appendLog("desktop", `Receiver already healthy at ${cfg.healthUrl}.`);
    return { ok: true, degraded: false, healthUrl: cfg.healthUrl };
  }

  const receiverFile = appPath("receivers", "dune-live-give-receiver.js");
  try {
    receiverProcess = spawnNodeScript(receiverFile, "receiver");
  } catch (error) {
    const message = `Receiver offline. Suite will continue in degraded/Dry Run mode. ${error.message}`;
    appendLog("desktop", message);
    appendLog("receiver", message);
    return { ok: false, degraded: true, healthUrl: cfg.healthUrl, reason: error.message };
  }
  const ready = await waitForUrl(cfg.healthUrl, START_TIMEOUT_MS);
  if (!ready) {
    const reason = childErrors.get("receiver") || "No child-process error was reported.";
    const message = `Receiver offline at ${cfg.healthUrl}. Suite will continue in degraded/Dry Run mode. ${reason}`;
    appendLog("desktop", message);
    appendLog("receiver", message);
    return { ok: false, degraded: true, healthUrl: cfg.healthUrl, reason };
  }
  appendLog("desktop", `Receiver became healthy at ${cfg.healthUrl}.`);
  return { ok: true, degraded: false, healthUrl: cfg.healthUrl };
}

async function startServer() {
  const serverFile = appPath("server.js");
  serverProcess = spawnNodeScript(serverFile, "suite");
  const ready = await waitForUrl(`http://127.0.0.1:${APP_PORT}/`, START_TIMEOUT_MS);
  if (!ready) {
    const reason = childErrors.get("suite") || "No child-process error was reported.";
    throw new Error(`AlphaNine Dune Suite did not start at http://127.0.0.1:${APP_PORT}/.\n${reason}\nSee ${logPath("suite")}`);
  }
}

function killTree(child) {
  if (!child) return;
  try {
    if (app.isPackaged && typeof child.kill === "function") {
      child.kill();
    } else if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else if (typeof child.kill === "function") {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

function cleanupChildren() {
  shuttingDown = true;
  killTree(serverProcess);
  killTree(receiverProcess);
}

function focusMainWindow(reason = "focus-request") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    appendLog("desktop", `Could not focus window for ${reason}: main window is not available.`);
    return false;
  }
  try {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.moveTop();
    mainWindow.focus();
    app.focus({ steal: true });
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        appendLog("desktop", ALREADY_RUNNING_MESSAGE);
      }
    }, 750);
    return true;
  } catch (error) {
    appendLog("desktop", `${ALREADY_RUNNING_MESSAGE} ${error.stack || error.message}`);
    return false;
  }
}

function quitSuite() {
  cleanupChildren();
  app.quit();
}

function createTray() {
  if (tray) return;
  const iconPath = appPath("assets", "alphanine-logo.jpg");
  if (!fs.existsSync(iconPath)) {
    appendLog("desktop", `Tray icon was not found: ${iconPath}`);
    return;
  }
  tray = new Tray(iconPath);
  tray.setToolTip("AlphaNine Dune Suite");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show AlphaNine Dune Suite", click: () => focusMainWindow("tray-show") },
    { type: "separator" },
    { label: "Quit", click: quitSuite }
  ]));
  tray.on("double-click", () => focusMainWindow("tray-double-click"));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#07090c",
    title: "AlphaNine Dune Suite",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`http://127.0.0.1:${APP_PORT}/`);
}

async function boot() {
  appendLog("desktop", `Booting AlphaNine Dune Suite. packaged=${app.isPackaged} appPath=${app.getAppPath()} resourcesPath=${process.resourcesPath || ""}`);
  createFirstRunFiles();
  loadEnvironment();
  const receiverStartup = await startReceiverIfNeeded();
  if (receiverStartup?.degraded) {
    appendLog("desktop", `Starting dashboard with receiver degraded: ${receiverStartup.reason || receiverStartup.healthUrl || "receiver offline"}`);
  }
  await startServer();
  createWindow();
  createTray();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.whenReady().then(() => {
    appendLog("desktop", ALREADY_RUNNING_MESSAGE);
    dialog.showMessageBox({
      type: "warning",
      title: "AlphaNine Dune Suite already running",
      message: ALREADY_RUNNING_MESSAGE
    }).finally(() => app.quit());
  });
} else {
  app.on("second-instance", () => {
    focusMainWindow("second-instance");
  });

  app.whenReady().then(() => {
    boot().catch((error) => {
      appendLog("desktop", `Startup failed: ${error.stack || error.message}`);
      dialog.showErrorBox("AlphaNine Dune Suite failed to start", startupErrorMessage(error));
      cleanupChildren();
      app.quit();
    });
  });

  app.on("before-quit", cleanupChildren);
  app.on("window-all-closed", quitSuite);
}
