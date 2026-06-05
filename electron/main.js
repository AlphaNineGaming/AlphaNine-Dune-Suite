const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const APP_PORT = Number(process.env.PORT || 8810);
const RECEIVER_DEFAULT_HOST = "127.0.0.1";
const RECEIVER_DEFAULT_PORT = 5055;
const START_TIMEOUT_MS = 45000;

let mainWindow = null;
let serverProcess = null;
let receiverProcess = null;
let shuttingDown = false;

function appPath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

function userPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
    ELECTRON_RUN_AS_NODE: "1",
    ...extra
  };
}

function spawnNodeScript(scriptPath, label, extraEnv = {}) {
  const logDir = userPath("logs");
  ensureDir(logDir);
  const out = fs.openSync(path.join(logDir, `${label}.log`), "a");
  const child = spawn(process.execPath, [scriptPath], {
    cwd: app.getAppPath(),
    env: childEnv(extraEnv),
    stdio: ["ignore", out, out],
    windowsHide: true
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`${label} exited with code ${code || ""} ${signal || ""}`.trim());
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
    throw new Error(`Give-item receiver did not become healthy at ${cfg.healthUrl}.`);
  }
}

async function startServer() {
  const serverFile = appPath("server.js");
  serverProcess = spawnNodeScript(serverFile, "suite");
  const ready = await waitForUrl(`http://127.0.0.1:${APP_PORT}/`, START_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`AlphaNine Dune Suite did not start at http://127.0.0.1:${APP_PORT}/.`);
  }
}

function killTree(child) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
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
  createFirstRunFiles();
  loadEnvironment();
  await startReceiverIfNeeded();
  await startServer();
  createWindow();
}

app.setAppUserModelId("com.alphanine.dunesuite");

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
      dialog.showErrorBox("AlphaNine Dune Suite failed to start", error.message);
      cleanupChildren();
      app.quit();
    });
  });

  app.on("before-quit", cleanupChildren);
  app.on("window-all-closed", () => app.quit());
}
