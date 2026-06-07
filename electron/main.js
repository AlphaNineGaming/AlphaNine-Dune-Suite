const { app, BrowserWindow, dialog, shell, utilityProcess } = require("electron");
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
let shuttingDown = false;
const childErrors = new Map();

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
        host: "127.0.0.1",
        port: APP_PORT,
        vmName: "dune-awakening",
        vmIp: "",
        sshUser: "dune",
        sshKey: "",
        panelTitle: "AlphaNine Dune Suite",
        panelSubtitle: "Unified local tools for your self-hosted server",
        serverInstallPath: "D:\\SteamLibrary\\steamapps\\common\\Dune Awakening Self-Hosted Server"
      }, null, 2), "utf8");
    }
  }
  process.env.ALPHANINE_CONFIG_PATH = configPath;
}

function loadEnvironment() {
  readEnvFile(appPath(".env"));
  readEnvFile(appPath(".env.local"), true);
  readEnvFile(userPath(".env"));
  readEnvFile(userPath(".env.local"), true);
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
  const transport = String(process.env.DUNE_ADMIN_GIVE_ITEM_TRANSPORT || "").toLowerCase();
  if (transport !== "http-json") return false;
  if (String(process.env.DUNE_RECEIVER_DISABLED || "").toLowerCase() === "true") return false;
  return Boolean(process.env.DUNE_RECEIVER_SSH_HOST);
}

async function startReceiverIfNeeded() {
  if (!shouldStartReceiver()) return;
  const cfg = receiverConfig();
  process.env.DUNE_ADMIN_GIVE_ITEM_URL = process.env.DUNE_ADMIN_GIVE_ITEM_URL || cfg.giveUrl;
  process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL = process.env.DUNE_ADMIN_GIVE_ITEM_HEALTH_URL || cfg.healthUrl;
  if (!process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN && process.env.DUNE_RECEIVER_TOKEN) {
    process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN = process.env.DUNE_RECEIVER_TOKEN;
  }

  if (await requestOk(cfg.healthUrl)) return;

  const receiverFile = appPath("receivers", "dune-live-give-receiver.js");
  receiverProcess = spawnNodeScript(receiverFile, "receiver");
  const ready = await waitForUrl(cfg.healthUrl, START_TIMEOUT_MS);
  if (!ready) {
    const reason = childErrors.get("receiver") || "No child-process error was reported.";
    throw new Error(`Give-item receiver did not become healthy at ${cfg.healthUrl}.\n${reason}\nSee ${logPath("receiver")}`);
  }
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
  mainWindow.loadURL(`http://127.0.0.1:${APP_PORT}/`);
}

async function boot() {
  appendLog("desktop", `Booting AlphaNine Dune Suite. packaged=${app.isPackaged} appPath=${app.getAppPath()} resourcesPath=${process.resourcesPath || ""}`);
  createFirstRunFiles();
  loadEnvironment();
  await startReceiverIfNeeded();
  await startServer();
  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
  app.on("window-all-closed", () => app.quit());
}
