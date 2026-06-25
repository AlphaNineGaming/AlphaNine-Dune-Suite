const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP_PORT = Number(process.env.PORT || 8810);
const RECEIVER_DEFAULT_HOST = "127.0.0.1";
const RECEIVER_DEFAULT_PORT = 5055;
const START_TIMEOUT_MS = 45000;

app.setName("AlphaNine Dune Suite");
app.setAppUserModelId("com.alphanine.dunesuite");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu-sandbox");

let mainWindow = null;
let serverProcess = null;
let receiverProcess = null;
let tray = null;
let shuttingDown = false;
const childErrors = new Map();
const ALREADY_RUNNING_MESSAGE = "AlphaNine Dune Suite is already running. Close the existing elevated instance first.";
const WINDOWS_ADMIN_REQUIRED_MESSAGE = "AlphaNine Dune Suite requires Administrator privileges to manage Hyper-V, networking, and server operations.";
let electronElevated = null;

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

function expandEnvPath(value) {
  return String(value || "").replace(/%([^%]+)%/g, (_whole, key) => process.env[key] || _whole);
}

function usableServerPath(value) {
  const configured = String(value || "").trim();
  if (!configured || new Set(["<set>", "set", "***", "********"]).has(configured.toLowerCase())) return "";
  const resolved = expandEnvPath(configured);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : "";
  } catch {
    return "";
  }
}

function quoteEnvValue(value) {
  const text = String(value ?? "");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

const MASKED_SECRET_VALUES = new Set(["********", "<set>"]);

function isMaskedSecretValue(value) {
  return MASKED_SECRET_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function usableSecretValue(value) {
  return isMaskedSecretValue(value) ? "" : String(value ?? "");
}

function assertNoMaskedSecrets(cfg, destination) {
  const masked = Object.entries(cfg || {}).filter(([key, value]) => /password|token|secret/i.test(key) && isMaskedSecretValue(value));
  if (masked.length) throw new Error(`Refusing to write masked secret placeholder${masked.length === 1 ? "" : "s"} to ${destination}: ${masked.map(([key]) => key).join(", ")}`);
}

function normalizeSelectedBattlegroup(value) {
  if (!value || typeof value !== "object") return null;
  const namespace = String(value.namespace || "").trim();
  const name = String(value.name || "").trim();
  if (!namespace || !name) return null;
  return { namespace, name };
}

function receiverUrlsFromConfig(cfg) {
  const host = String(cfg.receiverHost || RECEIVER_DEFAULT_HOST).trim();
  const port = String(cfg.receiverPort || RECEIVER_DEFAULT_PORT).trim();
  return {
    host,
    port,
    giveUrl: `http://${host}:${port}/api/give-item`,
    healthUrl: `http://${host}:${port}/health`
  };
}

function managedEnvValues(cfg) {
  const receiver = receiverUrlsFromConfig(cfg);
  const dedicatedReceiverSshHost = String(cfg.receiverSshHost || "").trim();
  const sshHost = String(dedicatedReceiverSshHost || cfg.sshHost || cfg.vmIp || "").trim();
  const sshUser = String(dedicatedReceiverSshHost
    ? (cfg.receiverSshUser || cfg.sshUser || "dune")
    : (cfg.sshUser || cfg.receiverSshUser || "dune")).trim();
  const sshKey = expandEnvPath(dedicatedReceiverSshHost
    ? (cfg.receiverSshKey || cfg.sshKey || "")
    : (cfg.sshKey || cfg.receiverSshKey || ""));
  const receiverToken = String(cfg.receiverToken || "").trim();
  const adminToken = String(cfg.adminGiveItemToken || receiverToken || "").trim();
  const selected = normalizeSelectedBattlegroup(cfg.selectedBattlegroup);
  const values = {
    DUNE_RECEIVER_HOST: receiver.host,
    DUNE_RECEIVER_PORT: receiver.port,
    DUNE_RECEIVER_URL: `http://${receiver.host}:${receiver.port}`,
    DUNE_RECEIVER_SSH_HOST: sshHost,
    DUNE_RECEIVER_SSH_USER: sshUser,
    DUNE_RECEIVER_SSH_KEY: sshKey,
    DUNE_DATABASE_HOST: String(cfg.databaseHost || "").trim(),
    DUNE_DATABASE_PORT: String(cfg.databasePort || 15432).trim(),
    DUNE_DATABASE_NAME: String(cfg.databaseName || "dune").trim(),
    DUNE_DATABASE_USER: String(cfg.databaseUser || "postgres").trim(),
    DUNE_DATABASE_PASSWORD: String(cfg.databasePassword || ""),
    DUNE_ADMIN_DATABASE_PORT: String(cfg.databasePort || 15432).trim(),
    DUNE_RECEIVER_TOKEN: receiverToken,
    DUNE_ADMIN_GIVE_ITEM_TOKEN: adminToken,
    DUNE_ADMIN_GIVE_ITEM_TRANSPORT: "http-json",
    DUNE_ADMIN_GIVE_ITEM_URL: receiver.giveUrl,
    DUNE_ADMIN_GIVE_ITEM_HEALTH_URL: receiver.healthUrl,
    DUNE_RECEIVER_LIVE_TELEPORT_ENABLED: cfg.liveTeleportEnabled ? "true" : "false",
    DUNE_RECEIVER_TELEPORT_SAFE_Z_OFFSET: String(cfg.teleportSafeZOffset || 1000),
    DUNE_SERVER_INSTALL_PATH: usableServerPath(cfg.serverInstallPath),
    DUNE_AWAKENING_SERVER_PATH: usableServerPath(cfg.awakeningServerPath)
  };
  if (selected) {
    values.DUNE_RECEIVER_BG_NAMESPACE = selected.namespace;
    values.DUNE_RECEIVER_BG_NAME = selected.name;
    values.DUNE_BATTLEGROUP_NAMESPACE = selected.namespace;
    values.DUNE_BATTLEGROUP_NAME = selected.name;
  }
  return values;
}

function writeManagedEnvFile(cfg) {
  assertNoMaskedSecrets(cfg, ".env");
  const envPath = userPath(".env");
  const values = managedEnvValues(cfg);
  const lines = [
    "# AlphaNine Dune Suite managed environment",
    "# Generated from Setup Wizard/config.json. Do not edit by hand; use the Setup Wizard.",
    "# Precedence: defaults < managed .env < .env.local/process overrides < config.json runtime mapping.",
    ""
  ];
  for (const [name, value] of Object.entries(values)) lines.push(`${name}=${quoteEnvValue(value)}`);
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  return envPath;
}

function applyConfigRuntimeEnv(cfg) {
  const values = managedEnvValues(cfg);
  for (const [name, value] of Object.entries(values)) process.env[name] = String(value ?? "");
}

function createFirstRunFiles() {
  const dataDir = app.getPath("userData");
  ensureDir(dataDir);

  const envLocal = userPath(".env.local");
  if (!fs.existsSync(envLocal)) {
    const header = [
      "# AlphaNine Dune Suite advanced local overrides",
      "# Normal configuration is saved by the Setup Wizard to config.json and mirrored to .env.",
      "# Put advanced, non-wizard overrides here only when support asks you to.",
      ""
    ].join("\n");
    fs.writeFileSync(envLocal, header, "utf8");
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
        sshHost: "",
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
        adminGiveItemToken: "",
        receiverSshHost: "",
        receiverSshUser: "dune",
        receiverSshKey: "",
        mapDefault: "HaggaBasin",
        logLevel: "info",
        updateRepo: "AlphaNineGaming/alphanine-dune-suite",
        panelTitle: "AlphaNine Dune Suite",
        panelSubtitle: "Unified local tools for your self-hosted server",
        serverInstallPath: "",
        awakeningServerPath: "",
        liveTeleportEnabled: true,
        dragTeleportEnabled: true,
        teleportEndpointPath: "/api/v1/players/teleport-coords",
        teleportCommandTemplate: "",
        teleportSafeZOffset: 1000
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

function generateReceiverToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function ensureReceiverTokenConfig() {
  const configPath = userPath("config.json");
  const cfg = readAppConfig();
  const receiverToken = usableSecretValue(cfg.receiverToken)
    || usableSecretValue(process.env.DUNE_RECEIVER_TOKEN)
    || usableSecretValue(cfg.adminGiveItemToken)
    || usableSecretValue(process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN)
    || generateReceiverToken();
  const adminGiveItemToken = receiverToken;
  const databasePassword = isMaskedSecretValue(cfg.databasePassword)
    ? usableSecretValue(process.env.DUNE_DATABASE_PASSWORD)
    : String(cfg.databasePassword ?? "");
  const next = {
    ...cfg,
    databasePassword,
    receiverToken,
    adminGiveItemToken,
    receiverTokenSource: usableSecretValue(cfg.receiverToken) ? (cfg.receiverTokenSource || "config.json") : "generated"
  };
  assertNoMaskedSecrets(next, "config.json");
  const changed = databasePassword !== cfg.databasePassword || receiverToken !== cfg.receiverToken || adminGiveItemToken !== cfg.adminGiveItemToken || next.receiverTokenSource !== cfg.receiverTokenSource;
  if (!changed) return cfg;
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  appendLog("desktop", "Repaired or generated secret configuration and saved it to config.json.");
  return next;
}

function loadEnvironment() {
  readEnvFile(appPath(".env"));
  readEnvFile(appPath(".env.local"), true);
  readEnvFile(userPath(".env"));
  readEnvFile(userPath(".env.local"), true);
  const cfg = ensureReceiverTokenConfig();
  const managedEnvPath = writeManagedEnvFile(cfg);
  process.env.ALPHANINE_MANAGED_ENV_PATH = managedEnvPath;
  process.env.ALPHANINE_RECEIVER_ENV_SOURCE = "managed .env/config/runtime";
  applyConfigRuntimeEnv(cfg);
  appendLog("desktop", `Managed runtime environment regenerated at ${managedEnvPath}.`);
  if (!process.env.DUNE_RECEIVER_TOKEN || !process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN) {
    appendLog("desktop", "Receiver token environment is incomplete after startup configuration load.");
  }
  process.env.PORT = String(APP_PORT);
  electronElevated = detectElectronElevated();
  process.env.ALPHANINE_ELECTRON_PID = String(process.pid);
  process.env.ALPHANINE_ELECTRON_ELEVATED = electronElevated === null ? "unknown" : String(electronElevated);
  appendLog("desktop", `Electron process elevation: ${process.env.ALPHANINE_ELECTRON_ELEVATED}; pid=${process.pid}`);
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    ...extra
  };
}

function detectElectronElevated() {
  if (process.platform !== "win32") return null;
  try {
    const script = "$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000
    });
    if (result.error || result.status !== 0) {
      appendLog("desktop", `Electron elevation probe failed: ${result.error?.message || result.stderr || result.status}`);
      return null;
    }
    return /^true$/i.test(String(result.stdout || "").trim());
  } catch (error) {
    appendLog("desktop", `Electron elevation probe error: ${error.stack || error.message}`);
    return null;
  }
}

function isRunningElevated() {
  if (process.platform !== "win32") return true;
  const detected = detectElectronElevated();
  return detected === true;
}

function enforceAdministratorPrivileges() {
  if (isRunningElevated()) return true;
  appendLog("desktop", WINDOWS_ADMIN_REQUIRED_MESSAGE);
  dialog.showErrorBox("Administrator privileges required", WINDOWS_ADMIN_REQUIRED_MESSAGE);
  app.quit();
  return false;
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
  const child = spawn(process.execPath, [scriptPath], {
    cwd: childCwd(),
    env: childEnv({ ELECTRON_RUN_AS_NODE: "1", ...extraEnv }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  pipeChildLogs(child, label);
  child.on("error", (error) => {
    const message = error?.message || "Packaged child process failed to start.";
    childErrors.set(label, message);
    appendLog(label, `spawn error: ${error?.stack || message}`);
    appendLog("desktop", `${label} spawn error: ${error?.stack || message}`);
  });
  child.on("spawn", () => {
    appendLog(label, `${label} started with Electron executable as Node. pid=${child.pid || ""}; electronElevated=${process.env.ALPHANINE_ELECTRON_ELEVATED}`);
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
  if (!process.env.DUNE_RECEIVER_TOKEN) process.env.DUNE_RECEIVER_TOKEN = generateReceiverToken();
  if (!process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN) process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN = process.env.DUNE_RECEIVER_TOKEN;
  process.env.ALPHANINE_RECEIVER_STARTED_BY_SUITE = "true";

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

ipcMain.handle("choose-ssh-key", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select SSH key",
    properties: ["openFile"],
    filters: [
      { name: "SSH keys", extensions: ["pem", "key", "ppk", "*"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle("choose-server-install-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Dune Awakening server installation folder",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, folderPath: result.filePaths[0] };
});

ipcMain.handle("choose-database-backup-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select database backup folder",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, folderPath: result.filePaths[0] };
});

ipcMain.handle("choose-database-backup-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select database backup file",
    properties: ["openFile"],
    filters: [
      { name: "Database backups", extensions: ["zip", "sql", "dump", "backup", "tar"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle("open-path", async (_event, targetPath) => {
  const value = String(targetPath || "").trim();
  if (!value) return { ok: false, error: "Path is empty." };
  const error = await shell.openPath(value);
  return { ok: !error, error };
});

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
    if (!enforceAdministratorPrivileges()) return;
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
