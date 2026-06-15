const http = require("http");
const https = require("https");
const net = require("net");
const { execFile, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP_VERSION = "0.3.0-beta";
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8810);
const MANAGER_PORT = 8812;
const CONFIG_PATH = process.env.ALPHANINE_CONFIG_PATH || path.join(__dirname, "config.json");
const TELEPORT_PRESETS_PATH = process.env.ALPHANINE_TELEPORT_PRESETS_PATH || path.join(__dirname, "assets", "teleport-location-presets.json");
const TELEPORT_PLACEHOLDER_COMMAND = "teleport {playerId} {x} {y} {z}";
const ADMIN_AUDIT_LOG = process.env.APPDATA
  ? path.join(process.env.APPDATA, "AlphaNine Dune Suite", "admin-audit.log")
  : path.join(__dirname, "admin-audit.log");
const PROGRESSION_DATA_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "AlphaNine Dune Suite")
  : __dirname;
const PROGRESSION_BACKUP_DIR = path.join(PROGRESSION_DATA_DIR, "progression-backups");
const PROGRESSION_AUDIT_LOG = path.join(PROGRESSION_DATA_DIR, "logs", "progression-audit.log");
function packagedUnpackedPath(...parts) {
  if (!String(__dirname).includes("app.asar")) return path.join(__dirname, ...parts);
  return path.join(__dirname.replace("app.asar", "app.asar.unpacked"), ...parts);
}

const MANAGER_DIR = packagedUnpackedPath("manager");
const CODEX_DIR = path.join(__dirname, "gear-codex");
const APPDATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, "AlphaNine Dune Suite") : "";
const DATA_DIR = APPDATA_DIR ? path.join(APPDATA_DIR, "data") : path.join(__dirname, "data");
const DUNE_ITEMS_CACHE_PATH = path.join(DATA_DIR, "dune-items-cache.json");
const GEAR_IMAGE_CACHE_DIR = path.join(DATA_DIR, "gear-images");
const GEAR_IMPORT_URL = "https://dune.gaming.tools/items";
const GEAR_DATA_ENTITIES_URL = "https://cdn-hosted.gaming.tools/dune/data/en/entities.d.json";
const GEAR_CDN_ASSET_URL = "https://cdn-hosted.gaming.tools/dune";
const LOCALAPPDATA_DIR = process.env.LOCALAPPDATA || process.env.APPDATA || "";
const MANAGER_DATA_DIR = LOCALAPPDATA_DIR ? path.join(LOCALAPPDATA_DIR, "AlphaNine Dune Awakening Manager") : MANAGER_DIR;
const MANAGER_CONFIG_PATH = path.join(MANAGER_DATA_DIR, "manager-config.json");
const MANAGER_APPLIED_PROFILE_PATH = path.join(MANAGER_DATA_DIR, "applied-profile.json");
const MANAGER_APPLIED_SETTINGS_PATH = path.join(MANAGER_DATA_DIR, "applied-server-settings.json");
const DEFAULT_DATABASE_BACKUP_DIR = APPDATA_DIR ? path.join(APPDATA_DIR, "database-backups") : path.join(__dirname, "database-backups");

const defaultConfig = {
  setupComplete: false,
  serverType: "local-hyperv",
  host: "127.0.0.1",
  port: 8810,
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
  receiverPort: 5055,
  receiverToken: "",
  receiverSshHost: "",
  receiverSshUser: "dune",
  receiverSshKey: "",
  mapDefault: "HaggaBasin",
  logLevel: "info",
  updateRepo: "AlphaNineGaming/alphanine-dune-suite",
  panelTitle: "AlphaNine Dune Suite",
  panelSubtitle: "Unified local tools for your self-hosted server",
  serverInstallPath: "D:\\SteamLibrary\\steamapps\\common\\Dune Awakening Self-Hosted Server",
  liveTeleportEnabled: true,
  teleportEndpointPath: "/api/v1/players/teleport-coords",
  teleportCommandTemplate: "",
  teleportPayloadTemplate: "{\n  \"fls_id\": \"{playerId}\",\n  \"x\": {x},\n  \"y\": {y},\n  \"z\": {z},\n  \"partition_id\": {partitionId},\n  \"dryRun\": {dryRun},\n  \"test\": {test}\n}",
  progressionEditingEnabled: false,
  databaseBackupLocation: DEFAULT_DATABASE_BACKUP_DIR,
  uiSoundsEnabled: true,
  uiSoundVolume: 100
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  return { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")) };
}

function loadRawConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
}

function effectiveTeleportCommandTemplate(value) {
  const template = String(value || "").trim();
  return template === TELEPORT_PLACEHOLDER_COMMAND ? "" : template;
}

function saveConfig(nextConfig) {
  const allowed = ["setupComplete", "serverType", "host", "port", "vmName", "vmIp", "sshUser", "sshKey", "databaseHost", "databasePort", "databaseName", "databaseUser", "databasePassword", "receiverHost", "receiverPort", "receiverToken", "receiverSshHost", "receiverSshUser", "receiverSshKey", "mapDefault", "logLevel", "updateRepo", "panelTitle", "panelSubtitle", "serverInstallPath", "liveTeleportEnabled", "teleportEndpointPath", "teleportCommandTemplate", "teleportPayloadTemplate", "progressionEditingEnabled", "databaseBackupLocation", "uiSoundsEnabled", "uiSoundVolume"];
  const clean = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, key)) clean[key] = nextConfig[key];
  }
  clean.setupComplete = clean.setupComplete === true || clean.setupComplete === "true";
  clean.serverType = String(clean.serverType || "local-hyperv").trim();
  clean.host = String(clean.host || "127.0.0.1").trim();
  clean.port = Number(clean.port) || PORT;
  clean.vmName = String(clean.vmName || "dune-awakening").trim();
  clean.vmIp = String(clean.vmIp || "").trim();
  clean.sshUser = String(clean.sshUser || "dune").trim();
  clean.sshKey = String(clean.sshKey || "").trim();
  clean.databaseHost = String(clean.databaseHost || "").trim();
  clean.databasePort = Number(clean.databasePort) || 15432;
  clean.databaseName = String(clean.databaseName || "dune").trim();
  clean.databaseUser = String(clean.databaseUser || "postgres").trim();
  clean.databasePassword = String(clean.databasePassword || "");
  clean.receiverHost = String(clean.receiverHost || "127.0.0.1").trim();
  clean.receiverPort = Number(clean.receiverPort) || 5055;
  clean.receiverToken = String(clean.receiverToken || "");
  clean.receiverSshHost = String(clean.receiverSshHost || "").trim();
  clean.receiverSshUser = String(clean.receiverSshUser || "dune").trim();
  clean.receiverSshKey = String(clean.receiverSshKey || "").trim();
  clean.mapDefault = String(clean.mapDefault || "HaggaBasin").trim();
  clean.logLevel = String(clean.logLevel || "info").trim();
  clean.updateRepo = String(clean.updateRepo || "AlphaNineGaming/alphanine-dune-suite").trim();
  clean.panelTitle = String(clean.panelTitle || "AlphaNine Dune Suite").trim();
  clean.panelSubtitle = String(clean.panelSubtitle || "Unified local tools for your self-hosted server").trim();
  clean.serverInstallPath = String(clean.serverInstallPath || "").trim();
  clean.liveTeleportEnabled = clean.liveTeleportEnabled === true || clean.liveTeleportEnabled === "true";
  clean.teleportEndpointPath = String(clean.teleportEndpointPath || "/api/v1/players/teleport-coords").trim();
  if (!clean.teleportEndpointPath.startsWith("/")) clean.teleportEndpointPath = `/${clean.teleportEndpointPath}`;
  clean.teleportCommandTemplate = effectiveTeleportCommandTemplate(clean.teleportCommandTemplate);
  clean.teleportPayloadTemplate = String(clean.teleportPayloadTemplate || defaultConfig.teleportPayloadTemplate).trim();
  clean.progressionEditingEnabled = clean.progressionEditingEnabled === true || clean.progressionEditingEnabled === "true";
  clean.databaseBackupLocation = expandEnvPath(String(clean.databaseBackupLocation || DEFAULT_DATABASE_BACKUP_DIR).trim());
  clean.uiSoundsEnabled = clean.uiSoundsEnabled === true || clean.uiSoundsEnabled === "true";
  clean.uiSoundVolume = Math.max(0, Math.min(100, Number(clean.uiSoundVolume) || 0));
  if (clean.port < 1 || clean.port > 65535) throw new Error("Port must be between 1 and 65535.");
  if (clean.databasePort < 1 || clean.databasePort > 65535) throw new Error("Database port must be between 1 and 65535.");
  if (clean.receiverPort < 1 || clean.receiverPort > 65535) throw new Error("Receiver port must be between 1 and 65535.");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
  return clean;
}

function comparableConfigValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number(value);
  return String(value ?? "");
}

function verifyConfigSaved(expectedConfig) {
  const reloaded = loadConfig();
  const mismatches = [];
  for (const [key, expected] of Object.entries(expectedConfig || {})) {
    if (comparableConfigValue(reloaded[key]) !== comparableConfigValue(expected)) {
      mismatches.push({
        field: key,
        expected: key.toLowerCase().includes("password") || key.toLowerCase().includes("token") ? "<secret>" : comparableConfigValue(expected),
        actual: key.toLowerCase().includes("password") || key.toLowerCase().includes("token") ? "<secret>" : comparableConfigValue(reloaded[key])
      });
    }
  }
  return {
    ok: mismatches.length === 0,
    config: reloaded,
    configPath: CONFIG_PATH,
    checkedAt: new Date().toISOString(),
    mismatches
  };
}

function serverInstallPathStatus(value) {
  const configured = String(value || "").trim();
  const resolved = expandEnvPath(configured);
  const result = {
    configured,
    path: resolved,
    exists: false,
    valid: false,
    checks: [],
    message: "Server install path is not configured."
  };
  if (!resolved) return result;
  result.exists = fs.existsSync(resolved);
  if (!result.exists) {
    result.message = "Selected folder does not exist.";
    return result;
  }
  let stat;
  let entries;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    result.message = `Selected folder could not be inspected: ${error.message}`;
    return result;
  }
  if (!stat.isDirectory()) {
    result.message = "Selected path is not a folder.";
    return result;
  }
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    result.message = `Selected folder could not be inspected: ${error.message}`;
    return result;
  }
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase());
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase());
  const hasServerName = /dune|awakening|server/i.test(path.basename(resolved));
  const hasSteamFiles = names.has("steam_appid.txt") || names.has("steamclient64.dll") || names.has("steamclient.dll");
  const hasBinaries = files.some((name) => name.endsWith(".exe") && /dune|server|awakening/i.test(name));
  const hasServerDirs = dirs.some((name) => ["dune", "duneawakening", "duneawakeningserver", "server", "binaries", "content", "config", "saved"].includes(name) || /dune|server|binaries|content|config|saved/.test(name));
  result.checks = [
    { name: "Folder exists", ok: true },
    { name: "SteamCMD/Steam files", ok: hasSteamFiles },
    { name: "Server executable", ok: hasBinaries },
    { name: "Expected server folders", ok: hasServerDirs },
    { name: "Dune/server folder name", ok: hasServerName }
  ];
  result.valid = hasSteamFiles || hasBinaries || hasServerDirs || hasServerName;
  result.message = result.valid
    ? "Selected folder looks like a Dune Awakening server installation."
    : "Selected folder does not appear to be a valid Dune Awakening server installation.";
  return result;
}

function publicConfig(configValue = loadConfig()) {
  const copy = { ...configValue };
  copy.configPath = CONFIG_PATH;
  copy.databasePasswordSet = Boolean(copy.databasePassword);
  copy.receiverTokenSet = Boolean(copy.receiverToken);
  copy.sshKeyStatus = sshKeyStatus(copy.sshKey || defaultSshKeyPath());
  copy.receiverSshKeyStatus = sshKeyStatus(copy.receiverSshKey || copy.sshKey || defaultSshKeyPath());
  copy.serverInstallPathStatus = serverInstallPathStatus(copy.serverInstallPath);
  copy.databasePassword = copy.databasePassword ? "********" : "";
  copy.receiverToken = copy.receiverToken ? "********" : "";
  return copy;
}

function configWithSshDiagnostics(configValue = loadConfig()) {
  return {
    ...configValue,
    configPath: CONFIG_PATH,
    sshKeyStatus: sshKeyStatus(configValue.sshKey || defaultSshKeyPath()),
    receiverSshKeyStatus: sshKeyStatus(configValue.receiverSshKey || configValue.sshKey || defaultSshKeyPath()),
    serverInstallPathStatus: serverInstallPathStatus(configValue.serverInstallPath)
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024 * 8) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function expandEnvPath(value) {
  return String(value || "").replace(/%([^%]+)%/g, (_match, name) => process.env[name] || _match);
}

function defaultSshKeyPath() {
  return path.join(os.homedir(), "AppData", "Local", "DuneAwakeningServer", "sshKey");
}

function sshKeyStatus(value) {
  const configured = String(value || "").trim();
  const resolved = expandEnvPath(configured || defaultSshKeyPath());
  const exists = Boolean(resolved && fs.existsSync(resolved));
  return {
    configured,
    path: resolved,
    exists,
    message: exists ? "SSH key file found." : "SSH key file not found."
  };
}

const config = loadConfig();
const VM_NAME = config.vmName;
const VM_IP = String(config.vmIp || "").trim();
const SSH_USER = config.sshUser || "dune";
const SSH_KEY = expandEnvPath(config.sshKey || defaultSshKeyPath());
const DEFAULT_SERVER_ROOT = expandEnvPath(config.serverInstallPath);
let lastDirectorUrl = null;
let managerProcess = null;
let managerStartError = "";
let loggedPythonCommand = "";
let managerSpawnDiagnostics = null;
let receiverManagedProcess = null;
const vmMonitorPingHistory = [];
let vmMonitorLastSuccess = "";

function envFlag(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseEnvFile(filePath) {
  const values = {};
  if (!filePath || !fs.existsSync(filePath)) return values;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value.replace(/%([^%]+)%/g, (_whole, key) => process.env[key] || _whole);
  }
  return values;
}

function runtimeEnvFiles() {
  return [
    { label: "app .env", path: path.join(__dirname, ".env"), override: false },
    { label: "app .env.local", path: path.join(__dirname, ".env.local"), override: true },
    { label: "user .env", path: APPDATA_DIR ? path.join(APPDATA_DIR, ".env") : "", override: false },
    { label: "user .env.local", path: APPDATA_DIR ? path.join(APPDATA_DIR, ".env.local") : "", override: true }
  ].filter((entry) => entry.path);
}

function configHasValue(configValue, key) {
  return Object.prototype.hasOwnProperty.call(configValue || {}, key)
    && configValue[key] !== undefined
    && configValue[key] !== null
    && String(configValue[key]) !== "";
}

function configSourceForEnv(name, configValue = loadConfig()) {
  const rawConfig = loadRawConfig();
  const mappings = {
    PORT: { key: "port", value: () => String(PORT), source: "runtime override" },
    CONFIG_PATH: { key: "configPath", value: () => CONFIG_PATH, source: "runtime override" },
    ALPHANINE_CONFIG_PATH: { key: "configPath", value: () => CONFIG_PATH, source: "runtime override" },
    MANAGER_CONFIG_PATH: { key: "managerConfigPath", value: () => MANAGER_CONFIG_PATH, source: "runtime override" },
    MANAGER_DATA_DIR: { key: "managerDataDir", value: () => MANAGER_DATA_DIR, source: "runtime override" },
    DUNE_ADMIN_GIVE_ITEM_TRANSPORT: { key: "runtimeGiveTransport", value: () => runtimeGiveTransport.mode || "dry-run", source: "runtime override" },
    DUNE_ADMIN_GIVE_ITEM_URL: { key: "receiverHost/receiverPort", value: () => receiverUrls(configValue).giveUrl, source: "runtime override" },
    DUNE_ADMIN_GIVE_ITEM_HEALTH_URL: { key: "receiverHost/receiverPort", value: () => receiverUrls(configValue).healthUrl, source: "runtime override" },
    DUNE_ADMIN_GIVE_ITEM_TIMEOUT_MS: { key: "giveItemTimeout", value: () => String(LIVE_GIVE_ENV.timeoutMs), source: "runtime override" },
    DUNE_RECEIVER_HOST: { key: "receiverHost", value: () => String(configValue.receiverHost || "") },
    DUNE_RECEIVER_PORT: { key: "receiverPort", value: () => String(configValue.receiverPort || "") },
    DUNE_RECEIVER_URL: { key: "receiverHost/receiverPort", value: () => `http://${receiverUrls(configValue).host}:${receiverUrls(configValue).port}`, source: "runtime override" },
    DUNE_RECEIVER_TOKEN: { key: "receiverToken", value: () => String(configValue.receiverToken || "") },
    DUNE_ADMIN_GIVE_ITEM_TOKEN: { key: "receiverToken", value: () => String(configValue.receiverToken || "") },
    DUNE_RECEIVER_SSH_HOST: { key: "receiverSshHost", fallbackKey: "vmIp", value: () => String(configValue.receiverSshHost || configValue.vmIp || "") },
    DUNE_RECEIVER_SSH_USER: { key: "receiverSshUser", fallbackKey: "sshUser", value: () => String(configValue.receiverSshUser || configValue.sshUser || "") },
    DUNE_RECEIVER_SSH_KEY: { key: "receiverSshKey", fallbackKey: "sshKey", value: () => expandEnvPath(configValue.receiverSshKey || configValue.sshKey || "") },
    DUNE_RECEIVER_LIVE_TELEPORT_ENABLED: { key: "liveTeleportEnabled", value: () => configValue.liveTeleportEnabled ? "true" : "false" },
    DUNE_RECEIVER_TELEPORT_SAFE_Z_OFFSET: { key: "teleportSafeZOffset", value: () => String(configValue.teleportSafeZOffset || "") }
  };
  const mapping = mappings[name];
  if (!mapping) return null;
  if (mapping.source) return { source: mapping.source, setting: mapping.key, value: mapping.value() };
  if (configHasValue(rawConfig, mapping.key)) return { source: "settings", setting: mapping.key, value: mapping.value() };
  if (mapping.fallbackKey && configHasValue(rawConfig, mapping.fallbackKey)) return { source: "settings", setting: mapping.fallbackKey, value: mapping.value() };
  return null;
}

function runtimeEnvSource(name, configValue = loadConfig()) {
  const finalValue = process.env[name] || "";
  let current = "";
  let source = null;
  for (const entry of runtimeEnvFiles()) {
    const values = parseEnvFile(entry.path);
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    if (entry.override || !current) {
      current = values[name];
      source = { source: "env", detail: entry.label, path: entry.path };
    }
  }
  if (source && String(current) === String(finalValue)) return source;
  const configSource = configSourceForEnv(name, configValue);
  if (configSource && String(configSource.value) === String(finalValue)) {
    return { source: configSource.source, detail: configSource.setting || "", path: CONFIG_PATH };
  }
  if (finalValue) return { source: "env", detail: "process.env", path: "" };
  return { source: "default", detail: "not configured", path: "" };
}

function runtimeValue(name, fallback = "", configValue = loadConfig()) {
  const configSource = configSourceForEnv(name, configValue);
  const value = process.env[name] || fallback || (configSource ? configSource.value : "") || "";
  const source = process.env[name]
    ? runtimeEnvSource(name, configValue)
    : configSource && String(configSource.value) === String(value)
      ? { source: configSource.source, detail: configSource.setting || "", path: CONFIG_PATH }
      : { source: fallback ? "default" : "missing", detail: fallback ? "computed fallback" : "not configured", path: "" };
  return {
    name,
    value,
    displayValue: LIVE_GIVE_SECRET_ENV_NAMES.has(name) || /TOKEN|PASSWORD|SECRET/i.test(name) ? (value ? "<set>" : "") : value,
    set: Boolean(value),
    ...source
  };
}

function relevantRuntimeEnvNames() {
  const names = new Set([
    "CONFIG_PATH",
    "ALPHANINE_CONFIG_PATH",
    "MANAGER_CONFIG_PATH",
    "MANAGER_DATA_DIR",
    "DUNE_ADMIN_GIVE_ITEM_TRANSPORT",
    "DUNE_ADMIN_GIVE_ITEM_TIMEOUT_MS",
    "DUNE_ADMIN_GIVE_ITEM_URL",
    "DUNE_ADMIN_GIVE_ITEM_HEALTH_URL",
    "DUNE_ADMIN_GIVE_ITEM_TOKEN",
    "DUNE_RECEIVER_HOST",
    "DUNE_RECEIVER_PORT",
    "DUNE_RECEIVER_URL",
    "DUNE_RECEIVER_TOKEN",
    "DUNE_RECEIVER_SSH_HOST",
    "DUNE_RECEIVER_SSH_USER",
    "DUNE_RECEIVER_SSH_KEY",
    "DUNE_RECEIVER_SSH_KEY_C",
    "DUNE_RECEIVER_LIVE_TELEPORT_ENABLED",
    "DUNE_RECEIVER_TELEPORT_SAFE_Z_OFFSET",
    "PYTHON_PATH",
    "PYTHON_PATH_C",
    "DUNE_ADMIN_RABBITMQ_PUBLISH_URL",
    "DUNE_ADMIN_RABBITMQ_HEALTH_URL",
    "DUNE_ADMIN_RABBITMQ_USER",
    "DUNE_ADMIN_RABBITMQ_PASSWORD",
    "DUNE_ADMIN_RABBITMQ_ROUTING_KEY",
    "DUNE_ADMIN_GIVE_ITEM_MESSAGE_TEMPLATE"
  ]);
  for (const key of Object.keys(process.env)) {
    if (/^(DUNE_|PYTHON_|CONFIG_|ALPHANINE_|MANAGER_)/i.test(key)) names.add(key);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function requiredModesHelp() {
  return {
    title: "Required Variables Help",
    note: "Reference only. These examples are not the active runtime configuration.",
    lines: [
      "Dry-run mode does not require live transport variables.",
      "HTTP JSON receiver mode usually uses DUNE_ADMIN_GIVE_ITEM_URL, DUNE_ADMIN_GIVE_ITEM_HEALTH_URL, and DUNE_ADMIN_GIVE_ITEM_TOKEN.",
      "Receiver HTTP checks use DUNE_RECEIVER_HOST and DUNE_RECEIVER_PORT. SSH/kubectl checks use DUNE_RECEIVER_SSH_HOST, DUNE_RECEIVER_SSH_USER, and DUNE_RECEIVER_SSH_KEY.",
      "Secrets are redacted in diagnostics, but their presence is shown as <set>."
    ]
  };
}

const LIVE_GIVE_ENV = {
  transport: envFlag("DUNE_ADMIN_GIVE_ITEM_TRANSPORT").toLowerCase(),
  httpUrl: envFlag("DUNE_ADMIN_GIVE_ITEM_URL"),
  httpHealthUrl: envFlag("DUNE_ADMIN_GIVE_ITEM_HEALTH_URL"),
  httpToken: envFlag("DUNE_ADMIN_GIVE_ITEM_TOKEN"),
  rabbitPublishUrl: envFlag("DUNE_ADMIN_RABBITMQ_PUBLISH_URL"),
  rabbitHealthUrl: envFlag("DUNE_ADMIN_RABBITMQ_HEALTH_URL"),
  rabbitUser: envFlag("DUNE_ADMIN_RABBITMQ_USER"),
  rabbitPassword: envFlag("DUNE_ADMIN_RABBITMQ_PASSWORD"),
  rabbitRoutingKey: envFlag("DUNE_ADMIN_RABBITMQ_ROUTING_KEY"),
  rabbitMessageTemplate: envFlag("DUNE_ADMIN_GIVE_ITEM_MESSAGE_TEMPLATE"),
  timeoutMs: envNumber("DUNE_ADMIN_GIVE_ITEM_TIMEOUT_MS", 15000)
};
const LIVE_GIVE_DEFAULT_HTTP_URL = "http://127.0.0.1:5055/api/give-item";
const LIVE_GIVE_DEFAULT_HEALTH_URL = "http://127.0.0.1:5055/health";
const runtimeGiveTransport = {
  mode: "dry-run",
  serverOnline: false,
  serverStatus: "",
  reason: "Server status has not been checked yet.",
  initialized: false
};
const liveGiveAvailability = {
  initialized: false,
  available: false
};

const LIVE_GIVE_SECRET_ENV_NAMES = new Set([
  "DUNE_ADMIN_GIVE_ITEM_TOKEN",
  "DUNE_ADMIN_RABBITMQ_PASSWORD"
]);

function localIps() {
  return Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function receiverUrls(configValue = loadConfig()) {
  const host = configValue.receiverHost || envFlag("DUNE_RECEIVER_HOST", "127.0.0.1");
  const port = Number(configValue.receiverPort || envNumber("DUNE_RECEIVER_PORT", 5055));
  return {
    host,
    port,
    healthUrl: envFlag("DUNE_ADMIN_GIVE_ITEM_HEALTH_URL", `http://${host}:${port}/health`),
    giveUrl: envFlag("DUNE_ADMIN_GIVE_ITEM_URL", `http://${host}:${port}/api/give-item`)
  };
}

function requestStatus(urlValue, timeout = 2500) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(urlValue); }
    catch { resolve({ ok: false, statusCode: 0, error: "Invalid URL" }); return; }
    const client = parsed.protocol === "https:" ? https : http;
    const started = Date.now();
    const req = client.get(parsed, { timeout }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode, responseMs: Date.now() - started });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, responseMs: Date.now() - started, error: "Timed out" });
    });
    req.on("error", (error) => resolve({ ok: false, statusCode: 0, responseMs: Date.now() - started, error: error.message }));
  });
}

async function receiverStatus() {
  const cfg = receiverUrls();
  const health = await requestStatus(cfg.healthUrl);
  return {
    ok: health.ok,
    status: health.ok ? "Online" : "Offline",
    managed: Boolean(receiverManagedProcess && !receiverManagedProcess.killed),
    pid: receiverManagedProcess?.pid || null,
    ...cfg,
    health
  };
}

async function waitForReceiver(urlValue, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const status = await requestStatus(urlValue, 1500);
    if (status.ok) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return requestStatus(urlValue, 1500);
}

async function startManagedReceiver() {
  const before = await receiverStatus();
  if (before.ok) return { ok: true, message: "Receiver is already online.", receiver: before };
  const receiverFile = packagedUnpackedPath("receivers", "dune-live-give-receiver.js");
  if (!fs.existsSync(receiverFile)) throw new Error(`Receiver was not found: ${receiverFile}`);
  const cfg = loadConfig();
  const urls = receiverUrls(cfg);
  const env = {
    ...process.env,
    DUNE_RECEIVER_HOST: urls.host,
    DUNE_RECEIVER_PORT: String(urls.port),
    DUNE_RECEIVER_TOKEN: cfg.receiverToken || process.env.DUNE_RECEIVER_TOKEN || "",
    DUNE_RECEIVER_SSH_HOST: cfg.receiverSshHost || cfg.vmIp || process.env.DUNE_RECEIVER_SSH_HOST || "",
    DUNE_RECEIVER_SSH_USER: cfg.receiverSshUser || cfg.sshUser || process.env.DUNE_RECEIVER_SSH_USER || "",
    DUNE_RECEIVER_SSH_KEY: expandEnvPath(cfg.receiverSshKey || cfg.sshKey || process.env.DUNE_RECEIVER_SSH_KEY || ""),
    DUNE_RECEIVER_LIVE_TELEPORT_ENABLED: cfg.liveTeleportEnabled ? "true" : "false",
    DUNE_ADMIN_GIVE_ITEM_URL: urls.giveUrl,
    DUNE_ADMIN_GIVE_ITEM_HEALTH_URL: urls.healthUrl,
    DUNE_ADMIN_GIVE_ITEM_TOKEN: cfg.receiverToken || process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN || ""
  };
  receiverManagedProcess = spawn(process.execPath, [receiverFile], {
    cwd: __dirname,
    env,
    stdio: "ignore",
    windowsHide: true,
    detached: false
  });
  receiverManagedProcess.on("exit", () => { receiverManagedProcess = null; });
  const ready = await waitForReceiver(urls.healthUrl);
  return { ok: ready.ok, message: ready.ok ? "Receiver started." : "Receiver did not become healthy.", receiver: await receiverStatus() };
}

function stopManagedReceiver() {
  if (receiverManagedProcess && !receiverManagedProcess.killed) {
    try {
      if (process.platform === "win32" && receiverManagedProcess.pid) spawn("taskkill", ["/pid", String(receiverManagedProcess.pid), "/T", "/F"], { windowsHide: true });
      else receiverManagedProcess.kill("SIGTERM");
    } catch {}
    receiverManagedProcess = null;
    return { ok: true, message: "Receiver stop requested." };
  }
  return { ok: true, message: "No suite-managed receiver process was running." };
}

async function autoDiscovery() {
  const cfg = loadConfig();
  const ips = localIps();
  const serverPath = expandEnvPath(cfg.serverInstallPath || "");
  const receiver = await receiverStatus();
  const dbPort = Number(cfg.databasePort || envNumber("PGPORT", 15432));
  return {
    ok: true,
    localIps: ips,
    receiver,
    database: {
      host: cfg.databaseHost || cfg.vmIp || VM_IP || "Auto via Dune VM",
      port: dbPort,
      name: cfg.databaseName || "dune",
      configured: Boolean(cfg.databaseHost || cfg.vmIp || VM_IP)
    },
    server: {
      installPath: serverPath,
      installPathExists: Boolean(serverPath && fs.existsSync(serverPath)),
      vmName: cfg.vmName || VM_NAME,
      vmIp: cfg.vmIp || VM_IP
    }
  };
}

async function connectionTest(target) {
  if (target === "database") {
    try {
      const output = await dbQuery("select 1 as ok", 20000);
      return { ok: /1/.test(output), target, message: "Database connection passed.", detail: output || "select 1 completed" };
    } catch (error) {
      return { ok: false, target, message: "Database connection failed.", error: error.message };
    }
  }
  if (target === "receiver") {
    const receiver = await receiverStatus();
    return { ok: receiver.ok, target, message: receiver.ok ? "Receiver is online." : "Receiver is offline.", receiver };
  }
  if (target === "server") {
    try {
      const vm = await vmInfo();
      return { ok: Boolean(vm.exists), target, message: vm.exists ? `Server VM detected: ${vm.state || "Unknown"}` : "Server VM was not detected.", vm };
    } catch (error) {
      return { ok: false, target, message: "Server test failed.", error: error.message };
    }
  }
  return { ok: false, target, message: "Unknown connection test." };
}

function readRecentLog(filePath, maxBytes = 90000) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const size = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (error) {
    return `Could not read log: ${error.message}`;
  }
}

async function diagnosticsSnapshot() {
  const [database, receiver, server] = await Promise.all([
    connectionTest("database"),
    connectionTest("receiver"),
    connectionTest("server")
  ]);
  const logDir = APPDATA_DIR ? path.join(APPDATA_DIR, "logs") : __dirname;
  return {
    ok: true,
    version: APP_VERSION,
    configPath: CONFIG_PATH,
    appData: APPDATA_DIR || __dirname,
    database,
    receiver,
    server,
    api: { status: "Online", url: `http://${HOST}:${PORT}` },
    logs: {
      suite: readRecentLog(path.join(logDir, "suite.log")),
      receiver: readRecentLog(path.join(logDir, "receiver.log")),
      desktop: readRecentLog(path.join(logDir, "desktop.log")),
      audit: readRecentLog(ADMIN_AUDIT_LOG)
    }
  };
}

function importSettings(payload) {
  const configPayload = payload?.config || payload;
  if (!configPayload || typeof configPayload !== "object") throw new Error("Import file did not contain settings.");
  return saveConfig({ ...loadConfig(), ...configPayload });
}

function checkGitHubUpdates(repo) {
  return new Promise((resolve) => {
    const targetRepo = String(repo || loadConfig().updateRepo || "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
      resolve({ ok: false, currentVersion: APP_VERSION, error: "Set a GitHub owner/repo in Settings first." });
      return;
    }
    const options = {
      hostname: "api.github.com",
      path: `/repos/${targetRepo}/releases/latest`,
      headers: { "User-Agent": "AlphaNine-Dune-Suite" },
      timeout: 7000
    };
    const req = https.get(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body || "{}");
          if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(data.message || `GitHub returned ${res.statusCode}`);
          resolve({
            ok: true,
            currentVersion: APP_VERSION,
            latestVersion: String(data.tag_name || data.name || ""),
            releaseName: data.name || "",
            url: data.html_url || `https://github.com/${targetRepo}/releases/latest`
          });
        } catch (error) {
          resolve({ ok: false, currentVersion: APP_VERSION, error: error.message });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, currentVersion: APP_VERSION, error: "GitHub update check timed out." });
    });
    req.on("error", (error) => resolve({ ok: false, currentVersion: APP_VERSION, error: error.message }));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: options.timeout || 120000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 8
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error ? String(error.message || error) : ""
      });
    });
  });
}

function runWithStdin(command, args, inputPath, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timeoutMs = options.timeout || 120000;
    const maxBuffer = options.maxBuffer || 1024 * 1024 * 8;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, code: 0, stdout, stderr, error: `Command timed out after ${timeoutMs} ms.` });
    }, timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, code: 0, stdout, stderr, error: String(error.message || error) }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr, error: code === 0 ? "" : `Command exited with code ${code}.` }));
    child.stdin.on("error", (error) => {
      if (!settled && error.code !== "EPIPE") finish({ ok: false, code: 0, stdout, stderr, error: String(error.message || error) });
    });
    const input = fs.createReadStream(inputPath);
    input.on("error", (error) => {
      child.kill("SIGKILL");
      finish({ ok: false, code: 0, stdout, stderr, error: String(error.message || error) });
    });
    input.pipe(child.stdin);
  });
}

async function ps(script, timeout = 120000) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout });
}

function psSingleQuote(value) {
  return String(value || "").replace(/'/g, "''");
}

function normalizeVmState(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return "Unknown";
  if (["running"].includes(lower)) return "Running";
  if (["off", "stopped", "saved"].includes(lower)) return "Stopped";
  if (["starting", "restoring"].includes(lower)) return "Starting";
  if (["stopping", "saving", "pausing", "paused"].includes(lower)) return "Stopping";
  return raw;
}

function vmUserError(message) {
  const text = String(message || "").trim();
  if (!text) return { code: "unknown", message: "VM command failed. Check Hyper-V and PowerShell permissions." };
  if (/you do not have the required permission/i.test(text)) {
    return {
      code: "access_denied",
      message: "Hyper-V access denied. Run AlphaNine Dune Suite as Administrator or grant the current Windows account membership in Hyper-V Administrators."
    };
  }
  if (/hyper-v not detected|not recognized|get-vm|start-vm|stop-vm|restart-vm/i.test(text) && /not recognized|not found|not available|not detected/i.test(text)) {
    return { code: "hyperv_unavailable", message: "Hyper-V not detected on this system." };
  }
  if (/access is denied|permission|administrator|elevat/i.test(text)) {
    return { code: "access_denied", message: "Hyper-V access denied. Run AlphaNine Dune Suite as Administrator or grant the current Windows account membership in Hyper-V Administrators." };
  }
  if (/cannot find|was not found|does not exist|not found/i.test(text)) {
    return { code: "vm_not_found", message: "VM not found. Check the VM Name in Settings." };
  }
  if (/service.*not.*running|hyper-v.*service|vmms/i.test(text)) {
    return { code: "hyperv_service_unavailable", message: "Hyper-V service unavailable. Start the Hyper-V Virtual Machine Management service and try again." };
  }
  if (/invalid|parameter/i.test(text)) {
    return { code: "invalid_vm_name", message: "Invalid VM name. Check the VM Name in Settings." };
  }
  return { code: "powershell_failure", message: text };
}

function configuredVmName() {
  return String(loadConfig().vmName || VM_NAME || "").trim();
}

async function hyperVStatus() {
  if (process.platform !== "win32") {
    return { ok: false, available: false, code: "unsupported_platform", message: "Hyper-V controls are only available on Windows." };
  }
  const result = await ps("if (Get-Command Get-VM -ErrorAction SilentlyContinue) { 'available' } else { 'missing' }", 10000);
  if (!result.ok) {
    const error = vmUserError(result.stderr || result.error || result.stdout);
    return { ok: false, available: false, code: error.code, message: error.message };
  }
  const available = /available/i.test(result.stdout);
  return {
    ok: available,
    available,
    code: available ? "available" : "hyperv_unavailable",
    message: available ? "Hyper-V PowerShell cmdlets detected." : "Hyper-V not detected on this system."
  };
}

async function vmInfo(vmNameValue = configuredVmName()) {
  const vmName = String(vmNameValue || "").trim();
  if (!vmName) return { ok: false, configured: false, exists: false, state: "Unknown", status: "Unknown", error: "VM name is not configured." };
  const hyperv = await hyperVStatus();
  if (!hyperv.available) return { ok: false, configured: true, exists: false, name: vmName, state: "Unknown", status: "Unknown", hyperv, error: hyperv.message };
  const script = `
    try {
    $vm = Get-VM -Name '${psSingleQuote(vmName)}' -ErrorAction Stop
    $ips = @(Get-VMNetworkAdapter -VMName '${psSingleQuote(vmName)}' | Select-Object -ExpandProperty IPAddresses | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' })
    @{ ok=$true; configured=$true; exists=$true; name="$($vm.Name)"; state="$($vm.State)"; status="$($vm.State)"; uptime="$($vm.Uptime)"; memory=$vm.MemoryAssigned; ip=($ips | Select-Object -First 1) } | ConvertTo-Json -Compress
    } catch {
      @{ ok=$false; configured=$true; exists=$false; name='${psSingleQuote(vmName)}'; state='Unknown'; status='Unknown'; needsAdmin=$true; error="$($_.Exception.Message)" } | ConvertTo-Json -Compress
    }
  `;
  const result = await ps(script, 30000);
  if (!result.ok) {
    const error = vmUserError(result.stderr || result.error);
    return { ok: false, configured: true, exists: false, name: vmName, state: "Unknown", status: "Unknown", needsAdmin: error.code === "access_denied", hyperv, error: error.message, errorCode: error.code };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    const state = normalizeVmState(parsed.state || parsed.status);
    const parsedError = parsed.ok || parsed.exists ? null : vmUserError(parsed.error);
    return { ...parsed, ok: Boolean(parsed.ok || parsed.exists), configured: true, name: parsed.name || vmName, state, status: state, hyperv, error: parsedError ? parsedError.message : parsed.error, errorCode: parsedError ? parsedError.code : parsed.errorCode };
  } catch {
    const error = vmUserError(result.stdout || result.stderr);
    return { ok: false, configured: true, exists: false, name: vmName, state: "Unknown", status: "Unknown", hyperv, error: error.message, errorCode: error.code };
  }
}

function appendVmAudit(action, result) {
  appendAdminAudit(`vm_${action}`, {
    timestamp: new Date().toISOString(),
    vmName: result?.name || configuredVmName() || "",
    result: result?.ok ? "success" : "failure",
    state: result?.state || result?.status || "Unknown",
    error: result?.error || "",
    details: result?.details || result?.stdout || result?.stderr || ""
  });
}

async function vmAction(action) {
  const allowed = new Set(["start", "stop", "restart"]);
  if (!allowed.has(action)) return { ok: false, error: "Unsupported VM action." };
  const vmName = configuredVmName();
  if (!vmName) return { ok: false, configured: false, error: "VM name is not configured." };
  const hyperv = await hyperVStatus();
  if (!hyperv.available) {
    const result = { ok: false, configured: true, action, name: vmName, state: "Unknown", status: "Unknown", hyperv, error: hyperv.message, errorCode: hyperv.code };
    appendVmAudit(action, result);
    return result;
  }
  const before = await vmInfo(vmName);
  if (action === "start" && before.state === "Running") {
    const result = { ok: true, action, name: vmName, state: "Running", status: "Running", message: "VM is already running.", vm: before };
    appendVmAudit(action, result);
    return result;
  }
  if (action === "stop" && before.state === "Stopped") {
    const result = { ok: true, action, name: vmName, state: "Stopped", status: "Stopped", message: "VM is already stopped.", vm: before };
    appendVmAudit(action, result);
    return result;
  }
  const command = action === "start" ? "Start-VM" : action === "stop" ? "Stop-VM" : "Restart-VM";
  const script = `
    try {
      ${command} -Name '${psSingleQuote(vmName)}' -ErrorAction Stop
      $vm = Get-VM -Name '${psSingleQuote(vmName)}' -ErrorAction Stop
      @{ ok=$true; action='${action}'; name="$($vm.Name)"; state="$($vm.State)"; status="$($vm.State)" } | ConvertTo-Json -Compress
    } catch {
      @{ ok=$false; action='${action}'; name='${psSingleQuote(vmName)}'; state='Unknown'; status='Unknown'; error="$($_.Exception.Message)" } | ConvertTo-Json -Compress
    }
  `;
  const result = await ps(script, action === "restart" ? 120000 : 60000);
  let parsed = {};
  try { parsed = JSON.parse(result.stdout.trim() || "{}"); } catch {}
  const state = normalizeVmState(parsed.state || parsed.status);
  const userError = vmUserError(parsed.error || result.stderr || result.error || "");
  const finalResult = {
    ok: Boolean(result.ok && parsed.ok),
    action,
    name: parsed.name || vmName,
    state,
    status: state,
    hyperv,
    details: result.stdout || result.stderr || result.error || parsed.error || "",
    error: result.ok && parsed.ok ? "" : userError.message,
    errorCode: result.ok && parsed.ok ? "" : userError.code
  };
  appendVmAudit(action, finalResult);
  return finalResult;
}

async function waitForVmRunning(timeout = 90000) {
  const started = Date.now();
  let last = await vmInfo();
  while (Date.now() - started < timeout) {
    if (last.state === "Running") return { ok: true, vm: last, waitedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 3000));
    last = await vmInfo();
  }
  return { ok: false, vm: last, waitedMs: Date.now() - started, error: "Timed out waiting for VM to reach Running." };
}

function vmMonitorHost(vm = null) {
  return String(vm?.ip || VM_IP || "").trim();
}

function configuredPortFromUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
  } catch {}
  return null;
}

function configuredMonitorPorts() {
  const receiver = receiverUrls();
  const ports = [
    { key: "suite", label: "8810 (Suite Backend)", host: HOST, port: PORT },
    { key: "receiver", label: `${receiver.port} (Live Give Receiver)`, host: receiver.host, port: receiver.port },
    { key: "ssh", label: "22 (SSH)", port: 22 }
  ];
  const rabbitPort = configuredPortFromUrl(LIVE_GIVE_ENV.rabbitHealthUrl || LIVE_GIVE_ENV.rabbitPublishUrl) || envNumber("DUNE_ADMIN_RABBITMQ_PORT", 0);
  const dbPort = envNumber("DUNE_ADMIN_DATABASE_PORT", 0) || envNumber("PGPORT", 0) || configuredPortFromUrl(process.env.DATABASE_URL || "");
  if (rabbitPort) ports.push({ key: "rabbitmq", label: `${rabbitPort} (RabbitMQ)`, port: rabbitPort });
  if (dbPort) ports.push({ key: "database", label: `${dbPort} (Database)`, port: dbPort });
  return ports;
}

function checkPort(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (open, error = "") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, responseMs: Date.now() - started, error });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "Timed out"));
    socket.once("error", (error) => done(false, error.code || error.message));
    socket.connect(port, host);
  });
}

async function pingHost(host) {
  if (!host) return { ok: false, ms: null, error: "VM address unavailable" };
  const script = `
    $r = Test-Connection -ComputerName ${JSON.stringify(host)} -Count 1 -ErrorAction SilentlyContinue
    if ($r) { [int]$r.ResponseTime } else { "offline" }
  `;
  const result = await ps(script, 2500);
  const text = String(result.stdout || "").trim();
  const ms = Number(text);
  if (Number.isFinite(ms)) return { ok: true, ms, error: "" };
  return { ok: false, ms: null, error: result.stderr || result.error || "Ping failed" };
}

function recordVmPing(ping) {
  const now = Date.now();
  vmMonitorPingHistory.push({ t: now, ms: ping.ok ? ping.ms : null });
  while (vmMonitorPingHistory.length && now - vmMonitorPingHistory[0].t > 60000) vmMonitorPingHistory.shift();
  const values = vmMonitorPingHistory.map((row) => row.ms).filter((value) => Number.isFinite(value));
  return {
    current: ping.ok ? ping.ms : null,
    average: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    history: vmMonitorPingHistory.slice(-60)
  };
}

async function vmMonitorServiceChecks(host, ports) {
  const byKey = Object.fromEntries(ports.map((row) => [row.key, row]));
  const services = {
    ssh: { label: "SSH Reachable", reachable: Boolean(byKey.ssh?.open), responseMs: byKey.ssh?.responseMs ?? null, error: byKey.ssh?.error || "" },
    receiver: { label: "Receiver Reachable", reachable: Boolean(byKey.receiver?.open), responseMs: byKey.receiver?.responseMs ?? null, error: byKey.receiver?.error || "" },
    database: { label: "Database Reachable", reachable: byKey.database ? Boolean(byKey.database.open) : null, responseMs: byKey.database?.responseMs ?? null, error: byKey.database?.error || "Not configured" },
    rabbitmq: { label: "RabbitMQ Reachable", reachable: byKey.rabbitmq ? Boolean(byKey.rabbitmq.open) : null, responseMs: byKey.rabbitmq?.responseMs ?? null, error: byKey.rabbitmq?.error || "Not configured" },
    kubernetes: { label: "Kubernetes Reachable", reachable: null, responseMs: null, error: "SSH unavailable" }
  };
  if (services.ssh.reachable && host) {
    const started = Date.now();
    const result = await sshCommand("sudo kubectl get nodes --request-timeout=3s --no-headers 2>/dev/null | head -n 1", 8000);
    services.kubernetes = {
      label: "Kubernetes Reachable",
      reachable: result.ok && Boolean(String(result.stdout || "").trim()),
      responseMs: Date.now() - started,
      error: result.ok ? "" : (result.stderr || result.error || "kubectl check failed")
    };
  }
  return services;
}

function vmMonitorHealthScore(vm, pingStats, ports, services) {
  let score = 0;
  const serviceValues = Object.values(services).filter((service) => service.reachable !== null);
  if (vm.exists && String(vm.state || "").toLowerCase() === "running") score += 25;
  if (Number.isFinite(pingStats.current)) score += pingStats.current < 120 ? 20 : pingStats.current < 250 ? 12 : 6;
  const openPorts = ports.filter((port) => port.open).length;
  if (ports.length) score += Math.round((openPorts / ports.length) * 25);
  const reachableServices = serviceValues.filter((service) => service.reachable).length;
  if (serviceValues.length) score += Math.round((reachableServices / serviceValues.length) * 30);
  return Math.max(0, Math.min(100, score));
}

function vmMonitorKind(score, online) {
  if (!online || score < 45) return "bad";
  if (score < 75) return "warn";
  return "ok";
}

async function vmConnectionMonitor() {
  const checkedAt = new Date().toISOString();
  const vm = await vmInfo();
  const host = vmMonitorHost(vm);
  const ping = await pingHost(host);
  const pingStats = recordVmPing(ping);
  const portTargets = configuredMonitorPorts().map((row) => ({ ...row, host: row.host || host }));
  const ports = await Promise.all(portTargets.map(async (target) => {
    if (!target.host) return { ...target, open: false, responseMs: null, error: "VM address unavailable" };
    const result = await checkPort(target.host, target.port);
    return { ...target, ...result };
  }));
  const services = await vmMonitorServiceChecks(host, ports);
  const hasReachablePort = ports.some((port) => port.open);
  const hasReachableService = Object.values(services).some((service) => service.reachable === true);
  const online = Boolean(ping.ok || hasReachablePort || hasReachableService || (vm.exists && String(vm.state || "").toLowerCase() === "running"));
  const score = vmMonitorHealthScore(vm, pingStats, ports, services);
  const errors = [
    vm.error,
    ping.error,
    ...ports.filter((port) => !port.open).map((port) => `${port.label}: ${port.error || "Closed"}`),
    ...Object.values(services).filter((service) => service.reachable === false).map((service) => `${service.label}: ${service.error || "Unavailable"}`)
  ].filter(Boolean).slice(0, 8);
  if (online) vmMonitorLastSuccess = checkedAt;
  return {
    checkedAt,
    status: online ? "Online" : "Offline",
    kind: vmMonitorKind(score, online),
    vm: {
      exists: Boolean(vm.exists),
      state: vm.state || "Unknown",
      hostname: VM_NAME,
      address: host || "Unknown",
      uptime: vm.uptime || "Unknown"
    },
    latency: pingStats,
    ports,
    services,
    healthScore: score,
    lastErrors: errors,
    lastSuccessfulConnection: vmMonitorLastSuccess || "None yet"
  };
}

async function sshCommand(command, timeout = 180000, options = {}) {
  const info = await vmInfo();
  const ip = info.ip || VM_IP;
  if (!info.exists && !ip) return { ok: false, stdout: "", stderr: info.error || "VM not found.", error: "VM not found." };
  if (info.exists && info.state !== "Running") return { ok: false, stdout: "", stderr: "VM is not running.", error: "VM is not running." };
  if (!ip) return { ok: false, stdout: "", stderr: "VM IP address was not found.", error: "VM IP address was not found." };
  const key = sshKeyStatus(SSH_KEY);
  if (!key.exists) return { ok: false, stdout: "", stderr: key.message, error: key.message, sshKey: key };
  return run("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "LogLevel=QUIET",
    "-i", key.path,
    `${SSH_USER}@${ip}`,
    command
  ], { timeout, maxBuffer: options.maxBuffer });
}

function parseStatus(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = {};
  const servers = [];
  let inServers = false;
  let statusColumns = [];
  for (const line of lines) {
    if (/^Battlegroup:/.test(line)) summary.battlegroup = line.replace(/^Battlegroup:\s*/, "");
    const keyValues = [...line.matchAll(/\b(PHASE|SERVERGROUP|GATEWAY|DIRECTOR)\s*[:=]\s*([A-Za-z-]+)/gi)];
    for (const match of keyValues) {
      const key = match[1].toLowerCase();
      const value = match[2];
      if (key === "phase") {
        summary.phase = value;
        summary.status = value;
      } else if (key === "servergroup") {
        summary.servergroup = value;
      } else {
        summary[key] = value;
      }
    }
    if (/^(Status|Phase)\s+/i.test(line) && /(Gateway|Director)/i.test(line)) {
      statusColumns = line.split(/\s+/).map((part) => part.toLowerCase());
      continue;
    }
    if (/^(Healthy|Reconciling|Running|Updating|Starting|Progressing|Unhealthy|Ready|Pending|Stopped|Failed|Error|Unreachable|Missing)\s+/i.test(line) && (!summary.status || !summary.gateway || !summary.director || !summary.servergroup)) {
      const parts = line.split(/\s+/);
      summary.status = parts[0];
      summary.phase = parts[0];
      if (statusColumns.length) {
        for (let index = 1; index < statusColumns.length && index < parts.length; index += 1) {
          const column = statusColumns[index];
          if (column === "servergroup" || column === "server-group") summary.servergroup = parts[index];
          else if (column === "database") summary.database = parts[index];
          else if (column === "gateway") summary.gateway = parts[index];
          else if (column === "director") summary.director = parts[index];
          else if (column === "uptime") summary.uptime = parts.slice(index).join(" ");
        }
      } else {
        summary.database = parts[1];
        summary.gateway = parts[2];
        summary.director = parts[3];
        summary.uptime = parts.slice(4).join(" ");
      }
    }
    if (/^Game Servers/i.test(line)) {
      inServers = true;
      continue;
    }
    if (inServers && !/^[-\s]*$/.test(line) && !/^Map\s+/i.test(line)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 5) {
        servers.push({
          map: parts[0],
          phase: parts[1],
          ready: parts[2],
          players: parts[3],
          age: parts.slice(4).join(" ")
        });
      }
    }
  }
  return { summary, servers, raw: text };
}

async function battlegroup(action) {
  const allowed = new Set(["status", "start", "restart", "stop", "update", "backup", "logs-export", "operator-logs-export"]);
  if (!allowed.has(action)) return { ok: false, error: "Unsupported action." };
  if (action !== "status") {
    const readiness = serverControlConfigured();
    if (!readiness.configured) {
      appendAdminAudit(`server_${action}_skipped`, {
        action,
        reason: readiness.reason,
        config: readiness.summary
      });
      return { ok: false, skipped: true, stdout: "", stderr: readiness.reason, error: readiness.reason };
    }
    appendAdminAudit(`server_${action}_requested`, {
      action,
      config: readiness.summary
    });
  }
  return sshCommand(`/home/dune/.dune/bin/battlegroup ${action}`, action === "update" ? 600000 : 240000);
}

function serverControlConfigured() {
  const cfg = loadConfig();
  const root = expandEnvPath(cfg.serverInstallPath || "");
  const rootExists = Boolean(root && fs.existsSync(root));
  const hasAddress = Boolean(String(cfg.vmIp || VM_IP || "").trim());
  const configured = Boolean(cfg.setupComplete || hasAddress || rootExists);
  return {
    configured,
    reason: configured ? "Server control is configured." : "Server start skipped: complete Setup or configure VM IP/server install path first.",
    summary: {
      setupComplete: Boolean(cfg.setupComplete),
      vmName: cfg.vmName || VM_NAME || "",
      vmIpSet: hasAddress,
      serverInstallPathSet: Boolean(root),
      serverInstallPathExists: rootExists
    }
  };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function battlegroupResource() {
  const result = await sshCommand("sudo kubectl get igwbg -A -o json", 30000);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || "Could not read battlegroup resource.");
  let data = null;
  try { data = JSON.parse(result.stdout || "{}"); }
  catch { throw new Error("Could not parse battlegroup resource."); }
  const item = data.items && data.items[0];
  if (!item) throw new Error("No battlegroup resource was found.");
  return item;
}

function mapRowsFromResource(item) {
  const active = new Map();
  for (const server of item.status?.servers || []) {
    const key = server.partitionMap || server.map;
    if (!key) continue;
    active.set(key, (active.get(key) || 0) + 1);
  }
  return (item.spec?.serverGroup?.template?.spec?.sets || []).map((set, index) => ({
    index,
    map: set.map || `Map ${index + 1}`,
    replicas: Number(set.replicas || 0),
    running: active.get(set.map) || 0,
    memory: set.resources?.limits?.memory || "",
    dedicatedScaling: Boolean(set.dedicatedScaling),
    deploymentMode: set.dedicatedScaling ? "Dedicated" : "Standard"
  }));
}

async function mapDeploymentList() {
  const item = await battlegroupResource();
  return {
    battlegroup: item.metadata?.name || "",
    namespace: item.metadata?.namespace || "",
    maps: mapRowsFromResource(item)
  };
}

async function worldMapMetadata() {
  const [item, mapNamesRaw, partitionsRaw, markerCountsRaw, mapAreasRaw, resetSeedsRaw, spiceRaw] = await Promise.all([
    battlegroupResource(),
    dbQuery(`
      select map_name_id::text, map_name
      from dune.map_names
      order by map_name_id
    `),
    dbQuery(`
      select
        wp.map,
        coalesce(wp.label, '') as label,
        wp.dimension_index::text,
        coalesce(wp.blocked, false)::text,
        coalesce(wp.server_id, '') as server_id,
        coalesce(wp.partition_definition::text, '') as partition_definition
      from dune.world_partition wp
      order by wp.partition_id
    `),
    dbQuery(`
      select coalesce(mn.map_name, 'Unknown') as map_name, count(*)::text as marker_count
      from dune.markers m
      left join dune.map_names mn on mn.map_name_id = m.map_name_id
      group by mn.map_name
      order by count(*) desc, map_name
    `),
    dbQuery(`
      select coalesce(map_name, 'Unknown') as map_name, count(*)::text as area_count
      from dune.map_areas
      group by map_name
      order by count(*) desc, map_name
    `),
    dbQuery(`
      select map, world_reset_seed::text
      from dune.world_map_reset_seed
      order by map
    `),
    dbQuery(`
      select
        coalesce(server_id, 'Unknown') as server_id,
        spicefield_type_id::text,
        inactive_fields_of_type::text,
        requested_spawned_of_type::text
      from dune.spicefield_server_availability
      order by server_id, spicefield_type_id
    `)
  ]);

  const serverRows = mapRowsFromResource(item);
  const serverByMap = new Map(serverRows.map((row) => [row.map, row]));
  const namesById = new Map();
  const mapNames = mapNamesRaw ? mapNamesRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id = "", name = ""] = line.split("\t");
    namesById.set(id, name);
    return { id: Number(id) || null, name };
  }).filter((row) => row.name) : [];

  const markerCounts = new Map();
  const markerRows = markerCountsRaw ? markerCountsRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [mapName = "Unknown", count = "0"] = line.split("\t");
    const row = { mapName, count: Number(count) || 0 };
    markerCounts.set(mapName, row.count);
    return row;
  }) : [];

  const areaCounts = new Map();
  const areaRows = mapAreasRaw ? mapAreasRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [mapName = "Unknown", count = "0"] = line.split("\t");
    const row = { mapName, count: Number(count) || 0 };
    areaCounts.set(mapName, row.count);
    return row;
  }) : [];

  const resetSeeds = resetSeedsRaw ? resetSeedsRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [map = "", seed = ""] = line.split("\t");
    return { map, worldResetSeed: seed === "" ? null : Number(seed) };
  }).filter((row) => row.map) : [];

  const partitions = partitionsRaw ? partitionsRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [map = "", label = "", dimensionIndex = "", blocked = "false", serverId = "", definition = ""] = line.split("\t");
    const server = serverByMap.get(map) || null;
    return {
      map,
      label,
      dimensionIndex: Number(dimensionIndex) || 0,
      blocked: /^true$/i.test(blocked),
      serverId,
      serverRunning: Boolean(server && Number(server.running) > 0),
      serverReplicas: server ? Number(server.replicas) || 0 : 0,
      deploymentMode: server?.deploymentMode || "",
      definition
    };
  }).filter((row) => row.map) : [];

  const partitionSummary = partitions.reduce((summary, row) => {
    summary.total += 1;
    if (row.blocked) summary.blocked += 1;
    else summary.unblocked += 1;
    if (row.serverRunning) summary.running += 1;
    return summary;
  }, { total: 0, blocked: 0, unblocked: 0, running: 0 });

  const spicefieldAvailability = spiceRaw ? spiceRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [serverId = "", spicefieldTypeId = "", inactive = "0", requested = "0"] = line.split("\t");
    return {
      serverId,
      spicefieldTypeId: Number(spicefieldTypeId) || 0,
      inactiveFieldsOfType: Number(inactive) || 0,
      requestedSpawnedOfType: Number(requested) || 0
    };
  }) : [];

  const relevantNames = new Set(["HaggaBasin", "DeepDesert", "Arrakeen", "HarkoVillage", "Overland"]);
  const regionCards = mapNames
    .filter((row) => relevantNames.has(row.name))
    .map((row) => {
      const normalized = row.name.replace(/\s+/g, "");
      const relatedPartitions = partitions.filter((partition) => (
        partition.map.toLowerCase().includes(normalized.toLowerCase()) ||
        partition.label.toLowerCase().includes(normalized.toLowerCase()) ||
        (row.name === "HaggaBasin" && partition.map === "Survival_1") ||
        (row.name === "Overland" && partition.map === "Overmap")
      ));
      return {
        name: row.name,
        mapNameId: row.id,
        partitionCount: relatedPartitions.length,
        blockedPartitions: relatedPartitions.filter((partition) => partition.blocked).length,
        runningPartitions: relatedPartitions.filter((partition) => partition.serverRunning).length,
        markerCount: markerCounts.get(row.name) || 0,
        discoveredAreaCount: areaCounts.get(row.name) || 0,
        worldResetSeed: resetSeeds.find((seed) => seed.map === row.name)?.worldResetSeed ?? null
      };
    });

  return {
    ok: true,
    sourceTables: [
      "dune.map_names",
      "dune.world_partition",
      "dune.map_areas",
      "dune.markers",
      "dune.world_map_reset_seed",
      "dune.spicefield_server_availability"
    ],
    excludedTables: ["dune.overmap_players", "dune.player_markers"],
    battlegroup: item.metadata?.name || "",
    namespace: item.metadata?.namespace || "",
    serverRegionStatus: {
      configuredRegion: "",
      battlegroupPhase: item.status?.phase || "",
      serverGroupPhase: item.status?.serverGroupPhase || "",
      namespace: item.metadata?.namespace || ""
    },
    mapNames,
    regions: regionCards,
    partitions,
    partitionSummary,
    markerCounts: markerRows,
    markerCount: markerRows.reduce((sum, row) => sum + row.count, 0),
    mapAreas: areaRows,
    resetSeeds,
    spicefieldAvailability
  };
}

async function setMapReplicas(mapName, replicas) {
  const cleanMap = String(mapName || "").trim();
  const count = Number(replicas);
  if (!/^[A-Za-z0-9_]+$/.test(cleanMap)) throw new Error("Choose a valid map.");
  if (!Number.isInteger(count) || count < 0 || count > 3) throw new Error("Replica count must be between 0 and 3.");

  const item = await battlegroupResource();
  const rows = mapRowsFromResource(item);
  const row = rows.find((entry) => entry.map === cleanMap);
  if (!row) throw new Error("Map was not found in the battlegroup.");
  if (row.dedicatedScaling && count > 0) {
    throw new Error(`${cleanMap} is a dedicated-scaling map. The current safe deploy button can only start standard maps; dedicated maps need battlegroup director scaling first.`);
  }

  const namespace = item.metadata?.namespace;
  const name = item.metadata?.name;
  const patch = JSON.stringify([{ op: "replace", path: `/spec/serverGroup/template/spec/sets/${row.index}/replicas`, value: count }]);
  const command = [
    "sudo kubectl patch igwbg",
    shQuote(name),
    "-n",
    shQuote(namespace),
    "--type=json",
    `-p=${shQuote(patch)}`
  ].join(" ");
  const result = await sshCommand(command, 120000);
  return { ...result, map: cleanMap, replicas: count };
}

function gearCatalog() {
  const cache = loadDuneItemsCache();
  return cache.items || [];
}

function gearImageUrlFromPath(localPath) {
  if (!localPath) return "";
  const name = path.basename(String(localPath));
  return name ? `/gear-images/${encodeURIComponent(name)}` : "";
}

function sanitizeGearItemForUi(item = {}) {
  const imageLocalPath = String(item.imageLocalPath || "");
  const icon = gearImageUrlFromPath(imageLocalPath);
  return {
    id: String(item.id || ""),
    name: String(item.name || item.id || ""),
    category: String(item.category || ""),
    type: String(item.type || item.subtype || ""),
    subtype: String(item.subtype || item.type || ""),
    detail: String(item.detail || ""),
    tier: String(item.tier || ""),
    rarity: String(item.rarity || ""),
    maxStack: String(item.maxStack || ""),
    imageLocalPath,
    icon,
    hasDisplayName: item.hasDisplayName === true
  };
}

function loadDuneItemsCache() {
  if (!fs.existsSync(DUNE_ITEMS_CACHE_PATH)) {
    return { ok: false, items: [], report: { cachePath: DUNE_ITEMS_CACHE_PATH, imageCacheDir: GEAR_IMAGE_CACHE_DIR, totalItemsFound: 0, totalImagesDownloaded: 0, totalImagesReused: 0, failedImageDownloads: 0, message: "Item cache has not been generated yet. Run Import Gear Items." } };
  }
  try {
    const data = JSON.parse(fs.readFileSync(DUNE_ITEMS_CACHE_PATH, "utf8"));
    const items = (data.items || []).map(sanitizeGearItemForUi).filter((item) => item.id && item.name);
    return { ok: true, items, report: data.report || {}, generatedAt: data.generatedAt || "" };
  } catch (error) {
    return { ok: false, items: [], report: { cachePath: DUNE_ITEMS_CACHE_PATH, imageCacheDir: GEAR_IMAGE_CACHE_DIR, error: error.message, totalItemsFound: 0 } };
  }
}

function itemCandidateRoots() {
  const cfg = loadConfig();
  return [
    cfg.serverInstallPath,
    process.env.DUNE_SERVER_INSTALL_PATH,
    process.env.DUNE_AWAKENING_SERVER_PATH,
    process.env.DUNE_GAME_PATH,
    process.env.STEAM_APPS
  ].filter(Boolean).map((entry) => path.resolve(String(entry))).filter((entry, index, list) => fs.existsSync(entry) && list.indexOf(entry) === index);
}

function isLikelyItemFile(filePath) {
  const lower = filePath.toLowerCase();
  return /\.(json|jsonc|csv|tsv|txt|ini|cfg|dat|bin|uasset|uexp|pak|utoc|ucas|vhd|vhdx)$/i.test(lower);
}

function walkItemFiles(root, limit = 12000) {
  const files = [];
  let truncated = false;
  const stack = [root];
  while (stack.length && files.length < limit) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!/node_modules|installer-output|\.git|logs|backups|screenshots/i.test(full)) stack.push(full);
      } else if (entry.isFile() && isLikelyItemFile(full)) {
        files.push(full);
      }
    }
  }
  if (stack.length || files.length >= limit) truncated = true;
  files.truncated = truncated;
  return files;
}

function cleanItemText(value) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function looksLikeItemId(value) {
  const text = cleanItemText(value);
  return /^[A-Za-z0-9_:.\/-]{3,220}$/.test(text) && /(item|items\.|inventory|loot|weapon|armor|resource|equipment|template|gear)/i.test(text);
}

function addDiscoveredItem(items, raw) {
  const id = cleanItemText(raw.id || raw.template || raw.path || raw.internalId);
  if (!id || !looksLikeItemId(id)) return;
  const existing = items.get(id);
  const display = cleanItemText(raw.name || raw.displayName || raw.label || raw.title);
  const hasDisplayName = Boolean(display && display !== id && !looksLikeItemId(display));
  const item = {
    id,
    name: hasDisplayName ? display : id,
    category: cleanItemText(raw.category || raw.type || raw.class || ""),
    detail: cleanItemText(raw.detail || raw.description || raw.source || ""),
    tier: cleanItemText(raw.tier || ""),
    rarity: cleanItemText(raw.rarity || ""),
    maxStack: cleanItemText(raw.maxStack || raw.stackSize || ""),
    icon: "",
    source: cleanItemText(raw.source || ""),
    hasDisplayName
  };
  if (!existing || (!existing.hasDisplayName && item.hasDisplayName)) items.set(id, { ...existing, ...item });
}

function scanJsonForItems(value, source, items, depth = 0) {
  if (depth > 18 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => scanJsonForItems(entry, source, items, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const id = value.id || value.itemId || value.ItemId || value.template || value.Template || value.nameId || value.assetId || value.path || value.objectPath || value.ObjectPath || value.primaryAssetId;
  const name = value.displayName || value.DisplayName || value.name || value.Name || value.title || value.Title || value.localizedName;
  if (id || looksLikeItemId(name)) {
    addDiscoveredItem(items, {
      id: id || name,
      name,
      category: value.category || value.Category || value.itemType || value.ItemType || value.type || value.Type,
      detail: value.description || value.Description || value.tooltip || value.Tooltip,
      tier: value.tier || value.Tier,
      rarity: value.rarity || value.Rarity,
      maxStack: value.maxStack || value.MaxStack || value.stackSize || value.StackSize,
      source
    });
  }
  for (const child of Object.values(value)) scanJsonForItems(child, source, items, depth + 1);
}

function scanTextForItems(text, source, items) {
  const patterns = [
    /\bItems\.[A-Za-z0-9_.:-]{2,180}\b/g,
    /\b(?:Item|Weapon|Armor|Resource|Inventory)[A-Za-z0-9_.:-]{3,180}\b/g,
    /\/Game\/[A-Za-z0-9_\/.-]*(?:Item|Weapon|Armor|Resource|Inventory|Gear)[A-Za-z0-9_\/.-]*/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) addDiscoveredItem(items, { id: match[0], source });
  }
}

function scanItemFile(filePath, items) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const report = { path: filePath, size: stat.size, format: ext.replace(".", "") || "unknown", itemsFound: 0, status: "scanned" };
  const before = items.size;
  if (stat.size > 250 * 1024 * 1024) {
    report.status = "skipped-too-large";
    report.note = "File exceeds scanner limit. No items were silently skipped; this file requires a dedicated Unreal extraction tool.";
    return report;
  }
  try {
    if ([".json", ".jsonc"].includes(ext)) {
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      scanJsonForItems(JSON.parse(raw), filePath, items);
    } else if ([".pak", ".utoc", ".ucas", ".uasset", ".uexp"].includes(ext)) {
      const raw = fs.readFileSync(filePath);
      scanTextForItems(raw.toString("latin1"), filePath, items);
      report.status = "binary-inspected";
      report.note = "Unreal binary/container inspected for item identifiers. Display names require exported metadata/localization.";
    } else {
      scanTextForItems(fs.readFileSync(filePath, "utf8"), filePath, items);
    }
  } catch (error) {
    report.status = "error";
    report.error = error.message;
  }
  report.itemsFound = items.size - before;
  return report;
}

async function scanRemoteDuneItems(items) {
  const script = [
    "set +e",
    "roots='/home/dune /funcom /mnt /opt /var/lib/rancher/k3s/storage'",
    "pattern='Items\\.[A-Za-z0-9_.:-]{2,180}|/Game/[A-Za-z0-9_./-]*(Item|Weapon|Armor|Resource|Inventory|Gear)[A-Za-z0-9_./-]*'",
    "for root in $roots; do",
    "  [ -d \"$root\" ] || continue",
    "  find \"$root\" -type f \\( -iname '*.json' -o -iname '*.csv' -o -iname '*.ini' -o -iname '*.txt' -o -iname '*.uasset' -o -iname '*.uexp' -o -iname '*.pak' -o -iname '*.utoc' -o -iname '*.ucas' \\) -size -300M -print 2>/dev/null",
    "done | head -n 2000 | while IFS= read -r file; do",
    "  echo __ALPHANINE_FILE__:$file",
    "  grep -aEo \"$pattern\" \"$file\" 2>/dev/null | sort -u | head -n 5000",
    "done"
  ].join("\n");
  const result = await sshCommand(script, 120000, { maxBuffer: 1024 * 1024 * 12 });
  const report = { source: "ssh-vm", status: result.ok ? "scanned" : "unavailable", filesScanned: [], itemsFound: 0, error: result.ok ? "" : (result.stderr || result.error || result.stdout || "Remote VM item scan failed.") };
  if (!result.ok) return report;
  let current = "";
  const before = items.size;
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("__ALPHANINE_FILE__:")) {
      current = line.slice("__ALPHANINE_FILE__:".length);
      report.filesScanned.push({ path: current, status: "remote-scanned" });
      continue;
    }
    if (line.trim()) addDiscoveredItem(items, { id: line.trim(), source: current ? `ssh:${current}` : "ssh" });
  }
  report.itemsFound = items.size - before;
  return report;
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value = "") {
  return decodeHtmlEntities(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseHtmlAttrs(tag = "") {
  const attrs = {};
  for (const match of String(tag || "").matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] || match[3] || match[4] || "");
  }
  return attrs;
}

function absoluteUrl(href, base = GEAR_IMPORT_URL) {
  try { return new URL(String(href || ""), base).toString(); } catch { return ""; }
}

function stableGearIdFromUrl(urlValue, fallback = "") {
  try {
    const url = new URL(urlValue);
    const segment = url.pathname.split("/").filter(Boolean).pop() || fallback;
    return decodeURIComponent(segment).trim() || fallback;
  } catch {
    return fallback;
  }
}

function safeGearFileName(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "item";
}

function cleanGearDisplayName(value, fallback = "") {
  const clean = stripTags(value)
    .replace(/\s+[\-|]\s*(Dune Awakening|Dune: Awakening|Gaming\.Tools|Dune Gaming Tools).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || fallback;
}

function gearImageExtension(urlValue = "", contentType = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("webp")) return ".webp";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("png")) return ".png";
  try {
    const ext = path.extname(new URL(urlValue).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  } catch {}
  return ".png";
}

function httpRequestBuffer(urlValue, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 20000);
  const redirects = Number(options.redirects ?? 4);
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlValue); } catch (error) { reject(error); return; }
    const client = parsed.protocol === "http:" ? http : https;
    const req = client.request(parsed, {
      method: "GET",
      headers: {
        "User-Agent": `AlphaNine-Dune-Suite/${APP_VERSION} item-cache-importer`,
        "Accept": options.accept || "*/*"
      }
    }, (response) => {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects > 0) {
        response.resume();
        httpRequestBuffer(absoluteUrl(location, urlValue), { ...options, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        resolve({ buffer: body, contentType: String(response.headers["content-type"] || ""), statusCode: response.statusCode });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.end();
  });
}

async function httpRequestText(urlValue, timeoutMs = 25000) {
  const result = await httpRequestBuffer(urlValue, { timeoutMs, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });
  return result.buffer.toString("utf8");
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const count = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }));
  return results;
}

function parseGearTextMetadata(text = "") {
  const clean = stripTags(text);
  const result = { name: cleanGearDisplayName(clean, clean), category: "", subtype: "", type: "", tier: "", rarity: "" };
  const rarityMatch = clean.match(/\b(Common|Uncommon|Rare|Epic|Legendary|Unique)\b/i);
  if (rarityMatch) result.rarity = rarityMatch[1];
  const tierMatch = clean.match(/\bTier\s+([0-9IVX]+)\b/i);
  if (tierMatch) result.tier = `Tier ${tierMatch[1]}`;
  const structured = clean.match(/^(.*?)\s+([A-Za-z][A-Za-z &/]+?)\s+-\s+([A-Za-z][A-Za-z &/]+?)(?:\s+Tier\s+[0-9IVX]+)?(?:\s+(?:Common|Uncommon|Rare|Epic|Legendary|Unique))?$/i);
  if (structured) {
    result.name = cleanGearDisplayName(structured[1], structured[1]).trim();
    result.category = structured[2].trim();
    result.subtype = structured[3].trim();
    result.type = result.subtype;
  }
  return result;
}

function metaContent(html, selectorName) {
  const escaped = selectorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const regex of regexes) {
    const match = String(html || "").match(regex);
    if (match) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function parseDuneGamingToolsItemLinks(html) {
  const items = new Map();
  for (const match of String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseHtmlAttrs(match[1]);
    const href = attrs.href || "";
    if (!/\/items\/[^/?#]+/i.test(href)) continue;
    const detailUrl = absoluteUrl(href, GEAR_IMPORT_URL);
    const id = stableGearIdFromUrl(detailUrl);
    if (!id || items.has(id)) continue;
    const parsed = parseGearTextMetadata(match[2]);
    const name = parsed.name && parsed.name.length < 140 ? cleanGearDisplayName(parsed.name, id) : id;
    items.set(id, {
      id,
      name,
      category: parsed.category,
      subtype: parsed.subtype,
      type: parsed.type,
      tier: parsed.tier,
      rarity: parsed.rarity,
      detail: "",
      detailUrl,
      imageUrl: "",
      imageLocalPath: "",
      maxStack: "",
      hasDisplayName: Boolean(name && name !== id)
    });
  }
  return Array.from(items.values());
}

function parseDuneGamingToolsDetail(html, item) {
  const h1 = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = cleanGearDisplayName(metaContent(html, "og:title") || (h1 ? stripTags(h1[1]) : ""), item.name);
  const description = metaContent(html, "description") || metaContent(html, "og:description");
  const imageUrl = metaContent(html, "og:image") || metaContent(html, "twitter:image") || (() => {
    for (const match of String(html || "").matchAll(/<img\b([^>]*)>/gi)) {
      const attrs = parseHtmlAttrs(match[1]);
      const src = attrs.src || attrs["data-src"] || "";
      if (src && !/logo|avatar|favicon/i.test(src)) return absoluteUrl(src, item.detailUrl);
    }
    return "";
  })();
  const combined = [title, description, stripTags(html).slice(0, 800)].filter(Boolean).join(" ");
  const parsed = parseGearTextMetadata(`${title || item.name} ${description || ""}`);
  return {
    ...item,
    name: title && title.length < 140 ? cleanGearDisplayName(title, item.name) : item.name,
    detail: description || item.detail || "",
    category: item.category || parsed.category,
    subtype: item.subtype || parsed.subtype,
    type: item.type || parsed.type,
    tier: item.tier || parsed.tier || (combined.match(/\bTier\s+([0-9IVX]+)\b/i) ? `Tier ${combined.match(/\bTier\s+([0-9IVX]+)\b/i)[1]}` : ""),
    rarity: item.rarity || parsed.rarity || ((combined.match(/\b(Common|Uncommon|Rare|Epic|Legendary|Unique)\b/i) || [])[1] || ""),
    imageUrl: imageUrl ? absoluteUrl(imageUrl, item.detailUrl) : item.imageUrl,
    hasDisplayName: Boolean((title || item.name) && (title || item.name) !== item.id)
  };
}

async function downloadGearImage(item) {
  if (!item.imageUrl) return { ...item, imageStatus: "missing", imageError: "No image URL found." };
  fs.mkdirSync(GEAR_IMAGE_CACHE_DIR, { recursive: true });
  const hash = crypto.createHash("sha1").update(item.imageUrl).digest("hex").slice(0, 12);
  const stem = safeGearFileName(`${item.id}-${item.name}-${hash}`);
  const existing = fs.readdirSync(GEAR_IMAGE_CACHE_DIR).find((file) => file.startsWith(`${stem}.`));
  if (existing) {
    return { ...item, imageLocalPath: path.join(GEAR_IMAGE_CACHE_DIR, existing), imageStatus: "reused" };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await httpRequestBuffer(item.imageUrl, { timeoutMs: 20000, accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" });
      const ext = gearImageExtension(item.imageUrl, response.contentType);
      const filePath = path.join(GEAR_IMAGE_CACHE_DIR, `${stem}${ext}`);
      fs.writeFileSync(filePath, response.buffer);
      return { ...item, imageLocalPath: filePath, imageStatus: "downloaded" };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  return { ...item, imageStatus: "failed", imageError: lastError ? lastError.message : "Image download failed." };
}

function parseSvelteDevalueJson(text) {
  const UNDEFINED = -1;
  const HOLE = -2;
  const NAN = -3;
  const POSITIVE_INFINITY = -4;
  const NEGATIVE_INFINITY = -5;
  const NEGATIVE_ZERO = -6;
  const SPARSE_ARRAY = -7;
  const values = JSON.parse(String(text || ""));
  const hydrated = new Array(values.length);
  function hydrate(index, strict = false) {
    if (index === UNDEFINED) return undefined;
    if (index === NAN) return NaN;
    if (index === POSITIVE_INFINITY) return Infinity;
    if (index === NEGATIVE_INFINITY) return -Infinity;
    if (index === NEGATIVE_ZERO) return -0;
    if (strict || typeof index !== "number") throw new Error("Invalid devalue reference.");
    if (index in hydrated) return hydrated[index];
    const value = values[index];
    if (!value || typeof value !== "object") {
      hydrated[index] = value;
    } else if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        const type = value[0];
        if (type === "Date") hydrated[index] = new Date(value[1]);
        else if (type === "Set") {
          const set = new Set();
          hydrated[index] = set;
          for (let i = 1; i < value.length; i++) set.add(hydrate(value[i]));
        } else if (type === "Map") {
          const map = new Map();
          hydrated[index] = map;
          for (let i = 1; i < value.length; i += 2) map.set(hydrate(value[i]), hydrate(value[i + 1]));
        } else if (type === "Object") {
          hydrated[index] = Object(value[1]);
        } else {
          hydrated[index] = value;
        }
      } else if (value[0] === SPARSE_ARRAY) {
        const sparse = new Array(value[1]);
        hydrated[index] = sparse;
        for (let i = 2; i < value.length; i += 2) sparse[value[i]] = hydrate(value[i + 1]);
      } else {
        const array = new Array(value.length);
        hydrated[index] = array;
        for (let i = 0; i < value.length; i++) if (value[i] !== HOLE) array[i] = hydrate(value[i]);
      }
    } else {
      const object = {};
      hydrated[index] = object;
      for (const key of Object.keys(value)) {
        if (key !== "__proto__") object[key] = hydrate(value[key]);
      }
    }
    return hydrated[index];
  }
  return hydrate(0);
}

function titleCaseGearCategory(value = "") {
  return String(value || "")
    .replace(/^items\//, "")
    .split("/")
    .pop()
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function gearItemCategory(entity = {}) {
  const categories = Array.isArray(entity.categories) ? entity.categories : [];
  const primary = categories.find((entry) => /^items\/[^/]+$/i.test(entry)) || categories[0] || "";
  return titleCaseGearCategory(primary || entity.mainCategoryId || "");
}

function gearItemSubtype(entity = {}) {
  const categories = Array.isArray(entity.categories) ? entity.categories : [];
  const deepest = categories.slice().sort((a, b) => b.length - a.length)[0] || "";
  const subtype = titleCaseGearCategory(deepest);
  const category = gearItemCategory(entity);
  return subtype && subtype !== category ? subtype : "";
}

function gearItemDetail(entity = {}) {
  const lines = [];
  if (entity.description) lines.push(stripTags(entity.description));
  if (Array.isArray(entity.stats) && entity.stats.length) {
    for (const stat of entity.stats) {
      if (!stat || stat.value == null) continue;
      lines.push(`${String(stat.name || stat.key || "Stat").replace(/:+$/, "")}: ${stat.value}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function gearImageUrlFromIconPath(iconPath = "") {
  const clean = String(iconPath || "").trim();
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  return `${GEAR_CDN_ASSET_URL}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

async function discoverDuneItems() {
  const startedAt = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GEAR_IMAGE_CACHE_DIR, { recursive: true });
  const entityResponse = await httpRequestText(GEAR_DATA_ENTITIES_URL, 45000);
  const entities = parseSvelteDevalueJson(entityResponse);
  const listItems = (Array.isArray(entities) ? entities : []).filter((entity) => entity && entity.mainCategoryId === "items");
  if (!listItems.length) throw new Error("No items were found in the online item entity feed.");
  const normalized = listItems.map((entity) => ({
    id: String(entity.id || ""),
    name: cleanGearDisplayName(entity.name || entity.id || "", entity.id || ""),
    category: gearItemCategory(entity),
    subtype: gearItemSubtype(entity),
    type: gearItemSubtype(entity),
    detail: gearItemDetail(entity),
    tier: entity.tier ? `Tier ${entity.tier}` : "",
    rarity: String(entity.rarity || ""),
    maxStack: String(entity.maxStack || entity.maxStackSize || entity.stackSize || ""),
    detailUrl: `${GEAR_IMPORT_URL}/${encodeURIComponent(String(entity.id || ""))}`,
    imageUrl: gearImageUrlFromIconPath(entity.iconPath),
    imageLocalPath: "",
    hasDisplayName: Boolean(entity.name && entity.name !== entity.id),
    detailStatus: "loaded"
  })).filter((item) => item.id && item.name);
  const withImages = await mapWithConcurrency(normalized, 4, downloadGearImage);
  const discoveredItems = withImages
    .map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.id || ""),
      category: String(item.category || ""),
      subtype: String(item.subtype || item.type || ""),
      type: String(item.type || item.subtype || ""),
      detail: String(item.detail || ""),
      tier: String(item.tier || ""),
      rarity: String(item.rarity || ""),
      maxStack: String(item.maxStack || ""),
      detailUrl: String(item.detailUrl || ""),
      imageUrl: String(item.imageUrl || ""),
      imageLocalPath: String(item.imageLocalPath || ""),
      hasDisplayName: item.hasDisplayName === true,
      imageStatus: String(item.imageStatus || "missing"),
      imageError: String(item.imageError || ""),
      detailStatus: String(item.detailStatus || "")
    }))
    .filter((item) => item.id && item.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const report = {
    cachePath: DUNE_ITEMS_CACHE_PATH,
    imageCacheDir: GEAR_IMAGE_CACHE_DIR,
    filesScanned: [{ label: "entity feed", status: "loaded", itemsFound: listItems.length }],
    totalFilesScanned: 1,
    totalItemsFound: discoveredItems.length,
    itemsWithDisplayNames: discoveredItems.filter((item) => item.hasDisplayName).length,
    unknownOrUnclassifiedItems: discoveredItems.filter((item) => !item.hasDisplayName || !item.category).length,
    totalImagesDownloaded: discoveredItems.filter((item) => item.imageStatus === "downloaded").length,
    totalImagesReused: discoveredItems.filter((item) => item.imageStatus === "reused").length,
    failedImageDownloads: discoveredItems.filter((item) => item.imageStatus === "failed").length,
    missingImages: discoveredItems.filter((item) => item.imageStatus === "missing").length,
    durationMs: Date.now() - startedAt
  };
  const cache = { ok: true, generatedAt: new Date().toISOString(), version: APP_VERSION, items: discoveredItems, report };
  fs.writeFileSync(DUNE_ITEMS_CACHE_PATH, JSON.stringify(cache, null, 2));
  appendAdminAudit("gear_item_import_completed", report);
  return { ...cache, items: discoveredItems.map(sanitizeGearItemForUi) };
}

async function dbQuery(sql, timeout = 45000) {
  const { namespace, dbPod, dbSvc } = await databaseRuntimeTarget();
  const command = [
    `PW=$(sudo kubectl exec -n ${shQuote(namespace)} ${shQuote(dbPod)} -- printenv POSTGRES_PASSWORD)`,
    `sudo kubectl exec -n ${shQuote(namespace)} ${shQuote(dbPod)} -- env PGPASSWORD="$PW" psql -v ON_ERROR_STOP=1 -h ${shQuote(dbSvc)} -p 15432 -U postgres -d dune -At -F $'\\t' -c ${shQuote(sql)}`
  ].join("; ");
  const result = await sshCommand(command, timeout);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || "Database query failed.");
  return result.stdout.trim();
}

function shortOutput(value = "", max = 4000) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}

async function timedDatabaseVerificationCommand(label, command, timeout = 20000, options = {}) {
  const started = Date.now();
  const displayCommand = options.displayCommand || command;
  if (options.onSubstep) options.onSubstep(label, displayCommand);
  databaseBackupAudit("database_verification_query", { label, command: displayCommand, timeoutMs: timeout, status: "opening_ssh_session" });
  databaseBackupAudit("database_verification_query", { label, command: displayCommand, timeoutMs: timeout, status: "waiting_for_command" });
  const result = await sshCommand(command, timeout, { maxBuffer: 1024 * 1024 });
  const elapsedMs = Date.now() - started;
  const payload = {
    label,
    command: displayCommand,
    timeoutMs: timeout,
    elapsedMs,
    exitCode: result.code ?? null,
    ok: Boolean(result.ok),
    stdout: options.redactStdout ? "<redacted>" : shortOutput(result.stdout),
    stderr: shortOutput(result.stderr),
    error: result.error || ""
  };
  if (!result.ok && /timed out/i.test(`${result.error || ""} ${result.stderr || ""}`)) {
    databaseBackupAudit("database_verification_timeout", payload);
    const error = new Error(`Database verification command timed out after ${timeout} ms: ${command}`);
    error.details = payload;
    throw error;
  }
  if (!result.ok) {
    databaseBackupAudit("database_verification_failed", payload);
    const error = new Error(result.stderr || result.stdout || result.error || `Database verification command failed: ${label}`);
    error.details = payload;
    throw error;
  }
  databaseBackupAudit("database_verification_query", { ...payload, status: "completed" });
  return { ...payload, raw: result };
}

async function verifyImportedDatabaseStatus(timeout = 20000, options = {}) {
  const started = Date.now();
  databaseBackupAudit("database_verification_started", { timeoutMs: timeout });
  if (options.onSubstep) options.onSubstep("Locating DB target", "databaseRuntimeTarget()");
  databaseBackupAudit("database_verification_query", { label: "locating database", command: "databaseRuntimeTarget()", timeoutMs: timeout, status: "started" });
  const targetStarted = Date.now();
  let target = null;
  try {
    target = await Promise.race([
      databaseRuntimeTarget(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Database target discovery timed out.")), timeout))
    ]);
  } catch (error) {
    const payload = { label: "locating database", command: "databaseRuntimeTarget()", timeoutMs: timeout, elapsedMs: Date.now() - targetStarted, error: error.message };
    databaseBackupAudit(/timed out/i.test(error.message) ? "database_verification_timeout" : "database_verification_failed", payload);
    error.details = payload;
    throw error;
  }
  databaseBackupAudit("database_verification_query", {
    label: "locating database",
    command: "databaseRuntimeTarget()",
    timeoutMs: timeout,
    status: "completed",
    elapsedMs: Date.now() - targetStarted,
    namespace: target.namespace,
    dbPod: target.dbPod,
    dbSvc: target.dbSvc
  });
  const passwordCommand = `sudo kubectl exec -n ${shQuote(target.namespace)} ${shQuote(target.dbPod)} -- printenv POSTGRES_PASSWORD`;
  await timedDatabaseVerificationCommand("Reading DB password", passwordCommand, timeout, { redactStdout: true, onSubstep: options.onSubstep });
  const sql = "select current_database(), pg_size_pretty(pg_database_size(current_database())), (select count(*) from information_schema.tables where table_schema='dune'), now()::text";
  const queryCommand = [
    `PW=$(sudo kubectl exec -n ${shQuote(target.namespace)} ${shQuote(target.dbPod)} -- printenv POSTGRES_PASSWORD)`,
    `sudo kubectl exec -n ${shQuote(target.namespace)} ${shQuote(target.dbPod)} -- env PGPASSWORD="$PW" psql -v ON_ERROR_STOP=1 -h ${shQuote(target.dbSvc)} -p 15432 -U postgres -d dune -At -F $'\\t' -c ${shQuote(sql)}`
  ].join("; ");
  const query = await timedDatabaseVerificationCommand("Running psql verification", queryCommand, timeout, { onSubstep: options.onSubstep });
  const row = parseDbRows(query.raw.stdout.trim(), ["database", "size", "duneTables", "checkedAt"])[0] || {};
  const result = { ok: true, durationMs: Date.now() - started, target, row, commands: { password: passwordCommand, query: queryCommand }, stdout: shortOutput(query.raw.stdout), stderr: shortOutput(query.raw.stderr) };
  databaseBackupAudit("database_verification_success", result);
  if (options.onSubstep) options.onSubstep("Verification complete", "");
  return result;
}

async function databaseRuntimeTarget() {
  const item = await battlegroupResource();
  const namespace = item.metadata?.namespace;
  const name = item.metadata?.name;
  if (!namespace || !name) throw new Error("Dune battlegroup database target was not detected.");
  return {
    namespace,
    name,
    dbPod: `${name}-db-dbdepl-sts-0`,
    dbSvc: `${name}-db-dbdepl-svc`
  };
}

function databaseBackupAudit(action, payload) {
  appendAdminAudit(action, payload);
}

const databaseRestoreJobs = new Map();
const RESTORE_TIMELINE_STEPS = [
  "Preparing import",
  "Checking Battlegroup offline",
  "Preparing backup source",
  "Uploading backup if needed",
  "Backup source ready",
  "Creating safety backup",
  "Safety backup complete",
  "Safety backup verified",
  "Importing Battlegroup backup",
  "Verifying imported database",
  "Completed"
];

function readableDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} hr ${minutes} min ${seconds} sec`;
  if (minutes) return `${minutes} min ${seconds} sec`;
  return `${seconds} sec`;
}

function publicRestoreJob(job) {
  if (!job) return null;
  const durationMs = job.durationMs || (job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0);
  return {
    ok: job.status !== "failed",
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    startedAt: job.startedAt,
    completedAt: job.completedAt || "",
    durationMs,
    elapsed: readableDuration(durationMs),
    error: job.error || "",
    verificationSubstep: job.verificationSubstep || "",
    verificationDetail: job.verificationDetail || "",
    history: job.history || [],
    timeline: job.timeline || RESTORE_TIMELINE_STEPS,
    result: job.result || null,
    logPath: ADMIN_AUDIT_LOG
  };
}

function restoreJobStep(job, step, extra = {}) {
  job.step = step;
  if (Object.prototype.hasOwnProperty.call(extra, "verificationSubstep")) job.verificationSubstep = extra.verificationSubstep || "";
  if (Object.prototype.hasOwnProperty.call(extra, "verificationDetail")) job.verificationDetail = extra.verificationDetail || "";
  job.updatedAt = new Date().toISOString();
  job.history.push({ at: job.updatedAt, step, ...extra });
  databaseBackupAudit("database_import_step_changed", { jobId: job.jobId, step, ...extra });
}

function finishRestoreJob(job, status, result = {}) {
  job.status = status;
  job.completedAt = new Date().toISOString();
  job.durationMs = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
  job.result = result;
  if (status === "failed") job.error = result.error || "Restore failed or could not be verified.";
}

function startDatabaseRestoreJob(payload = {}) {
  const jobId = `import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const job = {
    jobId,
    status: "pending",
    step: "Pending",
    startedAt: new Date().toISOString(),
    completedAt: "",
    durationMs: 0,
    error: "",
    result: null,
    payload: { filePath: String(payload.filePath || ""), confirmText: String(payload.confirmText || "") },
    history: [],
    timeline: RESTORE_TIMELINE_STEPS
  };
  databaseRestoreJobs.set(jobId, job);
  databaseBackupAudit("database_import_started", { jobId, filePath: job.payload.filePath });
  restoreJobStep(job, "Pending");
  runDatabaseRestoreJob(job).catch((error) => {
    finishRestoreJob(job, "failed", { ok: false, status: "failed", error: error.message, logPath: ADMIN_AUDIT_LOG });
    databaseBackupAudit("database_import_failed", { jobId, error: error.message });
  });
  return publicRestoreJob(job);
}

function activeDatabaseImportJob() {
  return [...databaseRestoreJobs.values()].find((job) => job.status === "pending" || job.status === "running") || null;
}

function databaseBackupDir(configValue = loadConfig()) {
  return expandEnvPath(configValue.databaseBackupLocation || DEFAULT_DATABASE_BACKUP_DIR);
}

function ensureDatabaseBackupDir(folder = databaseBackupDir()) {
  const resolved = path.resolve(expandEnvPath(folder || DEFAULT_DATABASE_BACKUP_DIR));
  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("Database backup location is not a folder.");
  return resolved;
}

function databaseBackupFilename(prefix = "battlegroup-backup") {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:T]/g, "-").replace(/Z$/, "");
  return `${prefix}-${stamp}-${APP_VERSION}.zip`;
}

function fileInfo(filePath) {
  const stat = fs.statSync(filePath);
  return {
    filename: path.basename(filePath),
    path: filePath,
    size: stat.size,
    sizeLabel: formatBytes(stat.size),
    date: stat.mtime.toISOString()
  };
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

async function databaseStatus() {
  const started = Date.now();
  try {
    const output = await dbQuery("select current_database(), pg_size_pretty(pg_database_size(current_database())), (select count(*) from pg_stat_activity), (select count(*) from pg_stat_activity where state = 'active'), date_trunc('second', now() - pg_postmaster_start_time())::text", 12000);
    const row = parseDbRows(output, ["database", "size", "connections", "activeQueries", "uptime"])[0] || {};
    return { ok: true, status: "online", durationMs: Date.now() - started, ...row };
  } catch (error) {
    return { ok: false, status: "unavailable", durationMs: Date.now() - started, error: error.message };
  }
}

function parseBattlegroupBackupOutput(output = "") {
  const text = String(output || "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const backupIdMatch = text.match(/\b(?:backup(?:\s+name|\s+id)?|id|name)\s*[:=]\s*([A-Za-z0-9_.:-]+)/i);
  const dumpOperationMatch = text.match(/\b(sh-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-dump-\d{8,}-\d{6,})\b/i);
  const pathMatch = text.match(/((?:\/[^\s"'<>]+)+)/);
  const fileMatch = text.match(/\b([A-Za-z0-9_.-]*backup[A-Za-z0-9_.-]*(?:\.zip|\.tar|\.backup|\.bgbackup)?)\b/i);
  return {
    backupId: backupIdMatch ? backupIdMatch[1] : (fileMatch ? fileMatch[1] : ""),
    backupName: fileMatch ? fileMatch[1] : (backupIdMatch ? backupIdMatch[1] : ""),
    dumpOperationName: dumpOperationMatch ? dumpOperationMatch[1] : "",
    phase: /phase\s*[=:]\s*Succeeded/i.test(text) ? "Succeeded" : (/phase\s*[=:]\s*Failed/i.test(text) ? "Failed" : (/phase\s*[=:]\s*Ongoing/i.test(text) || /Still waiting/i.test(text) ? "Ongoing" : "")),
    vmPath: pathMatch ? pathMatch[1] : "",
    output: text,
    lines
  };
}

async function runningDumpOperations() {
  const result = await sshCommand("sudo kubectl get dumps -A --no-headers 2>/dev/null || true", 15000, { maxBuffer: 1024 * 128 });
  const rows = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const running = rows.filter((line) => /\b(Ongoing|Running|Pending)\b/i.test(line)).map((line) => {
    const parts = line.split(/\s+/);
    return { namespace: parts[0] || "", name: parts[1] || parts[0] || "", phase: parts.find((part) => /^(Ongoing|Running|Pending)$/i.test(part)) || "Ongoing", raw: line };
  });
  return { ok: result.ok, running, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error || "" };
}

async function collectDumpDiagnostics(operationName = "") {
  const name = String(operationName || "").trim();
  const commands = [
    { label: "dump operations", command: "sudo kubectl get dumps -A -o wide 2>&1 || true" },
    { label: "dump details", command: name ? `sudo kubectl describe dumps -A ${shQuote(name)} 2>&1 || true` : "echo dump operation name unavailable" },
    { label: "recent backup pods", command: "sudo kubectl get pods -A 2>&1 | grep -Ei 'dump|backup|postgres|db' | tail -n 80 || true" },
    { label: "recent operator logs", command: "sudo kubectl logs -A --tail=120 -l control-plane=controller-manager 2>&1 || true" }
  ];
  const results = [];
  for (const item of commands) {
    const started = Date.now();
    const result = await sshCommand(item.command, 20000, { maxBuffer: 1024 * 512 });
    results.push({ ...item, ok: result.ok, elapsedMs: Date.now() - started, stdout: shortOutput(result.stdout), stderr: shortOutput(result.stderr), error: result.error || "" });
  }
  databaseBackupAudit("database_safety_backup_diagnostics", { operationName: name, results });
  return results;
}

function vmBackupParts(vmPath = "", metadata = {}) {
  const rawPath = String(metadata.vmBackupPath || metadata.vmPath || vmPath || "").trim();
  const filename = String(metadata.vmBackupFilename || (rawPath ? path.posix.basename(rawPath) : "")).trim();
  const dir = String(metadata.vmBackupDir || (rawPath ? path.posix.dirname(rawPath) : "")).trim();
  const battlegroupId = String(metadata.battlegroupId || (dir ? path.posix.basename(dir) : "")).trim();
  const fullPath = String(metadata.vmBackupPath || (dir && filename ? path.posix.join(dir, filename) : rawPath)).trim();
  const yamlPath = String(metadata.vmYamlPath || (fullPath ? `${fullPath}.yaml` : "")).trim();
  return { battlegroupId, vmBackupDir: dir, vmBackupFilename: filename, vmBackupPath: fullPath, vmYamlPath: yamlPath };
}

function databaseBackupMetadataFilename(prefix = "battlegroup-backup") {
  return databaseBackupFilename(prefix).replace(/\.zip$/i, ".json");
}

function writeBattlegroupBackupMetadata(payload, prefix = "battlegroup-backup") {
  const folder = ensureDatabaseBackupDir();
  const metadataPath = path.join(folder, databaseBackupMetadataFilename(prefix));
  fs.writeFileSync(metadataPath, JSON.stringify(payload, null, 2), "utf8");
  return fileInfo(metadataPath);
}

async function createDatabaseBackup(options = {}) {
  const started = Date.now();
  const timeout = Number(options.timeout || (options.safety ? 120000 : 240000));
  const isSafety = Boolean(options.safety);
  try {
    if (options.onStatus) options.onStatus("Starting", "Starting Battlegroup backup.");
    if (isSafety) {
      const running = await runningDumpOperations().catch((error) => ({ ok: false, running: [], error: error.message }));
      if (running.running?.length) {
        const message = "A backup operation is already running. Wait for it to finish or cancel it from the Battlegroup tools.";
        databaseBackupAudit("database_safety_backup_blocked", { reason: "existing_dump_running", running: running.running, message });
        throw new Error(message);
      }
    }
    if (options.onStatus) options.onStatus("Ongoing", `Safety backup still running... 0s / ${Math.round(timeout / 1000)}s`);
    const result = await sshCommand(`/home/dune/.dune/bin/battlegroup backup`, timeout, { maxBuffer: 1024 * 1024 * 32 });
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    const parsed = parseBattlegroupBackupOutput(combinedOutput);
    if (parsed.dumpOperationName) databaseBackupAudit("database_safety_backup_dump_operation", { operationName: parsed.dumpOperationName, phase: parsed.phase || "Unknown" });
    if (!result.ok) {
      const timedOut = /timed out/i.test(`${result.error || ""} ${result.stderr || ""}`);
      if (isSafety && timedOut) {
        if (options.onStatus) options.onStatus("Timed out", `Safety backup still running... ${Math.round(timeout / 1000)}s / ${Math.round(timeout / 1000)}s`);
        const diagnostics = await collectDumpDiagnostics(parsed.dumpOperationName).catch((error) => [{ label: "diagnostics", ok: false, error: error.message }]);
        const message = "Pre-import safety backup did not finish within 120 seconds. Import was cancelled. Try again, or create a manual backup first.";
        databaseBackupAudit("database_safety_backup_timeout", { operationName: parsed.dumpOperationName, phase: parsed.phase || "Ongoing", timeoutMs: timeout, stdout: shortOutput(result.stdout), stderr: shortOutput(result.stderr), diagnostics });
        const error = new Error(message);
        error.details = { operationName: parsed.dumpOperationName, diagnostics, stdout: shortOutput(result.stdout), stderr: shortOutput(result.stderr) };
        throw error;
      }
      throw new Error(result.stderr || result.stdout || result.error || "Battlegroup backup command failed.");
    }
    if (options.onStatus) options.onStatus("Succeeded", "Safety backup completed successfully.");
    const vmBackup = vmBackupParts(parsed.vmPath);
    const metadata = {
      ok: true,
      type: "battlegroup-backup",
      createdAt: new Date().toISOString(),
      version: APP_VERSION,
      backupId: parsed.backupId,
      backupName: parsed.backupName,
      dumpOperationName: parsed.dumpOperationName,
      phase: parsed.phase || "Succeeded",
      vmPath: parsed.vmPath,
      battlegroupId: vmBackup.battlegroupId,
      vmBackupDir: vmBackup.vmBackupDir,
      vmBackupFilename: vmBackup.vmBackupFilename,
      vmBackupPath: vmBackup.vmBackupPath,
      vmYamlPath: vmBackup.vmYamlPath,
      storage: parsed.vmPath ? "vm+local-metadata" : "vm-output+local-metadata",
      output: result.stdout,
      stderr: result.stderr,
      note: "Backup was created using /home/dune/.dune/bin/battlegroup backup. Local file is metadata unless the Battlegroup command output exposes a downloadable file path."
    };
    const info = writeBattlegroupBackupMetadata(metadata, options.prefix || (options.safety ? "pre-import-safety" : "battlegroup-backup"));
    const payload = {
      ok: true,
      status: "created",
      method: "battlegroup",
      durationMs: Date.now() - started,
      elapsed: readableDuration(Date.now() - started),
      backupId: parsed.backupId,
      backupName: parsed.backupName,
      dumpOperationName: parsed.dumpOperationName,
      phase: parsed.phase || "Succeeded",
      vmPath: parsed.vmPath,
      battlegroupId: vmBackup.battlegroupId,
      vmBackupDir: vmBackup.vmBackupDir,
      vmBackupFilename: vmBackup.vmBackupFilename,
      vmBackupPath: vmBackup.vmBackupPath,
      vmYamlPath: vmBackup.vmYamlPath,
      storage: metadata.storage,
      output: result.stdout,
      stderr: result.stderr,
      file: info,
      filePath: info.path,
      localMetadataPath: info.path
    };
    databaseBackupAudit(options.safety ? "battlegroup_safety_backup_created" : "battlegroup_backup_created", payload);
    return payload;
  } catch (error) {
    if (options.onStatus) options.onStatus(/120 seconds|timed out/i.test(error.message) ? "Timed out" : "Failed", error.message);
    const payload = { ok: false, status: "failed", method: "battlegroup", durationMs: Date.now() - started, elapsed: readableDuration(Date.now() - started), error: error.message, details: error.details || null };
    databaseBackupAudit(options.safety ? "battlegroup_safety_backup_failed" : "battlegroup_backup_failed", payload);
    return payload;
  }
}

function listDatabaseBackups() {
  const folder = ensureDatabaseBackupDir();
  const allowed = new Set([".zip", ".tar", ".backup", ".bgbackup", ".json"]);
  const backups = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const info = fileInfo(path.join(folder, entry.name));
      if (path.extname(entry.name).toLowerCase() === ".json") {
        try {
          const metadata = JSON.parse(fs.readFileSync(info.path, "utf8"));
          if (metadata.type === "battlegroup-backup") {
            const vmBackup = vmBackupParts(metadata.vmBackupPath || metadata.vmPath || "", metadata);
            info.type = "battlegroup-backup";
            info.backupId = metadata.backupId || "";
            info.backupName = metadata.backupName || "";
            info.vmPath = vmBackup.vmBackupPath || metadata.vmPath || "";
            info.battlegroupId = vmBackup.battlegroupId;
            info.vmBackupDir = vmBackup.vmBackupDir;
            info.vmBackupFilename = vmBackup.vmBackupFilename;
            info.vmBackupPath = vmBackup.vmBackupPath;
            info.vmYamlPath = vmBackup.vmYamlPath;
            info.storage = metadata.storage || "local-metadata";
            info.availability = "Metadata only";
          }
        } catch {}
      }
      return info;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return { ok: true, folder, backups };
}

function validateRestoreFile(filePath) {
  const resolved = path.resolve(expandEnvPath(filePath || ""));
  const ext = path.extname(resolved).toLowerCase();
  const allowed = new Set([".zip", ".tar", ".backup", ".bgbackup", ".json"]);
  if (!resolved) throw new Error("Backup file path is required.");
  if (!allowed.has(ext)) throw new Error("Unsupported Battlegroup backup file type. Choose .zip, .tar, .backup, .bgbackup, or Suite Battlegroup metadata .json.");
  if (!fs.existsSync(resolved)) throw new Error("Backup file was not found.");
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("Selected backup path is not a file.");
  return { path: resolved, ext, size: stat.size };
}

async function resolveBattlegroupImportSource(filePath) {
  const source = validateRestoreFile(filePath);
  if (source.ext === ".json") {
    let metadata = null;
    try { metadata = JSON.parse(fs.readFileSync(source.path, "utf8")); }
    catch { throw new Error("Selected metadata file is not valid JSON."); }
    if (metadata.type !== "battlegroup-backup") throw new Error("Selected JSON is not an AlphaNine Battlegroup backup metadata file.");
    const vmBackup = vmBackupParts(metadata.vmBackupPath || metadata.vmPath || "", metadata);
    if (!vmBackup.vmBackupPath) throw new Error("Selected Battlegroup metadata does not include a VM backup path. Choose the actual Battlegroup backup file or create a new backup.");
    return { ...source, sourceType: "vm", remotePath: vmBackup.vmBackupPath, ...vmBackup, metadata };
  }
  return { ...source, sourceType: "local", metadata: null };
}

function closestVmBackup(filename = "", listing = "") {
  const files = String(listing || "").match(/[A-Za-z0-9_.-]+\.backup/g) || [];
  if (!files.length) return "";
  const stamp = String(filename || "").match(/\d{8}-\d{6}/)?.[0] || "";
  if (stamp) {
    const sameStamp = files.find((file) => file.includes(stamp));
    if (sameStamp) return sameStamp;
  }
  const prefix = String(filename || "").replace(/-\d{8}-\d{6}\.backup$/i, "");
  return files.find((file) => prefix && file.startsWith(prefix)) || files[0] || "";
}

async function listVmBackupDirectory(vmBackupDir) {
  const dir = String(vmBackupDir || "").trim();
  if (!dir) return { ok: false, listing: "", error: "VM backup directory is missing." };
  const result = await sshCommand(`if [ -d ${shQuote(dir)} ]; then ls -lah ${shQuote(dir)}; else echo "__DIR_MISSING__"; fi`, 20000, { maxBuffer: 1024 * 256 });
  return { ok: result.ok, listing: result.stdout || "", error: result.stderr || result.error || "", dir };
}

async function checkVmBackupAvailable(source = {}) {
  const vmBackup = vmBackupParts(source.remotePath || source.vmBackupPath || "", source);
  if (!vmBackup.vmBackupPath) return { known: true, available: false, backupExists: false, yamlExists: false, message: "Metadata is missing the real VM backup path.", ...vmBackup };
  try {
    const dir = await listVmBackupDirectory(vmBackup.vmBackupDir);
    if (!dir.ok) return { known: false, available: false, backupExists: false, yamlExists: false, message: dir.error || "Could not list VM backup directory.", directoryListing: dir.listing, ...vmBackup };
    const result = await sshCommand([
      `test -f ${shQuote(vmBackup.vmBackupPath)} && echo "__BACKUP_OK__" || echo "__BACKUP_MISSING__"`,
      `test -f ${shQuote(vmBackup.vmYamlPath)} && echo "__YAML_OK__" || echo "__YAML_MISSING__"`
    ].join("; "), 15000, { maxBuffer: 1024 * 64 });
    if (!result.ok) return { known: false, available: false, backupExists: false, yamlExists: false, message: result.stderr || result.stdout || result.error || "Could not verify VM backup file.", directoryListing: dir.listing, ...vmBackup };
    const output = result.stdout || "";
    const backupExists = output.includes("__BACKUP_OK__");
    const yamlExists = output.includes("__YAML_OK__");
    const available = backupExists && yamlExists;
    const closest = available ? "" : closestVmBackup(vmBackup.vmBackupFilename, dir.listing);
    const missing = !backupExists ? "real VM backup file" : "sidecar YAML file";
    return {
      known: true,
      available,
      backupExists,
      yamlExists,
      closest,
      directoryListing: dir.listing,
      message: available ? "Available on VM." : `Backup metadata exists locally, but the ${missing} was not found.${closest ? ` Closest available backup: ${closest}.` : ""}`,
      ...vmBackup
    };
  } catch (error) {
    return { known: false, available: false, backupExists: false, yamlExists: false, message: error.message, ...vmBackupParts(source.remotePath || source.vmBackupPath || "", source) };
  }
}

async function copyBattlegroupImportFileToVm(localPath) {
  const started = Date.now();
  const info = await vmInfo();
  const ip = info.ip || VM_IP;
  if (!info.exists && !ip) throw new Error(info.error || "VM not found.");
  if (info.exists && info.state !== "Running") throw new Error("VM is not running.");
  if (!ip) throw new Error("VM IP address was not found.");
  const key = sshKeyStatus(SSH_KEY);
  if (!key.exists) throw new Error(key.message);
  const remotePath = `/tmp/alphanine-import-${Date.now()}-${path.basename(localPath).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  const size = fs.statSync(localPath).size;
  databaseBackupAudit("battlegroup_import_transfer_started", {
    ok: true,
    method: "ssh-stream",
    reason: "Streaming Battlegroup backup over SSH stdin; no SFTP subsystem required.",
    source: localPath,
    remotePath,
    size
  });
  const result = await runWithStdin("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "LogLevel=QUIET",
    "-i", key.path,
    `${SSH_USER}@${ip}`,
    `umask 077; cat > ${shQuote(remotePath)}`
  ], localPath, { timeout: 600000, maxBuffer: 1024 * 1024 * 32 });
  if (!result.ok) {
    const detail = result.stderr || result.error || "Could not stream Battlegroup backup file to VM.";
    const sftpHint = /sftp-server|subsystem request failed|scp: connection closed/i.test(detail)
      ? "SFTP is not available on this Dune Self-Hosting VM. Import uses SSH streaming; verify SSH shell access and file write permission to /tmp."
      : detail;
    databaseBackupAudit("battlegroup_import_transfer_failed", { ok: false, method: "ssh-stream", durationMs: Date.now() - started, remotePath, error: sftpHint, details: detail.slice(0, 2000) });
    throw new Error(sftpHint);
  }
  databaseBackupAudit("battlegroup_import_transfer_completed", { ok: true, method: "ssh-stream", durationMs: Date.now() - started, remotePath, size, stdout: result.stdout.slice(-1000), stderr: result.stderr.slice(-1000) });
  return remotePath;
}

async function verifyBattlegroupImport(context = {}) {
  const started = Date.now();
  const onSubstep = typeof context.onSubstep === "function" ? context.onSubstep : null;
  const checks = {
    importCommandCompleted: true,
    gameServerOnlineRequired: false,
    battlegroupHealthRequired: false,
    databaseReachable: false,
    databaseSizeReadable: false
  };
  databaseBackupAudit("battlegroup_import_verification_condition", {
    condition: "database_status_query",
    status: "pending",
    note: "Final import verification checks database reachability. It does not wait for game server/Battlegroup health.",
    remotePath: context.remotePath || "",
    importArg: context.importArg || ""
  });
  let verification = null;
  try {
    verification = await verifyImportedDatabaseStatus(20000, { onSubstep });
  } catch (error) {
    databaseBackupAudit("battlegroup_import_verification_condition", {
      condition: "database_status_query",
      status: "failed",
      error: error.message,
      details: error.details || null,
      checks
    });
    throw error;
  }
  const database = { ok: true, status: "online", durationMs: verification.durationMs, ...verification.row };
  checks.databaseReachable = true;
  checks.databaseSizeReadable = Boolean(database.size);
  databaseBackupAudit("battlegroup_import_verification_condition", {
    condition: "database_status_query",
    status: "success",
    database,
    commands: verification.commands,
    checks
  });
  return {
    ok: true,
    status: "verified",
    message: "Import completed successfully. You may now start the server.",
    durationMs: Date.now() - started,
    checks,
    database,
    commands: verification.commands,
    stdout: verification.stdout,
    stderr: verification.stderr
  };
}

async function verifyBattlegroupImportWithTotalTimeout(context = {}, timeout = 30000) {
  let timer = null;
  try {
    return await Promise.race([
      verifyBattlegroupImport(context),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Import finished, but database verification timed out after 30 seconds. You may need to refresh Database Status or start the server manually after checking logs.");
          error.code = "DATABASE_VERIFICATION_TOTAL_TIMEOUT";
          error.details = {
            timeoutMs: timeout,
            verificationSubstep: context.currentSubstep ? context.currentSubstep() : "",
            command: context.currentCommand ? context.currentCommand() : ""
          };
          databaseBackupAudit("database_verification_total_timeout", error.details);
          reject(error);
        }, timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureBattlegroupOfflineForImport() {
  const result = await battlegroup("status");
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || "Could not verify Battlegroup status before import.");
  const parsed = parseStatus(result.stdout || "");
  if (statusSummaryIsOnline(parsed.summary)) {
    throw new Error("Stop the server before importing a Battlegroup backup.");
  }
  return { ok: true, summary: parsed.summary, raw: result.stdout };
}

async function databaseImportReadiness(payload = {}) {
  const filePath = String(payload.filePath || "").trim();
  const activeJob = activeDatabaseImportJob();
  const conditions = {
    backupSelected: Boolean(filePath),
    backupValid: false,
    backupResolved: false,
    backupAvailable: false,
    serverOffline: false,
    noImportRunning: !activeJob,
    statusKnown: false
  };
  const response = {
    ok: false,
    canTypeConfirmation: false,
    canImport: false,
    reasonCode: "",
    message: "",
    conditions,
    activeJobId: activeJob?.jobId || "",
    backup: null,
    importSource: null,
    server: null
  };
  const finish = (reasonCode, message) => {
    response.reasonCode = reasonCode;
    response.message = message;
    response.canTypeConfirmation = Boolean(conditions.backupSelected && conditions.backupValid && conditions.backupResolved && conditions.backupAvailable && conditions.serverOffline && conditions.noImportRunning && conditions.statusKnown);
    response.canImport = response.canTypeConfirmation;
    response.ok = response.canImport;
    if (!response.canImport) databaseBackupAudit("database_import_readiness", { import_disabled_reason: reasonCode, message, conditions, activeJobId: response.activeJobId });
    else databaseBackupAudit("database_import_readiness", { import_enabled: true, conditions });
    return response;
  };
  if (!conditions.backupSelected) return finish("no_backup_selected", "No backup selected.");
  try {
    const source = await resolveBattlegroupImportSource(filePath);
    response.backup = { path: source.path, ext: source.ext, size: source.size };
    response.importSource = {
      sourceType: source.sourceType,
      metadataPath: source.sourceType === "vm" ? source.path : "",
      remotePath: source.remotePath || "",
      vmBackupDir: source.vmBackupDir || "",
      vmBackupFilename: source.vmBackupFilename || "",
      vmBackupPath: source.vmBackupPath || source.remotePath || "",
      vmYamlPath: source.vmYamlPath || "",
      localPath: source.sourceType === "local" ? source.path : "",
      backupName: source.metadata?.backupName || source.metadata?.backupId || path.basename(source.remotePath || source.path || ""),
      storage: source.metadata?.storage || (source.sourceType === "vm" ? "vm+local-metadata" : "local-file"),
      availability: { known: true, available: true, message: "Local backup file is available." }
    };
    conditions.backupValid = true;
    conditions.backupResolved = true;
    conditions.backupAvailable = source.sourceType === "local";
    if (source.sourceType === "vm") {
      if (!source.remotePath) {
        conditions.backupResolved = false;
        conditions.backupAvailable = false;
        return finish("metadata_missing_real_backup_path", "Metadata is missing the real VM backup path.");
      }
      response.importSource.availability = { known: false, available: false, message: "Real VM backup file availability will be checked after the server is confirmed offline." };
    }
  } catch (error) {
    const message = error.message || "Invalid backup selected.";
    const reason = /metadata.*vm backup path|metadata.*real/i.test(message) ? "metadata_missing_real_backup_path" : "invalid_backup_selected";
    return finish(reason, message);
  }
  if (!conditions.noImportRunning) return finish("import_running", "Another import is currently running.");
  try {
    const status = await battlegroup("status");
    if (!status.ok) {
      response.server = { ok: false, error: status.stderr || status.stdout || status.error || "Unable to determine server status." };
      return finish("server_status_unknown", "Unable to determine server status.");
    }
    const parsed = parseStatus(status.stdout || "");
    response.server = { ok: true, summary: parsed.summary, raw: status.stdout };
    conditions.statusKnown = true;
    conditions.serverOffline = !statusSummaryIsOnline(parsed.summary);
    if (!conditions.serverOffline) return finish("server_online", "Server is still running.");
    if (response.importSource?.sourceType === "vm") {
      const availability = await checkVmBackupAvailable(response.importSource);
      response.importSource.availability = availability;
      conditions.backupAvailable = Boolean(availability.available);
      if (!availability.available) return finish(availability.known ? "real_backup_unavailable" : "server_status_unknown", availability.message || "Could not verify the real VM backup file.");
    }
    return finish("ready", "Ready to type IMPORT and start import.");
  } catch (error) {
    response.server = { ok: false, error: error.message };
    return finish("server_status_unknown", "Unable to determine server status.");
  }
}

async function battlegroupImport(importTarget) {
  const target = typeof importTarget === "string" ? { importArg: importTarget, remotePath: importTarget } : (importTarget || {});
  const importArg = target.importArg || target.vmBackupFilename || target.remotePath || "";
  const importFilename = String(importArg || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const readiness = serverControlConfigured();
  if (!readiness.configured) return { ok: false, skipped: true, stdout: "", stderr: readiness.reason, error: readiness.reason };
  appendAdminAudit("server_import_requested", { importArg: importFilename, originalImportArg: importArg, remotePath: target.remotePath || "", vmBackupDir: target.vmBackupDir || "", vmBackupFilename: target.vmBackupFilename || "", config: readiness.summary });
  appendAdminAudit("battlegroup_import_confirmation_sent", { importArg: importFilename, confirmation: "yes" });
  const command = `printf 'yes\\n' | /home/dune/.dune/bin/battlegroup import ${shQuote(importFilename)}`;
  const result = await sshCommand(command, 900000, { maxBuffer: 1024 * 1024 * 32 });
  const output = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error || ""}`;
  if (!result.ok && /Type 'yes' to continue:/i.test(output) && /timed out|timeout/i.test(output)) {
    return { ...result, stderr: "Battlegroup import is waiting for confirmation input.", error: "Battlegroup import is waiting for confirmation input." };
  }
  return result;
}

async function runDatabaseRestoreJob(job) {
  const started = Date.now();
  const filePath = String(job.payload.filePath || "").trim();
  const confirmText = String(job.payload.confirmText || "").trim();
  job.status = "running";
  if (confirmText !== "IMPORT") throw new Error("Import requires typing IMPORT.");
  let importSource = null;
  let remotePath = "";
  let importArg = "";
  let uploaded = false;
  try {
    restoreJobStep(job, "Preparing import");
    importSource = await resolveBattlegroupImportSource(filePath);
    restoreJobStep(job, "Checking Battlegroup offline");
    const offline = await ensureBattlegroupOfflineForImport();
    restoreJobStep(job, "Preparing backup source", { filePath, size: importSource.size, sourceType: importSource.sourceType, battlegroupStatus: offline.summary });
    if (importSource.sourceType === "vm") {
      remotePath = importSource.remotePath;
      const availability = await checkVmBackupAvailable(importSource);
      databaseBackupAudit("battlegroup_import_directory_checked", {
        jobId: job.jobId,
        vmBackupDir: importSource.vmBackupDir,
        vmBackupFilename: importSource.vmBackupFilename,
        vmBackupPath: importSource.vmBackupPath || importSource.remotePath,
        vmYamlPath: importSource.vmYamlPath,
        backupExists: availability.backupExists,
        yamlExists: availability.yamlExists,
        closest: availability.closest || "",
        listing: availability.directoryListing || ""
      });
      if (!availability.available) throw new Error(availability.message || "Backup metadata exists locally, but the real VM backup file was not found.");
      importArg = importSource.vmBackupFilename || path.posix.basename(remotePath);
      restoreJobStep(job, "Uploading backup if needed", { skipped: true, reason: "Using Battlegroup backup already stored on VM.", remotePath });
    } else {
      restoreJobStep(job, "Uploading backup if needed", { filePath, size: importSource.size });
      remotePath = await copyBattlegroupImportFileToVm(importSource.path);
      importArg = remotePath;
      uploaded = true;
    }
    restoreJobStep(job, "Backup source ready", { remotePath, importArg, sourceType: importSource.sourceType });
    restoreJobStep(job, "Creating safety backup");
    const safety = await createDatabaseBackup({
      prefix: "pre-import-safety",
      safety: true,
      timeout: 120000,
      onStatus: (status, detail) => restoreJobStep(job, "Creating safety backup", {
        safetyBackupStatus: status,
        verificationSubstep: `Safety backup: ${status}`,
        verificationDetail: detail || ""
      })
    });
    if (!safety.ok) throw new Error(safety.error || "Pre-import safety backup failed.");
    restoreJobStep(job, "Safety backup complete", { safetyBackup: safety.file, safetyBackupStatus: "Succeeded", verificationSubstep: "", verificationDetail: "" });
    if (!safety.file?.path || !fs.existsSync(safety.file.path)) throw new Error("Pre-import safety backup metadata could not be verified on disk.");
    restoreJobStep(job, "Safety backup verified", { safetyBackup: safety.file.path });
    restoreJobStep(job, "Importing Battlegroup backup");
    const result = await battlegroupImport({ remotePath, importArg, sourceType: importSource.sourceType, vmBackupDir: importSource.vmBackupDir, vmBackupFilename: importSource.vmBackupFilename });
    if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || "Battlegroup import failed.");
    restoreJobStep(job, "Verifying imported database", {
      pendingCondition: "database_status_query",
      gameServerOnlineRequired: false,
      battlegroupHealthRequired: false
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let verificationSubstep = "";
    let verificationCommand = "";
    const verification = await verifyBattlegroupImportWithTotalTimeout({
      remotePath,
      importArg,
      sourceType: importSource.sourceType,
      onSubstep: (label, command) => {
        verificationSubstep = label || "";
        verificationCommand = command || "";
        restoreJobStep(job, "Verifying imported database", {
          verificationSubstep,
          verificationDetail: verificationCommand,
          pendingCondition: label || "database_status_query"
        });
      },
      currentSubstep: () => verificationSubstep,
      currentCommand: () => verificationCommand
    }, 30000);
    databaseBackupAudit("battlegroup_import_verified", { jobId: job.jobId, verification });
    const response = { ok: true, status: "success", message: "Import completed successfully. You may now start the server.", durationMs: Date.now() - started, elapsed: readableDuration(Date.now() - started), importedFrom: filePath, remotePath, importArg, sourceType: importSource.sourceType, safetyBackup: safety.file, verification, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000), logPath: ADMIN_AUDIT_LOG };
    finishRestoreJob(job, "success", response);
    restoreJobStep(job, "Completed", { verified: true });
    databaseBackupAudit("battlegroup_import_completed", { jobId: job.jobId, ...response });
    return response;
  } catch (error) {
    if (uploaded && remotePath) await sshCommand(`rm -f ${shQuote(remotePath)}`, 30000).catch(() => {});
    const verificationFailed = job.history.some((row) => row.step === "Verifying imported database");
    const response = { ok: false, status: verificationFailed ? "verification_failed" : "failed", message: verificationFailed ? "Battlegroup import completed but database verification failed." : "Battlegroup import failed or could not be verified.", durationMs: Date.now() - started, elapsed: readableDuration(Date.now() - started), importedFrom: filePath, remotePath, importArg, error: error.message, logPath: ADMIN_AUDIT_LOG };
    finishRestoreJob(job, "failed", response);
    restoreJobStep(job, verificationFailed ? "Verification Failed" : "Failed", { error: error.message });
    databaseBackupAudit("battlegroup_import_failed", { jobId: job.jobId, ...response });
    return response;
  }
}

function parseDbRows(output, columns) {
  return String(output || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const row = {};
    columns.forEach((column, index) => { row[column] = parts[index] || ""; });
    return row;
  });
}

function inspectStatus(condition, unavailable = false) {
  if (unavailable) return "unknown";
  return condition ? "detected" : "missing";
}

function progressionTableStatus(tableSet, tableName, unavailable = false) {
  return {
    schema: "dune",
    table: tableName,
    status: inspectStatus(tableSet.has(`dune.${tableName}`), unavailable)
  };
}

function progressionFunctionStatus(functionSet, functionName, unavailable = false) {
  return {
    schema: "dune",
    function: functionName,
    status: inspectStatus(functionSet.has(`dune.${functionName}`), unavailable)
  };
}

function hasColumn(columnSet, schema, table, column) {
  return columnSet.has(`${schema}.${table}.${column}`);
}

function progressionSupportStatus(requirements, unavailable = false) {
  if (unavailable) return "unknown";
  return requirements.every(Boolean) ? "detected" : "unsupported";
}

async function progressionFactionComponentScan() {
  const sql = `
    with recursive
    actor_source as (
      select id as actor_id, properties
      from dune.actors
      where properties is not null
      limit 250
    ),
    walk(actor_id, path, value) as (
      select actor_id, array[]::text[], properties
      from actor_source
      union all
      select w.actor_id, w.path || child.key, child.value
      from walk w
      cross join lateral (
        select e.key, e.value
        from jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) e
        union all
        select (a.ordinality - 1)::text as key, a.value
        from jsonb_array_elements(case when jsonb_typeof(w.value) = 'array' then w.value else '[]'::jsonb end) with ordinality a(value, ordinality)
      ) child
      where jsonb_typeof(w.value) in ('object', 'array')
    )
    select 'component', actor_id::text, array_to_string(path, '.'), ''
    from walk
    where path[array_length(path, 1)] = 'FactionPlayerComponent'
    union all
    select 'array', actor_id::text, array_to_string(path, '.'), jsonb_typeof(value)
    from walk
    where path[array_length(path, 1)] = 'm_FactionDataArray'
    union all
    select 'faction_related', actor_id::text, array_to_string(path, '.'), jsonb_typeof(value)
    from walk
    where array_to_string(path, '.') ilike '%faction%'
    order by 1, 2, 3
    limit 80;
  `;
  const rows = parseDbRows(await dbQuery(sql, 20000), ["kind", "actor_id", "path", "jsonType"]);
  const components = rows.filter((row) => row.kind === "component");
  const arrays = rows.filter((row) => row.kind === "array");
  const related = rows.filter((row) => row.kind === "faction_related");
  const actorIds = [...new Set([...components, ...arrays].map((row) => row.actor_id).filter(Boolean))];
  return {
    status: arrays.length ? "detected" : (components.length || related.length ? "missing" : "missing"),
    actorIds,
    componentPaths: components.map((row) => ({ actor_id: row.actor_id, path: row.path })),
    arrayPaths: arrays.map((row) => ({ actor_id: row.actor_id, path: row.path, jsonType: row.jsonType })),
    factionRelatedPaths: related.slice(0, 20).map((row) => ({ actor_id: row.actor_id, path: row.path, jsonType: row.jsonType }))
  };
}

const PROGRESSION_TARGET_TABLES = [
  "specialization_tracks",
  "player_faction_reputation",
  "actors",
  "fgl_entities",
  "actor_fgl_entities",
  "player_state",
  "accounts",
  "encrypted_accounts"
];

const PROGRESSION_CORE_TABLES = [
  "specialization_tracks",
  "player_faction_reputation",
  "actors",
  "fgl_entities",
  "actor_fgl_entities"
];

function progressionSets(inspect) {
  const tableSet = new Set((inspect?.tables || []).filter((row) => row.status === "detected").map((row) => `${row.schema}.${row.table}`));
  const columnSet = new Set((inspect?.columns || []).map((row) => `${row.schema}.${row.table}.${row.column}`));
  const functionSet = new Set((inspect?.functions || []).filter((row) => row.status === "detected").map((row) => `${row.schema}.${row.function}`));
  return { tableSet, columnSet, functionSet };
}

async function progressionInspector() {
  const tableList = PROGRESSION_TARGET_TABLES.map((table) => sqlString(table)).join(", ");
  const sql = `
    select 'schema', schema_name, '', '', '', ''
    from information_schema.schemata
    where schema_name = 'dune'

    union all

    select 'table', table_schema, table_name, table_type, '', ''
    from information_schema.tables
    where table_schema = 'dune'
      and lower(table_name) in (${tableList})

    union all

    select 'column', table_schema, table_name, column_name, data_type, udt_name
    from information_schema.columns
    where table_schema = 'dune'
      and lower(table_name) in (${tableList})

    union all

    select 'function', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), '', ''
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'dune'
      and lower(p.proname) in (
        'set_specialization_xp_and_level',
        'set_player_faction_reputation'
      )
    order by 1, 2, 3, 4;
  `;
  try {
    const started = Date.now();
    const rows = parseDbRows(await dbQuery(sql, 20000), ["kind", "schema", "name", "detail", "dataType", "udtName"]);
    const schemaSet = new Set(rows.filter((row) => row.kind === "schema").map((row) => row.schema));
    const tableSet = new Set(rows.filter((row) => row.kind === "table").map((row) => `${row.schema}.${row.name}`));
    const columnRows = rows.filter((row) => row.kind === "column").map((row) => ({
      schema: row.schema,
      table: row.name,
      column: row.detail,
      dataType: row.dataType,
      udtName: row.udtName,
      status: "detected"
    }));
    const columnSet = new Set(columnRows.map((row) => `${row.schema}.${row.table}.${row.column}`));
    const functionRows = rows.filter((row) => row.kind === "function").map((row) => ({
      schema: row.schema,
      function: row.name,
      arguments: row.detail,
      status: "detected"
    }));
    const functionSet = new Set(functionRows.map((row) => `${row.schema}.${row.function}`));
    const tables = PROGRESSION_TARGET_TABLES.map((table) => progressionTableStatus(tableSet, table));
    const functions = [
      progressionFunctionStatus(functionSet, "set_specialization_xp_and_level"),
      progressionFunctionStatus(functionSet, "set_player_faction_reputation")
    ];
    const canScanFactionComponent = tableSet.has("dune.actors") && hasColumn(columnSet, "dune", "actors", "properties");
    const factionComponentScan = canScanFactionComponent
      ? await progressionFactionComponentScan().catch((error) => ({ status: "unknown", actorIds: [], error: error.message }))
      : { status: "unsupported", actorIds: [], error: "dune.actors.properties not detected" };
    const supports = {
      specializationXp: {
        label: "Specialization XP",
        status: progressionSupportStatus([
          tableSet.has("dune.specialization_tracks"),
          hasColumn(columnSet, "dune", "specialization_tracks", "player_id"),
          hasColumn(columnSet, "dune", "specialization_tracks", "track_type"),
          hasColumn(columnSet, "dune", "specialization_tracks", "xp_amount"),
          hasColumn(columnSet, "dune", "specialization_tracks", "level"),
          functionSet.has("dune.set_specialization_xp_and_level")
        ]),
        evidence: "Requires specialization_tracks columns and set_specialization_xp_and_level."
      },
      characterXp: {
        label: "Character XP",
        status: progressionSupportStatus([
          tableSet.has("dune.fgl_entities"),
          tableSet.has("dune.actor_fgl_entities"),
          hasColumn(columnSet, "dune", "fgl_entities", "components"),
          hasColumn(columnSet, "dune", "actor_fgl_entities", "actor_id"),
          hasColumn(columnSet, "dune", "actor_fgl_entities", "entity_id"),
          hasColumn(columnSet, "dune", "actor_fgl_entities", "slot_name")
        ]),
        evidence: "Metadata path exists for FLevelComponent discovery; component JSON values are not read in Phase 1."
      },
      skillPoints: {
        label: "Skill Points",
        status: tableSet.has("dune.fgl_entities") && hasColumn(columnSet, "dune", "fgl_entities", "components") ? "unknown" : "unsupported",
        evidence: "Skill point fields live inside component JSON and require read-only player lookup in Phase 2."
      },
      techKnowledgePoints: {
        label: "Tech Knowledge Points",
        status: tableSet.has("dune.actors") && hasColumn(columnSet, "dune", "actors", "properties") ? "unknown" : "unsupported",
        evidence: "Tech knowledge appears inside actor properties JSON and is not sampled in Phase 1."
      },
      factionReputation: {
        label: "Faction Reputation",
        status: progressionSupportStatus([
          tableSet.has("dune.player_faction_reputation"),
          hasColumn(columnSet, "dune", "player_faction_reputation", "actor_id"),
          hasColumn(columnSet, "dune", "player_faction_reputation", "faction_id"),
          hasColumn(columnSet, "dune", "player_faction_reputation", "reputation_amount"),
          functionSet.has("dune.set_player_faction_reputation")
        ]),
        evidence: "Requires player_faction_reputation columns and set_player_faction_reputation."
      },
      factionComponentCacheSync: {
        label: "Faction Component Cache Sync",
        status: factionComponentScan.status,
        evidence: factionComponentScan.status === "detected"
          ? `FactionPlayerComponent.m_FactionDataArray detected on actor IDs: ${factionComponentScan.actorIds.join(", ") || "unknown"}.`
          : factionComponentScan.status === "missing"
            ? "dune.actors.properties was scanned; FactionPlayerComponent.m_FactionDataArray was not found in sampled actors."
            : `Faction component scan unsupported or failed: ${factionComponentScan.error || "unknown reason"}.`,
        details: factionComponentScan
      }
    };
    return {
      ok: true,
      status: "available",
      database: { status: "connected", schema: schemaSet.has("dune") ? "dune" : "unknown" },
      schemaSignature: [
        `tables:${tables.filter((row) => row.status === "detected").map((row) => row.table).sort().join(",") || "none"}`,
        `functions:${functions.filter((row) => row.status === "detected").map((row) => row.function).sort().join(",") || "none"}`
      ].join("|"),
      durationMs: Date.now() - started,
      tables,
      columns: columnRows,
      functions,
      supports,
      safety: {
        readOnlyMode: true,
        liveEditingEnabled: false,
        rawSqlInputEnabled: false,
        message: "Read-only mode active. Live editing disabled."
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      database: { status: "unavailable", error: error.message },
      schemaSignature: "unknown",
      tables: PROGRESSION_TARGET_TABLES.map((table) => progressionTableStatus(new Set(), table, true)),
      columns: [],
      functions: ["set_specialization_xp_and_level", "set_player_faction_reputation"].map((name) => progressionFunctionStatus(new Set(), name, true)),
      supports: {
        specializationXp: { label: "Specialization XP", status: "unknown", evidence: "Database unavailable." },
        characterXp: { label: "Character XP", status: "unknown", evidence: "Database unavailable." },
        skillPoints: { label: "Skill Points", status: "unknown", evidence: "Database unavailable." },
        techKnowledgePoints: { label: "Tech Knowledge Points", status: "unknown", evidence: "Database unavailable." },
        factionReputation: { label: "Faction Reputation", status: "unknown", evidence: "Database unavailable." },
        factionComponentCacheSync: { label: "Faction Component Cache Sync", status: "unknown", evidence: "Database unavailable." }
      },
      safety: {
        readOnlyMode: true,
        liveEditingEnabled: false,
        rawSqlInputEnabled: false,
        message: "Progression database unavailable. Read-only inspector did not run."
      }
    };
  }
}

function firstExpression(expressions, fallback = "''") {
  return expressions.filter(Boolean).join(", ") || fallback;
}

function progressionUnsupported(reason, inspect = null) {
  return {
    ok: false,
    status: "unsupported",
    reason,
    inspectStatus: inspect?.status || "unknown",
    safety: {
      readOnlyMode: true,
      liveEditingEnabled: false,
      rawSqlInputEnabled: false
    }
  };
}

async function progressionPlayerLookup(queryValue) {
  const query = String(queryValue || "").trim();
  if (!query) return { ok: false, status: "not-found", reason: "Enter a character name, player name, actor id, or player id." };
  const inspect = await progressionInspector();
  if (!inspect.ok) {
    return {
      ok: false,
      status: "unavailable",
      reason: "Progression database unavailable",
      database: inspect.database,
      safety: inspect.safety
    };
  }
  const { tableSet, columnSet } = progressionSets(inspect);
  if (!tableSet.has("dune.actors") || !hasColumn(columnSet, "dune", "actors", "id")) {
    return progressionUnsupported("dune.actors with id column is required for player lookup.", inspect);
  }
  const columnType = new Map((inspect.columns || []).map((row) => [`${row.schema}.${row.table}.${row.column}`, row.udtName || row.dataType || ""]));

  const hasActorsClass = hasColumn(columnSet, "dune", "actors", "class");
  const hasActorsOwner = hasColumn(columnSet, "dune", "actors", "owner_account_id");
  const hasActorsMap = hasColumn(columnSet, "dune", "actors", "map");
  const hasActorsProperties = hasColumn(columnSet, "dune", "actors", "properties");
  const hasPlayerState = tableSet.has("dune.player_state");
  const hasPsAccount = hasColumn(columnSet, "dune", "player_state", "account_id");
  const hasPsName = hasColumn(columnSet, "dune", "player_state", "character_name");
  const hasPsController = hasColumn(columnSet, "dune", "player_state", "player_controller_id");
  const hasPsPawn = hasColumn(columnSet, "dune", "player_state", "player_pawn_id");
  const hasPsOnline = hasColumn(columnSet, "dune", "player_state", "online_status");
  const hasAccounts = tableSet.has("dune.accounts");
  const hasAccountsId = hasColumn(columnSet, "dune", "accounts", "id");
  const hasAccountsUser = hasColumn(columnSet, "dune", "accounts", "user");
  const hasAccountsFuncom = hasColumn(columnSet, "dune", "accounts", "funcom_id");
  const hasEncrypted = tableSet.has("dune.encrypted_accounts");
  const hasEncryptedId = hasColumn(columnSet, "dune", "encrypted_accounts", "id");
  const hasEncryptedFuncom = hasColumn(columnSet, "dune", "encrypted_accounts", "encrypted_funcom_id")
    && String(columnType.get("dune.encrypted_accounts.encrypted_funcom_id") || "").toLowerCase() === "bytea";

  const joins = [];
  if (hasPlayerState && hasPsAccount && hasActorsOwner) {
    joins.push("left join dune.player_state ps on ps.account_id = a.owner_account_id");
  }
  if (hasAccounts && hasAccountsId && hasActorsOwner) {
    joins.push("left join dune.accounts ac on ac.id = a.owner_account_id");
  }
  if (hasEncrypted && hasEncryptedId && hasActorsOwner) {
    joins.push("left join dune.encrypted_accounts ea on ea.id = a.owner_account_id");
  }

  const search = sqlString(`%${query}%`);
  const exact = sqlString(query);
  const conditions = [`a.id::text = ${exact}`];
  if (hasActorsOwner) conditions.push(`a.owner_account_id::text = ${exact}`);
  if (hasPsController && joins.some((join) => join.includes("player_state"))) conditions.push(`ps.player_controller_id::text = ${exact}`);
  if (hasPsPawn && joins.some((join) => join.includes("player_state"))) conditions.push(`ps.player_pawn_id::text = ${exact}`);
  if (hasPsName && joins.some((join) => join.includes("player_state"))) conditions.push(`ps.character_name ilike ${search}`);
  if (hasAccountsUser && joins.some((join) => join.includes("dune.accounts"))) conditions.push(`ac."user" ilike ${search}`);
  if (hasAccountsFuncom && joins.some((join) => join.includes("dune.accounts"))) conditions.push(`ac.funcom_id ilike ${search}`);
  if (hasEncryptedFuncom && joins.some((join) => join.includes("encrypted_accounts"))) conditions.push(`convert_from(ea.encrypted_funcom_id, 'UTF8') ilike ${search}`);
  const playerFilter = hasActorsClass ? "and a.class ilike '%Player%'" : "";
  const nameExpr = firstExpression([
    hasPsName && joins.some((join) => join.includes("player_state")) ? "ps.character_name" : "",
    hasAccountsUser && joins.some((join) => join.includes("dune.accounts")) ? "ac.\"user\"" : "",
    hasAccountsFuncom && joins.some((join) => join.includes("dune.accounts")) ? "ac.funcom_id" : "",
    hasEncryptedFuncom && joins.some((join) => join.includes("encrypted_accounts")) ? "convert_from(ea.encrypted_funcom_id, 'UTF8')" : ""
  ]);
  const playerSql = `
    select
      a.id::text as actor_id,
      ${hasActorsOwner ? "coalesce(a.owner_account_id::text, '')" : "''"} as account_id,
      coalesce(${nameExpr}) as character_name,
      ${hasPsController && joins.some((join) => join.includes("player_state")) ? "coalesce(ps.player_controller_id::text, '')" : "''"} as player_controller_id,
      ${hasPsPawn && joins.some((join) => join.includes("player_state")) ? "coalesce(ps.player_pawn_id::text, '')" : "''"} as player_pawn_id,
      ${hasPsOnline && joins.some((join) => join.includes("player_state")) ? "coalesce(ps.online_status::text, 'unknown')" : "'unknown'"} as online_status,
      ${hasActorsMap ? "coalesce(a.map, '')" : "''"} as map
    from dune.actors a
    ${joins.join("\n")}
    where (${conditions.join(" or ")})
      ${playerFilter}
    order by a.id
    limit 20;
  `;
  const players = parseDbRows(await dbQuery(playerSql, 20000), ["actor_id", "account_id", "character_name", "player_controller_id", "player_pawn_id", "online_status", "map"]);
  if (!players.length) {
    return { ok: false, status: "not-found", query, players: [], reason: "No matching progression player found.", safety: inspect.safety };
  }
  const player = players[0];
  const progressionActorId = Number(player.player_controller_id || player.actor_id);
  if (!Number.isSafeInteger(progressionActorId) || progressionActorId < 1) {
    return progressionUnsupported("Matched player did not expose a usable actor/player id.", inspect);
  }

  const result = {
    ok: true,
    status: "found",
    query,
    matches: players,
    player: {
      player_id: String(progressionActorId),
      actor_id: String(progressionActorId),
      character_actor_id: player.actor_id,
      account_id: player.account_id,
      character_name: player.character_name || "Unknown",
      player_controller_id: player.player_controller_id,
      player_pawn_id: player.player_pawn_id,
      online_status: player.online_status || "unknown",
      map: player.map || ""
    },
    specializationTracks: [],
    factionReputation: [],
    characterXp: null,
    techKnowledge: null,
    progressionDebug: {
      checkedActorIds: [],
      fglEntityLinks: [],
      componentNames: [],
      fLevelTarget: null,
      fieldStatus: {}
    },
    warnings: [],
    safety: inspect.safety
  };

  const onlineText = String(player.online_status || "").toLowerCase();
  if (onlineText.includes("online")) {
    result.warnings.push("Character XP editing requires the player to be offline.");
  }

  if (inspect.supports?.specializationXp?.status === "detected") {
    const rows = parseDbRows(await dbQuery(`
      select track_type::text, xp_amount::text, level::text
      from dune.specialization_tracks
      where player_id = ${progressionActorId}
      order by track_type
    `, 20000), ["track_type", "xp_amount", "level"]);
    result.specializationTracks = rows;
  } else {
    result.specializationStatus = inspect.supports?.specializationXp?.status || "unsupported";
  }

  if (inspect.supports?.factionReputation?.status === "detected") {
    const rows = parseDbRows(await dbQuery(`
      select faction_id::text, reputation_amount::text
      from dune.player_faction_reputation
      where actor_id = ${progressionActorId}
      order by faction_id
    `, 20000), ["faction_id", "reputation_amount"]);
    result.factionReputation = rows;
  } else {
    result.factionReputationStatus = inspect.supports?.factionReputation?.status || "unsupported";
  }

  const actorIdsToCheck = [...new Set([
    player.actor_id,
    player.player_controller_id,
    player.player_pawn_id,
    String(progressionActorId)
  ].map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
  result.progressionDebug.checkedActorIds = actorIdsToCheck.map(String);

  if (inspect.supports?.characterXp?.status === "detected") {
    const characterScan = await progressionCharacterComponentScan(actorIdsToCheck).catch((error) => ({
      values: null,
      links: [],
      componentNames: [],
      fieldStatus: {
        TotalXPEarned: `Character XP component scan failed: ${error.message}`,
        TotalSkillPoints: `Character XP component scan failed: ${error.message}`,
        UnspentSkillPoints: `Character XP component scan failed: ${error.message}`
      }
    }));
    result.progressionDebug.fglEntityLinks = characterScan.links;
    result.progressionDebug.componentNames = characterScan.componentNames;
    result.progressionDebug.fLevelTarget = characterScan.target || null;
    result.progressionDebug.fieldStatus = { ...result.progressionDebug.fieldStatus, ...characterScan.fieldStatus };
    result.characterXp = characterScan.values;
  } else {
    result.characterXpStatus = inspect.supports?.characterXp?.status || "unsupported";
    result.progressionDebug.fieldStatus.TotalXPEarned = "unsupported: character XP schema not detected";
    result.progressionDebug.fieldStatus.TotalSkillPoints = "unsupported: character XP schema not detected";
    result.progressionDebug.fieldStatus.UnspentSkillPoints = "unsupported: character XP schema not detected";
  }

  if (tableSet.has("dune.actors") && hasActorsProperties) {
    const techScan = await progressionTechKnowledgeScan(actorIdsToCheck).catch((error) => ({
      values: null,
      componentNames: [],
      fieldStatus: { m_TechKnowledgePoints: `Character XP component scan failed: ${error.message}` }
    }));
    result.progressionDebug.componentNames = [...new Set([...(result.progressionDebug.componentNames || []), ...techScan.componentNames])];
    result.progressionDebug.techKnowledgeTarget = techScan.target || null;
    result.progressionDebug.fieldStatus = { ...result.progressionDebug.fieldStatus, ...techScan.fieldStatus };
    result.techKnowledge = techScan.values;
  } else {
    result.techKnowledgeStatus = inspect.supports?.techKnowledgePoints?.status || "unsupported";
    result.progressionDebug.fieldStatus.m_TechKnowledgePoints = "unsupported: actors.properties not detected";
  }

  return result;
}

function sqlValuesList(numbers) {
  return numbers.map((value) => `(${Number(value)})`).join(", ");
}

function fieldFoundStatus(value, paths) {
  return value === "" || value == null
    ? `unsupported: field not found in scanned component JSON${paths ? `; paths checked ${paths}` : ""}`
    : "detected";
}

async function progressionCharacterComponentScan(actorIds) {
  if (!actorIds.length) {
    return {
      values: null,
      target: null,
      links: [],
      componentNames: [],
      fieldStatus: {
        TotalXPEarned: "unsupported: no actor ids available",
        TotalSkillPoints: "unsupported: no actor ids available",
        UnspentSkillPoints: "unsupported: no actor ids available"
      }
    };
  }
  const sql = `
    with recursive
    candidates(actor_id) as (values ${sqlValuesList(actorIds)}),
    links as (
      select c.actor_id, afe.entity_id, coalesce(afe.slot_name, '') as slot_name, fe.components
      from candidates c
      left join dune.actor_fgl_entities afe on afe.actor_id = c.actor_id
      left join dune.fgl_entities fe on fe.entity_id = afe.entity_id
    ),
    walk(actor_id, entity_id, slot_name, path, value) as (
      select actor_id, entity_id, slot_name, array[]::text[], components
      from links
      where components is not null
      union all
      select w.actor_id, w.entity_id, w.slot_name, w.path || child.key, child.value
      from walk w
      cross join lateral (
        select e.key, e.value
        from jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) e
        union all
        select (a.ordinality - 1)::text as key, a.value
        from jsonb_array_elements(case when jsonb_typeof(w.value) = 'array' then w.value else '[]'::jsonb end) with ordinality a(value, ordinality)
      ) child
      where jsonb_typeof(w.value) in ('object', 'array')
    )
    select 'link', actor_id::text, coalesce(entity_id::text, ''), slot_name, '', ''
    from links
    union all
    select distinct 'component', '', '', '', path[1], ''
    from walk
    where array_length(path, 1) = 1
    union all
    select 'field', actor_id::text, coalesce(entity_id::text, ''), slot_name, array_to_string(path, '.'), value #>> '{}'
    from walk
    where path[array_length(path, 1)] in ('TotalXPEarned', 'TotalSkillPoints', 'UnspentSkillPoints')
    order by 1, 2, 3, 4, 5;
  `;
  const rows = parseDbRows(await dbQuery(sql, 20000), ["kind", "actor_id", "entity_id", "slot_name", "path", "value"]);
  const links = rows.filter((row) => row.kind === "link").map((row) => ({
    actor_id: row.actor_id,
    entity_id: row.entity_id,
    slot_name: row.slot_name,
    found: Boolean(row.entity_id)
  }));
  const componentNames = [...new Set(rows.filter((row) => row.kind === "component").map((row) => row.path).filter(Boolean))];
  const fields = rows.filter((row) => row.kind === "field");
  const targetOf = (name) => {
    const preferred = fields.find((row) => row.path.endsWith(`.${name}`) && /DuneCharacter/i.test(row.slot_name || ""));
    return preferred || fields.find((row) => row.path.endsWith(`.${name}`)) || null;
  };
  const totalXpTarget = targetOf("TotalXPEarned");
  const totalSkillTarget = targetOf("TotalSkillPoints");
  const unspentTarget = targetOf("UnspentSkillPoints");
  const pathOf = (name) => fields.filter((row) => row.path.endsWith(`.${name}`)).map((row) => `${row.actor_id}/${row.entity_id}/${row.slot_name}:${row.path}`).join("; ");
  const values = {
    TotalXPEarned: totalXpTarget?.value || "",
    TotalSkillPoints: totalSkillTarget?.value || "",
    UnspentSkillPoints: unspentTarget?.value || ""
  };
  return {
    values,
    target: {
      actor_id: totalXpTarget?.actor_id || totalSkillTarget?.actor_id || unspentTarget?.actor_id || "",
      entity_id: totalXpTarget?.entity_id || totalSkillTarget?.entity_id || unspentTarget?.entity_id || "",
      slot_name: totalXpTarget?.slot_name || totalSkillTarget?.slot_name || unspentTarget?.slot_name || "",
      fields: {
        TotalXPEarned: totalXpTarget ? { path: totalXpTarget.path, value: totalXpTarget.value } : null,
        TotalSkillPoints: totalSkillTarget ? { path: totalSkillTarget.path, value: totalSkillTarget.value } : null,
        UnspentSkillPoints: unspentTarget ? { path: unspentTarget.path, value: unspentTarget.value } : null
      }
    },
    links,
    componentNames,
    fieldStatus: {
      TotalXPEarned: fieldFoundStatus(values.TotalXPEarned, pathOf("TotalXPEarned")),
      TotalSkillPoints: fieldFoundStatus(values.TotalSkillPoints, pathOf("TotalSkillPoints")),
      UnspentSkillPoints: fieldFoundStatus(values.UnspentSkillPoints, pathOf("UnspentSkillPoints"))
    }
  };
}

async function progressionTechKnowledgeScan(actorIds) {
  if (!actorIds.length) {
    return { values: null, componentNames: [], target: null, fieldStatus: { m_TechKnowledgePoints: "unsupported: no actor ids available" } };
  }
  const sql = `
    with recursive
    candidates(actor_id) as (values ${sqlValuesList(actorIds)}),
    actors as (
      select c.actor_id, a.properties
      from candidates c
      left join dune.actors a on a.id = c.actor_id
    ),
    walk(actor_id, path, value) as (
      select actor_id, array[]::text[], properties
      from actors
      where properties is not null
      union all
      select w.actor_id, w.path || child.key, child.value
      from walk w
      cross join lateral (
        select e.key, e.value
        from jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) e
        union all
        select (a.ordinality - 1)::text as key, a.value
        from jsonb_array_elements(case when jsonb_typeof(w.value) = 'array' then w.value else '[]'::jsonb end) with ordinality a(value, ordinality)
      ) child
      where jsonb_typeof(w.value) in ('object', 'array')
    )
    select distinct 'component', actor_id::text, path[1], ''
    from walk
    where array_length(path, 1) = 1
    union all
    select 'field', actor_id::text, array_to_string(path, '.'), value #>> '{}'
    from walk
    where path[array_length(path, 1)] = 'm_TechKnowledgePoints'
    order by 1, 2, 3;
  `;
  const rows = parseDbRows(await dbQuery(sql, 20000), ["kind", "actor_id", "path", "value"]);
  const componentNames = [...new Set(rows.filter((row) => row.kind === "component").map((row) => row.path).filter(Boolean))];
  const fields = rows.filter((row) => row.kind === "field");
  const preferred = fields.find((row) => String(row.actor_id) === String(actorIds[0])) || fields[0];
  const value = preferred?.value || "";
  const paths = fields.map((row) => `${row.actor_id}:${row.path}`).join("; ");
  return {
    values: { m_TechKnowledgePoints: value },
    componentNames,
    target: preferred ? { actor_id: preferred.actor_id, path: preferred.path, value } : null,
    fieldStatus: { m_TechKnowledgePoints: fieldFoundStatus(value, paths) }
  };
}

const progressionPreviews = new Map();

function clampNumber(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`);
  return Math.max(min, Math.min(max, number));
}

function progressionAudit(action, payload) {
  const entry = { timestamp: new Date().toISOString(), action, ...payload };
  fs.mkdirSync(path.dirname(PROGRESSION_AUDIT_LOG), { recursive: true });
  fs.appendFileSync(PROGRESSION_AUDIT_LOG, JSON.stringify(entry) + "\n", "utf8");
}

function progressionBackupPath(playerId, action, id) {
  fs.mkdirSync(PROGRESSION_BACKUP_DIR, { recursive: true });
  const safeAction = String(action || "progression").replace(/[^a-z0-9_-]/gi, "_");
  const safePlayer = String(playerId || "player").replace(/[^a-z0-9_-]/gi, "_");
  return path.join(PROGRESSION_BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safePlayer}-${safeAction}-${id}.json`);
}

function sqlTextArrayPath(pathValue) {
  const parts = String(pathValue || "").split(".").filter(Boolean);
  if (!parts.length) throw new Error("Detected JSON path is empty.");
  return `ARRAY[${parts.map((part) => sqlString(part)).join(", ")}]`;
}

function requireSqlIntegerLiteral(value, name) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${name} must be an integer.`);
  return text;
}

async function progressionPlayerComponentSupport(actorId) {
  const output = await dbQuery(`
    select
      coalesce((properties ? 'FactionPlayerComponent')::text, 'false'),
      coalesce((properties ? 'TechKnowledgePlayerComponent')::text, 'false')
    from dune.actors
    where id = ${actorId}
    limit 1
  `, 20000);
  const [faction = "false", tech = "false"] = String(output || "").split("\t");
  return { factionComponent: /^true$/i.test(faction), techKnowledgeComponent: /^true$/i.test(tech) };
}

async function progressionPreview(payload) {
  const action = String(payload?.action || "").trim();
  if (!["specialization_xp", "faction_reputation", "character_xp_skill_points"].includes(action)) {
    throw new Error("Unsupported progression action.");
  }
  const query = String(payload?.query || payload?.playerId || "").trim();
  const playerData = await progressionPlayerLookup(query);
  if (!playerData.ok) return progressionUnsupported(playerData.reason || "Player lookup failed.");
  const inspect = await progressionInspector();
  const actorId = requireInteger(playerData.player.actor_id, "actor_id", 1);
  const componentSupport = await progressionPlayerComponentSupport(actorId).catch(() => ({ factionComponent: false, techKnowledgeComponent: false }));
  const previewId = crypto.randomBytes(16).toString("hex");
  let oldValues = {};
  let newValues = {};
  let sqlPreview = "";

  if (action === "specialization_xp") {
    if (inspect.supports?.specializationXp?.status !== "detected") return progressionUnsupported("Specialization XP schema/function support was not detected.", inspect);
    const track = String(payload?.trackType || "").trim();
    if (!track) throw new Error("trackType is required.");
    const xp = Math.round(clampNumber(payload?.xpAmount, "xpAmount", 0, 44182));
    const level = clampNumber(payload?.level, "level", 0, 100);
    const current = (playerData.specializationTracks || []).find((row) => row.track_type === track) || null;
    oldValues = current || { track_type: track, xp_amount: "0", level: "0", missing: true };
    newValues = { track_type: track, xp_amount: xp, level };
    sqlPreview = `SELECT dune.set_specialization_xp_and_level(${actorId}, ${sqlString(track)}::dune.specializationtracktype, ${xp}, ${level});`;
  }

  if (action === "faction_reputation") {
    if (inspect.supports?.factionReputation?.status !== "detected") return progressionUnsupported("Faction reputation schema/function support was not detected.", inspect);
    if (!componentSupport.factionComponent) return progressionUnsupported("FactionPlayerComponent cache sync support was not detected for this player; refusing live reputation write.", inspect);
    const factionId = requireInteger(payload?.factionId, "factionId", 1, 32767);
    const reputationAmount = Math.round(clampNumber(payload?.reputationAmount, "reputationAmount", 0, 12474));
    const current = (playerData.factionReputation || []).find((row) => String(row.faction_id) === String(factionId)) || null;
    oldValues = current || { faction_id: String(factionId), reputation_amount: "0", missing: true };
    newValues = { faction_id: factionId, reputation_amount: reputationAmount };
    sqlPreview = `SELECT dune.set_player_faction_reputation(${actorId}, ${factionId}, ${reputationAmount}); plus FactionPlayerComponent cache rebuild.`;
  }

  if (action === "character_xp_skill_points") {
    if (inspect.supports?.characterXp?.status !== "detected") return progressionUnsupported("Character XP FLevelComponent support was not detected.", inspect);
    if (String(playerData.player.online_status || "").toLowerCase().includes("online")) {
      return progressionUnsupported("Character XP editing requires the player to be offline.", inspect);
    }
    const techTarget = playerData.progressionDebug?.techKnowledgeTarget || null;
    const fLevelTarget = playerData.progressionDebug?.fLevelTarget || null;
    const xpDetected = playerData.characterXp
      && playerData.characterXp.TotalXPEarned !== ""
      && playerData.characterXp.TotalSkillPoints !== ""
      && playerData.characterXp.UnspentSkillPoints !== ""
      && playerData.techKnowledge
      && playerData.techKnowledge.m_TechKnowledgePoints !== "";
    const fLevelFields = fLevelTarget?.fields || {};
    const fLevelDetected = fLevelTarget?.entity_id
      && fLevelFields.TotalXPEarned?.path
      && fLevelFields.TotalSkillPoints?.path
      && fLevelFields.UnspentSkillPoints?.path;
    if (!xpDetected || !fLevelDetected || !techTarget?.actor_id || !techTarget?.path) {
      return {
        ...progressionUnsupported("Character XP fields were not detected correctly for this player. Live character XP editing remains blocked.", inspect),
        mismatchDebug: {
          lookupDetectedCharacterXp: playerData.characterXp || null,
          lookupFLevelTarget: fLevelTarget,
          lookupDetectedTechKnowledge: playerData.techKnowledge || null,
          lookupTechKnowledgeTarget: techTarget,
          fieldStatus: playerData.progressionDebug?.fieldStatus || {},
          checkedActorIds: playerData.progressionDebug?.checkedActorIds || []
        }
      };
    }
    const totalXp = Math.round(clampNumber(payload?.totalXpEarned, "totalXpEarned", 0));
    const totalSkillPoints = Math.round(clampNumber(payload?.totalSkillPoints, "totalSkillPoints", 0));
    const unspentSkillPoints = Math.round(clampNumber(payload?.unspentSkillPoints, "unspentSkillPoints", 0));
    const techKnowledgePoints = Math.round(clampNumber(payload?.techKnowledgePoints, "techKnowledgePoints", 0));
    oldValues = {
      ...(playerData.characterXp || {}),
      ...(playerData.techKnowledge || {})
    };
    newValues = { TotalXPEarned: totalXp, TotalSkillPoints: totalSkillPoints, UnspentSkillPoints: unspentSkillPoints, m_TechKnowledgePoints: techKnowledgePoints };
    sqlPreview = `Update FLevelComponent at actor ${fLevelTarget.actor_id} entity ${fLevelTarget.entity_id} paths ${fLevelFields.TotalXPEarned.path}, ${fLevelFields.TotalSkillPoints.path}, ${fLevelFields.UnspentSkillPoints.path}; update TechKnowledge at actor ${techTarget.actor_id} path ${techTarget.path}.`;
    componentSupport.fLevelTarget = fLevelTarget;
    componentSupport.techKnowledgeTarget = techTarget;
  }

  const backup = {
    createdAt: new Date().toISOString(),
    action,
    player: playerData.player,
    oldValues,
    fLevelTarget: componentSupport.fLevelTarget || null,
    techKnowledgeTarget: componentSupport.techKnowledgeTarget || null,
    source: "progression-preview",
    readOnlyBackup: true
  };
  const backupPath = progressionBackupPath(actorId, action, previewId);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  const preview = {
    ok: true,
    status: "preview",
    previewId,
    backupPath,
    action,
    player: playerData.player,
    oldValues,
    newValues,
    fLevelTarget: componentSupport.fLevelTarget || null,
    techKnowledgeTarget: componentSupport.techKnowledgeTarget || null,
    sqlPreview,
    warning: "Live progression editing can corrupt player data. Backup first."
  };
  progressionPreviews.set(previewId, { ...preview, createdAt: Date.now(), componentSupport });
  return preview;
}

function factionComponentArraySql(actorId) {
  return `
    update dune.actors
    set properties = jsonb_set(
      properties,
      '{FactionPlayerComponent,m_FactionDataArray}',
      (
        select jsonb_agg(jsonb_build_object(
          'Faction', jsonb_build_object('Name', case when fid = 1 then 'Atreides' else 'Harkonnen' end),
          'timestamp', extract(epoch from now()),
          'ReputationAmount', rep
        ))
        from (
          values
            (1, coalesce((select reputation_amount from dune.player_faction_reputation where actor_id = ${actorId} and faction_id = 1), 0)),
            (2, coalesce((select reputation_amount from dune.player_faction_reputation where actor_id = ${actorId} and faction_id = 2), 0))
        ) as v(fid, rep)
      ),
      true
    )
    where id = ${actorId}
      and properties ? 'FactionPlayerComponent';
  `;
}

async function progressionApply(payload) {
  const configValue = loadConfig();
  const previewId = String(payload?.previewId || "").trim();
  const preview = progressionPreviews.get(previewId);
  if (!configValue.progressionEditingEnabled) throw new Error("Enable Progression Editing is OFF.");
  if (!preview) throw new Error("Dry-run preview was not generated first or has expired.");
  if (!fs.existsSync(preview.backupPath)) throw new Error("Matching backup file is missing.");
  if (payload?.confirmText !== "CONFIRM" && payload?.confirmed !== true) throw new Error("Type CONFIRM before applying.");
  if (Date.now() - preview.createdAt > 1000 * 60 * 30) throw new Error("Dry-run preview expired. Generate a new preview.");
  const inspect = await progressionInspector();
  if (!inspect.ok) throw new Error("Progression schema inspection failed.");
  const actorId = requireInteger(preview.player.actor_id, "actor_id", 1);
  const action = preview.action;
  let sql = "";
  if (action === "specialization_xp") {
    if (inspect.supports?.specializationXp?.status !== "detected") throw new Error("Specialization XP support is no longer detected.");
    sql = `
      begin;
      select dune.set_specialization_xp_and_level(${actorId}, ${sqlString(preview.newValues.track_type)}::dune.specializationtracktype, ${preview.newValues.xp_amount}, ${preview.newValues.level});
      commit;
    `;
  } else if (action === "faction_reputation") {
    if (inspect.supports?.factionReputation?.status !== "detected") throw new Error("Faction reputation support is no longer detected.");
    if (!preview.componentSupport?.factionComponent) throw new Error("FactionPlayerComponent cache sync support was not detected.");
    sql = `
      begin;
      select dune.set_player_faction_reputation(${actorId}, ${preview.newValues.faction_id}, ${preview.newValues.reputation_amount});
      ${factionComponentArraySql(actorId)}
      commit;
    `;
  } else if (action === "character_xp_skill_points") {
    if (inspect.supports?.characterXp?.status !== "detected") throw new Error("Character XP support is no longer detected.");
    const fresh = await progressionPlayerLookup(actorId);
    if (String(fresh.player?.online_status || "").toLowerCase().includes("online")) throw new Error("Character XP editing requires the player to be offline.");
    const fLevelTarget = preview.componentSupport?.fLevelTarget;
    const fLevelFields = fLevelTarget?.fields || {};
    if (!fLevelTarget?.entity_id
      || !fLevelFields.TotalXPEarned?.path
      || !fLevelFields.TotalSkillPoints?.path
      || !fLevelFields.UnspentSkillPoints?.path) {
      throw new Error("Preview did not include a resolved FLevelComponent path.");
    }
    const techTarget = preview.componentSupport?.techKnowledgeTarget;
    if (!techTarget?.actor_id || !techTarget?.path) throw new Error("Preview did not include a resolved TechKnowledge component path.");
    const fLevelEntityId = requireSqlIntegerLiteral(fLevelTarget.entity_id, "fLevel_entity_id");
    sql = `
      begin;
      with updated_flevel as (
        update dune.fgl_entities
        set components = jsonb_set(jsonb_set(jsonb_set(
        components,
        ${sqlTextArrayPath(fLevelFields.TotalXPEarned.path)}, to_jsonb(${preview.newValues.TotalXPEarned}::bigint), false),
        ${sqlTextArrayPath(fLevelFields.TotalSkillPoints.path)}, to_jsonb(${preview.newValues.TotalSkillPoints}::bigint), false),
        ${sqlTextArrayPath(fLevelFields.UnspentSkillPoints.path)}, to_jsonb(${preview.newValues.UnspentSkillPoints}::bigint), false)
        where entity_id = ${fLevelEntityId}
        returning 1
      )
      select 'flevel_rows', count(*)::text from updated_flevel;
      with updated_tech as (
        update dune.actors
        set properties = jsonb_set(
        properties,
        ${sqlTextArrayPath(techTarget.path)},
        to_jsonb(${preview.newValues.m_TechKnowledgePoints}::bigint),
        false)
        where id = ${requireInteger(techTarget.actor_id, "tech_knowledge_actor_id", 1)}
        returning 1
      )
      select 'tech_rows', count(*)::text from updated_tech;
      commit;
    `;
  } else {
    throw new Error("Unsupported progression action.");
  }
  try {
    const output = await dbQuery(sql, 30000);
    const debugRows = parseDbRows(output, ["key", "value"]);
    const rowsAffected = Object.fromEntries(debugRows.filter((row) => /_rows$/.test(row.key || "")).map((row) => [row.key, Number(row.value) || 0]));
    if (action === "character_xp_skill_points") {
      const readBack = await progressionPlayerLookup(actorId);
      const readBackValues = {
        TotalXPEarned: readBack.characterXp?.TotalXPEarned ?? "",
        TotalSkillPoints: readBack.characterXp?.TotalSkillPoints ?? "",
        UnspentSkillPoints: readBack.characterXp?.UnspentSkillPoints ?? "",
        m_TechKnowledgePoints: readBack.techKnowledge?.m_TechKnowledgePoints ?? ""
      };
      const expected = {
        TotalXPEarned: String(preview.newValues.TotalXPEarned),
        TotalSkillPoints: String(preview.newValues.TotalSkillPoints),
        UnspentSkillPoints: String(preview.newValues.UnspentSkillPoints),
        m_TechKnowledgePoints: String(preview.newValues.m_TechKnowledgePoints)
      };
      const verified = Object.keys(expected).every((key) => String(readBackValues[key]) === expected[key]);
      const verificationDebug = {
        fLevelTarget: preview.componentSupport?.fLevelTarget || null,
        techKnowledgeTarget: preview.componentSupport?.techKnowledgeTarget || null,
        rowsAffected,
        readBackValues,
        expectedValues: expected,
        readBackFieldStatus: readBack.progressionDebug?.fieldStatus || {}
      };
      if (!verified) {
        progressionPreviews.delete(previewId);
        progressionAudit("progression_apply_verification_failed", { action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupFilePath: preview.backupPath, success: false, verificationFailed: true, debug: verificationDebug });
        return { ok: false, status: "verification_failed", action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupPath: preview.backupPath, debug: verificationDebug, warning: "Database write completed, but read-back did not match the requested values." };
      }
      progressionPreviews.delete(previewId);
      progressionAudit("progression_apply_success", { action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupFilePath: preview.backupPath, success: true, debug: verificationDebug });
      return { ok: true, status: "applied", action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupPath: preview.backupPath, debug: verificationDebug };
    }
    progressionPreviews.delete(previewId);
    progressionAudit("progression_apply_success", { action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupFilePath: preview.backupPath, success: true });
    return { ok: true, status: "applied", action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupPath: preview.backupPath };
  } catch (error) {
    try { await dbQuery("rollback;", 10000); } catch {}
    progressionAudit("progression_apply_failure", { action, player: preview.player, oldValues: preview.oldValues, newValues: preview.newValues, backupFilePath: preview.backupPath, success: false, error: error.message });
    throw error;
  }
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "****";
    if (parsed.username) parsed.username = "****";
    return parsed.toString();
  } catch {
    return String(value || "");
  }
}

function httpRequestJson(urlValue, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlValue); }
    catch { reject(new Error("Give-item transport URL is invalid.")); return; }
    const client = parsed.protocol === "https:" ? https : http;
    const body = options.body == null ? null : Buffer.from(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    const req = client.request(parsed, {
      method: options.method || (body ? "POST" : "GET"),
      headers: {
        ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}),
        ...(options.headers || {})
      },
      timeout: options.timeout || LIVE_GIVE_ENV.timeoutMs
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Give-item transport timed out.")));
    req.on("error", (error) => {
      const target = redactUrl(urlValue);
      const detail = error.code ? `${error.code}: ${error.message}` : error.message;
      reject(new Error(`Give-item transport request failed for ${target}: ${detail}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

function basicAuthHeader(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function jsonPathEscape(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

function renderGiveItemTemplate(template, command) {
  return String(template || "").replace(/\{\{\s*(playerId|template|qty|quality|requestId)\s*\}\}/g, (_match, key) => {
    const value = key === "requestId" ? command.requestId : command[key];
    return jsonPathEscape(value);
  });
}

function liveGiveRequiredEnv(mode = LIVE_GIVE_ENV.transport) {
  if (mode === "http-json") {
    return [];
  }
  if (mode === "rabbitmq-http") {
    return [
      "DUNE_ADMIN_RABBITMQ_PUBLISH_URL",
      "DUNE_ADMIN_RABBITMQ_USER",
      "DUNE_ADMIN_RABBITMQ_PASSWORD",
      "DUNE_ADMIN_RABBITMQ_ROUTING_KEY",
      "DUNE_ADMIN_GIVE_ITEM_MESSAGE_TEMPLATE"
    ];
  }
  return [];
}

function liveGiveMissingEnv(mode = LIVE_GIVE_ENV.transport) {
  const values = {
    DUNE_ADMIN_GIVE_ITEM_URL: LIVE_GIVE_ENV.httpUrl,
    DUNE_ADMIN_RABBITMQ_PUBLISH_URL: LIVE_GIVE_ENV.rabbitPublishUrl,
    DUNE_ADMIN_RABBITMQ_USER: LIVE_GIVE_ENV.rabbitUser,
    DUNE_ADMIN_RABBITMQ_PASSWORD: LIVE_GIVE_ENV.rabbitPassword,
    DUNE_ADMIN_RABBITMQ_ROUTING_KEY: LIVE_GIVE_ENV.rabbitRoutingKey,
    DUNE_ADMIN_GIVE_ITEM_MESSAGE_TEMPLATE: LIVE_GIVE_ENV.rabbitMessageTemplate
  };
  return liveGiveRequiredEnv(mode).filter((name) => !values[name]);
}

function transportDisplayName(mode) {
  return mode || "dry-run";
}

const SERVER_STATUS_ONLINE = new Set(["healthy", "reconciling", "running", "updating", "starting", "progressing", "ready"]);
const SERVER_STATUS_OFFLINE = new Set(["stopped", "failed", "error", "unreachable", "missing", "offline"]);

function mapServerStatus(value) {
  const raw = String(value || "").trim();
  const key = raw.toLowerCase();
  if (!raw || key === "unknown") return { raw: raw || "Unknown", label: "Warning", kind: "warn", online: false };
  if (SERVER_STATUS_ONLINE.has(key)) return { raw, label: "Online", kind: "ok", online: true };
  if (SERVER_STATUS_OFFLINE.has(key)) return { raw, label: "Offline", kind: "bad", online: false };
  return { raw, label: "Warning", kind: "warn", online: false };
}

function mapServerSummaryStatus(summary) {
  const phaseStatus = mapServerStatus(summary?.phase || summary?.status);
  const checks = [summary?.servergroup, summary?.gateway, summary?.director].filter((value) => String(value || "").trim()).map(mapServerStatus);
  if (phaseStatus.kind === "bad" || checks.some((check) => check.kind === "bad")) return { label: "Offline", kind: "bad", online: false, phase: phaseStatus, checks };
  if (phaseStatus.online && checks.every((check) => check.kind !== "bad")) return { label: "Online", kind: "ok", online: true, phase: phaseStatus, checks };
  return { label: "Warning", kind: "warn", online: false, phase: phaseStatus, checks };
}

function topServerStatusDecision({ vm = {}, status = null, raw = "", statusResult = null } = {}) {
  const summary = status?.summary || {};
  const keyComponents = {
    phase: summary.phase || summary.status || "",
    servergroup: summary.servergroup || "",
    gateway: summary.gateway || "",
    director: summary.director || ""
  };
  const hardOfflineReasons = Object.entries(keyComponents)
    .filter(([, value]) => SERVER_STATUS_OFFLINE.has(String(value || "").trim().toLowerCase()))
    .map(([key, value]) => `${key}:${value}`);
  const rawText = String(raw || "");
  const battlegroupStatusReturned = Boolean(rawText.trim() && (Object.keys(summary).length || /Battlegroup:|Battlegroup Info|Game Servers/i.test(rawText)));
  const sshReachable = Boolean(statusResult?.ok || battlegroupStatusReturned);
  const hypervRunning = String(vm?.state || vm?.status || "").toLowerCase() === "running";
  const confirmationSources = {
    hypervRunning,
    sshReachable,
    battlegroupStatusReturned,
    parsedBattlegroupPhase: keyComponents.phase || "",
    keyComponents
  };
  if (hardOfflineReasons.length) {
    return { label: "Offline", kind: "bad", online: false, onlineDecisionReason: "Hard offline Battlegroup status/component detected.", hardOfflineReasons, confirmationSources };
  }
  if (battlegroupStatusReturned && sshReachable) {
    return { label: "Online", kind: "ok", online: true, onlineDecisionReason: "SSH returned usable Battlegroup status output and no hard offline state was detected.", hardOfflineReasons, confirmationSources };
  }
  if (sshReachable) {
    return { label: "Warning", kind: "warn", online: false, onlineDecisionReason: "SSH is reachable, but Battlegroup status output was not usable.", hardOfflineReasons, confirmationSources };
  }
  if (hypervRunning) {
    return { label: "Warning", kind: "warn", online: false, onlineDecisionReason: "Hyper-V reports the VM is running, but Battlegroup status could not be confirmed.", hardOfflineReasons, confirmationSources };
  }
  return { label: "Offline", kind: "bad", online: false, onlineDecisionReason: "No reachable VM or SSH Battlegroup status path was confirmed.", hardOfflineReasons: ["no_reachable_vm_or_ssh_path"], confirmationSources };
}

function statusSummaryIsOnline(summary) {
  return mapServerSummaryStatus(summary).online;
}

function serverSnapshotIsOnline(snapshot) {
  return Boolean(statusSummaryIsOnline(snapshot?.status?.summary || snapshot?.status));
}

function runtimeTransportAuditAction(nextMode, startup) {
  if (startup) return nextMode === "http-json" ? "startup_transport_http_json" : "startup_transport_dry_run";
  return nextMode === "http-json" ? "transport_changed_http_json" : "transport_changed_dry_run";
}

function appendRuntimeSafetyAudit(online, nextMode, source, reason) {
  if (nextMode === "http-json") {
    appendAdminAudit("server_online_detected", {
      source,
      serverOnline: online,
      transport: nextMode,
      reason
    });
    return;
  }
  appendAdminAudit("offline_detected", {
    source,
    serverOnline: online,
    reason
  });
  appendAdminAudit("dry_run_enabled", {
    source,
    transport: nextMode,
    serverOnline: online,
    reason
  });
}

function appendLiveGiveAvailabilityAudit(liveGiveAvailable, transport, source) {
  const changed = !liveGiveAvailability.initialized || liveGiveAvailability.available !== liveGiveAvailable;
  liveGiveAvailability.initialized = true;
  liveGiveAvailability.available = liveGiveAvailable;
  if (!changed) return;
  const reason = liveGiveAvailable
    ? "Server and receiver transport are online."
    : (transport?.dryRunReason || transport?.reason || transport?.error || runtimeGiveTransport.reason || "Live Give unavailable.");
  appendAdminAudit(liveGiveAvailable ? "online_detected" : "offline_detected", {
    source,
    serverOnline: Boolean(runtimeGiveTransport.serverOnline),
    receiverReachable: Boolean(transport?.reachable),
    reason
  });
  appendAdminAudit(liveGiveAvailable ? "live_give_enabled" : "dry_run_enabled", {
    source,
    transport: transport?.mode || runtimeGiveTransport.mode || "dry-run",
    serverOnline: Boolean(runtimeGiveTransport.serverOnline),
    receiverReachable: Boolean(transport?.reachable),
    reason
  });
}

async function updateRuntimeGiveTransport(snapshot = null, source = "status") {
  let checked = snapshot;
  if (!checked) {
    const availability = await liveGiveServerAvailability();
    checked = { vm: availability.vm, status: { summary: availability.status }, raw: availability.raw };
  }
  const online = serverSnapshotIsOnline(checked);
  const nextMode = online ? "http-json" : "dry-run";
  const mappedStatus = mapServerSummaryStatus(checked?.status?.summary || checked?.status);
  const nextReason = online ? `Server ${mappedStatus.label}.` : `Server ${mappedStatus.label}.`;
  const changed = !runtimeGiveTransport.initialized || runtimeGiveTransport.mode !== nextMode || runtimeGiveTransport.serverOnline !== online;
  const startup = !runtimeGiveTransport.initialized || source === "startup";
  runtimeGiveTransport.mode = nextMode;
  runtimeGiveTransport.serverOnline = online;
  runtimeGiveTransport.serverStatus = String(checked?.status?.summary?.status || checked?.status?.status || "");
  runtimeGiveTransport.serverStatusMapped = mappedStatus;
  runtimeGiveTransport.reason = nextReason;
  runtimeGiveTransport.initialized = true;
  if (changed) {
    appendAdminAudit(runtimeTransportAuditAction(nextMode, startup), {
      source,
      transport: nextMode,
      serverOnline: online,
      serverStatus: runtimeGiveTransport.serverStatus,
      reason: nextReason
    });
    appendRuntimeSafetyAudit(online, nextMode, source, nextReason);
  }
  return { ...runtimeGiveTransport };
}

function dryRunReason(transport) {
  if (!transport.configured) {
    if (transport.missingEnv?.length) return `Missing required env vars: ${transport.missingEnv.join(", ")}.`;
    return transport.reason || "Live give-item transport is not configured.";
  }
  if (!transport.reachable) {
    return transport.error ? `Transport is not reachable: ${transport.error}` : "Transport is configured but not reachable.";
  }
  return "";
}

function liveGiveUnavailableMessage(transport) {
  if ((transport?.mode || runtimeGiveTransport.mode) === "dry-run" && runtimeGiveTransport.reason) {
    return `Live Give Unavailable: ${runtimeGiveTransport.serverOnline ? runtimeGiveTransport.reason : "Server Offline"}.`;
  }
  const missing = transport?.missingEnv || [];
  if (missing.includes("DUNE_ADMIN_GIVE_ITEM_TRANSPORT")) {
    return "Live Give unavailable: missing DUNE_ADMIN_GIVE_ITEM_TRANSPORT.";
  }
  if (missing.length) return `Live Give unavailable: missing ${missing.join(", ")}.`;
  return `Live Give unavailable: ${transport?.dryRunReason || transport?.reason || transport?.error || "transport is not configured."}`;
}

function validateGiveItemPayload(payload) {
  const playerId = String(payload.playerId || "").trim();
  const template = String(payload.template || "").trim();
  const qty = Number(payload.qty || 1);
  const quality = Number(payload.quality || 0);
  if (!playerId) throw new Error("Choose a player first.");
  if (playerId.length > 128 || !/^[A-Za-z0-9_:.+\-# @]+$/.test(playerId)) throw new Error("Player name/id contains unsupported characters.");
  if (!template || template.length > 160 || !/^[A-Za-z0-9_:.+-]+$/.test(template)) throw new Error("Choose a valid item template.");
  const catalogMatch = gearCatalog().some((item) => item.id === template);
  if (!catalogMatch) throw new Error("Item template was not found in the local Gear Codex catalog.");
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw new Error("Quantity must be a whole number between 1 and 9999.");
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) throw new Error("Quality must be a whole number between 0 and 100.");
  return {
    playerId,
    template,
    qty,
    quality,
    requestId: `${Date.now()}-${Math.random().toString(16).slice(2)}`
  };
}

function giveTransportConfig() {
  const runtimeMode = runtimeGiveTransport.mode || "dry-run";
  if (runtimeMode === "dry-run" || runtimeMode === "disabled") {
    return {
      mode: "dry-run",
      configured: false,
      missingEnv: [],
      runtime: { ...runtimeGiveTransport },
      reason: runtimeGiveTransport.reason || "Server Offline or Not Healthy."
    };
  }
  if (runtimeMode === "http-json") {
    const url = LIVE_GIVE_ENV.httpUrl || LIVE_GIVE_DEFAULT_HTTP_URL;
    const missingEnv = liveGiveMissingEnv("http-json");
    if (missingEnv.length) return { mode: "http-json", configured: false, missingEnv, reason: `${missingEnv.join(", ")} required for http-json transport.` };
    return {
      mode: "http-json",
      configured: true,
      missingEnv: [],
      url,
      healthUrl: LIVE_GIVE_ENV.httpHealthUrl || LIVE_GIVE_DEFAULT_HEALTH_URL,
      token: LIVE_GIVE_ENV.httpToken,
      runtime: { ...runtimeGiveTransport }
    };
  }
  if (runtimeMode === "rabbitmq-http") {
    const url = LIVE_GIVE_ENV.rabbitPublishUrl;
    const user = LIVE_GIVE_ENV.rabbitUser;
    const password = LIVE_GIVE_ENV.rabbitPassword;
    const routingKey = LIVE_GIVE_ENV.rabbitRoutingKey;
    const messageTemplate = LIVE_GIVE_ENV.rabbitMessageTemplate;
    const missing = liveGiveMissingEnv("rabbitmq-http");
    if (missing.length) return { mode: "rabbitmq-http", configured: false, missingEnv: missing, reason: `${missing.join(", ")} required for rabbitmq-http transport.` };
    let overviewUrl = LIVE_GIVE_ENV.rabbitHealthUrl;
    if (!overviewUrl) {
      try {
        const parsed = new URL(url);
        parsed.pathname = "/api/overview";
        parsed.search = "";
        overviewUrl = parsed.toString();
      } catch {
        overviewUrl = "";
      }
    }
    return { mode: "rabbitmq-http", configured: true, missingEnv: [], url, user, password, routingKey, messageTemplate, overviewUrl };
  }
  return {
    mode: runtimeMode,
    configured: false,
    missingEnv: [],
    reason: `Unsupported runtime Give Item transport '${runtimeMode}'. Use http-json or dry-run.`
  };
}

function activeRuntimeConfigDiagnostics() {
  const cfg = loadConfig();
  const runtimeValues = relevantRuntimeEnvNames().map((name) => runtimeValue(name, "", cfg));
  return {
    activeConfigPath: CONFIG_PATH,
    backendConfigPath: CONFIG_PATH,
    managerConfigPath: MANAGER_CONFIG_PATH,
    appDataDir: APPDATA_DIR,
    managerDataDir: MANAGER_DATA_DIR,
    sourcePriority: [
      "process.env inherited by Electron",
      "app .env when variable is not already set",
      "app .env.local overrides earlier env values",
      "user .env when variable is not already set",
      "user .env.local overrides earlier env values",
      "AppData config.json settings mapped into runtime env",
      "computed runtime fallbacks/defaults"
    ],
    envFiles: runtimeEnvFiles().map((entry) => ({
      label: entry.label,
      path: entry.path,
      exists: fs.existsSync(entry.path),
      override: entry.override
    })),
    values: runtimeValues,
    loadedEnvironmentVariables: runtimeValues
  };
}

async function checkGiveTransport() {
  const config = giveTransportConfig();
  if (!config.configured) return { ...config, reachable: false, dryRunReason: dryRunReason({ ...config, reachable: false }) };
  try {
    if (config.mode === "http-json") {
      const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
      const response = await httpRequestJson(config.healthUrl, { method: "GET", headers, timeout: LIVE_GIVE_ENV.timeoutMs });
      const checked = { ...config, reachable: response.statusCode >= 200 && response.statusCode < 500, statusCode: response.statusCode };
      return { ...checked, dryRunReason: dryRunReason(checked) };
    }
    if (config.mode === "rabbitmq-http") {
      const response = await httpRequestJson(config.overviewUrl, {
        method: "GET",
        headers: { Authorization: basicAuthHeader(config.user, config.password) },
        timeout: LIVE_GIVE_ENV.timeoutMs
      });
      const checked = { ...config, reachable: response.ok, statusCode: response.statusCode };
      return { ...checked, dryRunReason: dryRunReason(checked) };
    }
  } catch (error) {
    const checked = { ...config, reachable: false, error: error.message };
    return { ...checked, dryRunReason: dryRunReason(checked) };
  }
  const checked = { ...config, reachable: false, error: "Transport reachability check is not implemented." };
  return { ...checked, dryRunReason: dryRunReason(checked) };
}

async function sendLiveGiveItem(command, checkedConfig = null) {
  const config = checkedConfig || await checkGiveTransport();
  if (!config.configured) {
    return {
      ok: false,
      dryRun: false,
      status: "live-unavailable",
      command,
      transport: config.mode,
      missingEnv: config.missingEnv || [],
      error: liveGiveUnavailableMessage(config)
    };
  }
  if (!config.reachable) {
    return {
      ok: false,
      dryRun: false,
      status: "live-unavailable",
      command,
      transport: config.mode,
      missingEnv: config.missingEnv || [],
      error: liveGiveUnavailableMessage(config)
    };
  }
  if (config.mode === "http-json") {
    const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
    const response = await httpRequestJson(config.url, {
      method: "POST",
      headers,
      body: {
        playerId: command.playerId,
        itemId: command.template,
        template: command.template,
        quantity: command.qty,
        qty: command.qty,
        quality: command.quality,
        requestId: command.requestId
      },
      timeout: LIVE_GIVE_ENV.timeoutMs
    });
    if (!response.ok) throw new Error(`Give-item HTTP transport returned ${response.statusCode}: ${response.text || "no response body"}`);
    const verified = Boolean(response.data?.verified || response.data?.inventoryVerified || response.data?.grantVerified);
    return {
      ok: true,
      dryRun: false,
      verified,
      status: verified ? "live-verified" : "live-published",
      transport: "http-json",
      command,
      response: response.data,
      stdout: verified ? "Live Give verified by receiver inventory check." : "Live Give published/queued. Inventory verification is not available."
    };
  }
  if (config.mode === "rabbitmq-http") {
    const payload = renderGiveItemTemplate(config.messageTemplate, command);
    try { JSON.parse(payload); }
    catch (error) { throw new Error(`DUNE_ADMIN_GIVE_ITEM_MESSAGE_TEMPLATE did not render valid JSON: ${error.message}`); }
    const response = await httpRequestJson(config.url, {
      method: "POST",
      headers: { Authorization: basicAuthHeader(config.user, config.password) },
      body: {
        properties: {},
        routing_key: config.routingKey,
        payload,
        payload_encoding: "string"
      },
      timeout: LIVE_GIVE_ENV.timeoutMs
    });
    if (!response.ok || response.data?.routed === false) {
      throw new Error(`RabbitMQ publish failed${response.statusCode ? ` (${response.statusCode})` : ""}: ${response.text || "message was not routed"}`);
    }
    return {
      ok: true,
      dryRun: false,
      verified: false,
      status: "live-published",
      transport: "rabbitmq-http",
      command,
      response: { routed: response.data?.routed !== false },
      stdout: "Live Give published/queued. Inventory verification is not available."
    };
  }
  return { ok: false, dryRun: false, status: "live-unavailable", command, error: `Live Give unavailable: unsupported transport '${config.mode}'.` };
}

async function adminProbe() {
  const tablesSql = `
    select table_schema || '.' || table_name
    from information_schema.tables
    where table_type = 'BASE TABLE'
      and table_schema not in ('pg_catalog', 'information_schema')
      and (
        lower(table_name) like '%player%' or
        lower(table_name) like '%character%' or
        lower(table_name) like '%inventory%' or
        lower(table_name) like '%item%'
      )
    order by table_schema, table_name
    limit 80
  `;
  const transport = await checkGiveTransport();
  const liveGiveAvailable = Boolean(transport.configured && transport.reachable);
  let output = "";
  try {
    output = await dbQuery(tablesSql);
  } catch (error) {
    return adminProbeUnavailable(error, transport);
  }
  return {
    ok: true,
    transport: transportDisplayName(transport.mode),
    configured: Boolean(transport.configured),
    reachable: Boolean(transport.reachable),
    missingEnv: transport.missingEnv || [],
    liveGiveAvailable,
    dryRunReason: liveGiveAvailable ? "" : (transport.dryRunReason || transport.reason || transport.error || "Live give-item transport is unavailable."),
    giveTransport: {
      mode: transport.mode,
      configured: Boolean(transport.configured),
      reachable: Boolean(transport.reachable),
      statusCode: transport.statusCode || null,
      target: transport.url ? redactUrl(transport.url) : "",
      missingEnv: transport.missingEnv || [],
      reason: transport.reason || transport.error || "",
      dryRunReason: liveGiveAvailable ? "" : (transport.dryRunReason || transport.reason || transport.error || "Live give-item transport is unavailable.")
    },
    tables: output ? output.split(/\r?\n/).filter(Boolean) : [],
    note: liveGiveAvailable
      ? `Live item grants are enabled through ${transport.mode}.`
      : `Player/item database access is reachable. Live item grants are dry-run only: ${transport.dryRunReason || transport.reason || transport.error || "transport is not reachable."}`
  };
}

function adminProbeUnavailable(error, transportOverride = null) {
  const transport = transportOverride || giveTransportConfig();
  const checked = {
    ...transport,
    reachable: Boolean(transport.reachable),
    error: transport.error || transport.reason || ""
  };
  const reason = dryRunReason(checked);
  return {
    ok: false,
    databaseReachable: false,
    transport: transportDisplayName(checked.mode),
    configured: Boolean(checked.configured),
    reachable: Boolean(checked.reachable),
    missingEnv: checked.missingEnv || [],
    liveGiveAvailable: Boolean(checked.configured && checked.reachable),
    dryRunReason: checked.configured && checked.reachable ? "" : reason,
    giveTransport: {
      mode: checked.mode,
      configured: Boolean(checked.configured),
      reachable: Boolean(checked.reachable),
      statusCode: checked.statusCode || null,
      target: checked.url ? redactUrl(checked.url) : "",
      missingEnv: checked.missingEnv || [],
      reason: checked.reason || checked.error || "",
      dryRunReason: checked.configured && checked.reachable ? "" : reason
    },
    error: error?.message || "Admin probe failed.",
    note: `Database/admin probe is offline: ${error?.message || "unknown error"}`
  };
}

async function liveGiveEnvStatus() {
  await updateRuntimeGiveTransport(null, "env");
  const transport = await checkGiveTransport();
  const liveGiveAvailable = Boolean(transport.configured && transport.reachable);
  appendLiveGiveAvailabilityAudit(liveGiveAvailable, transport, "live-give-env");
  return {
    ok: true,
    liveGiveAvailable,
    transport: transportDisplayName(transport.mode),
    configured: Boolean(transport.configured),
    reachable: Boolean(transport.reachable),
    missingEnv: transport.missingEnv || [],
    dryRunReason: liveGiveAvailable ? "" : (transport.dryRunReason || transport.reason || transport.error || "Live give-item transport is unavailable."),
    message: liveGiveAvailable ? "Live Give transport is configured and reachable." : liveGiveUnavailableMessage(transport),
    runtimeTransport: { ...runtimeGiveTransport },
    activeRuntimeConfig: activeRuntimeConfigDiagnostics(),
    requiredModesHelp: requiredModesHelp(),
    giveTransport: {
      mode: transport.mode,
      configured: Boolean(transport.configured),
      reachable: Boolean(transport.reachable),
      statusCode: transport.statusCode || null,
      target: transport.url ? redactUrl(transport.url) : "",
      missingEnv: transport.missingEnv || [],
      reason: transport.reason || transport.error || "",
      dryRunReason: liveGiveAvailable ? "" : (transport.dryRunReason || transport.reason || transport.error || "Live give-item transport is unavailable.")
    }
  };
}

async function adminPlayers() {
  const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const diagnostics = {
    serverPath: DEFAULT_SERVER_ROOT || "",
    sshTarget: VM_IP ? `${SSH_USER}@${VM_IP}` : `${SSH_USER}@auto-vm-ip`,
    sourcesChecked: [],
    filesChecked: [],
    sourceTableUsed: "",
    joinPathUsed: "",
    characterNamesResolved: 0,
    playersFound: 0,
    reason: "",
    errors: []
  };
  const characterQuery = `
    with account_ids as (
      select account_id from dune.communinet_player where account_id is not null
      union
      select account_id from dune.player_state where account_id is not null
    )
    select
      a.account_id::text,
      coalesce(ac.user, '') as fls_id,
      coalesce(ac.funcom_id, '') as funcom_id,
      coalesce(ps.player_controller_id::text, '') as player_controller_id,
      coalesce(ps.player_state_id::text, ps.player_pawn_id::text, ps.player_controller_id::text, '') as character_id,
      coalesce(nullif(ps.character_name, ''), a.account_id::text) as character_name,
      case when nullif(ps.character_name, '') is null then 'false' else 'true' end as resolved
    from account_ids a
    left join dune.player_state ps on ps.account_id = a.account_id
    left join dune.accounts ac on ac.id = a.account_id
    order by a.account_id, ps.last_avatar_activity desc nulls last, ps.player_state_id
    limit 200
  `;
  try {
    const output = await dbQuery(characterQuery);
    const players = output ? output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [accountId = "", flsId = "", funcomId = "", playerControllerId = "", characterId = "", characterName = "", resolved = "false"] = line.split("\t");
      return {
        id: accountId,
        name: characterName || accountId || "Unknown",
        account_id: accountId,
        fls_id: flsId,
        funcom_id: funcomId,
        player_controller_id: playerControllerId,
        character_id: characterId,
        character_name: characterName || accountId || "Unknown",
        characterNameResolved: /^true$/i.test(resolved)
      };
    }).filter((player) => player.id) : [];
    const resolvedCount = players.filter((player) => player.characterNameResolved).length;
    diagnostics.sourcesChecked.push({
      type: "database",
      source: "dune.communinet_player + dune.player_state",
      idColumn: "communinet_player.account_id / player_state.account_id",
      nameColumn: "player_state.character_name",
      rows: players.length,
      resolvedNames: resolvedCount,
      ok: true,
      joinPath: "dune.communinet_player.account_id -> dune.player_state.account_id -> dune.accounts.id"
    });
    diagnostics.sourceTableUsed = "dune.player_state";
    diagnostics.joinPathUsed = "dune.communinet_player.account_id -> dune.player_state.account_id -> dune.accounts.id";
    diagnostics.characterNamesResolved = resolvedCount;
    diagnostics.playersFound = players.length;
    if (players.length) {
      if (!resolvedCount) diagnostics.reason = "Player rows were found, but none had a character_name in dune.player_state.";
      return {
        ok: true,
        source: "dune.player_state",
        joinPath: diagnostics.joinPathUsed,
        characterNamesResolved: resolvedCount,
        players,
        diagnostics,
        error: resolvedCount ? "" : diagnostics.reason,
        details: playerDiagnosticLines(diagnostics)
      };
    }
    diagnostics.reason = "No account/player rows were found in dune.communinet_player or dune.player_state.";
  } catch (error) {
    diagnostics.sourcesChecked.push({
      type: "database",
      source: "dune.communinet_player + dune.player_state",
      idColumn: "communinet_player.account_id / player_state.account_id",
      nameColumn: "player_state.character_name",
      rows: 0,
      resolvedNames: 0,
      ok: false,
      joinPath: "dune.communinet_player.account_id -> dune.player_state.account_id -> dune.accounts.id",
      error: error.message
    });
    diagnostics.errors.push(`dune.player_state character query: ${error.message}`);
  }
  const metaSql = `
    select table_name || E'\\t' || string_agg(column_name, ',' order by ordinal_position)
    from information_schema.columns
    where table_schema = 'dune'
      and (
        lower(table_name) like '%player%' or
        lower(table_name) like '%character%'
      )
    group by table_name
    order by
      case
        when table_name = 'communinet_player' then 0
        when table_name = 'overmap_players' then 1
        when table_name like '%player%' then 2
        else 3
      end,
      table_name
    limit 40
  `;
  let metaOutput = "";
  try {
    metaOutput = await dbQuery(metaSql);
  } catch (error) {
    diagnostics.reason = "Could not read Dune database metadata.";
    diagnostics.errors.push(error.message);
    return {
      ok: false,
      source: "",
      players: [],
      diagnostics,
      error: diagnostics.reason,
      details: playerDiagnosticLines(diagnostics)
    };
  }
  const idNames = ["player_id", "playerid", "account_id", "accountid", "character_id", "characterid", "id", "uid", "uuid"];
  const nameNames = ["display_name", "displayname", "player_name", "playername", "character_name", "charactername", "name", "username", "nickname"];
  const candidates = metaOutput.split(/\r?\n/).filter(Boolean).map((line) => {
    const [table, columnsRaw = ""] = line.split("\t");
    const columns = columnsRaw.split(",").filter(Boolean);
    const lower = new Map(columns.map((column) => [column.toLowerCase(), column]));
    const idCol = idNames.map((name) => lower.get(name)).find(Boolean) || columns.find((column) => /player.*id|id.*player|character.*id|id$/i.test(column));
    const nameCol = nameNames.map((name) => lower.get(name)).find(Boolean) || columns.find((column) => /display/i.test(column) || (/name/i.test(column) && !/channel|guild|clan|faction|session|server|map/i.test(column)));
    if (!table || !idCol) return null;
    const idExpr = quoteIdent(idCol);
    const nameExpr = nameCol ? `coalesce(${quoteIdent(nameCol)}::text, ${idExpr}::text)` : `${idExpr}::text`;
    return {
      table: `dune.${table}`,
      idColumn: idCol,
      nameColumn: nameCol || "",
      sql: `select distinct ${idExpr}::text, ${nameExpr} from dune.${quoteIdent(table)} where ${idExpr} is not null order by 2 limit 100`
    };
  }).filter(Boolean);

  if (!candidates.length) {
    diagnostics.reason = "No Dune database tables with player-like or character-like columns were found.";
    return {
      ok: true,
      source: "",
      players: [],
      diagnostics,
      error: diagnostics.reason,
      details: playerDiagnosticLines(diagnostics)
    };
  }

  let best = { source: "", players: [] };
  for (const candidate of candidates) {
    const check = {
      type: "database",
      source: candidate.table,
      idColumn: candidate.idColumn,
      nameColumn: candidate.nameColumn || "(id only)",
      rows: 0,
      ok: false
    };
    try {
      const output = await dbQuery(candidate.sql);
      const players = output ? output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [id, name] = line.split("\t");
        return { id: id || "", name: name || id || "Unknown" };
      }) : [];
      check.rows = players.length;
      check.ok = true;
      diagnostics.sourcesChecked.push(check);
      if (players.length > 0) {
        best = { source: candidate.table, players };
        break;
      }
    } catch (error) {
      check.error = error.message;
      diagnostics.sourcesChecked.push(check);
      diagnostics.errors.push(`${candidate.table}: ${error.message}`);
    }
  }

  diagnostics.playersFound = best.players.length;
  if (!best.players.length) {
    diagnostics.reason = "No player rows were found in the checked Dune database tables. Players may need to join once, or their records may be stored in another table not yet recognized.";
  }

  return {
    ok: true,
    source: best.source,
    players: best.players,
    diagnostics,
    error: best.players.length ? "" : diagnostics.reason,
    details: playerDiagnosticLines(diagnostics)
  };
}

async function playersFeed() {
  const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const columnOutput = await dbQuery(`
    select table_name || E'\\t' || string_agg(column_name, ',' order by ordinal_position)
    from information_schema.columns
    where table_schema = 'dune'
      and table_name in ('player_state', 'communinet_player', 'accounts')
    group by table_name
  `);
  const tableColumns = new Map(columnOutput.split(/\r?\n/).filter(Boolean).map((line) => {
    const [table = "", columnsRaw = ""] = line.split("\t");
    return [table, new Set(columnsRaw.split(",").filter(Boolean).map((column) => column.toLowerCase()))];
  }));
  const psColumns = tableColumns.get("player_state") || new Set();
  const hasPs = (column) => psColumns.has(column.toLowerCase());
  const firstPsColumn = (columns) => columns.find((column) => hasPs(column));
  const levelColumn = firstPsColumn(["level", "character_level", "player_level", "current_level"]);
  const onlineColumn = firstPsColumn(["is_online", "online", "is_connected", "connected"]);
  const statusColumn = firstPsColumn(["status", "connection_status", "online_status", "presence_status"]);
  const lastSeenColumn = firstPsColumn(["last_avatar_activity", "last_seen", "last_login", "updated_at"]);
  const levelExpr = levelColumn ? `coalesce(ps.${quoteIdent(levelColumn)}::text, '')` : `''`;
  const onlineExpr = onlineColumn
    ? `case
        when ps.${quoteIdent(onlineColumn)} is null then ''
        when lower(ps.${quoteIdent(onlineColumn)}::text) in ('true','t','1','yes','online','connected','active') then 'online'
        when lower(ps.${quoteIdent(onlineColumn)}::text) in ('false','f','0','no','offline','disconnected','inactive') then 'offline'
        else ps.${quoteIdent(onlineColumn)}::text
      end`
    : `''`;
  const statusExpr = statusColumn ? `coalesce(ps.${quoteIdent(statusColumn)}::text, '')` : `''`;
  const lastSeenExpr = lastSeenColumn ? `coalesce(ps.${quoteIdent(lastSeenColumn)}::text, '')` : `''`;
  const playerStateOrder = lastSeenColumn ? `ps.${quoteIdent(lastSeenColumn)} desc nulls last,` : "";
  const feedQuery = `
    with account_ids as (
      select account_id from dune.communinet_player where account_id is not null
      union
      select account_id from dune.player_state where account_id is not null
    )
    select
      a.account_id::text,
      coalesce(ac.user, '') as fls_id,
      coalesce(ac.funcom_id, '') as funcom_id,
      coalesce(ps.player_controller_id::text, '') as player_controller_id,
      coalesce(ps.player_state_id::text, ps.player_pawn_id::text, ps.player_controller_id::text, '') as character_id,
      coalesce(nullif(ps.character_name, ''), a.account_id::text) as character_name,
      ${levelExpr} as level,
      ${onlineExpr} as online_state,
      ${statusExpr} as status_text,
      ${lastSeenExpr} as last_seen
    from account_ids a
    left join dune.player_state ps on ps.account_id = a.account_id
    left join dune.accounts ac on ac.id = a.account_id
    order by a.account_id, ${playerStateOrder} ps.player_state_id
    limit 120
  `;
  const output = await dbQuery(feedQuery);
  const seen = new Set();
  const players = output ? output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [accountId = "", flsId = "", funcomId = "", playerControllerId = "", characterId = "", characterName = "", level = "", onlineState = "", statusText = "", lastSeen = ""] = line.split("\t");
    const rawStatus = String(onlineState || statusText || "").toLowerCase();
    let status = "unknown";
    if (/online|connected|active|true|1/.test(rawStatus)) status = "online";
    else if (/offline|disconnected|inactive|false|0/.test(rawStatus)) status = "offline";
    return {
      id: accountId,
      name: characterName || accountId || "Unknown",
      account_id: accountId,
      fls_id: flsId,
      funcom_id: funcomId,
      player_controller_id: playerControllerId,
      character_id: characterId,
      level: level || null,
      status,
      statusSource: onlineColumn || statusColumn || "",
      last_seen: lastSeen || null
    };
  }).filter((player) => {
    const key = player.account_id || player.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }) : [];
  return {
    ok: true,
    source: "dune.communinet_player + dune.player_state",
    players,
    fields: {
      level: levelColumn || "",
      status: onlineColumn || statusColumn || "",
      lastSeen: lastSeenColumn || ""
    }
  };
}

function liveMapPickColumn(columns, patterns) {
  return columns.find((column) => patterns.some((pattern) => pattern.test(column))) || "";
}

function liveMapPlayerIdentityKeys(player) {
  return [
    player.fls_id,
    player.account_id,
    player.player_controller_id,
    player.character_id,
    player.id
  ].filter(Boolean).map((value) => String(value));
}

function liveMapNormalizeStatus(value) {
  const raw = String(value || "").toLowerCase();
  if (/online|connected|active|true|1/.test(raw)) return "online";
  if (/offline|disconnected|inactive|false|0/.test(raw)) return "offline";
  return raw || "unknown";
}

function liveMapNumericExpr(alias, column, quoteIdent) {
  const ref = `${alias}.${quoteIdent(column)}`;
  return `case when ${ref} is not null and ${ref}::text ~ '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$' then ${ref}::double precision else null end`;
}

function liveMapTextExpr(alias, column, quoteIdent) {
  return column ? `coalesce(${alias}.${quoteIdent(column)}::text, '')` : `''`;
}

function liveMapColumnDiscoveryRows(output) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [table = "", raw = ""] = line.split("\t");
    const columns = raw.split(",").filter(Boolean);
    return { table, columns, lower: columns.map((column) => column.toLowerCase()) };
  });
}

async function liveMapDiscoverPositionTables(quoteIdent) {
  const output = await dbQuery(`
    select table_name || E'\\t' || string_agg(column_name, ',' order by ordinal_position)
    from information_schema.columns
    where table_schema = 'dune'
    group by table_name
    having bool_or(lower(column_name) ~ '(x|y|z|pos|position|transform|location|map|world|level|pawn|entity|actor|character|player_state|controller)')
       or lower(table_name) ~ '(player|character|pawn|entity|actor|controller|position|location|transform|vehicle|base|building)'
    order by table_name
    limit 260
  `, 45000);
  const rows = liveMapColumnDiscoveryRows(output);
  return rows.map((row) => {
    const xCol = liveMapPickColumn(row.lower, [/^x$/, /(^|_)pos.*x/, /position.*x/, /location.*x/, /world.*x/, /coord.*x/, /translate.*x/]);
    const yCol = liveMapPickColumn(row.lower, [/^y$/, /(^|_)pos.*y/, /position.*y/, /location.*y/, /world.*y/, /coord.*y/, /translate.*y/]);
    const zCol = liveMapPickColumn(row.lower, [/^z$/, /(^|_)pos.*z/, /position.*z/, /location.*z/, /world.*z/, /coord.*z/, /translate.*z/, /height/, /altitude/]);
    const accountCol = liveMapPickColumn(row.lower, [/^account_id$/, /account.*id/]);
    const controllerCol = liveMapPickColumn(row.lower, [/player.*controller.*id/, /^controller_id$/]);
    const characterCol = liveMapPickColumn(row.lower, [/character.*id/, /player_state.*id/, /player.*state.*id/]);
    const pawnCol = liveMapPickColumn(row.lower, [/pawn.*id/, /entity.*id/, /actor.*id/]);
    const nameCol = liveMapPickColumn(row.lower, [/character.*name/, /^name$/, /display.*name/, /label/]);
    const mapCol = liveMapPickColumn(row.lower, [/^map$/, /map.*name/, /world/, /level/, /zone/, /partition/]);
    const onlineCol = liveMapPickColumn(row.lower, [/online/, /connected/, /status/, /presence/]);
    const timeCol = liveMapPickColumn(row.lower, [/time/, /timestamp/, /created/, /updated/, /event.*id/, /^id$/]);
    const hasPosition = Boolean(xCol && yCol);
    const hasPositionBlob = row.lower.some((column) => /pos|position|transform|location/.test(column));
    const lowerToReal = new Map(row.columns.map((column) => [column.toLowerCase(), column]));
    return {
      table: row.table,
      columns: row.columns,
      hasPosition,
      hasPositionBlob,
      x: xCol ? lowerToReal.get(xCol) : "",
      y: yCol ? lowerToReal.get(yCol) : "",
      z: zCol ? lowerToReal.get(zCol) : "",
      account: accountCol ? lowerToReal.get(accountCol) : "",
      controller: controllerCol ? lowerToReal.get(controllerCol) : "",
      character: characterCol ? lowerToReal.get(characterCol) : "",
      pawn: pawnCol ? lowerToReal.get(pawnCol) : "",
      name: nameCol ? lowerToReal.get(nameCol) : "",
      map: mapCol ? lowerToReal.get(mapCol) : "",
      online: onlineCol ? lowerToReal.get(onlineCol) : "",
      time: timeCol ? lowerToReal.get(timeCol) : "",
      playerish: /player|character|pawn|controller|actor|entity|state/i.test(row.table)
    };
  });
}

async function liveMapPlayerPositions(players, discovery, quoteIdent) {
  const identityByKey = new Map();
  for (const player of players) {
    for (const key of liveMapPlayerIdentityKeys(player)) identityByKey.set(key, player);
  }
  const candidates = discovery
    .filter((row) => row.hasPosition && (row.playerish || row.account || row.controller || row.character || row.pawn || row.name))
    .sort((a, b) => Number(b.playerish) - Number(a.playerish))
    .slice(0, 18);
  const rawPlayerRecords = [];
  const positionSourceTried = [];
  const matched = [];
  const matchedKeys = new Set();
  for (const candidate of candidates) {
    const source = {
      table: `dune.${candidate.table}`,
      x: candidate.x,
      y: candidate.y,
      z: candidate.z,
      account: candidate.account,
      controller: candidate.controller,
      character: candidate.character,
      pawn: candidate.pawn,
      map: candidate.map,
      time: candidate.time,
      rows: 0,
      validRows: 0,
      matchedRows: 0
    };
    positionSourceTried.push(source);
    const select = [
      `${liveMapTextExpr("p", candidate.account, quoteIdent)} as account_id`,
      `${liveMapTextExpr("p", candidate.name, quoteIdent)} as character_name`,
      `${liveMapTextExpr("p", candidate.controller, quoteIdent)} as player_controller_id`,
      `${liveMapTextExpr("p", candidate.pawn, quoteIdent)} as pawn_entity_id`,
      `${liveMapTextExpr("p", candidate.character, quoteIdent)} as character_id`,
      `${liveMapNumericExpr("p", candidate.x, quoteIdent)} as x`,
      `${liveMapNumericExpr("p", candidate.y, quoteIdent)} as y`,
      `${candidate.z ? liveMapNumericExpr("p", candidate.z, quoteIdent) : "null"} as z`,
      `${liveMapTextExpr("p", candidate.map, quoteIdent)} as map`,
      `${liveMapTextExpr("p", candidate.online, quoteIdent)} as online_status`,
      `${liveMapTextExpr("p", candidate.time, quoteIdent)} as source_time`
    ].join(", ");
    const orderBy = candidate.time ? `order by p.${quoteIdent(candidate.time)} desc nulls last` : "";
    const sql = `
      select ${select}
      from dune.${quoteIdent(candidate.table)} p
      where p.${quoteIdent(candidate.x)} is not null
        and p.${quoteIdent(candidate.y)} is not null
      ${orderBy}
      limit 500
    `;
    try {
      const output = await dbQuery(sql, 30000);
      const rows = output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [accountId = "", characterName = "", controllerId = "", pawnEntityId = "", characterId = "", xRaw = "", yRaw = "", zRaw = "", map = "", onlineRaw = "", sourceTime = ""] = line.split("\t");
        return {
          account_id: accountId,
          character_name: characterName,
          player_controller_id: controllerId,
          pawn_entity_id: pawnEntityId,
          character_id: characterId,
          x: Number(xRaw),
          y: Number(yRaw),
          z: zRaw === "" ? null : Number(zRaw),
          map,
          online_status: onlineRaw,
          source_time: sourceTime,
          source: source.table
        };
      });
      source.rows = rows.length;
      for (const row of rows.slice(0, 12)) rawPlayerRecords.push(row);
      const valid = rows.filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
      source.validRows = valid.length;
      for (const row of valid) {
        const keys = [row.account_id, row.player_controller_id, row.character_id, row.pawn_entity_id].filter(Boolean).map(String);
        const identity = keys.map((key) => identityByKey.get(key)).find(Boolean) || null;
        if (!identity && players.length) continue;
        const matchKey = identity?.player_controller_id || identity?.character_id || identity?.account_id || row.player_controller_id || row.character_id || row.pawn_entity_id || row.account_id;
        if (matchKey && matchedKeys.has(String(matchKey))) continue;
        if (matchKey) matchedKeys.add(String(matchKey));
        matched.push({
          id: row.player_controller_id || row.character_id || row.account_id || row.pawn_entity_id || `player-${matched.length + 1}`,
          fls_id: identity?.fls_id || "",
          name: row.character_name || identity?.name || identity?.character_name || row.account_id || "Player",
          character_name: row.character_name || identity?.name || "",
          account_id: row.account_id || identity?.account_id || "",
          funcom_id: identity?.funcom_id || "",
          player_controller_id: row.player_controller_id || identity?.player_controller_id || "",
          pawn_entity_id: row.pawn_entity_id || "",
          online: liveMapNormalizeStatus(row.online_status || identity?.status),
          x: row.x,
          y: row.y,
          z: Number.isFinite(row.z) ? row.z : null,
          map: row.map || "HaggaBasin",
          hasPosition: true,
          source_time: row.source_time || "",
          source: source.table
        });
      }
      source.matchedRows = matchedKeys.size;
      if (matched.length) break;
    } catch (error) {
      source.error = error.message;
    }
  }
  console.log("[AlphaNine Live Map] raw player position records", JSON.stringify(rawPlayerRecords.slice(0, 10)));
  return { players: matched, rawPlayerRecords, positionSourceTried };
}

async function liveMapEntities() {
  const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    layers: { players: [], vehicles: [], bases: [] },
    sources: [],
    errors: [],
    bounds: null,
    debug: {
      playersLoaded: 0,
      playersWithIdentity: 0,
      playersWithPosition: 0,
      playersWithCoordinates: 0,
      playerPositionUnavailable: false,
      positionSourceTried: [],
      positionSourceTable: "",
      rawPlayerRecords: [],
      positionDiscovery: [],
      counts: { players: 0, vehicles: 0, bases: 0 },
      entitySources: { vehicles: "unavailable", bases: "unavailable" },
      missingReason: "",
      markerCount: 0
    }
  };
  let identityPlayers = [];
  try {
    const feed = await playersFeed();
    identityPlayers = Array.isArray(feed.players) ? feed.players : [];
    result.debug.playersLoaded = identityPlayers.length;
    result.debug.playersWithIdentity = identityPlayers.length;
    result.sources.push({ kind: "players", table: "api/players/feed", rows: result.debug.playersLoaded, coordinateRows: 0 });
    console.log("[AlphaNine Live Map] player identities", JSON.stringify(identityPlayers.slice(0, 10).map((player) => ({
      account_id: player.account_id,
      character_name: player.name || player.character_name,
      player_controller_id: player.player_controller_id,
      character_id: player.character_id,
      online: player.status
    }))));
  } catch (error) {
    result.errors.push(`api/players/feed: ${error.message}`);
  }
  let discovery = [];
  try {
    discovery = await liveMapDiscoverPositionTables(quoteIdent);
    result.debug.positionDiscovery = discovery.map((row) => ({
      table: `dune.${row.table}`,
      hasPosition: row.hasPosition,
      hasPositionBlob: row.hasPositionBlob,
      x: row.x,
      y: row.y,
      z: row.z,
      account: row.account,
      controller: row.controller,
      character: row.character,
      pawn: row.pawn,
      map: row.map,
      online: row.online,
      time: row.time
    })).slice(0, 80);
    const positions = await liveMapPlayerPositions(identityPlayers, discovery, quoteIdent);
    result.layers.players = positions.players;
    result.debug.rawPlayerRecords = positions.rawPlayerRecords;
    result.debug.positionSourceTried = positions.positionSourceTried;
    result.debug.playersWithPosition = positions.players.length;
    result.debug.playersWithCoordinates = positions.players.length;
    result.debug.positionSourceTable = positions.players[0]?.source || "";
  } catch (error) {
    result.errors.push(`player position discovery: ${error.message}`);
  }
  let tables = [];
  try {
    const metaOutput = await dbQuery(`
      select table_name || E'\\t' || string_agg(column_name, ',' order by ordinal_position)
      from information_schema.columns
      where table_schema = 'dune'
        and lower(table_name) ~ '(vehicle|sandbike|buggy|ornithopter|base|building|structure|claim|owned|garage|placeable|marker|poi)'
      group by table_name
      order by table_name
      limit 140
    `, 45000);
    tables = metaOutput.split(/\r?\n/).filter(Boolean).map((line) => {
      const [table = "", raw = ""] = line.split("\t");
      const columns = raw.split(",").filter(Boolean);
      return { table, columns, lower: columns.map((column) => column.toLowerCase()) };
    });
  } catch (error) {
    result.errors.push(`base/vehicle table discovery: ${error.message}`);
  }
  const kinds = [
    { kind: "vehicles", label: "Vehicles", table: /vehicle|sandbike|buggy|ornithopter|garage/i },
    { kind: "bases", label: "Bases", table: /base|building|structure|claim|placeable/i }
  ];
  const allPoints = [...result.layers.players];
  for (const spec of kinds) {
    const candidates = tables.filter((row) => spec.table.test(row.table));
    if (!candidates.length) {
      result.sources.push({ kind: spec.kind, table: "", status: "unavailable", rows: 0, coordinateRows: 0, reason: `No ${spec.label.toLowerCase()} tables discovered with candidate names.` });
      continue;
    }
    for (const candidate of candidates) {
      const lowerToReal = new Map(candidate.columns.map((column) => [column.toLowerCase(), column]));
      const xCol = liveMapPickColumn(candidate.lower, [/^x$/, /pos.*x/, /position.*x/, /location.*x/, /world.*x/, /coord.*x/]);
      const yCol = liveMapPickColumn(candidate.lower, [/^y$/, /pos.*y/, /position.*y/, /location.*y/, /world.*y/, /coord.*y/]);
      if (!xCol || !yCol) {
        result.sources.push({ kind: spec.kind, table: `dune.${candidate.table}`, status: "unavailable", rows: 0, coordinateRows: 0, x: xCol ? lowerToReal.get(xCol) : "", y: yCol ? lowerToReal.get(yCol) : "", reason: "No usable X/Y coordinate columns detected." });
        continue;
      }
      const zCol = liveMapPickColumn(candidate.lower, [/^z$/, /height/, /altitude/]);
      const idCol = liveMapPickColumn(candidate.lower, [/^id$/, /player.*id/, /vehicle.*id/, /base.*id/, /building.*id/, /account.*id/]);
      const nameCol = liveMapPickColumn(candidate.lower, [/name/, /label/, /display/]);
      const x = quoteIdent(lowerToReal.get(xCol));
      const y = quoteIdent(lowerToReal.get(yCol));
      const z = zCol ? quoteIdent(lowerToReal.get(zCol)) : "null";
      const id = idCol ? quoteIdent(lowerToReal.get(idCol)) : "null";
      const name = nameCol ? quoteIdent(lowerToReal.get(nameCol)) : "null";
      const sql = `select coalesce(${id}::text, '') as id, coalesce(${name}::text, '') as name, ${x}::double precision as x, ${y}::double precision as y, ${z}::text as z from dune.${quoteIdent(candidate.table)} where ${x} is not null and ${y} is not null limit 200`;
      const source = { kind: spec.kind, table: `dune.${candidate.table}`, status: "checking", x: lowerToReal.get(xCol), y: lowerToReal.get(yCol), z: zCol ? lowerToReal.get(zCol) : "", rows: 0, coordinateRows: 0 };
      try {
        const output = await dbQuery(sql, 30000);
        const loadedRows = output.split(/\r?\n/).filter(Boolean).map((line, index) => {
          const [id = "", name = "", xRaw = "", yRaw = "", zRaw = ""] = line.split("\t");
          const entity = { id: id || `${spec.kind}-${index + 1}`, name: name || `${spec.label} ${index + 1}`, x: Number(xRaw), y: Number(yRaw), z: zRaw || null, source: source.table };
          if (Number.isFinite(entity.x) && Number.isFinite(entity.y)) allPoints.push(entity);
          return entity;
        });
        const rows = loadedRows.filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
        source.rows = loadedRows.length;
        source.coordinateRows = rows.length;
        source.status = rows.length ? "real" : "empty";
        result.sources.push(source);
        result.layers[spec.kind] = rows;
        if (rows.length) break;
      } catch (error) {
        source.status = "unavailable";
        source.error = error.message;
        result.sources.push(source);
        result.errors.push(`${source.table}: ${error.message}`);
      }
    }
  }
  if (allPoints.length) {
    const xs = allPoints.map((row) => row.x);
    const ys = allPoints.map((row) => row.y);
    result.bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  result.debug.counts = { players: result.layers.players.length, vehicles: result.layers.vehicles.length, bases: result.layers.bases.length };
  for (const kind of ["vehicles", "bases"]) {
    const source = result.sources.find((row) => row.kind === kind && row.status === "real")
      || result.sources.find((row) => row.kind === kind && row.status === "empty")
      || result.sources.find((row) => row.kind === kind);
    result.debug.entitySources[kind] = source?.status || "unavailable";
  }
  result.debug.markerCount = result.layers.players.length + result.layers.vehicles.length + result.layers.bases.length;
  console.log("[AlphaNine Live Map] entity counts", JSON.stringify({ players: result.layers.players.length, vehicles: result.layers.vehicles.length, bases: result.layers.bases.length, entitySources: result.debug.entitySources }));
  result.debug.playerPositionUnavailable = result.debug.playersLoaded > 0 && result.debug.playersWithPosition === 0;
  if (result.debug.playerPositionUnavailable) {
    result.debug.missingReason = result.debug.positionSourceTried.length
      ? "Player identity rows were loaded, but no discovered position table produced coordinates that could be joined to those players."
      : "Player identity rows were loaded, but no Dune table with usable x/y position columns was discovered.";
    result.errors.push("Player position unavailable");
  }
  if (!result.sources.length) result.errors.push("No player, vehicle, or base tables with coordinate-like columns were discovered.");
  return result;
}

async function liveMapTeleportPreview(payload) {
  const preview = liveMapTeleportRequest(payload, { dryRun: true, test: true });
  return {
    ok: true,
    status: "preview",
    message: "Teleport preview only. No live teleport command was sent.",
    ...preview
  };
}

function receiverHttpAuthToken(configValue = loadConfig()) {
  return String(
    configValue.receiverToken
    || LIVE_GIVE_ENV.httpToken
    || process.env.DUNE_RECEIVER_TOKEN
    || process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN
    || ""
  ).trim();
}

function receiverHttpAuthSource(configValue = loadConfig()) {
  if (configValue.receiverToken) return "config.receiverToken";
  if (LIVE_GIVE_ENV.httpToken) return "DUNE_ADMIN_GIVE_ITEM_TOKEN";
  if (process.env.DUNE_RECEIVER_TOKEN) return "DUNE_RECEIVER_TOKEN";
  if (process.env.DUNE_ADMIN_GIVE_ITEM_TOKEN) return "DUNE_ADMIN_GIVE_ITEM_TOKEN";
  return "none";
}

function teleportReceiverUrl(configValue = loadConfig()) {
  const receiver = receiverUrls(configValue);
  const pathPart = String(configValue.teleportEndpointPath || "/teleport").trim() || "/teleport";
  const endpointPath = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  return `http://${receiver.host}:${receiver.port}${endpointPath}`;
}

function renderTeleportTemplate(template, values) {
  return String(template || "").replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ));
}

function loadTeleportLocationPresets() {
  try {
    if (!fs.existsSync(TELEPORT_PRESETS_PATH)) return { ok: true, presets: [], path: TELEPORT_PRESETS_PATH };
    const raw = JSON.parse(fs.readFileSync(TELEPORT_PRESETS_PATH, "utf8").replace(/^\uFEFF/, ""));
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.presets) ? raw.presets : [];
    const presets = rows.filter((row) => row && row.enabled !== false).map((row) => {
      const x = Number(row.x), y = Number(row.y), z = Number(row.z);
      const partitionId = Number(row.partition_id ?? row.partitionId ?? 0);
      return {
        name: String(row.name || "Unnamed location").trim(),
        map: String(row.map || "HaggaBasin").trim(),
        x,
        y,
        z,
        partition_id: Number.isFinite(partitionId) ? Math.trunc(partitionId) : 0
      };
    }).filter((row) => row.name && [row.x, row.y, row.z].every(Number.isFinite) && row.z !== 0);
    return { ok: true, presets, path: TELEPORT_PRESETS_PATH };
  } catch (error) {
    return { ok: false, presets: [], path: TELEPORT_PRESETS_PATH, error: error.message };
  }
}

function resolveTeleportZ(payload, configValue) {
  const raw = String(payload.z ?? "").trim();
  const z = Number(raw);
  if (raw !== "" && Number.isFinite(z) && z !== 0) return { z, warning: "" };
  throw new Error("Teleport Z/elevation is required. Map clicks provide X/Y only; enter a verified Z, choose a location preset, or use Teleport to Player.");
}

function liveMapTeleportRequest(payload, options = {}) {
  const cfg = loadConfig();
  const playerId = String(payload.playerId || "").trim();
  const characterName = String(payload.characterName || payload.name || "").trim();
  const x = Number(payload.x);
  const y = Number(payload.y);
  const zInfo = resolveTeleportZ(payload, cfg);
  const z = zInfo.z;
  const partitionId = Number(payload.partition_id ?? payload.partitionId ?? 0);
  const map = String(payload.map || "HaggaBasin").trim();
  if (!playerId) throw new Error("Choose or enter a player/controller id first.");
  if (playerId.length > 128 || !/^[A-Za-z0-9_:.+\-# @]+$/.test(playerId)) throw new Error("Player/controller id contains unsupported characters.");
  if (![x, y, z].every(Number.isFinite)) throw new Error("Teleport coordinates must be numeric.");
  if (!Number.isFinite(partitionId) || partitionId < 0) throw new Error("Partition ID must be a non-negative number when provided.");
  const commandTemplate = effectiveTeleportCommandTemplate(cfg.teleportCommandTemplate);
  const command = commandTemplate ? renderTeleportTemplate(commandTemplate, {
    playerId,
    characterName,
    x,
    y,
    z,
    map,
    partitionId: Math.trunc(partitionId)
  }) : `TeleportToExact ${playerId} ${x} ${y} ${z}`;
  const values = {
    playerId: jsonPathEscape(playerId),
    characterName: jsonPathEscape(characterName),
    x,
    y,
    z,
    partitionId: Math.trunc(partitionId),
    map: jsonPathEscape(map),
    command: jsonPathEscape(command),
    dryRun: options.dryRun === true ? "true" : "false",
    test: options.test === true ? "true" : "false"
  };
  const rendered = renderTeleportTemplate(cfg.teleportPayloadTemplate || defaultConfig.teleportPayloadTemplate, values);
  let requestPayload;
  try { requestPayload = JSON.parse(rendered); }
  catch (error) { throw new Error(`Teleport HTTP JSON payload template rendered invalid JSON: ${error.message}`); }
  return {
    endpoint: teleportReceiverUrl(cfg),
    command,
    request: requestPayload,
    warning: zInfo.warning
  };
}

async function liveMapTeleportStatus() {
  const cfg = loadConfig();
  const availability = await liveGiveServerAvailability();
  const receiver = await receiverStatus();
  const hookConfigured = Boolean(String(cfg.teleportEndpointPath || "").trim() && String(cfg.teleportPayloadTemplate || "").trim());
  const receiverTeleport = receiver?.health?.config?.teleport || {};
  const receiverLiveTeleportEnabled = receiverTeleport.liveTeleportEnabled !== false;
  const receiverTeleportSupported = receiverTeleport.teleportSupported !== false;
  const reasons = [];
  if (!availability.online) reasons.push("Server is not online.");
  if (!receiver.ok) reasons.push(`Receiver is not reachable at ${receiver.healthUrl}.`);
  if (!cfg.liveTeleportEnabled) reasons.push("Receiver live teleport is disabled. Set DUNE_RECEIVER_LIVE_TELEPORT_ENABLED=true to allow live teleport.");
  if (receiver.ok && receiverTeleport.liveTeleportEnabled === false) reasons.push("Receiver live teleport is disabled. Set DUNE_RECEIVER_LIVE_TELEPORT_ENABLED=true to allow live teleport.");
  if (!hookConfigured) reasons.push("Teleport endpoint/payload is not configured.");
  if (receiver.ok && receiverTeleport.teleportSupported === false) reasons.push("Receiver does not support live teleport.");
  return {
    ok: true,
    canTeleport: availability.online && receiver.ok && Boolean(cfg.liveTeleportEnabled) && receiverLiveTeleportEnabled && hookConfigured && receiverTeleportSupported,
    serverHealthy: availability.online,
    receiverReachable: receiver.ok,
    liveTeleportEnabled: Boolean(cfg.liveTeleportEnabled),
    receiverLiveTeleportEnabled,
    hookConfigured,
    receiverTeleportSupported,
    endpoint: teleportReceiverUrl(cfg),
    reasons
  };
}

async function liveMapTeleportExecute(payload) {
  const status = await liveMapTeleportStatus();
  const preview = liveMapTeleportRequest(payload, { dryRun: false, test: false });
  if (!status.serverHealthy) return { ok: false, status: "blocked", error: "Server is not online.", ...preview, readiness: status };
  if (!status.receiverReachable) return { ok: false, status: "blocked", error: "Receiver offline.", ...preview, readiness: status };
  if (!status.liveTeleportEnabled) return { ok: false, status: "blocked", error: "Receiver live teleport is disabled. Set DUNE_RECEIVER_LIVE_TELEPORT_ENABLED=true to allow live teleport.", ...preview, readiness: status };
  if (!status.receiverLiveTeleportEnabled) return { ok: false, status: "blocked", error: "Receiver live teleport is disabled. Set DUNE_RECEIVER_LIVE_TELEPORT_ENABLED=true to allow live teleport.", ...preview, readiness: status };
  if (!status.hookConfigured) return { ok: false, status: "blocked", error: "Teleport endpoint/payload is not configured.", ...preview, readiness: status };
  if (!status.receiverTeleportSupported) return { ok: false, status: "blocked", error: "Receiver does not support live teleport.", ...preview, readiness: status };
  appendAdminAudit("teleport_requested", {
    endpoint: preview.endpoint,
    authHeaderPresent: Boolean(receiverHttpAuthToken(loadConfig())),
    authTokenSource: receiverHttpAuthSource(loadConfig()),
    playerId: preview.request.playerId,
    characterName: preview.request.characterName,
    x: preview.request.x,
    y: preview.request.y,
    z: preview.request.z,
    map: preview.request.map
  });
  const cfg = loadConfig();
  const authToken = receiverHttpAuthToken(cfg);
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  try {
    const response = await httpRequestJson(preview.endpoint, {
      method: "POST",
      headers,
      body: preview.request,
      timeout: 10000
    });
    const failedStatus = response.data?.status || `http-${response.statusCode}`;
    if (!response.ok || response.data?.ok !== true) {
      const message = response.data?.message || response.data?.error || response.text || `Receiver returned ${response.statusCode}.`;
      appendAdminAudit("teleport_failed", { endpoint: preview.endpoint, status: failedStatus, message });
      return { ok: false, status: failedStatus, error: message, response: response.data, httpStatus: response.statusCode, ...preview, readiness: status };
    }
    appendAdminAudit("teleport_sent_to_rmq", { endpoint: preview.endpoint, response: response.data });
    return { ok: true, status: response.data?.status || "sent_to_rmq", message: response.data?.message || "Teleport command sent. Verify in game.", response: response.data, httpStatus: response.statusCode, ...preview, readiness: status };
  } catch (error) {
    appendAdminAudit("teleport_failed", { endpoint: preview.endpoint, error: error.message });
    return { ok: false, status: "failed", error: error.message, ...preview, readiness: status };
  }
}

function playerDiagnosticLines(diagnostics) {
  const lines = [
    `Server path: ${diagnostics.serverPath || "Not configured"}`,
    `SSH target: ${diagnostics.sshTarget || "Not configured"}`,
    `Source table used: ${diagnostics.sourceTableUsed || "Auto-detect fallback"}`,
    `Join path used: ${diagnostics.joinPathUsed || "No join path selected"}`,
    `Character names resolved: ${diagnostics.characterNamesResolved || 0}`,
    `Sources checked: ${diagnostics.sourcesChecked.length}`,
    `Players found: ${diagnostics.playersFound}`
  ];
  if (diagnostics.filesChecked.length) {
    lines.push(`Files/logs checked: ${diagnostics.filesChecked.join(", ")}`);
  } else {
    lines.push("Files/logs checked: none; current player discovery uses the Dune database.");
  }
  for (const source of diagnostics.sourcesChecked.slice(0, 10)) {
    const status = source.ok ? `${source.rows} row(s)` : `error: ${source.error || "unknown"}`;
    const resolved = typeof source.resolvedNames === "number" ? `, resolved=${source.resolvedNames}` : "";
    const join = source.joinPath ? `, join=${source.joinPath}` : "";
    lines.push(`${source.source} [id=${source.idColumn}, name=${source.nameColumn}${resolved}${join}] -> ${status}`);
  }
  if (diagnostics.sourcesChecked.length > 10) {
    lines.push(`...${diagnostics.sourcesChecked.length - 10} more source(s) checked.`);
  }
  if (diagnostics.reason) lines.push(`Reason: ${diagnostics.reason}`);
  for (const error of diagnostics.errors.slice(0, 5)) lines.push(`Parse/check error: ${error}`);
  return lines;
}

async function liveGiveServerAvailability() {
  const vm = await vmInfo();
  let status = null;
  let raw = "";
  const canCheckBattlegroup = Boolean((vm.exists && vm.state === "Running") || VM_IP);
  if (canCheckBattlegroup) {
    const result = await battlegroup("status");
    raw = result.stdout || result.stderr || result.error || "";
    status = parseStatus(raw);
  }
  const online = Boolean(statusSummaryIsOnline(status?.summary));
  return { online, vm, status: status?.summary || null, raw };
}

async function adminGiveItem(payload) {
  const command = validateGiveItemPayload(payload);
  const mode = String(payload?.mode || "dry-run").toLowerCase();
  const auditBase = {
    playerId: command.playerId,
    template: command.template,
    qty: command.qty,
    quality: command.quality,
    requestId: command.requestId
  };
  const server = await liveGiveServerAvailability();
  await updateRuntimeGiveTransport({ vm: server.vm, status: { summary: server.status }, raw: server.raw }, "give-item");
  if (!server.online) {
    const error = new Error("Server is offline. Start the server before using Give Item.");
    appendAdminAudit("give_item_blocked", { ...auditBase, mode, reason: error.message, server });
    throw error;
  }
  if (mode !== "execute") {
    const result = {
      ok: true,
      dryRun: true,
      status: "dry-run-passed",
      command,
      requestId: command.requestId,
      stdout: `Dry-run passed. Command validated for ${command.template} x${command.qty} -> ${command.playerId}.`,
      stderr: "",
      note: "Dry-run validated the command while the server was online. No live grant was executed."
    };
    appendAdminAudit("give_item_dry_run", { ...auditBase, result: { ok: result.ok, status: result.status } });
    return result;
  }
  if (payload?.confirmed !== true && payload?.confirmed !== "true") {
    const error = new Error("Confirm real Live Give execution before sending the command.");
    appendAdminAudit("give_item_live_blocked", { ...auditBase, reason: error.message });
    throw error;
  }
  const transport = await checkGiveTransport();
  if (!transport.configured || !transport.reachable) {
    const result = { ok: false, dryRun: false, status: "live-unavailable", command, transport: transport.mode, missingEnv: transport.missingEnv || [], stdout: "", stderr: liveGiveUnavailableMessage(transport), error: liveGiveUnavailableMessage(transport) };
    appendAdminAudit("give_item_live_unavailable", { ...auditBase, result: { ok: result.ok, status: result.status, transport: result.transport, missingEnv: result.missingEnv, error: result.error } });
    return result;
  }
  appendAdminAudit("give_item_live_started", { ...auditBase, server: server.status });
  try {
    const live = await sendLiveGiveItem(command, transport);
    if (live.status === "live-unavailable") {
      const result = { ...live, ok: false, dryRun: false, stdout: "", stderr: live.error || "Live Give unavailable." };
      appendAdminAudit("give_item_live_unavailable", { ...auditBase, result: { ok: result.ok, status: result.status, transport: result.transport, missingEnv: result.missingEnv || [], error: result.error || result.stderr } });
      return result;
    }
    if (!live.ok || live.dryRun) {
      const result = { ...live, ok: false, dryRun: false, status: "live-execution-failed", stdout: "", stderr: live.error || "Live execution failed." };
      appendAdminAudit("give_item_live_failed", { ...auditBase, result: { ok: result.ok, status: result.status, error: result.error || result.stderr } });
      return result;
    }
    if (live.status === "live-verified") {
      const result = { ...live, dryRun: false, status: "live-verified", stderr: "" };
      appendAdminAudit("give_item_live_verified", { ...auditBase, result: { ok: result.ok, status: result.status, transport: result.transport, response: result.response || null } });
      return result;
    }
    const result = { ...live, dryRun: false, status: "live-published", stderr: "" };
    appendAdminAudit("give_item_live_published", { ...auditBase, result: { ok: result.ok, status: result.status, transport: result.transport, response: result.response || null } });
    return result;
  } catch (error) {
    appendAdminAudit("give_item_live_failed", { ...auditBase, error: error.message });
    throw error;
  }
}

function sqlString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function requireInteger(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${name} must be a whole number.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return number;
}

function optionalInteger(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return requireInteger(value, name, min, max);
}

function requireReal(value, name, min = 0, max = 1000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return number;
}

function requireConfirmed(value) {
  if (value !== true && value !== "true" && value !== 1 && value !== "1") {
    throw new Error("Confirm the exact function call before running this permission action.");
  }
}

function appendAdminAudit(action, payload) {
  const entry = {
    at: new Date().toISOString(),
    ...payload,
    action
  };
  fs.mkdirSync(path.dirname(ADMIN_AUDIT_LOG), { recursive: true });
  fs.appendFileSync(ADMIN_AUDIT_LOG, `${JSON.stringify(entry)}\n`, "utf8");
}

async function adminPermissions(playerControllerIdValue) {
  const playerControllerId = optionalInteger(playerControllerIdValue, "player_controller_id", 0);
  const selectedWhere = playerControllerId === null ? "" : `where gm.player_id = ${playerControllerId}`;
  const rankWhere = playerControllerId === null ? "" : `where par.player_id = ${playerControllerId}`;
  const accessWhere = playerControllerId === null ? "" : `where pac.account_id in (select account_id from dune.player_state where player_controller_id = ${playerControllerId})`;
  const sql = `
    select
      'guild' as row_type,
      gm.player_id::text,
      gm.guild_id::text,
      gm.role_id::text,
      coalesce(ps.account_id::text, ''),
      coalesce(ps.character_name, ''),
      coalesce(ac.funcom_id, ac.user, ''),
      case when gm.role_id = 100 then 'true' else 'false' end
    from dune.guild_members gm
    left join dune.player_state ps on ps.player_controller_id = gm.player_id
    left join dune.accounts ac on ac.id = ps.account_id
    ${selectedWhere}
    order by gm.guild_id, gm.role_id desc, gm.player_id
    limit 300;

    select
      'actor_rank' as row_type,
      par.player_id::text,
      par.permission_actor_id::text,
      par.rank::text,
      coalesce(pa.actor_name, ''),
      coalesce(pa.actor_type::text, ''),
      coalesce(pa.access_level::text, '')
    from dune.permission_actor_rank par
    left join dune.permission_actor pa on pa.actor_id = par.permission_actor_id
    ${rankWhere}
    order by par.permission_actor_id, par.player_id
    limit 300;

    select
      'access_code' as row_type,
      pac.account_id::text,
      pac.access_code::text,
      pac.access_code_type::text,
      pac.is_resettable::text
    from dune.player_access_codes pac
    ${accessWhere}
    order by pac.account_id, pac.access_code_type, pac.access_code
    limit 300;
  `;
  const output = await dbQuery(sql);
  const guildMembers = [];
  const objectPermissions = [];
  const accessCodes = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    if (parts[0] === "guild") {
      guildMembers.push({
        player_id: parts[1] || "",
        guild_id: parts[2] || "",
        role_id: parts[3] || "",
        account_id: parts[4] || "",
        character_name: parts[5] || "",
        funcom_id: parts[6] || "",
        is_guild_admin: /^true$/i.test(parts[7] || "")
      });
    } else if (parts[0] === "actor_rank") {
      objectPermissions.push({
        player_id: parts[1] || "",
        actor_id: parts[2] || "",
        rank: parts[3] || "",
        actor_name: parts[4] || "",
        actor_type: parts[5] || "",
        access_level: parts[6] || ""
      });
    } else if (parts[0] === "access_code") {
      accessCodes.push({
        account_id: parts[1] || "",
        access_code: parts[2] || "",
        access_code_type: parts[3] || "",
        is_resettable: parts[4] || ""
      });
    }
  }
  return {
    ok: true,
    playerControllerId: playerControllerId === null ? "" : String(playerControllerId),
    guildMembers,
    objectPermissions,
    accessCodes,
    isGuildAdmin: guildMembers.some((row) => row.is_guild_admin),
    diagnostics: {
      sourceTables: ["dune.guild_members", "dune.permission_actor_rank", "dune.permission_actor", "dune.player_access_codes", "dune.player_state", "dune.accounts"],
      selectedPlayerControllerId: playerControllerId === null ? "" : String(playerControllerId),
      guildMembersFound: guildMembers.length,
      objectPermissionsFound: objectPermissions.length,
      accessCodesFound: accessCodes.length,
      writePolicy: "Writes call confirmed Dune functions only; no direct permission table insert/update."
    }
  };
}

function previewPermissionRankCall(payload) {
  const actorId = requireInteger(payload.actorId, "actor_id", 0);
  const playerControllerId = requireInteger(payload.playerControllerId, "player_controller_id", 0);
  const rank = requireInteger(payload.rank, "rank", 0, 100);
  const mapId = String(payload.mapId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(mapId)) throw new Error("map_id must use letters, numbers, underscore, or dash.");
  return {
    actorId,
    playerControllerId,
    rank,
    mapId,
    sql: `select dune.permission_set_player_rank(${actorId}, ${playerControllerId}, ${rank}, ${sqlString(mapId)});`
  };
}

async function adminSetPermissionRank(payload) {
  const call = previewPermissionRankCall(payload || {});
  requireConfirmed(payload?.confirmed);
  await dbQuery(call.sql);
  return {
    ok: true,
    action: "permission_set_player_rank",
    sql: call.sql,
    message: "Object permission rank function executed."
  };
}

function previewAccessCodeCall(payload) {
  const accountId = requireInteger(payload.accountId, "account_id", 0);
  const accessCode = requireInteger(payload.accessCode, "access_code", 0, 2147483647);
  const accessCodeType = requireInteger(payload.accessCodeType, "access_code_type", 0, 2147483647);
  const isResettable = payload.isResettable === true || payload.isResettable === "true" || payload.isResettable === 1 || payload.isResettable === "1";
  return {
    accountId,
    accessCode,
    accessCodeType,
    isResettable,
    sql: `select dune.create_server_player_access_codes(${accountId}, ${accessCode}, ${accessCodeType}, ${isResettable ? "true" : "false"});`
  };
}

async function adminCreateAccessCode(payload) {
  const call = previewAccessCodeCall(payload || {});
  requireConfirmed(payload?.confirmed);
  await dbQuery(call.sql);
  return {
    ok: true,
    action: "create_server_player_access_codes",
    sql: call.sql,
    message: "Access code function executed."
  };
}

// Legacy progression helpers are intentionally kept out of the active UI/API.
// Phase 1 uses /api/progression/inspect for read-only metadata discovery only.
const SPECIALIZATION_TRACKS = ["Crafting", "Gathering", "Exploration", "Combat", "Sabotage"];

function requireTrack(value) {
  const clean = String(value || "").trim();
  if (!SPECIALIZATION_TRACKS.includes(clean)) {
    throw new Error(`Track must be one of: ${SPECIALIZATION_TRACKS.join(", ")}.`);
  }
  return clean;
}

async function adminSkillReputation(playerControllerIdValue) {
  const playerControllerId = optionalInteger(playerControllerIdValue, "player_controller_id", 0);
  const trackWhere = playerControllerId === null ? "" : `where st.player_id = ${playerControllerId}`;
  const repWhere = playerControllerId === null ? "" : `where pfr.actor_id = ${playerControllerId}`;
  const factionWhere = playerControllerId === null ? "" : `where pf.actor_id = ${playerControllerId}`;
  const sql = `
    select 'track', st.player_id::text, st.track_type::text, st.xp_amount::text, st.level::text
    from dune.specialization_tracks st
    ${trackWhere}
    order by st.player_id, st.track_type;

    select 'reputation', pfr.actor_id::text, pfr.faction_id::text, coalesce(f.name, ''), pfr.reputation_amount::text
    from dune.player_faction_reputation pfr
    left join dune.factions f on f.id = pfr.faction_id
    ${repWhere}
    order by pfr.actor_id, pfr.faction_id;

    select 'current_faction', pf.actor_id::text, pf.faction_id::text, coalesce(f.name, ''), coalesce(pf.utc_time_faction_change::text, '')
    from dune.player_faction pf
    left join dune.factions f on f.id = pf.faction_id
    ${factionWhere}
    order by pf.actor_id;

    select 'faction', id::text, name, '', '' from dune.factions order by id;
  `;
  const output = await dbQuery(sql);
  const tracks = [];
  const reputation = [];
  const currentFactions = [];
  const factions = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    if (parts[0] === "track") {
      tracks.push({ player_id: parts[1] || "", track_type: parts[2] || "", xp_amount: parts[3] || "0", level: parts[4] || "0" });
    } else if (parts[0] === "reputation") {
      reputation.push({ actor_id: parts[1] || "", faction_id: parts[2] || "", faction_name: parts[3] || "", reputation_amount: parts[4] || "0" });
    } else if (parts[0] === "current_faction") {
      currentFactions.push({ actor_id: parts[1] || "", faction_id: parts[2] || "", faction_name: parts[3] || "", changed_at: parts[4] || "" });
    } else if (parts[0] === "faction") {
      factions.push({ id: parts[1] || "", name: parts[2] || "" });
    }
  }
  return {
    ok: true,
    playerControllerId: playerControllerId === null ? "" : String(playerControllerId),
    availableTracks: SPECIALIZATION_TRACKS,
    tracks,
    reputation,
    currentFactions,
    factions,
    warning: "Live pickup is not confirmed for specialization XP/level or reputation. A player relog or server restart may be required."
  };
}

async function currentTrackRow(playerControllerId, track) {
  const sql = `
    select xp_amount::text, level::text
    from dune.specialization_tracks
    where player_id = ${playerControllerId}
      and track_type = ${sqlString(track)}::dune.specializationtracktype
  `;
  const output = await dbQuery(sql);
  if (!output) return null;
  const [xp = "0", level = "0"] = output.split(/\t/);
  return { xp_amount: Number(xp) || 0, level: Number(level) || 0 };
}

function specializationCall(playerControllerId, track, xpAmount, level) {
  return `select dune.set_specialization_xp_and_level(${playerControllerId}, ${sqlString(track)}::dune.specializationtracktype, ${xpAmount}, ${level});`;
}

async function adminSpecializationAction(payload, mode) {
  const playerControllerId = requireInteger(payload?.playerControllerId, "player_controller_id", 0);
  const track = requireTrack(payload?.trackType);
  const previous = await currentTrackRow(playerControllerId, track);
  const amount = requireInteger(payload?.xpAmount, mode === "add" ? "xp_to_add" : "xp_amount", 0, 2147483647);
  const levelInput = payload?.level === undefined || payload?.level === null || String(payload.level).trim() === "" ? null : requireReal(payload.level, "level", 0, 1000);
  const nextXp = mode === "add" ? (previous?.xp_amount || 0) + amount : amount;
  const nextLevel = levelInput === null ? (previous?.level || 0) : levelInput;
  const sql = specializationCall(playerControllerId, track, nextXp, nextLevel);
  requireConfirmed(payload?.confirmed);
  await dbQuery(sql);
  const result = {
    ok: true,
    action: mode === "add" ? "give_skill_points" : "set_skill_points",
    sql,
    previous,
    next: { xp_amount: nextXp, level: nextLevel },
    rollbackSql: previous
      ? specializationCall(playerControllerId, track, previous.xp_amount, previous.level)
      : `delete from dune.specialization_tracks where player_id = ${playerControllerId} and track_type = ${sqlString(track)}::dune.specializationtracktype;`,
    warning: "Live pickup is not confirmed. Player relog or server restart may be required."
  };
  appendAdminAudit(result.action, { playerControllerId, track, previous, next: result.next, sql, rollbackSql: result.rollbackSql });
  return result;
}

async function currentReputationRow(playerControllerId, factionId) {
  const sql = `
    select reputation_amount::text
    from dune.player_faction_reputation
    where actor_id = ${playerControllerId}
      and faction_id = ${factionId}
  `;
  const output = await dbQuery(sql);
  if (!output) return null;
  return { reputation_amount: Number(output.trim()) || 0 };
}

function reputationCall(playerControllerId, factionId, amount) {
  return `select dune.set_player_faction_reputation(${playerControllerId}, ${factionId}, ${amount});`;
}

async function adminReputationAction(payload, mode) {
  const playerControllerId = requireInteger(payload?.playerControllerId, "player_controller_id", 0);
  const factionId = requireInteger(payload?.factionId, "faction_id", 1, 32767);
  const previous = await currentReputationRow(playerControllerId, factionId);
  const amount = mode === "add"
    ? requireInteger(payload?.reputationAmount, "reputation_to_add", 0, 2147483647)
    : requireInteger(payload?.reputationAmount, "reputation_amount", 0, 2147483647);
  const nextAmount = mode === "add" ? (previous?.reputation_amount || 0) + amount : amount;
  const sql = reputationCall(playerControllerId, factionId, nextAmount);
  requireConfirmed(payload?.confirmed);
  await dbQuery(sql);
  const result = {
    ok: true,
    action: mode === "add" ? "add_reputation" : "set_reputation",
    sql,
    previous,
    next: { reputation_amount: nextAmount },
    rollbackSql: previous
      ? reputationCall(playerControllerId, factionId, previous.reputation_amount)
      : `delete from dune.player_faction_reputation where actor_id = ${playerControllerId} and faction_id = ${factionId};`,
    warning: "Live pickup is not confirmed. Player relog or server restart may be required."
  };
  appendAdminAudit(result.action, { playerControllerId, factionId, previous, next: result.next, sql, rollbackSql: result.rollbackSql });
  return result;
}

async function adminTunedChannels() {
  const sql = `
    select
      coalesce(p.account_id::text, c.account_id::text) as account_id,
      coalesce(p.selected_channel_name::text, '') as selected_channel,
      coalesce(c.channel_name::text, '') as channel_name,
      coalesce(c.is_tuned::text, '') as is_tuned
    from dune.communinet_player p
    full outer join dune.communinet_player_channels c on c.account_id = p.account_id
    order by account_id, channel_name
    limit 300
  `;
  const output = await dbQuery(sql);
  const rows = output ? output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [accountId = "", selectedChannel = "", channelName = "", isTuned = ""] = line.split("\t");
    return { accountId, selectedChannel, channelName, isTuned };
  }) : [];
  return { ok: true, rows };
}

function logLiveGiveStartupValidation() {
  const config = giveTransportConfig();
  const selected = transportDisplayName(config.mode);
  const missing = config.missingEnv || [];
  console.log(`Live give-item transport: ${selected}`);
  if (config.configured) {
    console.log("Live give-item env: configured");
    return;
  }
  if (missing.length) {
    console.log(`Live give-item dry-run: missing ${missing.map((name) => LIVE_GIVE_SECRET_ENV_NAMES.has(name) ? `${name}=<secret missing>` : name).join(", ")}`);
    return;
  }
  console.log(`Live give-item dry-run: ${config.reason || "transport is not configured"}`);
}

function attemptConfiguredServerStart(source = "startup") {
  const readiness = serverControlConfigured();
  if (runtimeGiveTransport.serverOnline) return;
  if (!readiness.configured) {
    appendAdminAudit("server_start_skipped", {
      source,
      reason: readiness.reason,
      config: readiness.summary
    });
    return;
  }
  appendAdminAudit("server_start_requested", {
    source,
    config: readiness.summary
  });
  battlegroup("start").then((result) => {
    appendAdminAudit(result.ok ? "server_start_request_completed" : "server_start_request_failed", {
      source,
      ok: Boolean(result.ok),
      skipped: Boolean(result.skipped),
      error: result.error || result.stderr || ""
    });
  }).catch((error) => {
    appendAdminAudit("server_start_request_failed", {
      source,
      ok: false,
      error: error.message
    });
  });
}

async function directorUrl() {
  const info = await vmInfo();
  if (!info.exists || info.state !== "Running" || !info.ip) return { ok: false, error: "VM is not running or has no IP." };
  const result = await sshCommand("sudo kubectl get svc -A -o jsonpath='{.items[*].spec.ports[?(@.port==11717)].nodePort}' 2>&1", 30000);
  const port = (result.stdout || "").trim();
  if (!/^\d+$/.test(port)) return { ok: false, error: result.stdout || result.stderr || "Could not find director port." };
  lastDirectorUrl = `http://${info.ip}:${port}`;
  return { ok: true, url: lastDirectorUrl };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html";
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webp") return "image/webp";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeExecutablePath(value) {
  let executable = unquoteEnvValue(value).trim();
  executable = executable.replace(/^\uFEFF/, "");
  executable = unquoteEnvValue(executable).trim();
  if (process.platform === "win32") {
    executable = executable.replace(/\//g, "\\");
  }
  if (!executable) return "";
  return path.normalize(executable);
}

function readEnvValue(filePath, name) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === name) return normalizeExecutablePath(expandEnvPath(match[2]));
  }
  return "";
}

function envFilesByName(fileName) {
  return [
    APPDATA_DIR ? path.join(APPDATA_DIR, fileName) : "",
    path.join(__dirname, fileName)
  ].filter(Boolean);
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5000
  });
  return !result.error && result.status === 0;
}

function configuredPythonPath() {
  for (const filePath of envFilesByName(".env.local")) {
    const pythonPath = readEnvValue(filePath, "PYTHON_PATH");
    if (pythonPath) return { command: pythonPath, source: filePath };
  }
  for (const filePath of envFilesByName(".env")) {
    const pythonPath = readEnvValue(filePath, "PYTHON_PATH");
    if (pythonPath) return { command: pythonPath, source: filePath };
  }
  return null;
}

function findPython() {
  const configured = configuredPythonPath();
  if (configured) {
    const exists = fs.existsSync(configured.command);
    console.log(`Manager service PYTHON_PATH: ${configured.command} (${configured.source}) exists=${exists}`);
    if (exists || isWindowsAppsAlias(configured.command)) {
      return { command: configured.command, source: `PYTHON_PATH from ${configured.source}`, exists };
    }
    console.warn(`Configured PYTHON_PATH was not found: ${configured.command} (${configured.source})`);
  }
  if (commandAvailable("python")) return { command: "python", source: "PATH", exists: true };
  if (commandAvailable("py")) return { command: "py", source: "PATH", exists: true };
  return null;
}

function isWindowsAppsAlias(command) {
  return process.platform === "win32" && /\\WindowsApps\\/i.test(String(command || ""));
}

function managerSpawnDetails(resolved, args, useShell, reason = "") {
  const executable = resolved?.command || "";
  return {
    reason,
    command: executable,
    source: resolved?.source || "",
    cwd: MANAGER_DIR,
    args,
    shell: Boolean(useShell),
    executableExists: executable ? fs.existsSync(executable) : false,
    isWindowsAppsAlias: isWindowsAppsAlias(executable),
    ComSpec: process.env.ComSpec || "",
    SystemRoot: process.env.SystemRoot || "",
    PATH: process.env.PATH || "",
    PYTHONPATH: process.env.PYTHONPATH || ""
  };
}

function logManagerSpawnDetails(details) {
  const attempts = Array.isArray(managerSpawnDiagnostics?.attempts) ? managerSpawnDiagnostics.attempts : [];
  managerSpawnDiagnostics = { ...details, attempts: [...attempts, details] };
  console.log(`Manager service spawn diagnostics: ${JSON.stringify(details)}`);
}

function managerErrorPayload(error) {
  return {
    ok: false,
    error: error || managerFallbackWarning(),
    spawnDiagnostics: managerSpawnDiagnostics
  };
}

function logPythonResolution(resolved) {
  const message = resolved
    ? `Manager service Python command resolved: ${resolved.command} (${resolved.source}) exists=${resolved.exists}`
    : "Manager service warning: Python was not found. Set PYTHON_PATH in .env.local or install python/py.";
  if (message === loggedPythonCommand) return;
  loggedPythonCommand = message;
  console.log(message);
}

function defaultManagerConfig() {
  const sshKeyPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "DuneAwakeningServer", "sshKey") : "";
  return { vmIp: "", sshKeyPath, battlegroup: "" };
}

function readManagerConfigFallback() {
  const config = defaultManagerConfig();
  if (!fs.existsSync(MANAGER_CONFIG_PATH)) return config;
  try {
    const saved = JSON.parse(fs.readFileSync(MANAGER_CONFIG_PATH, "utf8"));
    if (saved && typeof saved === "object") {
      for (const key of Object.keys(config)) {
        if (Object.prototype.hasOwnProperty.call(saved, key)) config[key] = String(saved[key] || "").trim();
      }
    }
  } catch {}
  return config;
}

function writeManagerConfigFallback(payload) {
  const config = readManagerConfigFallback();
  for (const key of ["vmIp", "sshKeyPath", "battlegroup"]) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, key)) config[key] = String(payload[key] || "").trim();
  }
  fs.mkdirSync(MANAGER_DATA_DIR, { recursive: true });
  fs.writeFileSync(MANAGER_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  return config;
}

function managerFallbackWarning() {
  return managerStartError || "Manager service is unavailable because Python was not found.";
}

async function handleManagerFallback(req, res, managerPath) {
  if (managerPath === "/api/server/config" && req.method === "GET") {
    await json(res, { config: readManagerConfigFallback(), configFile: MANAGER_CONFIG_PATH, warning: managerFallbackWarning(), spawnDiagnostics: managerSpawnDiagnostics });
    return true;
  }
  if (managerPath === "/api/server/config" && req.method === "POST") {
    try {
      const config = writeManagerConfigFallback(JSON.parse(await readBody(req) || "{}"));
      await json(res, { ok: true, config, configFile: MANAGER_CONFIG_PATH, warning: managerFallbackWarning(), spawnDiagnostics: managerSpawnDiagnostics });
    } catch {
      await json(res, { ok: false, error: "Invalid server setup payload" }, 400);
    }
    return true;
  }
  if (managerPath === "/api/server/discover" && req.method === "GET") {
    await json(res, managerErrorPayload(`Battlegroup discovery could not start the manager service. ${managerFallbackWarning()}`), 502);
    return true;
  }
  if (managerPath === "/api/server/settings" && req.method === "GET") {
    let payload = { profileName: "No applied profile", settings: {} };
    try {
      if (fs.existsSync(MANAGER_APPLIED_PROFILE_PATH)) payload = JSON.parse(fs.readFileSync(MANAGER_APPLIED_PROFILE_PATH, "utf8"));
    } catch {}
    await json(res, { ...payload, warning: managerFallbackWarning(), spawnDiagnostics: managerSpawnDiagnostics });
    return true;
  }
  if (managerPath === "/api/server/settings" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req) || "{}");
      const flatSettings = {};
      for (const [sectionName, sectionSettings] of Object.entries(payload.settings || {})) {
        if (!sectionSettings || typeof sectionSettings !== "object" || Array.isArray(sectionSettings)) continue;
        for (const [key, value] of Object.entries(sectionSettings)) flatSettings[`${sectionName}.${key}`] = value;
      }
      fs.mkdirSync(MANAGER_DATA_DIR, { recursive: true });
      fs.writeFileSync(MANAGER_APPLIED_PROFILE_PATH, JSON.stringify(payload, null, 2), "utf8");
      fs.writeFileSync(MANAGER_APPLIED_SETTINGS_PATH, JSON.stringify(flatSettings, null, 2), "utf8");
      await json(res, {
        ok: true,
        message: "Settings saved locally. Install Python or set PYTHON_PATH to apply them to the server.",
        profileFile: MANAGER_APPLIED_PROFILE_PATH,
        settingsFile: MANAGER_APPLIED_SETTINGS_PATH,
        settingCount: Object.keys(flatSettings).length,
        warning: managerFallbackWarning(),
        spawnDiagnostics: managerSpawnDiagnostics
      });
    } catch {
      await json(res, { ok: false, error: "Invalid JSON payload" }, 400);
    }
    return true;
  }
  return false;
}

function safeFile(baseDir, requestPath) {
  const relative = decodeURIComponent(requestPath).replace(/^\/+/, "") || "index.html";
  const fullPath = path.join(baseDir, relative);
  const resolvedBase = path.resolve(baseDir);
  const resolvedFull = path.resolve(fullPath);
  if (!resolvedFull.startsWith(resolvedBase)) return null;
  return resolvedFull;
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(body);
}

async function json(res, body, status = 200) {
  send(res, status, "application/json", JSON.stringify(body));
}

function serveStatic(res, baseDir, requestPath) {
  const filePath = safeFile(baseDir, requestPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath), "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function managerUnavailableHtml(reason) {
  const safeReason = String(reason || "Manager service not running").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Server Manager unavailable</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background:#080a0d; color:#f6d98a; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:linear-gradient(135deg,#080a0d,#17120a); }
    .panel { width:min(720px, calc(100vw - 48px)); border:1px solid rgba(214,166,69,.35); background:rgba(10,12,12,.88); padding:28px; box-shadow:0 18px 48px rgba(0,0,0,.45); }
    h1 { margin:0 0 12px; font-size:22px; letter-spacing:.08em; text-transform:uppercase; }
    .label { margin-top:18px; color:#bda764; font-size:11px; letter-spacing:.12em; text-transform:uppercase; }
    .reason { margin-top:8px; color:#f1e0ac; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
  </style>
</head>
<body>
  <main class="panel">
    <h1>Server Manager unavailable.</h1>
    <div class="label">Reason</div>
    <div class="reason">${safeReason}</div>
  </main>
</body>
</html>`;
}

function sendManagerUnavailable(res, reason, status = 503) {
  send(res, status, "text/html", managerUnavailableHtml(reason));
}

function startManagerService() {
  if (managerProcess) return;
  if (managerStartError) return;
  const resolved = findPython();
  logPythonResolution(resolved);
  if (!resolved) {
    managerStartError = "Manager service failed to start: Python was not found. Set PYTHON_PATH in .env.local or install python/py.";
    console.warn(managerStartError);
    return;
  }
  spawnManagerProcess(resolved, isWindowsAppsAlias(resolved.command), isWindowsAppsAlias(resolved.command) ? "WindowsApps alias requires shell fallback" : "direct spawn");
}

function spawnManagerProcess(resolved, useShell, reason) {
  const args = ["manager-server.py", "--no-open"];
  const details = managerSpawnDetails(resolved, args, useShell, reason);
  logManagerSpawnDetails(details);
  managerProcess = spawn(resolved.command, args, {
    cwd: MANAGER_DIR,
    shell: useShell,
    windowsHide: true,
    stdio: "ignore"
  });
  managerProcess.on("error", (error) => {
    if (error.code === "ENOENT" && !useShell && isWindowsAppsAlias(resolved.command)) {
      managerSpawnDiagnostics = { ...managerSpawnDiagnostics, errorCode: error.code || "", errorMessage: error.message || String(error) };
      console.warn(`Manager service direct spawn failed with ENOENT for ${resolved.command}; retrying with shell:true.`);
      managerProcess = null;
      spawnManagerProcess(resolved, true, "direct spawn ENOENT; retrying with shell:true");
      return;
    }
    managerSpawnDiagnostics = { ...managerSpawnDiagnostics, errorCode: error.code || "", errorMessage: error.message || String(error) };
    managerStartError = `Manager service failed to start with ${resolved.command}: ${error.message}`;
    console.error(managerStartError);
    managerProcess = null;
  });
  managerProcess.on("exit", () => { managerProcess = null; });
}

async function proxyToManager(req, res, pathname) {
  startManagerService();
  const managerPath = pathname.replace(/^\/manager-api/, "");
  if (managerStartError && await handleManagerFallback(req, res, managerPath)) return;
  const target = `http://127.0.0.1:${MANAGER_PORT}${managerPath}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  try {
    const response = await fetch(target, {
      method: req.method,
      headers: { "Content-Type": req.headers["content-type"] || "application/json" },
      body
    });
    const text = await response.text();
    res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8" });
    res.end(text);
  } catch (error) {
    if (await handleManagerFallback(req, res, managerPath)) return;
    await json(res, managerErrorPayload(managerStartError || `Manager service is not ready: ${error.message}`), 502);
  }
}

function appPage() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AlphaNine Dune Suite</title>
  <link rel="stylesheet" href="/vendor/leaflet/leaflet.css">
  <script src="/vendor/leaflet/leaflet.js"></script>
  <style>
    :root {
      --bg:#050603; --bg-2:#090b07; --panel:rgba(15,17,11,.92); --panel-2:rgba(27,24,14,.84);
      --glass:rgba(245,199,93,.055); --line:rgba(214,166,69,.46); --line-strong:rgba(240,201,106,.72); --line-blue:rgba(143,197,219,.45);
      --text:#eee5d2; --muted:#a99b77; --sand:#d0a44e; --gold:#d7a84c; --gold-bright:#f3cf73; --blue:#8fc5db;
      --good:#66d17a; --warn:#f0b95c; --bad:#ff6262; --shadow:0 28px 90px rgba(0,0,0,.62);
      --content-max:1812px; --panel-gap:12px; --panel-pad:18px; --panel-cut:14px; --panel-radius:0;
      --font-panel-label:10.5px; --font-panel-title:15.5px; --font-panel-body:12.5px; --font-panel-value:21px; --font-panel-subtle:11.5px; --font-button:12.5px; --font-table:12.5px;
      color-scheme:dark; font-family:"Rajdhani","Segoe UI",system-ui,sans-serif;
    }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--text); background:
      radial-gradient(circle at 75% 7%, rgba(214,166,69,.22), transparent 25%),
      radial-gradient(circle at 18% 0%, rgba(111,80,30,.24), transparent 28%),
      linear-gradient(160deg, #050603 0%, #0d0f08 48%, #060704 100%); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.2; background:
      linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px); background-size:42px 42px; }
    body::after { content:""; position:fixed; inset:0; pointer-events:none; opacity:.13; mix-blend-mode:screen; background:
      repeating-linear-gradient(0deg, rgba(255,255,255,.06) 0 1px, transparent 1px 4px),
      radial-gradient(circle at 86% 19%, rgba(240,201,106,.3), transparent 12%); }
    button, input, select { font:inherit; }
    button { cursor:pointer; }
    .shell { min-height:100vh; display:grid; grid-template-columns:300px minmax(0,1fr); }
    .sidebar { position:sticky; top:0; height:100vh; display:flex; flex-direction:column; overflow:hidden; box-sizing:border-box; padding:26px 18px; border-right:1px solid var(--line); background:
      linear-gradient(180deg, rgba(13,14,9,.98), rgba(4,6,4,.96)),
      radial-gradient(circle at 70% 12%, rgba(214,166,69,.16), transparent 30%); box-shadow:var(--shadow), inset -18px 0 40px rgba(0,0,0,.35); }
    .brand { flex:0 0 auto; position:relative; padding:22px 18px 28px; border:1px solid rgba(214,166,69,.26); background:linear-gradient(135deg, rgba(214,166,69,.09), rgba(255,255,255,.015)); clip-path:polygon(0 0, 88% 0, 100% 18px, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
    .brand::before { content:""; display:block; width:58px; height:58px; margin-bottom:14px; border:1px solid var(--line-strong); background:
      linear-gradient(30deg, transparent 45%, rgba(240,201,106,.65) 46% 54%, transparent 55%),
      radial-gradient(circle, rgba(240,201,106,.22), rgba(4,6,4,.65)); box-shadow:0 0 28px rgba(240,201,106,.18); }
    .brand h1 { margin:0; font-size:28px; line-height:.95; letter-spacing:.09em; text-transform:uppercase; color:var(--gold-bright); }
    .brand p { margin:9px 0 0; color:var(--sand); font-size:14px; text-transform:uppercase; letter-spacing:.18em; }
    .build-info { display:grid; gap:3px; margin-top:14px; padding-top:12px; border-top:1px solid rgba(214,166,69,.18); color:rgba(208,164,78,.72); font-size:11px; line-height:1.25; letter-spacing:.08em; text-transform:uppercase; }
    .build-info span { display:block; }
    .nav { flex:1 1 auto; min-height:0; display:grid; align-content:start; gap:5px; margin-top:18px; padding-right:7px; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; scrollbar-color:rgba(240,201,106,.58) rgba(5,7,5,.68); scrollbar-width:thin; }
    .nav::-webkit-scrollbar { width:9px; }
    .nav::-webkit-scrollbar-track { background:rgba(5,7,5,.68); border:1px solid rgba(214,166,69,.1); }
    .nav::-webkit-scrollbar-thumb { background:linear-gradient(180deg, rgba(240,201,106,.72), rgba(111,80,30,.74)); border:1px solid rgba(240,201,106,.34); }
    .nav::-webkit-scrollbar-thumb:hover { background:linear-gradient(180deg, rgba(255,222,129,.88), rgba(154,107,41,.82)); }
    .tab { width:100%; min-height:42px; display:flex; align-items:center; justify-content:flex-start; gap:10px; border:1px solid rgba(214,166,69,.08); border-radius:0; background:rgba(255,255,255,.01); color:var(--sand); text-align:left; text-transform:uppercase; letter-spacing:.055em; font-size:12px; line-height:1.2; font-weight:760; clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
    .tab::before { content:""; flex:0 0 auto; width:8px; height:8px; border:1px solid currentColor; transform:rotate(45deg); box-shadow:0 0 8px currentColor; opacity:.72; }
    .tab.active, .tab:hover { color:var(--gold-bright); border-color:rgba(240,201,106,.58); background:linear-gradient(90deg, rgba(214,166,69,.22), rgba(214,166,69,.045)); box-shadow:inset 0 0 22px rgba(240,201,106,.075), 0 0 14px rgba(214,166,69,.1); }
    .tab.active { font-size:12px; font-weight:850; }
    .sidebar-foot { flex:0 0 auto; margin-top:16px; color:var(--muted); font-size:12px; line-height:1.5; }
    .legal-notice { margin-top:12px; padding-top:10px; border-top:1px solid rgba(214,166,69,.16); color:rgba(214,196,151,.68); font-size:10px; line-height:1.35; }
    .content { min-width:0; padding:18px 24px 30px; overflow-x:hidden; }
    .topbar { position:sticky; top:0; z-index:3; display:grid; grid-template-columns:minmax(260px,1fr) auto; gap:16px; align-items:center; margin:-18px -24px 18px; padding:16px 24px; backdrop-filter:blur(18px); background:linear-gradient(90deg, rgba(7,8,4,.94), rgba(23,19,10,.88)); border-bottom:1px solid var(--line); box-shadow:0 14px 42px rgba(0,0,0,.36); }
    .title h2 { margin:0; font-size:24px; letter-spacing:.12em; text-transform:uppercase; color:var(--gold-bright); }
    .title p { margin:5px 0 0; color:var(--muted); text-transform:uppercase; letter-spacing:.07em; font-size:12px; }
    .status-strip { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
    .badge { display:inline-flex; min-height:31px; align-items:center; gap:7px; border:1px solid var(--line); border-radius:0; padding:6px 11px; background:rgba(0,0,0,.28); color:var(--muted); font-size:11.5px; line-height:1.15; white-space:normal; text-transform:uppercase; letter-spacing:.055em; clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px)); }
    .badge::before { content:""; width:7px; height:7px; border-radius:999px; background:currentColor; box-shadow:0 0 10px currentColor; }
    .badge.ok { color:var(--good); border-color:rgba(86,214,143,.35); }
    .badge.warn { color:var(--warn); border-color:rgba(234,191,98,.35); }
    .badge.bad { color:var(--bad); border-color:rgba(255,102,102,.35); }
    .view { display:none; width:100%; max-width:var(--content-max); margin:0 auto; animation:fade .16s ease-out; }
    .view.active { display:block; }
    @keyframes fade { from { opacity:.2; transform:translateY(4px); } to { opacity:1; transform:none; } }
    .hero { position:relative; overflow:hidden; min-height:190px; margin-bottom:16px; border:1px solid var(--line-strong); border-radius:0; background:
      linear-gradient(90deg, rgba(5,6,3,.88), rgba(5,6,3,.42) 50%, rgba(5,6,3,.84)),
      linear-gradient(180deg, rgba(5,6,3,.08), rgba(5,6,3,.88)),
      url("/manager/assets/desert-command.png") center / cover; box-shadow:var(--shadow), inset 0 0 120px rgba(0,0,0,.55), 0 0 36px rgba(214,166,69,.18); clip-path:polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 24px 100%, 0 calc(100% - 24px)); }
    .hero::before { content:""; position:absolute; inset:0; background:
      radial-gradient(ellipse at 76% 14%, rgba(240,201,106,.26), transparent 26%),
      radial-gradient(ellipse at 34% 82%, rgba(215,168,76,.2), transparent 36%),
      linear-gradient(164deg, transparent 0 52%, rgba(214,166,69,.24) 53%, rgba(214,166,69,.06) 66%, transparent 67%); }
    .hero-body { position:relative; min-height:190px; display:grid; align-content:center; box-sizing:border-box; width:100%; max-width:920px; padding:30px; padding-right:250px; }
    .hero-actions { position:absolute; right:28px; bottom:24px; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; max-width:230px; }
    .hero-actions button { min-height:34px; padding:7px 11px; font-size:12px; line-height:1.15; text-transform:none; letter-spacing:.025em; background:rgba(6,8,5,.74); border-color:rgba(240,201,106,.44); color:var(--gold-bright); box-shadow:0 0 18px rgba(0,0,0,.2); }
    .kicker, .label { color:var(--gold-bright); font-size:var(--font-panel-label); text-transform:uppercase; letter-spacing:.11em; font-weight:900; line-height:1.2; }
    .hero h3 { margin:9px 0 0; font-size:clamp(26px, 2.1vw, 31px); line-height:1.08; letter-spacing:.075em; text-transform:uppercase; color:var(--gold-bright); text-shadow:0 0 24px rgba(240,201,106,.16); max-width:600px; }
    .hero p { margin:10px 0 0; color:#ded3c1; line-height:1.45; max-width:600px; }
    .grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:var(--panel-gap); }
    .grid.four { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .panel { position:relative; width:100%; min-width:0; border:1px solid var(--line); border-radius:var(--panel-radius); background:linear-gradient(180deg, rgba(19,19,12,.94), rgba(5,7,5,.88)); box-shadow:inset 0 0 0 1px rgba(240,201,106,.05), inset 0 -42px 70px rgba(0,0,0,.34), 0 18px 54px rgba(0,0,0,.32); clip-path:polygon(0 0, calc(100% - var(--panel-cut)) 0, 100% var(--panel-cut), 100% 100%, var(--panel-cut) 100%, 0 calc(100% - var(--panel-cut))); }
    .panel::before { content:""; position:absolute; left:12px; right:12px; top:8px; height:1px; background:linear-gradient(90deg, transparent, rgba(240,201,106,.42), transparent); pointer-events:none; }
    .panel::after { content:""; position:absolute; inset:0; pointer-events:none; box-shadow:inset 0 0 38px rgba(240,201,106,.06), 0 0 18px rgba(214,166,69,.08); }
    .panel.pad { padding:var(--panel-pad); }
    .value { margin-top:10px; font-size:var(--font-panel-value); line-height:1.12; font-weight:800; color:var(--gold-bright); overflow-wrap:anywhere; letter-spacing:.02em; }
    .subtle { color:var(--muted); font-size:var(--font-panel-subtle); line-height:1.42; }
    .dashboard-grid { display:grid; grid-template-columns:minmax(280px,.82fr) minmax(420px,1.2fr) minmax(320px,.92fr); gap:var(--panel-gap); align-items:start; margin-top:var(--panel-gap); }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid rgba(214,166,69,.14); padding-bottom:10px; margin-bottom:12px; }
    .micro { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .resource-bars { display:grid; gap:14px; }
    .resource-row { display:grid; grid-template-columns:92px minmax(0,1fr) 42px; gap:10px; align-items:center; color:var(--sand); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    .bar { position:relative; height:17px; border:1px solid rgba(214,166,69,.22); background:repeating-linear-gradient(90deg, rgba(0,0,0,.36) 0 13px, rgba(214,166,69,.12) 13px 15px); overflow:hidden; box-shadow:inset 0 0 20px rgba(0,0,0,.45); }
    .bar span { display:block; height:100%; background:linear-gradient(90deg, rgba(148,101,32,.95), rgba(240,201,106,.9)); box-shadow:0 0 18px rgba(240,201,106,.28); }
    .world-map-panel { margin-top:12px; }
    .map-explorer { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:12px; align-items:start; }
    .world-map { position:relative; min-height:380px; overflow:hidden; border:1px solid rgba(214,166,69,.34); background:#070604; box-shadow:inset 0 0 110px rgba(0,0,0,.66), inset 0 0 0 1px rgba(240,201,106,.05); touch-action:none; }
    .map-workspace { display:grid; gap:12px; }
    .world-map.full { min-height:calc(100vh - 130px); }
    .world-map:fullscreen { width:100vw; height:100vh; min-height:100vh; background:#050503; }
    .overland-layer { position:absolute; inset:0; z-index:2; overflow:hidden; cursor:grab; }
    .overland-layer.dragging { cursor:grabbing; }
    .map-camera { position:absolute; left:0; top:0; width:100%; height:100%; transform-origin:50% 50%; will-change:transform; }
    .world-map-image { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; user-select:none; pointer-events:none; filter:saturate(.95) contrast(1.04) brightness(.92); }
    .metadata-overlay { position:absolute; inset:0; pointer-events:none; background:linear-gradient(180deg, rgba(5,6,3,.1), rgba(5,6,3,.2)); }
    .region-boundaries { position:absolute; inset:0; width:100%; height:100%; z-index:4; pointer-events:none; }
    .region-boundary { fill:rgba(240,201,106,.08); stroke:rgba(240,201,106,.48); stroke-width:2; stroke-dasharray:8 7; opacity:.72; filter:drop-shadow(0 0 8px rgba(240,201,106,.18)); }
    .region-boundary.active { fill:rgba(240,201,106,.18); stroke:var(--gold-bright); stroke-width:3; opacity:1; filter:drop-shadow(0 0 14px rgba(240,201,106,.42)); }
    .map-controls { position:absolute; z-index:15; right:14px; top:14px; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px; max-width:min(390px, calc(100% - 28px)); }
    .map-controls button { min-height:32px; padding:6px 10px; font-size:11px; border-color:rgba(143,197,219,.38); background:rgba(5,7,5,.72); color:var(--gold-bright); }
    .map-subnav { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    .map-subnav button { min-height:32px; padding:6px 11px; font-size:11px; border-color:rgba(214,166,69,.25); background:rgba(255,255,255,.025); }
    .map-subnav button.active { border-color:var(--gold-bright); color:var(--gold-bright); background:rgba(214,166,69,.14); box-shadow:0 0 16px rgba(240,201,106,.1); }
    .map-routes { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:5; opacity:.34; }
    .contour { fill:none; stroke:rgba(240,201,106,.16); stroke-width:1.2; }
    .contour.major { stroke:rgba(240,201,106,.28); stroke-width:1.8; }
    .map-route { fill:none; stroke:rgba(240,201,106,.28); stroke-width:1; stroke-dasharray:1 13; filter:drop-shadow(0 0 2px rgba(240,201,106,.12)); }
    .map-route.secondary { stroke:rgba(159,146,118,.18); stroke-width:.8; stroke-dasharray:1 16; }
    .map-region { position:absolute; z-index:7; border:1px solid rgba(240,201,106,.28); background:rgba(5,7,5,.48); color:var(--gold-bright); padding:7px 9px; min-width:122px; min-height:auto; justify-content:flex-start; display:block; text-align:left; text-transform:uppercase; letter-spacing:.09em; font-size:12px; box-shadow:0 0 18px rgba(214,166,69,.1), inset 0 0 18px rgba(214,166,69,.05); clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px)); }
    .map-region:hover, .map-region.active { border-color:var(--gold-bright); background:rgba(214,166,69,.18); box-shadow:0 0 24px rgba(240,201,106,.22), inset 0 0 22px rgba(240,201,106,.08); }
    .map-region strong { display:block; font-size:13px; color:var(--gold-bright); }
    .map-region span { display:block; margin-top:3px; color:var(--muted); font-size:10px; letter-spacing:.08em; }
    .map-node { position:absolute; z-index:8; width:12px; height:12px; border:1px solid var(--gold-bright); border-radius:999px; background:#070806; box-shadow:0 0 12px rgba(240,201,106,.28); }
    .map-node.entry { width:11px; height:11px; border-radius:0; transform:rotate(45deg); border-color:rgba(240,201,106,.62); }
    .map-node.unknown { border-color:var(--warn); box-shadow:0 0 12px rgba(255,184,77,.22); }
    .map-poi { position:absolute; z-index:8; width:8px; height:8px; border:1px solid rgba(240,201,106,.74); background:rgba(240,201,106,.28); box-shadow:0 0 10px rgba(240,201,106,.2); }
    .map-poi::after { content:attr(data-label); position:absolute; left:12px; top:-5px; min-width:max-content; color:var(--sand); font-size:10px; text-transform:uppercase; letter-spacing:.08em; background:rgba(0,0,0,.42); border:1px solid rgba(214,166,69,.18); padding:3px 5px; }
    .map-legend { position:absolute; z-index:5; right:16px; bottom:14px; display:flex; flex-wrap:wrap; gap:8px; max-width:420px; padding:9px 10px; border:1px solid rgba(214,166,69,.24); background:rgba(0,0,0,.48); color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .legend-item { display:inline-flex; align-items:center; gap:6px; }
    .legend-dot { width:9px; height:9px; border-radius:999px; background:var(--good); box-shadow:0 0 10px var(--good); }
    .legend-dot.offline { background:var(--muted); box-shadow:none; }
    .legend-dot.unknown { background:var(--warn); box-shadow:0 0 10px rgba(255,184,77,.35); }
    .legend-line { width:22px; height:0; border-top:2px dashed rgba(240,201,106,.72); }
    .legend-entry { width:9px; height:9px; border:1px solid rgba(240,201,106,.75); transform:rotate(45deg); }
    .map-intel-overlay { position:absolute; z-index:9; left:18px; top:18px; width:min(360px, calc(100% - 36px)); display:grid; gap:8px; pointer-events:none; }
    .map-intel-card { border:1px solid rgba(214,166,69,.34); background:linear-gradient(180deg, rgba(6,8,5,.78), rgba(19,15,8,.7)); box-shadow:0 0 24px rgba(214,166,69,.1), inset 0 0 24px rgba(0,0,0,.36); padding:10px 12px; clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
    .map-intel-card strong { display:block; color:var(--gold-bright); font-size:18px; letter-spacing:.04em; }
    .map-intel-card span { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.1em; }
    .map-intel-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:12px; }
    .map-intel-tile { min-height:92px; border:1px solid rgba(214,166,69,.24); background:rgba(255,255,255,.025); padding:12px; clip-path:polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px)); }
    .map-intel-tile strong { display:block; color:var(--gold-bright); font-size:22px; margin-top:5px; }
    .map-region-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:12px; }
    .operations-intel { position:sticky; top:86px; display:grid; gap:12px; }
    .intel-stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .intel-stat { border:1px solid rgba(214,166,69,.22); background:rgba(255,255,255,.025); padding:10px; min-height:72px; clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px)); }
    .intel-stat span { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
    .intel-stat strong { display:block; margin-top:6px; color:var(--gold-bright); font-size:19px; overflow-wrap:anywhere; }
    .region-detail-panel { border:1px solid rgba(143,197,219,.3); background:linear-gradient(180deg, rgba(143,197,219,.055), rgba(0,0,0,.22)); padding:12px; clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
    .region-detail-panel h4 { margin:0 0 9px; color:var(--gold-bright); text-transform:uppercase; letter-spacing:.08em; }
    .map-region-card { border:1px solid rgba(214,166,69,.22); background:linear-gradient(180deg, rgba(19,18,11,.72), rgba(5,7,5,.68)); padding:12px; min-height:126px; display:block; text-align:left; color:var(--text); clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
    .map-region-card:hover, .map-region-card.active { border-color:var(--gold-bright); background:rgba(217,178,111,.12); box-shadow:0 0 20px rgba(240,201,106,.1); }
    .map-region-card h4 { margin:0 0 9px; color:var(--gold-bright); text-transform:uppercase; letter-spacing:.08em; font-size:13px; }
    .map-region-card .line { display:flex; justify-content:space-between; gap:8px; border-top:1px solid rgba(214,166,69,.1); padding-top:6px; margin-top:6px; color:var(--muted); font-size:12px; }
    .map-region-card .line strong { color:var(--sand); font-size:12px; }
    .map-metadata-note { margin-top:10px; color:var(--muted); font-size:12px; line-height:1.45; }
    .live-map-layout { width:100%; max-width:var(--content-max); margin:0 auto; display:grid; grid-template-columns:minmax(0,1400px) 360px; justify-content:center; gap:var(--panel-gap); align-items:start; overflow-x:hidden; }
    .live-map-stage { width:min(100%, calc(100vh - 150px), 1400px); max-width:1400px; justify-self:center; min-width:0; }
    .live-map-canvas { position:relative; width:100%; height:auto; aspect-ratio:1 / 1; border:1px solid rgba(214,166,69,.34); background:#070604; overflow:hidden; }
    .live-map-canvas .leaflet-container { width:100%; height:100%; background:#070604; font:inherit; }
    .live-map-canvas .leaflet-control-attribution { display:none; }
    .live-map-marker { border:1px solid currentColor; background:rgba(5,7,5,.88); box-shadow:0 0 14px currentColor; }
    .live-map-marker.player { color:var(--good); border-radius:999px; }
    .live-map-marker.pending { color:var(--warn); border-style:dashed; border-radius:999px; animation:pulse 1.2s ease-in-out infinite; }
    .live-map-marker.vehicle { color:var(--blue); transform:rotate(45deg); }
    .live-map-marker.base { color:var(--gold-bright); }
    .live-map-panel { width:360px; min-width:0; display:grid; gap:12px; }
    .live-map-layer-row { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid rgba(214,166,69,.1); }
    .live-map-log { max-height:180px; overflow:auto; }
    .live-map-coordinate-readout { position:absolute; z-index:600; right:12px; bottom:12px; border:1px solid rgba(214,166,69,.34); background:rgba(0,0,0,.62); color:var(--gold-bright); padding:7px 9px; font-size:11px; text-transform:uppercase; letter-spacing:.08em; pointer-events:none; }
    .coordinate-card { display:grid; gap:7px; }
    .coordinate-pair { display:grid; grid-template-columns:44px minmax(0,1fr); gap:8px; align-items:center; color:var(--muted); }
    .coordinate-pair strong { color:var(--gold-bright); overflow-wrap:anywhere; }
    .ops-list { display:grid; gap:10px; }
    .ops-row { display:grid; grid-template-columns:34px minmax(0,1fr) auto; gap:10px; align-items:center; padding:10px 0; border-bottom:1px solid rgba(214,166,69,.11); }
    .ops-icon { width:30px; height:30px; display:grid; place-items:center; border:1px solid rgba(214,166,69,.42); color:var(--gold-bright); background:rgba(214,166,69,.07); box-shadow:0 0 16px rgba(214,166,69,.08); }
    .metric-tile { min-height:116px; padding:14px 15px !important; }
    .metric-tile .label { min-height:20px; font-size:10.5px; letter-spacing:.105em; line-height:1.15; }
    .metric-tile .value { margin-top:8px; font-size:21px; line-height:1.1; font-weight:780; letter-spacing:.015em; }
    .metric-tile .subtle { margin-top:8px; color:rgba(169,155,119,.74); font-size:11.5px; line-height:1.3; }
    .layout-2 { display:grid; grid-template-columns:minmax(300px,390px) minmax(0,1fr); gap:var(--panel-gap); align-items:start; }
    .layout-3 { display:grid; grid-template-columns:1.1fr .9fr; gap:var(--panel-gap); align-items:start; }
    .controls, .action-row { display:flex; flex-wrap:wrap; gap:10px; }
    .sound-widget { display:grid; gap:9px; margin-top:14px; padding:12px; border:1px solid rgba(214,166,69,.28); background:linear-gradient(180deg, rgba(240,201,106,.055), rgba(0,0,0,.18)); clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
    .sound-widget-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .sound-toggle { min-height:34px; padding:7px 11px; border-color:rgba(143,197,219,.42); color:var(--gold-bright); }
    .sound-slider { display:grid; grid-template-columns:auto minmax(120px,1fr) 46px; gap:10px; align-items:center; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.1em; }
    .sound-slider input[type="range"] { min-height:30px; padding:0; accent-color:var(--gold-bright); }
    .sound-volume-readout { color:var(--gold-bright); text-align:right; font-weight:900; }
    .dashboard-footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin-top:12px; padding-top:12px; border-top:1px solid rgba(214,166,69,.16); color:var(--muted); font-size:12px; }
    .dashboard-footer a, .support-links a { color:var(--gold-bright); overflow-wrap:anywhere; }
    .about-overlay { position:fixed; inset:0; z-index:5100; background:rgba(3,4,5,.76); backdrop-filter:blur(8px); display:grid; place-items:center; padding:20px; }
    .about-card { width:min(560px,100%); border:1px solid var(--line); border-radius:var(--panel-radius); background:linear-gradient(180deg, rgba(19,19,12,.98), rgba(5,7,5,.94)); box-shadow:var(--shadow); padding:var(--panel-pad); clip-path:polygon(0 0, calc(100% - var(--panel-cut)) 0, 100% var(--panel-cut), 100% 100%, var(--panel-cut) 100%, 0 calc(100% - var(--panel-cut))); }
    .support-links { display:grid; gap:8px; margin-top:12px; color:var(--muted); font-size:13px; }
    .field-grid { display:grid; gap:10px; }
    label { display:grid; gap:6px; color:var(--sand); font-size:12px; text-transform:uppercase; letter-spacing:.09em; font-weight:800; }
    select, input, textarea { width:100%; min-height:44px; border:1px solid rgba(214,166,69,.34); border-radius:0; background:rgba(6,8,5,.9); color:var(--text); padding:0 12px; outline:none; }
    textarea { min-height:160px; padding:10px 12px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; line-height:1.35; }
    select:focus, input:focus, textarea:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(114,164,242,.12); }
    .button, .controls button, button { display:inline-flex; align-items:center; justify-content:center; min-height:38px; max-width:100%; border:1px solid rgba(214,166,69,.38); border-radius:0; background:linear-gradient(180deg, rgba(30,29,18,.95), rgba(10,12,8,.95)); color:var(--sand); padding:7px 13px; text-decoration:none; text-transform:uppercase; letter-spacing:.045em; font-size:var(--font-button); line-height:1.18; font-weight:760; text-align:center; white-space:normal; overflow-wrap:anywhere; }
    .primary { font-size:13px; }
    .panel-head button, .action-row button, .controls button, .setup-card button, .live-map-panel button, .settings-grid button, .vm-details button { font-size:12.5px; min-height:36px; padding:7px 12px; letter-spacing:.04em; }
    .panel-head button, .action-row button, .live-map-panel button, .settings-grid button, .vm-monitor-lists button, .dashboard-footer button { text-transform:none; }
    .primary { background:linear-gradient(180deg, rgba(159,111,38,.98), rgba(78,55,22,.98)) !important; border-color:rgba(240,201,106,.78) !important; color:#fff1c8 !important; box-shadow:0 0 24px rgba(240,201,106,.16); }
    .danger { background:linear-gradient(180deg, rgba(112,42,42,.98), rgba(63,25,25,.98)) !important; border-color:rgba(255,102,102,.5) !important; }
    .player-list, .admin-items { display:grid; gap:8px; max-height:520px; overflow:auto; padding-right:4px; }
    .player-card, .admin-item { display:grid; grid-template-columns:46px minmax(0,1fr); gap:10px; align-items:center; width:100%; border:1px solid rgba(214,166,69,.24); border-radius:0; padding:10px; background:rgba(255,255,255,.025); color:var(--text); text-align:left; clip-path:polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px)); }
    .player-card.active, .admin-item.active { border-color:var(--gold); background:rgba(217,178,111,.13); box-shadow:0 0 18px rgba(240,197,107,.08); }
    .avatar { width:46px; height:46px; display:grid; place-items:center; border:1px solid var(--line-blue); border-radius:6px; background:linear-gradient(135deg, rgba(114,164,242,.18), rgba(217,178,111,.08)); color:var(--blue); font-weight:900; }
    .gear-icon { width:46px; height:46px; display:grid; place-items:center; }
    .gear-icon > * { grid-area:1 / 1; }
    .admin-item img { width:46px; height:46px; object-fit:contain; border-radius:6px; background:#0b0e12; }
    .admin-item span, .player-card span { color:var(--muted); font-size:12px; display:block; overflow-wrap:anywhere; }
    .detail-list { display:grid; gap:8px; margin-top:12px; }
    .detail-row { display:grid; grid-template-columns:130px minmax(0,1fr); gap:8px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,.06); }
    .env-stack { display:grid; gap:var(--panel-gap); max-width:var(--content-max); margin:0 auto; }
    .env-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
    .env-card { min-width:0; border:1px solid rgba(214,166,69,.18); background:rgba(255,255,255,.022); padding:10px 12px; }
    .env-card span { display:block; color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:.09em; line-height:1.25; }
    .env-card strong { display:block; margin-top:5px; color:var(--gold-bright); font-size:12.5px; line-height:1.35; overflow-wrap:anywhere; word-break:break-word; }
    .env-var-list { display:grid; gap:8px; margin-top:12px; }
    .env-var-row { display:grid; grid-template-columns:minmax(180px,.42fr) minmax(0,1fr); gap:12px; align-items:start; padding:10px 0; border-bottom:1px solid rgba(255,255,255,.06); min-width:0; }
    .env-var-name, .env-var-value, .env-path-value { font-family:ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; overflow-wrap:anywhere; word-break:break-word; }
    .env-var-name { color:var(--sand); font-size:12px; line-height:1.35; }
    .env-var-source { display:block; margin-top:4px; color:var(--muted); font-family:inherit; font-size:10.5px; line-height:1.3; text-transform:uppercase; letter-spacing:.075em; overflow-wrap:anywhere; }
    .env-var-value { color:var(--gold-bright); font-size:12.5px; line-height:1.45; white-space:normal; }
    .env-help { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font-family:ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size:12px; line-height:1.45; max-height:none; }
    .env-section-note { margin-top:8px; color:var(--muted); font-size:11.5px; line-height:1.4; }
    .warning { border:1px solid rgba(234,191,98,.42); color:#f4d99c; background:rgba(234,191,98,.08); border-radius:0; padding:10px; font-size:13px; line-height:1.4; }
    .warning.hidden { display:none; }
    .hidden { display:none !important; }
    .check-row { display:flex; align-items:center; gap:9px; color:var(--muted); font-size:13px; text-transform:none; letter-spacing:0; }
    .check-row input { width:auto; min-height:0; }
    .activity { display:grid; gap:8px; max-height:380px; overflow:auto; }
    .activity-item { border-left:2px solid var(--gold); padding:9px 11px; background:rgba(255,255,255,.025); border-radius:0; }
    .activity-time { color:var(--muted); font-size:12px; margin-bottom:3px; }
    .vm-monitor { grid-column:1/-1; }
    .vm-monitor-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .health-score { min-width:86px; text-align:right; }
    .health-score strong { display:block; color:var(--gold-bright); font-size:30px; line-height:1; }
    .vm-status-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:12px; }
    .vm-status-card { min-height:82px; border:1px solid rgba(214,166,69,.22); background:rgba(255,255,255,.025); padding:10px; clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px)); }
    .vm-status-card span { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
    .vm-status-card strong { display:block; margin-top:6px; color:var(--gold-bright); font-size:18px; overflow-wrap:anywhere; }
    .vm-status-card.ok { border-color:rgba(89,213,139,.46); }
    .vm-status-card.warn { border-color:rgba(255,184,77,.5); }
    .vm-status-card.bad { border-color:rgba(255,102,102,.52); }
    .vm-monitor-lists { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; }
    .vm-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; padding:8px 0; border-bottom:1px solid rgba(255,255,255,.06); }
    .vm-row strong { overflow-wrap:anywhere; }
    .vm-row small { display:block; color:var(--muted); margin-top:2px; }
    .status-pill { min-width:72px; text-align:center; border:1px solid rgba(214,166,69,.28); padding:5px 8px; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
    .status-pill.ok { color:var(--good); border-color:rgba(89,213,139,.46); background:rgba(89,213,139,.08); }
    .status-pill.warn { color:var(--warn); border-color:rgba(255,184,77,.5); background:rgba(255,184,77,.08); }
    .status-pill.bad { color:var(--bad); border-color:rgba(255,102,102,.52); background:rgba(255,102,102,.08); }
    .restore-timeline { display:grid; gap:7px; margin-top:12px; }
    .restore-step { display:flex; align-items:center; gap:9px; padding:7px 9px; border:1px solid rgba(214,166,69,.18); background:rgba(0,0,0,.18); color:var(--muted); font-size:12px; }
    .restore-step span { width:18px; color:currentColor; text-align:center; }
    .restore-step.ok { color:var(--good); border-color:rgba(89,213,139,.34); background:rgba(89,213,139,.06); }
    .restore-step.warn { color:var(--warn); border-color:rgba(255,184,77,.45); background:rgba(255,184,77,.08); }
    .restore-step.bad { color:var(--bad); border-color:rgba(255,102,102,.48); background:rgba(255,102,102,.08); }
    .vm-details { margin-top:12px; border-top:1px solid rgba(214,166,69,.14); padding-top:10px; }
    .vm-details summary { cursor:pointer; color:var(--sand); text-transform:uppercase; letter-spacing:.08em; font-size:12px; font-weight:900; }
    .ping-graph { display:flex; align-items:end; gap:3px; min-height:70px; margin-top:10px; padding:8px; border:1px solid rgba(214,166,69,.16); background:rgba(0,0,0,.22); }
    .ping-bar { flex:1; min-width:3px; max-width:9px; height:8px; background:var(--bad); opacity:.78; }
    .ping-bar.ok { background:var(--good); }
    .ping-bar.warn { background:var(--warn); }
    .vm-error-list { display:grid; gap:6px; margin-top:10px; color:var(--muted); font-size:12px; }
    .player-feed { display:grid; gap:8px; max-height:260px; overflow:auto; padding-right:4px; }
    .feed-row { display:grid; grid-template-columns:16px minmax(160px,1fr) auto auto; gap:10px; align-items:center; padding:10px 11px; border:1px solid rgba(214,166,69,.18); background:rgba(255,255,255,.022); clip-path:polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px)); }
    .feed-dot { width:9px; height:9px; border-radius:999px; background:var(--warn); box-shadow:0 0 12px currentColor; color:var(--warn); }
    .feed-dot.online { background:var(--good); color:var(--good); }
    .feed-dot.offline { background:rgba(159,146,118,.62); color:rgba(159,146,118,.62); box-shadow:none; }
    .feed-name { min-width:0; }
    .feed-name strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .feed-id { color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .feed-level, .feed-status { color:var(--sand); font-size:12px; text-transform:uppercase; letter-spacing:.06em; white-space:nowrap; }
    .feed-status.online { color:var(--good); }
    .feed-status.offline { color:var(--muted); }
    .feed-status.unknown { color:var(--warn); }
    table { width:100%; border-collapse:collapse; font-size:var(--font-table); line-height:1.35; }
    th, td { text-align:left; border-bottom:1px solid rgba(255,255,255,.08); padding:9px 8px; overflow-wrap:anywhere; }
    th { color:var(--sand); font-size:12px; text-transform:uppercase; letter-spacing:.07em; }
    .table-wrap { width:100%; overflow-x:auto; }
    .table-wrap table { min-width:760px; }
    .panel { font-size:var(--font-panel-body); line-height:1.42; }
    .panel h2 { font-size:18px; line-height:1.18; letter-spacing:.07em; }
    .panel h3 { font-size:16px; line-height:1.2; letter-spacing:.055em; }
    .panel h4 { font-size:13.5px; line-height:1.2; letter-spacing:.06em; }
    .panel p, .panel li, .panel div, .panel span { line-height:1.42; }
    .panel .label, .panel label, .panel .micro, .panel th { font-size:var(--font-panel-label); }
    .panel .value { font-size:var(--font-panel-value); }
    .panel .subtle, .panel small, .panel td, .panel .detail-row, .panel .check-row, .panel .warning { font-size:var(--font-panel-subtle); }
    .panel input, .panel select, .panel textarea { font-size:12.5px; }
    .panel button, .panel .button { font-size:var(--font-button); }
    .panel-head h2, .summary h2 { font-size:18px; line-height:1.18; }
    .settings-grid .panel, .layout-2 .panel, .layout-3 .panel, .live-map-panel, .operations-intel, .about-card, .setup-card { font-size:var(--font-panel-body); }
    .live-map-panel .value, .operations-intel .value, .settings-grid .value, .layout-2 .value, .layout-3 .value { font-size:var(--font-panel-value); }
    .live-map-panel .label, .operations-intel .label, .settings-grid .label, .layout-2 .label, .layout-3 .label { font-size:var(--font-panel-label); }
    .teleport-panel .value, #teleportLog, #liveMapLog, #progressionResult, #progressionPreview, #progressionDebug { font-size:12px; }
    pre { white-space:pre-wrap; background:rgba(3,5,4,.78); border:1px solid rgba(214,166,69,.28); border-radius:0; padding:14px; max-height:430px; overflow:auto; color:#e8dfc8; }
    .frame-wrap { overflow:hidden; min-height:720px; }
    iframe { width:100%; height:78vh; min-height:720px; border:0; display:block; background:#080a0d; }
    .empty { padding:var(--panel-pad); border:1px dashed rgba(217,178,111,.35); border-radius:var(--panel-radius); color:var(--muted); background:rgba(255,255,255,.025); }
    .setup-overlay { position:fixed; inset:0; z-index:5000; background:rgba(3,4,5,.92); backdrop-filter:blur(10px); display:grid; place-items:center; padding:20px; }
    .setup-card { width:min(980px,100%); max-height:92vh; overflow:auto; border:1px solid var(--line); border-radius:var(--panel-radius); background:linear-gradient(180deg, rgba(19,19,12,.98), rgba(5,7,5,.94)); box-shadow:var(--shadow); padding:var(--panel-pad); clip-path:polygon(0 0, calc(100% - var(--panel-cut)) 0, 100% var(--panel-cut), 100% 100%, var(--panel-cut) 100%, 0 calc(100% - var(--panel-cut))); }
    .setup-steps { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; }
    .setup-step { border:1px solid rgba(214,166,69,.24); color:var(--muted); padding:7px 10px; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .setup-step.active { color:var(--gold-bright); border-color:rgba(214,166,69,.6); background:rgba(214,166,69,.08); }
    .setup-page { display:none; }
    .setup-page.active { display:block; }
    .path-picker-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:end; }
    .path-picker-row label { min-width:0; }
    .test-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
    .test-result { min-height:74px; border:1px solid rgba(214,166,69,.2); padding:10px; background:rgba(255,255,255,.025); color:var(--muted); font-size:12px; }
    .test-result.ok { color:var(--good); border-color:rgba(89,213,139,.46); }
    .test-result.bad { color:var(--bad); border-color:rgba(255,102,102,.52); }
    .settings-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--panel-gap); }
    .diagnostic-log { min-height:220px; max-height:420px; overflow:auto; white-space:pre-wrap; }
    .mt { margin-top:12px; } .mb { margin-bottom:12px; }
    @media (max-width:1300px) { .dashboard-grid{grid-template-columns:1fr 1fr}.dashboard-grid > .panel:last-child{grid-column:1/-1}.map-explorer{grid-template-columns:1fr}.operations-intel{position:relative;top:auto}.map-intel-grid,.map-region-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-body{padding:24px; padding-bottom:82px; max-width:none}.hero-actions{left:24px; right:24px; bottom:22px; justify-content:flex-start; max-width:none} }
    @media (max-width:1500px) { .live-map-layout{grid-template-columns:minmax(0,1fr) 340px}.live-map-panel{width:340px}.live-map-stage{width:100%;} }
    @media (max-width:1180px) { .live-map-layout{grid-template-columns:minmax(0,1fr) 320px}.live-map-panel{width:320px}.hero-body{padding:24px; padding-bottom:82px; max-width:none}.hero-actions{left:24px; right:24px; bottom:22px; justify-content:flex-start; max-width:none} }
    @media (max-width:1050px) { .shell{grid-template-columns:1fr}.sidebar{position:relative;height:100vh}.content{padding:14px}.topbar{position:relative;margin:-14px -14px 14px;grid-template-columns:1fr}.status-strip{justify-content:flex-start}.grid,.grid.four,.layout-2,.layout-3,.dashboard-grid,.map-explorer,.live-map-layout,.map-intel-grid,.map-region-grid,.intel-stat-grid,.vm-status-grid,.vm-monitor-lists,.env-grid{grid-template-columns:1fr}.path-picker-row{grid-template-columns:1fr}.live-map-layout{max-width:100%;justify-content:stretch}.live-map-stage{width:100%;max-width:100%}.live-map-panel{width:100%}.hero-body{padding:24px; padding-bottom:82px; max-width:none}.hero-actions{left:24px; right:24px; bottom:22px; justify-content:flex-start; max-width:none}.hero h3{font-size:24px}.frame-wrap,iframe{min-height:620px}.world-map.full{min-height:640px} }
    @media (max-width:720px) { .env-var-row{grid-template-columns:1fr;gap:5px}.env-var-value{font-size:12px}.env-help{font-size:11.5px} }
  </style>
</head>
<body>
<div id="aboutDialog" class="about-overlay hidden" role="dialog" aria-modal="true" aria-label="About AlphaNine Dune Suite">
  <div class="about-card">
    <div class="panel-head">
      <div>
        <div class="kicker">About</div>
        <h2>AlphaNine Dune Suite</h2>
        <div class="subtle">Version 0.3.0-beta</div>
      </div>
      <button type="button" onclick="closeAboutDialog()">Close</button>
    </div>
    <div class="support-links">
      <strong>Community &amp; Support</strong>
      <div>Discord: <a href="https://discord.gg/tuUv3hYTv" target="_blank" rel="noopener">https://discord.gg/tuUv3hYTv</a></div>
      <div>YouTube: <a href="https://www.youtube.com/@AlphanineGaming" target="_blank" rel="noopener">https://www.youtube.com/@AlphanineGaming</a></div>
    </div>
    <div class="legal-notice mt">Dune: Awakening &copy; Funcom.<br>AlphaNine Dune Suite is an independent community project and is not affiliated with or endorsed by Funcom.</div>
  </div>
</div>
<div id="setupWizard" class="setup-overlay hidden" role="dialog" aria-modal="true" aria-label="AlphaNine Dune Suite setup wizard">
  <div class="setup-card">
    <div class="panel-head">
      <div>
        <div class="kicker">First Launch</div>
        <h2>AlphaNine Dune Suite Setup</h2>
        <div class="subtle">Configure the suite once, then manage your server from the app.</div>
      </div>
      <button type="button" onclick="closeSetupWizard()">Skip For Now</button>
    </div>
    <div id="setupSteps" class="setup-steps">
      <div class="setup-step active">Welcome</div>
      <div class="setup-step">Server</div>
      <div class="setup-step">Database</div>
      <div class="setup-step">Receiver</div>
      <div class="setup-step">Finish</div>
    </div>
    <div id="setupPage0" class="setup-page active">
      <div class="empty">This wizard stores settings in your Windows app data folder. You do not need Node.js, npm commands, PowerShell, SSH, JSON editing, or manual receiver launching for normal use.</div>
    </div>
    <div id="setupPage1" class="setup-page">
      <div class="field-grid">
        <label>Server Type<select id="setupServerType"><option value="local-hyperv">Local Windows / Hyper-V</option><option value="remote-vm">Remote VM</option><option value="manual">Manual / Advanced</option></select></label>
        <div class="path-picker-row">
          <label>Dune Server Install Path<input id="setupServerInstallPath" placeholder="D:\\SteamLibrary\\steamapps\\common\\Dune Awakening Self-Hosted Server" onchange="refreshServerInstallPathWarning('setupServerInstallPath','setupServerInstallPathWarning')"></label>
          <button type="button" onclick="browseServerInstallPath('setupServerInstallPath','setupServerInstallPathWarning')">Browse...</button>
        </div>
        <div id="setupServerInstallPathWarning" class="warning">Server install path not checked.</div>
        <label>VM Name<input id="setupVmName" placeholder="dune-awakening"></label>
        <label>VM / Server IP<input id="setupVmIp" placeholder="192.168.1.50"></label>
        <button type="button" onclick="runDiscovery()">Auto Discover</button>
      </div>
      <pre id="setupDiscoveryLog" class="mt">Discovery has not run yet.</pre>
    </div>
    <div id="setupPage2" class="setup-page">
      <div class="field-grid">
        <label>Database Host<input id="setupDatabaseHost" placeholder="Auto via Dune VM or host/IP"></label>
        <label>Database Port<input id="setupDatabasePort" type="number" value="15432"></label>
        <label>Database Name<input id="setupDatabaseName" value="dune"></label>
        <label>Database User<input id="setupDatabaseUser" value="postgres"></label>
        <label>Database Password<input id="setupDatabasePassword" type="password" placeholder="Optional when using VM auto-detect"></label>
        <button type="button" onclick="runConnectionTest('database','setupDatabaseResult')">Test Database</button>
      </div>
      <div id="setupDatabaseResult" class="test-result mt">Not tested.</div>
    </div>
    <div id="setupPage3" class="setup-page">
      <div class="field-grid">
        <label>Receiver Host<input id="setupReceiverHost" value="127.0.0.1"></label>
        <label>Receiver Port<input id="setupReceiverPort" type="number" value="5055"></label>
        <label>Receiver Token<input id="setupReceiverToken" type="password" placeholder="Optional bearer token"></label>
        <label>Receiver SSH Host<input id="setupReceiverSshHost" placeholder="Dune VM IP"></label>
        <label>Receiver SSH User<input id="setupReceiverSshUser" value="dune"></label>
        <label>Receiver SSH Key<input id="setupReceiverSshKey" placeholder="%LOCALAPPDATA%\\DuneAwakeningServer\\sshKey"></label>
        <div class="action-row">
          <button type="button" onclick="receiverAction('start')">Start Receiver</button>
          <button type="button" onclick="runConnectionTest('receiver','setupReceiverResult')">Test Receiver</button>
        </div>
      </div>
      <div id="setupReceiverResult" class="test-result mt">Not tested.</div>
    </div>
    <div id="setupPage4" class="setup-page">
      <div class="test-grid">
        <button type="button" onclick="runConnectionTest('database','finishDbResult')">Test Database</button>
        <button type="button" onclick="runConnectionTest('receiver','finishReceiverResult')">Test Receiver</button>
        <button type="button" onclick="runConnectionTest('server','finishServerResult')">Test Server</button>
      </div>
      <div class="test-grid mt">
        <div id="finishDbResult" class="test-result">Database not tested.</div>
        <div id="finishReceiverResult" class="test-result">Receiver not tested.</div>
        <div id="finishServerResult" class="test-result">Server not tested.</div>
      </div>
      <div class="action-row mt">
        <button type="button" class="primary" onclick="finishSetup()">Save Configuration</button>
      </div>
      <div id="setupFinishResult" class="empty mt">Ready to save.</div>
    </div>
    <div class="action-row mt">
      <button type="button" onclick="setupPrev()">Back</button>
      <button type="button" class="primary" onclick="setupNext()">Next</button>
    </div>
  </div>
</div>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <h1>AlphaNine Dune Suite</h1>
      <p>Dune Operations Center</p>
      <div class="build-info" aria-label="Application version and build">
        <span>Version 0.3.0-beta</span>
        <span>Build b92e5a3</span>
      </div>
    </div>
    <nav class="nav">
      <button class="tab active" data-view="dashboard">Dashboard</button>
      <button class="tab" data-view="players">Players</button>
      <button class="tab" data-view="give">Give Item</button>
      <button class="tab" data-view="admin">Admin Tools</button>
      <button class="tab" data-view="progression">Progression Inspector</button>
      <button class="tab" data-view="database">Database</button>
      <button class="tab" data-view="server">Server Status</button>
      <button class="tab" data-view="live-map">Live Map</button>
      <button class="tab" data-view="management">Server Management</button>
      <button class="tab" data-view="codex">Gear Codex</button>
      <button class="tab" data-view="env">Env Setup</button>
      <button class="tab" data-view="logs">Logs</button>
      <button class="tab" data-view="diagnostics">Diagnostics</button>
      <button class="tab" data-view="settings">Settings</button>
    </nav>
    <div class="sidebar-foot">
      <button type="button" onclick="openAboutDialog()">About</button>
      <div class="legal-notice">Dune: Awakening &copy; Funcom.<br>AlphaNine Dune Suite is an independent community project and is not affiliated with or endorsed by Funcom.</div>
    </div>
  </aside>
  <main class="content">
    <div class="topbar">
      <div class="title">
        <h2 id="viewTitle">Dashboard</h2>
        <p id="viewSubtitle">Dune Awakening Server Operations Center.</p>
      </div>
      <div class="status-strip">
        <span id="topServer" class="badge warn">Server checking</span>
        <span id="topDb" class="badge warn">DB checking</span>
        <span id="topLive" class="badge warn">Live give checking</span>
        <span id="topPlayers" class="badge warn">Players 0</span>
        <span id="topSsh" class="badge warn">SSH unknown</span>
      </div>
    </div>

    <section id="dashboard" class="view active">
      <div class="hero">
        <div class="hero-body">
          <div class="kicker">Server operations command</div>
          <h3>Dune Awakening Server Operations Center</h3>
          <p>Live status, VM control, player telemetry, grant transport, database health, receiver bridge, and audit visibility for SH-HAGGA BASIN.</p>
        </div>
        <div class="hero-actions" aria-label="Support links">
          <button type="button" onclick="openSupportDiscord()">Discord Support</button>
          <span class="kofi-widget-slot">
            <script type='text/javascript' src='https://storage.ko-fi.com/cdn/widget/Widget_2.js'></script>
            <script type='text/javascript'>if(window.kofiwidget2){kofiwidget2.init('Support me on Ko-fi', '#72a4f2', 'E1W220NMPA');kofiwidget2.draw();}</script>
          </span>
        </div>
      </div>
      <div class="grid">
        <div class="panel pad metric-tile"><div class="label">VM Status</div><div id="dashboardVmStatus" class="value">Checking...</div><div class="subtle">Hyper-V VM state.</div></div>
        <div class="panel pad metric-tile"><div class="label">Server Population</div><div id="players" class="value">Checking...</div><div class="subtle">Current known player state.</div></div>
        <div class="panel pad metric-tile"><div class="label">Database Link</div><div id="adminDb" class="value">Checking...</div><div class="subtle">Postgres/admin probe.</div></div>
        <div class="panel pad metric-tile"><div class="label">Give Transport</div><div id="adminLive" class="value">Checking...</div><div class="subtle">Runtime grant route.</div></div>
        <div class="panel pad metric-tile"><div class="label">Receiver Bridge</div><div id="receiverState" class="value">Checking...</div><div class="subtle">HTTP JSON receiver health.</div></div>
        <div class="panel pad metric-tile"><div class="label">Queue Bridge</div><div id="rabbitState" class="value">Checking...</div><div class="subtle">RabbitMQ command target.</div></div>
      </div>
      <div class="dashboard-grid">
        <div class="panel pad">
          <div class="panel-head"><div class="label">Server Resources</div><div id="resourceSource" class="micro">Source: Unknown</div></div>
          <div class="resource-bars">
            <div class="resource-row"><span>CPU</span><div class="bar"><span id="resourceCpuBar" style="width:0%"></span></div><strong id="resourceCpu">Unknown</strong></div>
            <div class="resource-row"><span>Memory</span><div class="bar"><span id="resourceMemoryBar" style="width:0%"></span></div><strong id="resourceMemory">Unknown</strong></div>
            <div class="resource-row"><span>Disk</span><div class="bar"><span id="resourceDiskBar" style="width:0%"></span></div><strong id="resourceDisk">Unknown</strong></div>
            <div class="resource-row"><span>Network</span><div class="bar"><span id="resourceNetworkBar" style="width:0%"></span></div><strong id="resourceNetwork">Unknown</strong></div>
          </div>
        </div>
        <div class="panel pad">
          <div class="panel-head"><div class="label">Player Feed</div><div id="playerFeedStamp" class="micro">Loading</div></div>
          <div id="playerFeed" class="player-feed"><div class="empty">Loading players...</div></div>
        </div>
        <div class="panel pad">
          <div class="panel-head"><div class="label">Activity Feed</div><div class="micro">All events</div></div>
          <div id="activityFeed" class="activity"><div class="empty">Activity will appear after probes, refreshes, grants, and errors.</div></div>
        </div>
        <div class="panel pad vm-monitor">
          <div class="vm-monitor-head">
            <div>
              <div class="label">VM Connection Monitor</div>
              <div id="vmMonitorStamp" class="micro">Checking connectivity</div>
            </div>
            <div class="health-score"><span class="micro">Health</span><strong id="vmHealthScore">--</strong></div>
          </div>
          <div class="vm-status-grid">
            <div id="vmStatusCard" class="vm-status-card warn"><span>VM Status</span><strong id="vmMonitorStatus">Checking</strong></div>
            <div class="vm-status-card"><span>VM Address</span><strong id="vmMonitorAddress">Unknown</strong></div>
            <div class="vm-status-card"><span>Hostname</span><strong id="vmMonitorHost">Unknown</strong></div>
            <div id="vmLatencyCard" class="vm-status-card warn"><span>Current Ping</span><strong id="vmPingCurrent">-- ms</strong></div>
            <div class="vm-status-card"><span>Average Ping</span><strong id="vmPingAverage">-- ms</strong></div>
            <div class="vm-status-card"><span>Min Ping</span><strong id="vmPingMin">-- ms</strong></div>
            <div class="vm-status-card"><span>Max Ping</span><strong id="vmPingMax">-- ms</strong></div>
            <div id="vmUptimeCard" class="vm-status-card"><span>VM Uptime</span><strong id="vmUptime">Unknown</strong></div>
          </div>
          <div class="vm-monitor-lists">
            <div>
              <div class="label">Ports</div>
              <div id="vmPortList" class="mt"><div class="empty">Checking ports...</div></div>
            </div>
            <div>
              <div class="label">Services</div>
              <div id="vmServiceList" class="mt"><div class="empty">Checking services...</div></div>
            </div>
          </div>
          <details class="vm-details">
            <summary>Connection Details</summary>
            <div class="ping-graph" id="vmPingGraph" aria-label="Ping history graph"></div>
            <div class="vm-monitor-lists">
              <div>
                <div class="label">Port Status List</div>
                <div id="vmPortDetailList" class="vm-error-list"></div>
              </div>
              <div>
                <div class="label">Last Errors</div>
                <div id="vmErrorList" class="vm-error-list"></div>
                <div class="detail-row"><span class="subtle">Last Success</span><strong id="vmLastSuccess">None yet</strong></div>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="layout-3 mt">
        <div class="panel pad">
          <div class="panel-head"><div class="label">System Alerts</div><div class="micro">Operations</div></div>
          <div class="ops-list">
            <div class="ops-row"><div class="ops-icon">!</div><div><strong>Permission and elevation checks</strong><div class="subtle">Server Status reports admin and VM diagnostics when required.</div></div><span class="micro">Active</span></div>
            <div class="ops-row"><div class="ops-icon">Q</div><div><strong>Live Give queue wording</strong><div class="subtle">Live execution reports published/queued until inventory verification exists.</div></div><span class="micro">Guarded</span></div>
            <div class="ops-row"><div class="ops-icon">D</div><div><strong>Dry-Run default</strong><div class="subtle">Give Item opens in Dry-Run mode and requires manual Live Give selection.</div></div><span class="micro">Safe</span></div>
          </div>
        </div>
        <div class="panel pad">
          <div class="panel-head"><div class="label">Quick Actions</div><div class="micro">Command deck</div></div>
          <div class="action-row mt">
            <button class="primary" data-open="give">Give Item</button>
            <button data-open="players">Players</button>
            <button data-open="server">Server Status</button>
            <button onclick="refreshAll()">Refresh All</button>
          </div>
          <div class="sound-widget" aria-label="UI sound controls">
            <div class="sound-widget-head">
              <div class="label">Interface Audio</div>
              <button id="dashboardSoundToggle" class="sound-toggle" type="button">🔊 Sounds ON</button>
            </div>
            <label class="sound-slider">Volume <input id="dashboardSoundVolume" type="range" min="0" max="100" value="100"><span id="dashboardSoundVolumeLabel" class="sound-volume-readout">100%</span></label>
          </div>
          <pre id="dashboardLog" class="mt">Awaiting telemetry.</pre>
          <div class="dashboard-footer">
            <span>Need help? Join our Discord: <a href="https://discord.gg/tuUv3hYTv" target="_blank" rel="noopener">https://discord.gg/tuUv3hYTv</a></span>
          </div>
        </div>
      </div>
    </section>

    <section id="live-map" class="view">
      <div class="live-map-layout">
        <div class="panel pad live-map-stage">
          <div class="panel-head"><div><div class="label">Live Map</div><div id="liveMapStamp" class="micro">Leaflet tactical overlay</div></div><button type="button" onclick="refreshLiveMap()">Refresh</button></div>
          <div id="liveMapCanvas" class="live-map-canvas"></div>
        </div>
        <div class="live-map-panel">
          <div class="panel pad">
            <div class="label">Layers</div>
            <label class="live-map-layer-row"><span>Players</span><input id="liveLayerPlayers" type="checkbox" checked onchange="renderLiveMapLayers()"></label>
            <label class="live-map-layer-row"><span>Vehicles</span><input id="liveLayerVehicles" type="checkbox" checked onchange="renderLiveMapLayers()"></label>
            <label class="live-map-layer-row"><span>Bases</span><input id="liveLayerBases" type="checkbox" checked onchange="renderLiveMapLayers()"></label>
            <div id="livePlayerPositionWarning" class="warning mt hidden">Player position unavailable</div>
            <div id="liveEntityAvailability" class="warning mt hidden">Bases/vehicles data not available from server yet.</div>
            <div class="subtle mt">Resource and POI filters are reserved for the next layer pass.</div>
          </div>
          <div class="panel pad">
            <div class="label">Clicked Coordinates</div>
            <div class="coordinate-card mt">
              <div class="coordinate-pair"><span>X</span><strong id="liveClickedX">--</strong></div>
              <div class="coordinate-pair"><span>Y</span><strong id="liveClickedY">--</strong></div>
              <button type="button" onclick="copyLiveCoordinates()">Copy Coordinates</button>
            </div>
          </div>
          <div class="panel pad">
            <div class="label">Coordinate Search</div>
            <div class="field-grid mt">
              <label>X<input id="liveSearchX" type="number" step="0.01"></label>
              <label>Y<input id="liveSearchY" type="number" step="0.01"></label>
              <button type="button" class="primary" onclick="goToLiveCoordinates()">Go To</button>
            </div>
          </div>
          <div class="panel pad">
            <div class="label">Teleport To Coordinate</div>
            <div class="field-grid mt">
              <label>Player / Controller ID<input id="teleportPlayerId" placeholder="player_controller_id or account id"></label>
              <label>Known Location Preset<select id="teleportPreset" onchange="applyTeleportPreset()"><option value="">Manual coordinates</option></select></label>
              <label>X<input id="teleportX" type="number" step="0.01"></label>
              <label>Y<input id="teleportY" type="number" step="0.01"></label>
              <label>Z / Elevation<input id="teleportZ" type="number" step="0.01" placeholder="Required unless using a preset/player target"></label>
              <label>Partition ID<input id="teleportPartitionId" type="number" step="1" min="0" placeholder="0"></label>
              <button type="button" class="primary" onclick="previewTeleport()">Preview Teleport</button>
              <button type="button" id="liveTeleportButton" onclick="executeLiveTeleport()" disabled>Live Teleport</button>
            </div>
            <div class="warning mt">Map clicks provide X/Y only. Enter a verified Z, choose a saved preset, or use Teleport to Player. Terrain elevation is not calculated yet.</div>
            <div class="label mt">Teleport To Player</div>
            <div class="field-grid mt">
              <label>Target Player With Known Position<input id="teleportTargetPlayerId" placeholder="target FLS/controller/account id"></label>
              <button type="button" onclick="fillTeleportFromTargetPlayer()">Use Target Player Position</button>
              <button type="button" class="primary" onclick="previewTeleportToPlayer()">Preview To Player</button>
              <button type="button" id="liveTeleportToPlayerButton" onclick="executeTeleportToPlayer()" disabled>Live Teleport To Player</button>
            </div>
            <div id="teleportReadiness" class="warning mt">Live Teleport requires server health, receiver reachability, Settings enablement, and a configured hook.</div>
            <pre id="teleportLog" class="mt">Teleport mode is safe-preview only until a server-specific command hook is configured.</pre>
          </div>
          <div class="panel pad">
            <div class="label">Live Map Diagnostics</div>
            <div class="detail-list mt">
              <div class="detail-row"><span class="subtle">Zoom</span><strong id="liveDebugZoom">--</strong></div>
              <div class="detail-row"><span class="subtle">Leaflet</span><strong id="liveDebugLatLng">--</strong></div>
              <div class="detail-row"><span class="subtle">Dune X/Y</span><strong id="liveDebugDune">--</strong></div>
              <div class="detail-row"><span class="subtle">Players</span><strong id="liveDebugPlayers">0</strong></div>
              <div class="detail-row"><span class="subtle">Vehicles</span><strong id="liveDebugVehicles">0</strong></div>
              <div class="detail-row"><span class="subtle">Bases</span><strong id="liveDebugBases">0</strong></div>
              <div class="detail-row"><span class="subtle">Markers</span><strong id="liveDebugMarkers">0</strong></div>
              <div class="detail-row"><span class="subtle">Position Source</span><strong id="liveDebugPositionSource">--</strong></div>
              <div class="detail-row"><span class="subtle">Entity Source</span><strong id="liveDebugEntitySource">--</strong></div>
            </div>
            <pre id="liveMapLog" class="live-map-log mt">Awaiting live map data.</pre>
          </div>
        </div>
      </div>
    </section>

    <section id="players" class="view">
      <div class="layout-2">
        <div class="panel pad">
          <div class="label">Player Management</div>
          <label class="mt">Search Player<input id="playerSearch" placeholder="Search name, account, character id" oninput="renderPlayers()"></label>
          <div id="playerCards" class="player-list mt"><div class="empty">Loading players...</div></div>
        </div>
        <div class="panel pad">
          <div class="label">Selected Player Details</div>
          <div id="playerDetails" class="empty mt">Select a player to inspect account and character details.</div>
          <div class="label mt">Quick Actions</div>
          <div class="action-row mt">
            <button class="primary" onclick="jumpToGive()">Give Item</button>
            <button onclick="refreshAdmin()">Refresh Players</button>
            <button data-open="logs">View Diagnostics</button>
          </div>
        </div>
      </div>
    </section>

    <section id="give" class="view">
      <div class="layout-2">
        <div class="panel pad">
          <div class="label">Give Item</div>
          <div class="field-grid mt">
            <label>Player<select id="adminPlayer" onchange="syncSelectedPlayerFromSelect()"></select></label>
            <label>Item Template Search<input id="adminSearch" placeholder="Search item name or template" oninput="renderAdminItems()"></label>
            <label>Item Filter<select id="adminItemCategory" onchange="renderAdminItems()"><option value="">All discovered items</option></select></label>
            <label>Quantity<input id="adminQty" type="number" min="1" max="9999" value="1"></label>
            <label>Quality<input id="adminQuality" type="number" min="0" max="100" value="0" oninput="syncQualityWarning()"></label>
            <div id="qualityWarning" class="warning hidden">Quality/grade is unsupported by the live RabbitMQ grant path. Set quality back to 0 before sending a live grant.</div>
            <label>Mode<select id="liveGiveMode" onchange="syncLiveGiveMode()"><option value="dry-run">Dry-Run</option><option value="execute">Live Give</option></select></label>
            <div id="liveGiveServerStatus" class="warning">Server Status: Checking</div>
            <div id="liveGiveTransportStatus" class="warning">Live Give transport: Checking</div>
            <button id="liveGiveStartServerButton" onclick="startServerForGiveItem()">Start Server</button>
            <button id="adminGiveButton" class="primary" onclick="giveAdminItem()">Give Item</button>
            <button onclick="refreshAdmin()">Refresh Admin Data</button>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Item Templates</div>
          <div id="gearDiscoveryStatus" class="empty mt">Item cache status unknown.</div>
          <div class="action-row mt">
            <button onclick="discoverGearItems()">Import Gear Items</button>
            <button onclick="refreshAdmin()">Reload Cache</button>
          </div>
          <div id="adminItems" class="admin-items mt"><div class="empty">Loading item templates...</div></div>
        </div>
      </div>
    </section>

    <section id="env" class="view">
      <div class="env-stack">
        <div class="panel pad">
          <div class="label">Summary / Live Give Status</div>
          <div id="envLiveStatus" class="warning mt">Loading live-give environment status...</div>
          <div id="envMissingVars" class="detail-list mt"></div>
          <div class="action-row mt"><button class="primary" onclick="refreshLiveGiveEnv()">Refresh Env Status</button></div>
        </div>
        <div class="panel pad">
          <div class="label mt">Active Runtime Configuration</div>
          <div id="envRuntimeOverview" class="env-grid mt"></div>
        </div>
        <div class="panel pad">
          <div class="label mt">Loaded Environment Variables</div>
          <div class="env-section-note">Final merged values visible to the packaged backend/runtime. Secrets are redacted but still show whether they are set.</div>
          <div id="envRuntimeValues" class="env-var-list mt"></div>
        </div>
        <div class="panel pad">
          <div class="label">Config Paths</div>
          <div id="envRuntimePaths" class="detail-list mt"></div>
        </div>
        <div class="panel pad">
          <div class="label">Source Priority</div>
          <div id="envSourcePriority" class="detail-list mt"></div>
        </div>
        <div class="panel pad">
          <div class="label">Required Variables Help</div>
          <pre id="envLiveGuide" class="env-help">Reference only. These examples are not the active runtime configuration.

Dry-run mode does not require live transport variables.

HTTP JSON receiver mode usually uses:
DUNE_ADMIN_GIVE_ITEM_URL
DUNE_ADMIN_GIVE_ITEM_HEALTH_URL
DUNE_ADMIN_GIVE_ITEM_TOKEN

Receiver HTTP checks use:
DUNE_RECEIVER_HOST
DUNE_RECEIVER_PORT

SSH/kubectl checks use:
DUNE_RECEIVER_SSH_HOST
DUNE_RECEIVER_SSH_USER
DUNE_RECEIVER_SSH_KEY</pre>
        </div>
      </div>
    </section>

    <section id="admin" class="view">
      <div class="grid four">
        <div class="panel pad"><div class="label">DB</div><div id="adminDbMirror" class="value">Checking...</div></div>
        <div class="panel pad"><div class="label">Players Found</div><div id="adminPlayersFound" class="value">Checking...</div></div>
        <div class="panel pad"><div class="label">Items Loaded</div><div id="adminItemsFound" class="value">Checking...</div></div>
        <div class="panel pad"><div class="label">Live Grants</div><div id="adminLiveMirror" class="value">Checking...</div></div>
      </div>
      <div class="panel pad mt">
        <div class="label">Permission Tools</div>
        <div class="subtle mt">Confirmed systems only: Guild Admin / Object Permissions / Access Codes. This panel does not grant global server admin.</div>
        <div class="layout-2 mt">
          <div class="field-grid">
            <label>Selected Character<select id="permissionPlayer" onchange="syncPermissionPlayer()"></select></label>
            <div id="permissionSummary" class="empty">Select a player to inspect permission state.</div>
            <button onclick="refreshPermissions()">Refresh Permission Views</button>
          </div>
          <div>
            <div class="label">Selected Player Identity</div>
            <div id="permissionIdentity" class="detail-list"><div class="empty">No player selected.</div></div>
          </div>
        </div>
      </div>
      <div class="layout-3 mt">
        <div class="panel pad">
          <div class="label">Guild Admin / Object Permissions</div>
          <div class="subtle mt">Guild admin is read from <strong>guild_members.role_id = 100</strong>. Object ranks come from permission_actor_rank.</div>
          <table class="mt">
            <thead><tr><th>Guild Player</th><th>Guild</th><th>Role ID</th><th>Guild Admin</th></tr></thead>
            <tbody id="guildRows"><tr><td colspan="4">Loading guild members...</td></tr></tbody>
          </table>
          <table class="mt">
            <thead><tr><th>Actor</th><th>Name</th><th>Player</th><th>Rank</th></tr></thead>
            <tbody id="permissionRows"><tr><td colspan="4">Loading object permissions...</td></tr></tbody>
          </table>
        </div>
        <div class="panel pad">
          <div class="label">Access Codes</div>
          <table class="mt">
            <thead><tr><th>Account</th><th>Code</th><th>Type</th><th>Resettable</th></tr></thead>
            <tbody id="accessCodeRows"><tr><td colspan="4">Loading access codes...</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="layout-3 mt">
        <div class="panel pad">
          <div class="label">Set Object Permission Rank</div>
          <div class="field-grid mt">
            <label>Actor ID<input id="permActorId" placeholder="permission_actor.actor_id"></label>
            <label>Player Controller ID<input id="permControllerId" placeholder="player_controller_id"></label>
            <label>Rank<input id="permRank" type="number" min="0" max="100" value="1"></label>
            <label>Map ID<input id="permMapId" value="Survival_1"></label>
            <pre id="permRankPreview">select dune.permission_set_player_rank(actor_id, player_controller_id, rank, 'Survival_1');</pre>
            <label class="check-row"><input id="permRankConfirm" type="checkbox">I confirm this exact function call.</label>
            <button class="primary" onclick="setPermissionRank()">Run Permission Function</button>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Create Server Player Access Code</div>
          <div class="field-grid mt">
            <label>Account ID<input id="accessAccountId" placeholder="accounts.id"></label>
            <label>Access Code<input id="accessCodeValue" type="number" min="0" value="0"></label>
            <label>Access Code Type<input id="accessCodeType" type="number" min="0" value="0"></label>
            <label class="check-row"><input id="accessResettable" type="checkbox" checked>Resettable access code</label>
            <pre id="accessCodePreview">select dune.create_server_player_access_codes(account_id, access_code, access_code_type, true);</pre>
            <label class="check-row"><input id="accessCodeConfirm" type="checkbox">I confirm this exact function call.</label>
            <button class="primary" onclick="createAccessCode()">Run Access Code Function</button>
          </div>
        </div>
      </div>
      <div class="panel pad mt">
        <div class="label">Progression Editing</div>
        <div class="warning mt">Legacy skill/reputation edit controls are disabled. Use Progression Inspector for read-only schema detection. Live XP/reputation editing is not available in this phase.</div>
        <div class="action-row mt"><button type="button" data-open="progression">Open Progression Inspector</button></div>
      </div>
      <div class="panel pad mt">
        <div class="label">Tuned Channels</div>
        <table class="mt">
          <thead><tr><th>Account</th><th>Selected Channel</th><th>Channel</th><th>Tuned</th></tr></thead>
          <tbody id="adminChannels"><tr><td colspan="4">Loading tuned channels...</td></tr></tbody>
        </table>
      </div>
    </section>

    <section id="progression" class="view">
      <div class="grid four">
        <div class="panel pad"><div class="label">Database</div><div id="progressionDbStatus" class="value">Checking...</div><div class="subtle">Progression metadata probe.</div></div>
        <div class="panel pad"><div class="label">Safety</div><div id="progressionSafety" class="value">Read Only</div><div class="subtle">Live editing disabled.</div></div>
        <div class="panel pad"><div class="label">Schema</div><div id="progressionSchema" class="value">Unknown</div><div class="subtle">Detected Dune schema signature.</div></div>
        <div class="panel pad"><div class="label">Duration</div><div id="progressionDuration" class="value">--</div><div class="subtle">Metadata query time.</div></div>
      </div>
      <div class="panel pad mt">
        <div class="panel-head">
          <div><div class="label">Progression / XP Reputation Inspector</div><div class="subtle">Read-only database metadata discovery. No SQL input and no write actions.</div></div>
          <button type="button" onclick="refreshProgressionInspector()">Refresh Inspector</button>
        </div>
        <div id="progressionUnavailable" class="warning mt hidden">Progression database unavailable</div>
        <div class="layout-3 mt">
          <div>
            <div class="label">Support Detection</div>
            <div id="progressionSupportList" class="detail-list mt"><div class="empty">Open or refresh the inspector.</div></div>
          </div>
          <div>
            <div class="label">Safety Status</div>
            <div id="progressionSafetyList" class="detail-list mt">
              <div class="detail-row"><span class="subtle">Read-only mode</span><strong>Active</strong></div>
              <div class="detail-row"><span class="subtle">Live editing</span><strong>Disabled</strong></div>
              <div class="detail-row"><span class="subtle">Raw SQL input</span><strong>Disabled</strong></div>
            </div>
          </div>
          <div>
            <div class="label">Schema Signature</div>
            <pre id="progressionSignature" class="mt">Not loaded.</pre>
          </div>
        </div>
      </div>
      <div class="panel pad mt">
        <div class="panel-head">
          <div><div class="label">Read-Only Player Lookup</div><div class="subtle">Search by character name, player name, actor id, or player id when available.</div></div>
          <span class="badge ok">Read-only</span>
        </div>
        <div class="field-grid mt">
          <label>Player Search<input id="progressionPlayerQuery" placeholder="Character name, actor id, player id"></label>
          <button type="button" class="primary" onclick="lookupProgressionPlayer()">Lookup Player</button>
        </div>
        <div id="progressionPlayerStatus" class="empty mt">No player lookup has been run.</div>
        <div class="layout-3 mt">
          <div>
            <div class="label">Player Identity</div>
            <div id="progressionPlayerIdentity" class="detail-list mt"><div class="empty">No player selected.</div></div>
          </div>
          <div>
            <div class="label">Character XP</div>
            <div id="progressionCharacterXp" class="detail-list mt"><div class="empty">No character XP loaded.</div></div>
          </div>
          <div>
            <div class="label">Warnings</div>
            <div id="progressionPlayerWarnings" class="detail-list mt"><div class="empty">No warnings.</div></div>
          </div>
        </div>
        <div class="label mt">Character XP Detection Debug</div>
        <pre id="progressionCharacterDebug" class="mt">Run a player lookup to inspect actor/entity component paths.</pre>
      </div>
      <div class="panel pad mt">
        <div class="label">Live Progression Editing</div>
        <div class="warning mt">Live progression editing can corrupt player data. Backup first.</div>
        <div class="subtle mt">Generate Preview creates a read-only backup and old/new summary. Apply is blocked unless Settings enables progression editing and you type CONFIRM.</div>
        <div class="field-grid mt">
          <label>Action<select id="progressionAction" onchange="syncProgressionActionFields()"><option value="specialization_xp">Specialization XP</option><option value="faction_reputation">Faction Reputation</option><option value="character_xp_skill_points">Character XP / Skill Points</option></select></label>
          <label class="progression-edit-field progression-specialization">Track Type<input id="progressionTrackType" placeholder="Combat"></label>
          <label class="progression-edit-field progression-specialization">XP Amount<input id="progressionXpAmount" type="number" min="0" max="44182" value="0"></label>
          <label class="progression-edit-field progression-specialization">Level<input id="progressionLevel" type="number" min="0" max="100" step="0.1" value="0"></label>
          <label class="progression-edit-field progression-faction hidden">Faction ID<input id="progressionFactionId" type="number" min="1" value="1"></label>
          <label class="progression-edit-field progression-faction hidden">Reputation<input id="progressionReputationAmount" type="number" min="0" max="12474" value="0"></label>
          <label class="progression-edit-field progression-character hidden">Total XP Earned<input id="progressionTotalXp" type="number" min="0" value="0"></label>
          <label class="progression-edit-field progression-character hidden">Total Skill Points<input id="progressionTotalSkillPoints" type="number" min="0" value="0"></label>
          <label class="progression-edit-field progression-character hidden">Unspent Skill Points<input id="progressionUnspentSkillPoints" type="number" min="0" value="0"></label>
          <label class="progression-edit-field progression-character hidden">Tech Knowledge Points<input id="progressionTechKnowledgePoints" type="number" min="0" value="0"></label>
          <button type="button" onclick="previewProgressionApply()">Generate Preview + Backup</button>
          <label>Type CONFIRM<input id="progressionConfirmText" placeholder="CONFIRM"></label>
          <button type="button" class="danger" onclick="applyProgressionLive()">Apply Live Change</button>
        </div>
        <pre id="progressionPreviewLog" class="mt">No live progression preview generated.</pre>
      </div>
      <div class="layout-2 mt">
        <div class="panel pad">
          <div class="label">Detected Progression Tables</div>
          <table class="mt">
            <thead><tr><th>Schema</th><th>Table</th><th>Status</th></tr></thead>
            <tbody id="progressionTableRows"><tr><td colspan="3">Not loaded.</td></tr></tbody>
          </table>
        </div>
        <div class="panel pad">
          <div class="label">Detected Progression Functions</div>
          <table class="mt">
            <thead><tr><th>Schema</th><th>Function</th><th>Arguments</th><th>Status</th></tr></thead>
            <tbody id="progressionFunctionRows"><tr><td colspan="4">Not loaded.</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="panel pad mt">
        <div class="label">XP / Reputation Related Columns</div>
        <table class="mt">
          <thead><tr><th>Table</th><th>Column</th><th>Type</th><th>Status</th></tr></thead>
          <tbody id="progressionColumnRows"><tr><td colspan="4">Not loaded.</td></tr></tbody>
        </table>
      </div>
      <div class="layout-2 mt">
        <div class="panel pad">
          <div class="label">Specialization Tracks</div>
          <table class="mt">
            <thead><tr><th>Track</th><th>XP</th><th>Level</th></tr></thead>
            <tbody id="progressionSpecRows"><tr><td colspan="3">No player loaded.</td></tr></tbody>
          </table>
        </div>
        <div class="panel pad">
          <div class="label">Faction Reputation</div>
          <table class="mt">
            <thead><tr><th>Faction ID</th><th>Reputation</th></tr></thead>
            <tbody id="progressionFactionRows"><tr><td colspan="2">No player loaded.</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="server" class="view">
      <div class="grid four">
        <div class="panel pad"><div class="label">VM</div><div id="vm" class="value">Checking...</div></div>
        <div class="panel pad"><div class="label">Battlegroup</div><div id="battlegroup" class="value">Checking...</div></div>
        <div class="panel pad"><div class="label">Database</div><div id="sdb" class="value">Checking...</div></div>
        <div class="panel pad"><div class="label">Uptime</div><div id="suptime" class="value">Checking...</div></div>
      </div>
      <div class="panel pad mt">
        <div class="panel-head">
          <div>
            <div class="label">VM Actions</div>
            <div class="subtle">Hyper-V virtual machine state is tracked separately from Battlegroup health.</div>
          </div>
          <button onclick="refreshVmStatus()">Refresh VM</button>
        </div>
        <div class="grid three mt">
          <div class="panel pad"><div class="label">VM Status</div><div id="vmControlStatus" class="value">Checking...</div></div>
        </div>
        <div class="controls mt">
          <button onclick="refreshVmStatus()">Refresh VM</button>
          <button class="primary" onclick="runVmAction('start')">Start VM</button>
          <button class="danger" onclick="runVmAction('stop')">Stop VM</button>
          <button onclick="runVmAction('restart')">Restart VM</button>
        </div>
        <div class="subtle mt"><a href="https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/manage-hyper-v-hosts" target="_blank" rel="noopener">How to fix Hyper-V permissions</a></div>
        <pre id="vmControlLog" class="mt">Ready.</pre>
      </div>
      <div class="panel pad mt">
        <div class="label">Battlegroup Actions</div>
        <div class="controls mt">
          <button onclick="refresh()">Refresh</button>
          <button class="primary" onclick="act('start')">Start Server</button>
          <button onclick="act('restart')">Restart Server</button>
          <button class="danger" onclick="act('stop')">Stop Server</button>
          <button onclick="act('backup')">Backup</button>
          <button onclick="act('update')">Update</button>
          <button onclick="openDirector()">Open Director</button>
          <button onclick="act('logs-export')">Export Logs</button>
          <button onclick="act('operator-logs-export')">Export Operator Logs</button>
        </div>
        <pre id="serverLog" class="mt">Ready.</pre>
      </div>
      <div class="panel pad mt">
        <div class="label">Map Deployment</div>
        <div class="layout-2 mt">
          <div class="field-grid">
            <label>Map<select id="mapSelect"></select></label>
            <label>Replicas<input id="mapReplicas" type="number" min="0" max="3" value="1"></label>
            <div class="action-row"><button class="primary" onclick="deployMap()">Set Map</button><button onclick="stopSelectedMap()">Stop Map</button></div>
          </div>
          <div>
            <div class="grid four">
              <div class="panel pad"><div class="label">Map Group</div><div id="mapBattlegroup" class="value">Checking...</div></div>
              <div class="panel pad"><div class="label">Active</div><div id="activeMaps" class="value">Checking...</div></div>
              <div class="panel pad"><div class="label">Wanted</div><div id="wantedMaps" class="value">Checking...</div></div>
              <div class="panel pad"><div class="label">Memory</div><div id="mapMemory" class="value">Plan</div></div>
            </div>
          </div>
        </div>
        <table class="mt">
          <thead><tr><th>Map</th><th>Type</th><th>Wanted</th><th>Running</th><th>Memory</th></tr></thead>
          <tbody id="mapRows"><tr><td colspan="5">Loading maps...</td></tr></tbody>
        </table>
        <pre id="mapLog" class="mt">Ready.</pre>
      </div>
    </section>

    <section id="database" class="view">
      <div class="grid four">
        <div class="panel pad metric-tile"><div class="label">Database Status</div><div id="dbMgmtStatus" class="value">Checking...</div><div id="dbMgmtStatusDetail" class="subtle">Waiting for refresh.</div></div>
        <div class="panel pad metric-tile"><div class="label">Database Size</div><div id="dbMgmtSize" class="value">--</div><div class="subtle">Reported by PostgreSQL.</div></div>
        <div class="panel pad metric-tile"><div class="label">Connections</div><div id="dbMgmtConnections" class="value">--</div><div class="subtle">Current / active queries.</div></div>
        <div class="panel pad metric-tile"><div class="label">Backup Folder</div><div id="dbMgmtBackupFolderState" class="value">Checking...</div><div class="subtle">Persistent AppData setting.</div></div>
      </div>
      <div class="layout-3 mt">
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Battlegroup Backup</div><div class="subtle">Create a backup using the Dune Self-Hosting Battlegroup backup mechanism.</div></div></div>
          <div class="action-row mt">
            <button class="primary" onclick="createDatabaseBackup()">Create Backup</button>
            <button onclick="createSafetyBackupOnly()">Create Safety Backup Only</button>
            <button onclick="refreshDatabaseManagement()">Refresh</button>
          </div>
          <div id="dbBackupResult" class="empty mt">No backup created in this session.</div>
        </div>
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Import Battlegroup Backup</div><div class="subtle">Import requires the server to be stopped, IMPORT confirmation, and a safety Battlegroup backup first.</div></div></div>
          <div class="field-grid">
            <label>Backup File<input id="dbRestoreFile" placeholder="Choose a Battlegroup .zip, .tar, .backup, .bgbackup, or metadata .json file"></label>
            <label>Confirmation<input id="dbRestoreConfirm" placeholder="Type IMPORT before importing"></label>
          </div>
          <div class="action-row mt">
            <button id="dbChooseRestoreFileButton" onclick="chooseDatabaseRestoreFile()">Choose Backup File</button>
            <button id="dbRestoreButton" class="danger" onclick="restoreDatabaseBackup()">Import Battlegroup Backup</button>
          </div>
          <div id="dbRestoreResult" class="warning mt">Import is destructive. Stop the server, confirm the exact file, and type IMPORT.</div>
          <div id="dbImportReadiness" class="warning mt">Checking import readiness...</div>
          <div id="dbRestoreProgress" class="empty mt">No import job running.</div>
        </div>
      </div>
      <div class="layout-3 mt">
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Backup Location</div><div class="subtle">Choose where local Battlegroup backup metadata and supported copied files are saved.</div></div></div>
          <div class="detail-list">
            <div class="detail-row"><span class="subtle">Current path</span><strong id="dbBackupPath" class="env-path-value">Loading...</strong></div>
            <div class="detail-row"><span class="subtle">Default path</span><strong id="dbBackupDefaultPath" class="env-path-value">Loading...</strong></div>
          </div>
          <div class="action-row mt">
            <button onclick="chooseDatabaseBackupFolder()">Choose Folder</button>
            <button onclick="openDatabaseBackupFolder()">Open Folder</button>
            <button onclick="resetDatabaseBackupFolder()">Reset to Default</button>
          </div>
          <div id="dbLocationResult" class="empty mt">Backup location ready.</div>
        </div>
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Safety / Warnings</div><div class="subtle">Import is guarded and uses the Battlegroup/self-hosted workflow.</div></div></div>
          <div class="warning">Importing a Battlegroup backup can overwrite live server data. Stop the server first. The Suite requires explicit confirmation and creates a pre-import Battlegroup safety backup before any import attempt.</div>
          <div class="detail-list mt">
            <div class="detail-row"><span class="subtle">Import confirmation</span><strong>IMPORT</strong></div>
            <div class="detail-row"><span class="subtle">Safety backup</span><strong>Required before import</strong></div>
            <div class="detail-row"><span class="subtle">Accepted files</span><strong>.zip, .tar, .backup, .bgbackup, .json metadata</strong></div>
            <div class="detail-row"><span class="subtle">Write mode</span><strong>No SQL restore; Battlegroup import only</strong></div>
          </div>
        </div>
      </div>
      <div class="panel pad mt">
        <div class="panel-head"><div><div class="label">Recent Backups</div><div class="subtle">Backups found in the selected backup folder.</div></div><button onclick="refreshDatabaseBackups()">Refresh Backups</button></div>
        <div class="table-wrap"><table><thead><tr><th>Filename</th><th>Date</th><th>Size</th><th>Path</th><th>Actions</th></tr></thead><tbody id="dbBackupRows"><tr><td colspan="5">Loading backups...</td></tr></tbody></table></div>
      </div>
    </section>

    <section id="logs" class="view">
      <div class="layout-3">
        <div class="panel pad"><div class="label">Recent Activity</div><div id="activityFeedLogs" class="activity mt"></div></div>
        <div class="panel pad"><div class="label">Admin Probe and Errors</div><pre id="adminLog">Ready.</pre></div>
      </div>
      <div class="panel pad mt"><div class="label">Server Log</div><pre id="serverLogMirror">Ready.</pre></div>
    </section>

    <section id="management" class="view">
      <div class="panel pad">
        <div class="panel-head">
          <div>
            <div class="label">Server Management</div>
            <div class="subtle mt">Embedded AlphaNine manager tools for server operations.</div>
          </div>
          <button onclick="reloadManagerFrame()">Reload Manager</button>
        </div>
      </div>
      <div class="panel frame-wrap mt">
        <div id="managerFrameStatus" class="panel pad">
          <div class="label">Server Manager</div>
          <div class="value warn mt">Loading...</div>
          <div class="subtle mt">Opening embedded manager console.</div>
        </div>
        <iframe id="managerFrame" src="/manager/" title="AlphaNine Server Management" style="display:none" onload="handleManagerFrameLoad()"></iframe>
      </div>
    </section>

    <section id="codex" class="view">
      <div class="panel pad">
        <div class="panel-head">
          <div>
            <div class="label">Gear Codex</div>
            <div class="subtle mt">Operational item reference for templates, categories, and grant preparation.</div>
          </div>
          <button onclick="document.getElementById('gearCodexFrame').contentWindow.location.reload()">Reload Codex</button>
        </div>
      </div>
      <div class="panel frame-wrap mt"><iframe id="gearCodexFrame" src="/gear-codex/" title="AlphaNine Gear Codex"></iframe></div>
    </section>

    <section id="diagnostics" class="view">
      <div class="layout-3">
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Diagnostics</div><div class="subtle">Database, receiver, API, version, and logs.</div></div><button type="button" onclick="refreshDiagnostics()">Refresh</button></div>
          <div class="detail-list">
            <div class="detail-row"><span class="subtle">Database</span><strong id="diagDatabase">Unknown</strong></div>
            <div class="detail-row"><span class="subtle">Receiver</span><strong id="diagReceiver">Unknown</strong></div>
            <div class="detail-row"><span class="subtle">API</span><strong id="diagApi">Unknown</strong></div>
            <div class="detail-row"><span class="subtle">Version</span><strong id="diagVersion">0.3.0-beta</strong></div>
          </div>
          <div class="test-grid mt">
            <button type="button" onclick="runConnectionTest('database','diagTestDb')">Test Database</button>
            <button type="button" onclick="runConnectionTest('receiver','diagTestReceiver')">Test Receiver</button>
            <button type="button" onclick="runConnectionTest('server','diagTestServer')">Test Server</button>
          </div>
          <div class="test-grid mt">
            <div id="diagTestDb" class="test-result">Database not tested.</div>
            <div id="diagTestReceiver" class="test-result">Receiver not tested.</div>
            <div id="diagTestServer" class="test-result">Server not tested.</div>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Log Viewer</div>
          <select id="diagnosticLogSelect" class="mt" onchange="renderDiagnosticLog()">
            <option value="suite">Suite</option>
            <option value="receiver">Receiver</option>
            <option value="desktop">Desktop Launcher</option>
            <option value="audit">Admin Audit</option>
          </select>
          <pre id="diagnosticLog" class="diagnostic-log mt">Diagnostics not loaded.</pre>
        </div>
      </div>
    </section>

    <section id="settings" class="view">
      <div class="settings-grid">
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Setup</div><div class="subtle">First-launch wizard and connection tests.</div></div><button type="button" onclick="openSetupWizard()">Open Wizard</button></div>
          <div class="test-grid mt">
            <button type="button" onclick="runConnectionTest('database','settingsDbTest')">Test Database</button>
            <button type="button" onclick="runConnectionTest('receiver','settingsReceiverTest')">Test Receiver</button>
            <button type="button" onclick="runConnectionTest('server','settingsServerTest')">Test Server</button>
          </div>
          <div class="test-grid mt">
            <div id="settingsDbTest" class="test-result">Database not tested.</div>
            <div id="settingsReceiverTest" class="test-result">Receiver not tested.</div>
            <div id="settingsServerTest" class="test-result">Server not tested.</div>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Database</div>
          <div class="field-grid mt">
            <label>Host<input id="settingsDatabaseHost"></label>
            <label>Port<input id="settingsDatabasePort" type="number"></label>
            <label>Database<input id="settingsDatabaseName"></label>
            <label>User<input id="settingsDatabaseUser"></label>
            <label>Password<input id="settingsDatabasePassword" type="password" placeholder="Leave blank to keep saved password"></label>
          </div>
        </div>
        <div class="panel pad">
          <div class="panel-head"><div><div class="label">Receiver Management</div><div id="receiverManagerStatus" class="micro">Checking receiver</div></div><button type="button" onclick="refreshReceiverStatus()">Refresh</button></div>
          <div class="field-grid mt">
            <label>Host<input id="settingsReceiverHost"></label>
            <label>Port<input id="settingsReceiverPort" type="number"></label>
            <label>Token<input id="settingsReceiverToken" type="password" placeholder="Leave blank to keep saved token"></label>
            <label>SSH Host<input id="settingsReceiverSshHost"></label>
            <label>SSH User<input id="settingsReceiverSshUser"></label>
            <label>SSH Key<input id="settingsReceiverSshKey"></label>
            <div class="action-row"><button type="button" onclick="browseSshKey('settingsReceiverSshKey','settingsReceiverSshKeyWarning')">Browse SSH Key</button></div>
            <div id="settingsReceiverSshKeyWarning" class="warning">SSH key file not checked.</div>
          </div>
          <div class="action-row mt">
            <button type="button" onclick="receiverAction('start')">Start</button>
            <button type="button" onclick="receiverAction('stop')">Stop</button>
            <button type="button" onclick="receiverAction('restart')">Restart</button>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Network & Server</div>
          <div class="field-grid mt">
            <label>Server Type<select id="settingsServerType"><option value="local-hyperv">Local Windows / Hyper-V</option><option value="remote-vm">Remote VM</option><option value="manual">Manual / Advanced</option></select></label>
            <label>VM Name<input id="settingsVmName"></label>
            <label>VM IP<input id="settingsVmIp"></label>
            <label>SSH User<input id="settingsSshUser"></label>
            <label>SSH Key<input id="settingsSshKey"></label>
            <div class="action-row"><button type="button" onclick="browseSshKey('settingsSshKey','settingsSshKeyWarning')">Browse SSH Key</button></div>
            <div id="settingsSshKeyWarning" class="warning">SSH key file not checked.</div>
            <div class="path-picker-row">
              <label>Dune Server Path<input id="settingsServerInstallPath" onchange="refreshServerInstallPathWarning('settingsServerInstallPath','settingsServerInstallPathWarning')"></label>
              <button type="button" onclick="browseServerInstallPath('settingsServerInstallPath','settingsServerInstallPathWarning')">Browse...</button>
            </div>
            <div id="settingsServerInstallPathWarning" class="warning">Server install path not checked.</div>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Map & Logging</div>
          <div class="field-grid mt">
            <label>Default Map<select id="settingsMapDefault"><option value="HaggaBasin">Hagga Basin</option><option value="DeepDesert">Deep Desert</option><option value="Arrakeen">Arrakeen</option><option value="HarkoVillage">Harko Village</option></select></label>
            <label>Log Level<select id="settingsLogLevel"><option value="info">Info</option><option value="debug">Debug</option><option value="warn">Warnings</option></select></label>
            <label>GitHub Update Repo<input id="settingsUpdateRepo" placeholder="owner/repo"></label>
          </div>
          <div class="action-row mt">
            <button type="button" onclick="checkUpdates()">Check Updates</button>
            <button type="button" onclick="saveSettings()">Save Settings</button>
          </div>
          <div id="settingsSaveStatus" class="empty mt">Settings load automatically.</div>
        </div>
        <div class="panel pad">
          <div class="label">Live Map Teleport</div>
          <div class="field-grid mt">
            <label class="check-row"><input id="settingsLiveTeleportEnabled" type="checkbox">Enable Receiver Live Teleport</label>
            <label>Teleport Endpoint Path<input id="settingsTeleportEndpointPath" placeholder="/api/v1/players/teleport-coords"></label>
            <label>Preview Command Template<input id="settingsTeleportCommandTemplate" placeholder="TeleportToExact {playerId} {x} {y} {z}"></label>
          </div>
          <label class="mt">HTTP JSON Payload Template<textarea id="settingsTeleportPayloadTemplate" rows="9"></textarea></label>
          <div class="warning mt">Live Teleport calls the receiver HTTP JSON endpoint. Coordinate teleport requires a verified Z/elevation. The receiver publishes TeleportToExact for online players and uses the DB offline-position path for offline players.</div>
        </div>
        <div class="panel pad">
          <div class="label">Backup & Restore</div>
          <div class="action-row mt">
            <button type="button" onclick="exportSettings()">Export Settings</button>
            <button type="button" onclick="importSettings()">Import Settings</button>
          </div>
          <textarea id="settingsImportText" rows="8" placeholder="Paste exported settings JSON here"></textarea>
          <pre id="settingsBackupStatus" class="mt">No backup action yet.</pre>
        </div>
        <div class="panel pad">
          <div class="label">Progression Safety</div>
          <div class="warning mt">Enable only when you have a current backup and understand that live progression edits can corrupt player data.</div>
          <div class="field-grid mt">
            <label class="check-row"><input id="settingsProgressionEditingEnabled" type="checkbox">Enable Progression Editing</label>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">App Preferences</div>
          <div class="field-grid mt">
            <label class="check-row"><input id="uiSoundsEnabled" type="checkbox">Enable UI Sounds</label>
            <label>UI Sound Volume <span id="uiSoundVolumeLabel" class="micro">100%</span><input id="uiSoundVolume" type="range" min="0" max="100" value="100"></label>
            <div id="uiSoundStatus" class="empty">Sounds ON. Volume 100%.</div>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Runtime</div>
          <div class="detail-list">
            <div class="detail-row"><span class="subtle">Suite URL</span><strong>http://127.0.0.1:8810</strong></div>
            <div class="detail-row"><span class="subtle">Receiver</span><strong id="settingsReceiver">Checking...</strong></div>
            <div class="detail-row"><span class="subtle">SSH Target</span><strong id="settingsSsh">Unknown</strong></div>
            <div class="detail-row"><span class="subtle">Config</span><strong id="settingsConfigPath">App data</strong></div>
          </div>
        </div>
      </div>
    </section>
  </main>
</div>
<script>
const tabs=[...document.querySelectorAll(".tab")], views=[...document.querySelectorAll(".view")];
const viewCopy={
  dashboard:["Dashboard","Command overview for your self-hosted Arrakis battlegroup."],
  players:["Players","Search, inspect, and select characters for admin actions."],
  give:["Give Item","Live item grants through the configured receiver."],
  admin:["Admin Tools","Diagnostics, tuned channels, and backend probe state."],
  progression:["Progression Inspector","Read-only XP, skill, and reputation schema discovery."],
  database:["Database","Battlegroup backup, import, and backup location management."],
  server:["Server Status","Battlegroup controls, maps, and live server telemetry."],
  "live-map":["Live Map","Leaflet tactical map with server DB overlays."],
  management:["Server Management","Embedded server management console."],
  codex:["Gear Codex","Item template reference and operations catalog."],
  env:["Env Setup","Live Give environment requirements and missing variables."],
  logs:["Logs","Recent grants, probe results, and errors."],
  diagnostics:["Diagnostics","Connection health, version info, and log viewer."],
  settings:["Settings","App-level preferences and local runtime details."]
};
let managerFrameCheckTimer=null;
function setView(name){tabs.forEach(t=>t.classList.toggle("active",t.dataset.view===name));views.forEach(v=>v.classList.toggle("active",v.id===name));const c=viewCopy[name]||viewCopy.dashboard;document.getElementById("viewTitle").textContent=c[0];document.getElementById("viewSubtitle").textContent=c[1];location.hash=name;if(window.uiSoundReady)playUiSound("tab");if(name==="logs")syncLogs();if(name==="give")startGiveItemTool();if(name==="env")refreshLiveGiveEnv();if(name==="live-map")initLiveMap();if(name==="settings")loadSettings();if(name==="diagnostics")refreshDiagnostics();if(name==="progression")refreshProgressionInspector();if(name==="database")refreshDatabaseManagement();if(name==="management")initManagerFrame();}
tabs.forEach(t=>t.addEventListener("click",()=>setView(t.dataset.view)));
document.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.open)));
if(location.hash.slice(1)) setView(location.hash.slice(1));
let adminItems=[],adminItemReport=null,selectedAdminItem=null,adminLiveGiveAvailable=false,adminPlayers=[],selectedPlayerId="",permissionState=null,skillRepState=null,activity=[],liveGiveBusy=false,liveGiveServerOnline=false,liveGiveServerChecking=false,liveGiveServerStarting=false,liveGiveTransport=null,liveGiveUnavailableMessage="",liveGiveEnvDiagnostics=null,liveMap=null,liveMapData=null,liveMapLayerGroup=null,liveSelectedCoordinates=null,liveMarkerCount=0,liveTeleportReady=false,liveTeleportPending=null,liveTeleportPresets=[],setupStep=0,appConfig=null,diagnosticsData=null,progressionPreviewState=null,databaseImportReadiness=null,databaseImportRunning=false;
function esc(value){return String(value||"").replace(/[&<>"']/g,ch=>{if(ch==="&")return"&amp;";if(ch==="<")return"&lt;";if(ch===">")return"&gt;";if(ch==='"')return"&quot;";return"&#39;";});}
function setManagerFrameStatus(title,reason,kind="warn"){const status=document.getElementById("managerFrameStatus");const frame=document.getElementById("managerFrame");if(!status)return;status.style.display="block";if(frame)frame.style.display="none";status.innerHTML='<div class="label">'+esc(title||"Server Manager unavailable.")+'</div><div class="value '+esc(kind)+' mt">'+esc(title||"Server Manager unavailable.")+'</div><div class="subtle mt">Reason:<br>'+esc(reason||"Manager service not running / failed to start.")+'</div>';}
function normalizeManagerFrameTypography(){const frame=document.getElementById("managerFrame");try{const doc=frame&&frame.contentDocument;if(!doc||!doc.head)return;let style=doc.getElementById("alphanine-suite-typography");if(!style){style=doc.createElement("style");style.id="alphanine-suite-typography";doc.head.appendChild(style);}style.textContent=":root{--suite-panel-label:10.5px;--suite-panel-title:16px;--suite-panel-body:12.5px;--suite-panel-value:21px;--suite-panel-subtle:11.5px;--suite-button:12.5px} .panel,.summary,.rail,.group,.server-panel,.reward-panel{font-size:var(--suite-panel-body)!important;line-height:1.42!important}.panel-head h2,.summary h2,.group-title h3,.management-title strong{font-size:var(--suite-panel-title)!important;line-height:1.18!important}.brand-title,.setting-head,.label span,.reward-head span,.reward-panel label,.reward-status,.reward-log,.status-row,.endpoint-help{font-size:var(--suite-panel-subtle)!important}.label strong,.reward-head h3,.setting strong{font-size:13px!important;line-height:1.22!important}.value,.status-row strong{font-size:var(--suite-panel-value)!important;line-height:1.12!important}.btn,.chip,button{font-size:var(--suite-button)!important;line-height:1.18!important;padding:7px 12px!important;min-height:36px!important}input,select,textarea{font-size:12.5px!important}table{font-size:12.5px!important}th{font-size:10.5px!important}td{font-size:12px!important}";}catch{}}
function managerFrameHasContent(){const frame=document.getElementById("managerFrame");try{return Boolean(frame&&frame.contentDocument&&frame.contentDocument.body&&frame.contentDocument.body.innerText.trim());}catch{return false;}}
function handleManagerFrameLoad(){window.clearTimeout(managerFrameCheckTimer);managerFrameCheckTimer=window.setTimeout(checkManagerFrameLoaded,700);}
async function checkManagerFrameLoaded(){const status=document.getElementById("managerFrameStatus");const frame=document.getElementById("managerFrame");try{const service=await fetch("/manager-api/api/server/config",{cache:"no-store"});if(!service.ok){setManagerFrameStatus("Server Manager unavailable.","Manager service not running / failed to start. HTTP "+service.status+" from /manager-api/api/server/config.","bad");return;}const serviceData=await service.json().catch(()=>({}));if(serviceData.warning||serviceData.error){setManagerFrameStatus("Server Manager unavailable.",serviceData.warning||serviceData.error||"Manager service not running / failed to start.","bad");return;}}catch(error){setManagerFrameStatus("Server Manager unavailable.",error&&error.message?error.message:"Manager service not running / failed to start.","bad");return;}if(managerFrameHasContent()){normalizeManagerFrameTypography();if(status)status.style.display="none";if(frame)frame.style.display="block";return;}try{const response=await fetch("/manager/",{cache:"no-store"});if(!response.ok){setManagerFrameStatus("Server Manager unavailable.","HTTP "+response.status+" loading /manager/.","bad");return;}const text=await response.text();if(!text.trim()){setManagerFrameStatus("Server Manager unavailable.","Manager endpoint returned an empty response.","bad");return;}setManagerFrameStatus("Server Manager unavailable.","Embedded manager frame did not finish rendering. The manager endpoint is reachable, but the embedded frame stayed empty. Use Reload Manager or open /manager/ directly.","warn");}catch(error){setManagerFrameStatus("Server Manager unavailable.",error&&error.message?error.message:"Manager service not running / failed to start.","bad");}}
function initManagerFrame(){const status=document.getElementById("managerFrameStatus");const frame=document.getElementById("managerFrame");if(status){status.style.display="block";status.innerHTML='<div class="label">Server Manager</div><div class="value warn mt">Loading...</div><div class="subtle mt">Opening embedded manager console.</div>';}if(frame&&!frame.getAttribute("src"))frame.setAttribute("src","/manager/");window.clearTimeout(managerFrameCheckTimer);managerFrameCheckTimer=window.setTimeout(checkManagerFrameLoaded,3500);}
function reloadManagerFrame(){const frame=document.getElementById("managerFrame");if(!frame)return;const status=document.getElementById("managerFrameStatus");if(status){status.style.display="block";status.innerHTML='<div class="label">Server Manager</div><div class="value warn mt">Loading...</div><div class="subtle mt">Reloading embedded manager console.</div>';}frame.style.display="none";frame.src="/manager/?reload="+Date.now();window.clearTimeout(managerFrameCheckTimer);managerFrameCheckTimer=window.setTimeout(checkManagerFrameLoaded,3500);}
const SERVER_STATUS_ONLINE=["healthy","reconciling","running","updating","starting","progressing","ready"];
const SERVER_STATUS_OFFLINE=["stopped","failed","error","unreachable","missing","offline"];
function mapServerStatusValue(value){const raw=String(value||"").trim();const key=raw.toLowerCase();if(!raw||key==="unknown")return{raw:raw||"Unknown",label:"Warning",kind:"warn",online:false};if(SERVER_STATUS_ONLINE.includes(key))return{raw,label:"Online",kind:"ok",online:true};if(SERVER_STATUS_OFFLINE.includes(key))return{raw,label:"Offline",kind:"bad",online:false};return{raw,label:"Warning",kind:"warn",online:false};}
function mapServerSummary(data){const s=data?.status?.summary||data?.summary||data?.status||{};const phase=mapServerStatusValue(s.phase||s.status);const checks=[s.servergroup,s.gateway,s.director].filter(value=>String(value||"").trim()).map(mapServerStatusValue);if(phase.kind==="bad"||checks.some(check=>check.kind==="bad"))return{label:"Offline",kind:"bad",online:false,phase,checks};if(phase.online&&checks.every(check=>check.kind!=="bad"))return{label:"Online",kind:"ok",online:true,phase,checks};return{label:"Warning",kind:"warn",online:false,phase,checks};}
function statusClass(value){const text=String(value||"");if(/offline|failed|error|missing|not|false|unavailable|unsupported|stopped|unreachable/i.test(text))return"bad";if(/healthy|ready|running|reconciling|updating|starting|progressing|online|enabled|reachable|available|true|detected|connected/i.test(text))return"ok";return"warn";}
function tone(id,value){const el=document.getElementById(id);if(!el)return;el.className="value "+statusClass(value);el.textContent=String(value||"Unknown");}
function badge(id,value){const el=document.getElementById(id);if(!el)return;el.className="badge "+statusClass(value);el.textContent=String(value||"Unknown");}
function telemetryPercent(value){const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=100?number:null;}
function setResourceMetric(key,value){const percent=telemetryPercent(value);const label=document.getElementById("resource"+key);const bar=document.getElementById("resource"+key+"Bar");if(label)label.textContent=percent===null?"Unknown":Math.round(percent)+"%";if(bar)bar.style.width=percent===null?"0%":Math.max(0,Math.min(100,percent))+"%";}
function telemetrySourceLabel(source){const text=String(source||"").toLowerCase();if(text==="local"||text==="local pc")return"Local PC";if(text==="remote"||text==="vm"||text==="remote vm")return"Remote VM";if(text==="receiver")return"Receiver";return"Unknown";}
function renderServerResources(telemetry){const data=telemetry&&typeof telemetry==="object"?telemetry:null;const source=telemetrySourceLabel(data?.source);setText("resourceSource","Source: "+source);setResourceMetric("Cpu",data?.cpuPercent??data?.cpu);setResourceMetric("Memory",data?.memoryPercent??data?.memory);setResourceMetric("Disk",data?.diskPercent??data?.disk);setResourceMetric("Network",data?.networkPercent??data?.network);return Boolean(data&&source!=="Unknown"&&[data.cpuPercent??data.cpu,data.memoryPercent??data.memory,data.diskPercent??data.disk,data.networkPercent??data.network].some(value=>telemetryPercent(value)!==null));}
function addActivity(type,message,detail){const item={time:new Date().toLocaleTimeString(),type,message,detail:detail||""};activity.unshift(item);activity=activity.slice(0,40);renderActivity();}
const LIVE_MAP_IMAGE={width:4096,height:4096};
const LIVE_MAP_CONFIGS={
  HaggaBasin:{key:"HaggaBasin",label:"Hagga Basin",minX:-437871,maxX:350539,minY:-462011,maxY:376267,flipY:true},
  DeepDesert:{key:"DeepDesert",label:"Deep Desert",minX:-1300000,maxX:1200000,minY:-1300000,maxY:1200000},
  Arrakeen:{key:"Arrakeen",label:"Arrakeen",minX:-32000,maxX:17000,minY:-10000,maxY:9500,flipY:true},
  HarkoVillage:{key:"HarkoVillage",label:"Harko Village",minX:-5000,maxX:14500,minY:-5500,maxY:32000}
};
let liveMapKey="HaggaBasin";
function liveMapConfig(){return LIVE_MAP_CONFIGS[liveMapKey]||LIVE_MAP_CONFIGS.HaggaBasin;}
function liveMapBounds(){return [[0,0],[LIVE_MAP_IMAGE.height,LIVE_MAP_IMAGE.width]];}
function clampLiveUnit(value){if(value<0)return 0;if(value>1)return 1;return value;}
function worldToLiveLatLng(x,y,cfg=liveMapConfig()){const nx=(Number(x)-cfg.minX)/(cfg.maxX-cfg.minX);const ny=(Number(y)-cfg.minY)/(cfg.maxY-cfg.minY);const fx=clampLiveUnit(cfg.flipX?1-nx:nx);const fy=clampLiveUnit(cfg.flipY?1-ny:ny);return [fy*LIVE_MAP_IMAGE.height,fx*LIVE_MAP_IMAGE.width];}
function liveLatLngToWorld(latlng,cfg=liveMapConfig()){const fx=Number(latlng.lng)/LIVE_MAP_IMAGE.width;const fy=Number(latlng.lat)/LIVE_MAP_IMAGE.height;const rx=cfg.flipX?1-fx:fx;const ry=cfg.flipY?1-fy:fy;return {x:rx*(cfg.maxX-cfg.minX)+cfg.minX,y:ry*(cfg.maxY-cfg.minY)+cfg.minY};}
function leafletToDune(latlng){return liveLatLngToWorld(latlng);}
function duneToLeaflet(x,y){return worldToLiveLatLng(x,y);}
function formatLiveCoord(value){const number=Number(value);return Number.isFinite(number)?number.toFixed(2):"--";}
function initLiveMap(){if(!window.L){setText("liveMapStamp","Leaflet unavailable");return;}const el=document.getElementById("liveMapCanvas");if(!el)return;if(!liveMap){liveMap=L.map(el,{crs:L.CRS.Simple,minZoom:-3,maxZoom:4,zoomSnap:.25,zoomDelta:.5,zoomControl:true});const bounds=liveMapBounds();L.imageOverlay("/assets/world-map-overland.png",bounds,{maxZoom:4,maxNativeZoom:4,noWrap:true}).addTo(liveMap);liveMap.fitBounds(bounds);liveMapLayerGroup=L.layerGroup().addTo(liveMap);const readout=document.createElement("div");readout.id="liveMouseReadout";readout.className="live-map-coordinate-readout";readout.textContent="X -- / Y --";el.appendChild(readout);liveMap.on("mousemove",event=>updateLiveMouseCoordinates(event.latlng));liveMap.on("click",event=>selectLiveCoordinates(event.latlng,{fillTeleport:true}));liveMap.on("zoomend moveend",()=>updateLiveMapDebug());}setTimeout(()=>{liveMap.invalidateSize();updateLiveMapDebug();},80);loadTeleportPresets();refreshLiveMap();refreshTeleportReadiness();}
function liveMapChecked(id){const el=document.getElementById(id);return !el||el.checked;}
function liveMapProject(entity){const x=Number(entity.x),y=Number(entity.y);if(!Number.isFinite(x)||!Number.isFinite(y))return null;return duneToLeaflet(x,y);}
function liveMapIcon(kind){return L.divIcon({className:"",html:'<div class="live-map-marker '+kind+'" style="width:14px;height:14px"></div>',iconSize:[14,14],iconAnchor:[7,7]});}
function liveTeleportPlayerId(row){return row?.fls_id||row?.funcom_id||row?.player_controller_id||"";}
function liveMapPlayerKeys(row){return [row?.fls_id,row?.funcom_id,row?.player_controller_id,row?.id,row?.account_id,row?.name].filter(value=>value!==undefined&&value!==null&&String(value).trim()).map(value=>String(value).trim());}
function sameLiveMapPlayer(row,playerId){const target=String(playerId||"").trim();return Boolean(target)&&liveMapPlayerKeys(row).includes(target);}
function findLiveMapPlayerByTeleportId(playerId){return (liveMapData?.layers?.players||[]).find(row=>sameLiveMapPlayer(row,playerId))||null;}
function liveMapPosition(row){if(!row)return null;const x=Number(row.x),y=Number(row.y),z=Number(row.z);if(!Number.isFinite(x)||!Number.isFinite(y))return null;return {x,y,z:Number.isFinite(z)?z:null};}
function liveMapDistance(a,b){if(!a||!b)return Number.POSITIVE_INFINITY;return Math.hypot(Number(a.x)-Number(b.x),Number(a.y)-Number(b.y));}
function formatLivePosition(pos){return pos?("X "+Math.round(Number(pos.x))+" / Y "+Math.round(Number(pos.y))+" / Z "+(Number.isFinite(Number(pos.z))?Math.round(Number(pos.z)):"--")):"unknown";}
function clearCachedTeleportPlayer(playerId){if(!liveMapData?.layers?.players)return;liveMapData.layers.players=liveMapData.layers.players.filter(row=>!sameLiveMapPlayer(row,playerId));}
function renderPendingTeleportMarker(){if(!liveTeleportPending||!liveMapLayerGroup||!liveMapChecked("liveLayerPlayers"))return 0;const target=liveTeleportPending.target;if(!target)return 0;const point=duneToLeaflet(target.x,target.y);const marker=L.marker(point,{icon:L.divIcon({className:"",html:'<div class="live-map-marker pending" style="width:18px;height:18px"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).bindPopup('<strong>Teleport pending</strong><br>Teleport sent, waiting for server position update...<br>'+esc(formatLivePosition(target)));marker.addTo(liveMapLayerGroup);return 1;}
function reconcileTeleportPending(){if(!liveTeleportPending)return;const player=findLiveMapPlayerByTeleportId(liveTeleportPending.playerId);const next=liveMapPosition(player);if(!next)return;const movedFromOld=!liveTeleportPending.oldPosition||liveMapDistance(next,liveTeleportPending.oldPosition)>2;const nearTarget=liveMapDistance(next,liveTeleportPending.target)<50;if(movedFromOld||nearTarget){const detail="Player "+liveTeleportPending.playerId+" old "+formatLivePosition(liveTeleportPending.oldPosition)+" -> new "+formatLivePosition(next);console.debug("[AlphaNine Live Map] teleport position refresh",{playerId:liveTeleportPending.playerId,oldPosition:liveTeleportPending.oldPosition,newPosition:next,target:liveTeleportPending.target});addActivity("maps","Teleport position confirmed",detail);const log=document.getElementById("teleportLog");if(log&&!/Server position confirmed/.test(log.textContent||""))log.textContent+=(log.textContent?"\n\n":"")+"Server position confirmed.\n"+detail;liveTeleportPending=null;}}
function addLiveMapMarkers(kind,rows){const enabled={players:liveMapChecked("liveLayerPlayers"),vehicles:liveMapChecked("liveLayerVehicles"),bases:liveMapChecked("liveLayerBases")}[kind];if(!enabled)return 0;let count=0;(rows||[]).forEach(row=>{const point=liveMapProject(row);if(!point)return;count+=1;const marker=L.marker(point,{icon:liveMapIcon(kind.slice(0,-1)||kind),draggable:kind==="players"}).bindPopup('<strong>'+esc(row.name||row.id||kind)+'</strong><br>'+esc(row.source||"DB")+'<br>X '+esc(formatLiveCoord(row.x))+' / Y '+esc(formatLiveCoord(row.y))+(row.z!=null?' / Z '+esc(row.z):'')+(kind==="players"?'<br>Drag marker to preview teleport.':''));marker.on("click",()=>{if(kind==="players"){const playerId=liveTeleportPlayerId(row);const input=document.getElementById("teleportPlayerId");const targetInput=document.getElementById("teleportTargetPlayerId");if(input&&!input.value&&playerId)input.value=playerId;else if(targetInput&&!targetInput.value&&playerId)targetInput.value=playerId;}selectLiveCoordinates({lat:point[0],lng:point[1]},{fillTeleport:false});});if(kind==="players")marker.on("dragend",event=>{const dragged=event.target;const next=dragged.getLatLng();dragged.setLatLng(point);const coords=leafletToDune(next);const playerId=liveTeleportPlayerId(row);const input=document.getElementById("teleportPlayerId");if(input&&playerId)input.value=playerId;const tx=document.getElementById("teleportX");const ty=document.getElementById("teleportY");const tz=document.getElementById("teleportZ");if(tx)tx.value=String(Math.round(coords.x));if(ty)ty.value=String(Math.round(coords.y));selectLiveCoordinates(next,{fillTeleport:false});const log=document.getElementById("teleportLog");if(log)log.textContent="Drag teleport preview armed. Marker snapped back until Preview Teleport is sent.\\nPlayer: "+(playerId||"FLS ID unavailable")+"\\nX "+Math.round(coords.x)+" / Y "+Math.round(coords.y)+"\\nEnter a verified Z/elevation before live teleport.";playUiSound("click");});marker.addTo(liveMapLayerGroup);});return count;}
function renderLiveMapLayers(){if(!liveMap||!liveMapLayerGroup||!liveMapData)return;reconcileTeleportPending();liveMapLayerGroup.clearLayers();liveMarkerCount=0;const playerRows=liveTeleportPending?(liveMapData.layers?.players||[]).filter(row=>!sameLiveMapPlayer(row,liveTeleportPending.playerId)):liveMapData.layers?.players;liveMarkerCount+=addLiveMapMarkers("players",playerRows);liveMarkerCount+=addLiveMapMarkers("vehicles",liveMapData.layers?.vehicles);liveMarkerCount+=addLiveMapMarkers("bases",liveMapData.layers?.bases);liveMarkerCount+=renderPendingTeleportMarker();updateLiveMapDebug();}
function updateLiveMouseCoordinates(latlng){const coords=leafletToDune(latlng);const readout=document.getElementById("liveMouseReadout");if(readout)readout.textContent="X "+formatLiveCoord(coords.x)+" / Y "+formatLiveCoord(coords.y);}
function selectLiveCoordinates(latlng,options={}){const coords=leafletToDune(latlng);liveSelectedCoordinates={...coords,lat:Number(latlng.lat),lng:Number(latlng.lng)};setText("liveClickedX",formatLiveCoord(coords.x));setText("liveClickedY",formatLiveCoord(coords.y));const searchX=document.getElementById("liveSearchX");const searchY=document.getElementById("liveSearchY");if(searchX)searchX.value=formatLiveCoord(coords.x);if(searchY)searchY.value=formatLiveCoord(coords.y);if(options.fillTeleport){const teleportX=document.getElementById("teleportX");const teleportY=document.getElementById("teleportY");if(teleportX)teleportX.value=String(Math.round(coords.x));if(teleportY)teleportY.value=String(Math.round(coords.y));}updateLiveMapDebug(latlng);}
async function copyLiveCoordinates(){if(!liveSelectedCoordinates){playUiSound("warning");return;}const text="X "+formatLiveCoord(liveSelectedCoordinates.x)+", Y "+formatLiveCoord(liveSelectedCoordinates.y);try{await navigator.clipboard.writeText(text);playUiSound("success");addActivity("maps","Coordinates copied",text);}catch{playUiSound("warning");}}
function goToLiveCoordinates(){if(!liveMap)return;const x=Number(document.getElementById("liveSearchX")?.value);const y=Number(document.getElementById("liveSearchY")?.value);if(!Number.isFinite(x)||!Number.isFinite(y)){playUiSound("warning");return;}const point=duneToLeaflet(x,y);liveMap.setView(point,Math.max(liveMap.getZoom(),2));selectLiveCoordinates({lat:point[0],lng:point[1]},{fillTeleport:true});playUiSound("click");}
async function loadTeleportPresets(){try{const data=await getJson("/api/live-map/teleport/presets");liveTeleportPresets=data.presets||[];const select=document.getElementById("teleportPreset");if(!select)return;select.innerHTML='<option value="">Manual coordinates</option>'+liveTeleportPresets.map((preset,index)=>'<option value="'+index+'">'+esc(preset.name)+' / '+esc(preset.map)+' / Z '+esc(preset.z)+'</option>').join("");if(!liveTeleportPresets.length)select.innerHTML+='<option value="" disabled>No enabled presets found</option>';}catch(e){const log=document.getElementById("teleportLog");if(log)log.textContent="Location presets unavailable. "+betterError(e);}}
function applyTeleportPreset(){const select=document.getElementById("teleportPreset");const preset=liveTeleportPresets[Number(select?.value)];if(!preset)return;setValue("teleportX",preset.x);setValue("teleportY",preset.y);setValue("teleportZ",preset.z);setValue("teleportPartitionId",preset.partition_id||0);const point=duneToLeaflet(preset.x,preset.y);if(liveMap)liveMap.setView(point,Math.max(liveMap.getZoom(),2));selectLiveCoordinates({lat:point[0],lng:point[1]},{fillTeleport:false});const log=document.getElementById("teleportLog");if(log)log.textContent="Loaded verified location preset: "+preset.name+"\\n"+formatLivePosition(preset);playUiSound("click");}
function findLiveMapPlayerByAnyId(playerId){return findLiveMapPlayerByTeleportId(playerId);}
function fillTeleportFromTargetPlayer(){const targetId=document.getElementById("teleportTargetPlayerId")?.value||"";const target=findLiveMapPlayerByAnyId(targetId);const pos=liveMapPosition(target);if(!target||!pos){const message="Target player position unavailable. Refresh Live Map and choose a player with known X/Y/Z.";document.getElementById("teleportLog").textContent=message;playUiSound("warning");return null;}if(!Number.isFinite(Number(pos.z))||Number(pos.z)===0){const message="Target player has no valid Z/elevation. Teleport to Player requires known X/Y/Z.";document.getElementById("teleportLog").textContent=message;playUiSound("warning");return null;}setValue("teleportX",pos.x);setValue("teleportY",pos.y);setValue("teleportZ",pos.z);setValue("teleportPartitionId",target.partition_id||target.partitionId||0);const point=duneToLeaflet(pos.x,pos.y);if(liveMap)liveMap.setView(point,Math.max(liveMap.getZoom(),2));selectLiveCoordinates({lat:point[0],lng:point[1]},{fillTeleport:false});document.getElementById("teleportLog").textContent="Loaded target player position for "+(target.name||target.character_name||targetId)+"\\n"+formatLivePosition(pos);playUiSound("click");return target;}
async function previewTeleportToPlayer(){if(!fillTeleportFromTargetPlayer())return;await previewTeleport();}
async function executeTeleportToPlayer(){if(!fillTeleportFromTargetPlayer())return;await executeLiveTeleport();}
function updateLiveMapDebug(latlng){const selected=latlng?leafletToDune(latlng):liveSelectedCoordinates;setText("liveDebugZoom",liveMap?String(liveMap.getZoom().toFixed(2)):"--");if(latlng)setText("liveDebugLatLng",formatLiveCoord(latlng.lat)+", "+formatLiveCoord(latlng.lng));else if(liveSelectedCoordinates)setText("liveDebugLatLng",formatLiveCoord(liveSelectedCoordinates.lat)+", "+formatLiveCoord(liveSelectedCoordinates.lng));else setText("liveDebugLatLng","--");setText("liveDebugDune",selected?("X "+formatLiveCoord(selected.x)+" / Y "+formatLiveCoord(selected.y)):"--");const debug=liveMapData?.debug||{};const loaded=Number(debug.playersLoaded??(liveMapData?.layers?.players||[]).length)||0;const positioned=Number(debug.playersWithPosition??debug.playersWithCoordinates??0)||0;const counts=debug.counts||{players:(liveMapData?.layers?.players||[]).length,vehicles:(liveMapData?.layers?.vehicles||[]).length,bases:(liveMapData?.layers?.bases||[]).length};setText("liveDebugPlayers","Loaded "+loaded+", positioned "+positioned);setText("liveDebugVehicles",String(counts.vehicles||0)+" / "+(debug.entitySources?.vehicles||"unknown"));setText("liveDebugBases",String(counts.bases||0)+" / "+(debug.entitySources?.bases||"unknown"));setText("liveDebugMarkers",String(liveMarkerCount));setText("liveDebugPositionSource",debug.positionSourceTable||"--");setText("liveDebugEntitySource","Vehicles "+(debug.entitySources?.vehicles||"--")+" / Bases "+(debug.entitySources?.bases||"--"));}
async function refreshLiveMap(){if(!liveMap)return;try{const data=await getJson("/api/live-map/entities");liveMapData=data;renderLiveMapLayers();const counts={players:(data.layers?.players||[]).length,vehicles:(data.layers?.vehicles||[]).length,bases:(data.layers?.bases||[]).length};const debug=data.debug||{};const loaded=Number(debug.playersLoaded??counts.players)||0;const valid=Number(debug.playersWithPosition??debug.playersWithCoordinates??counts.players)||0;const warning=document.getElementById("livePlayerPositionWarning");const entityWarning=document.getElementById("liveEntityAvailability");const playerWord=loaded===1?"player":"players";if(warning){warning.classList.toggle("hidden",!(loaded>0&&valid===0));warning.textContent="Loaded "+loaded+" "+playerWord+", "+valid+" with coordinates";}const vehicleSource=debug.entitySources?.vehicles||"unavailable";const baseSource=debug.entitySources?.bases||"unavailable";const entityUnavailable=counts.vehicles===0&&counts.bases===0&&vehicleSource!=="real"&&baseSource!=="real";if(entityWarning){entityWarning.classList.toggle("hidden",!entityUnavailable);entityWarning.textContent=entityUnavailable?"Bases/vehicles data not available from server yet.":"";}console.debug("[AlphaNine Live Map] entity counts",{players:counts.players,vehicles:counts.vehicles,bases:counts.bases,playersLoaded:loaded,playersWithCoordinates:valid,entitySources:debug.entitySources||{}});setText("liveMapStamp","Loaded "+loaded+" "+playerWord+", "+valid+" with coordinates / Vehicles "+counts.vehicles+" / Bases "+counts.bases);document.getElementById("liveMapLog").textContent=JSON.stringify({counts,entitySources:debug.entitySources||{},debug,sources:data.sources||[],errors:data.errors||[],raw:data},null,2);updateLiveMapDebug();addActivity("maps","Live map refreshed",loaded+" players / "+valid+" positioned / "+counts.vehicles+" vehicles / "+counts.bases+" bases / "+liveMarkerCount+" markers");}catch(e){setText("liveMapStamp","Live map error");document.getElementById("liveMapLog").textContent=betterError(e);addActivity("error","Live map failed",e.message);}}
function teleportPayload(){const p=selectedPlayer();return{playerId:document.getElementById("teleportPlayerId").value,characterName:p?.character_name||p?.name||"",x:document.getElementById("teleportX").value,y:document.getElementById("teleportY").value,z:document.getElementById("teleportZ").value,partitionId:document.getElementById("teleportPartitionId")?.value||0,map:"HaggaBasin"};}
function renderTeleportResult(data){return (data.message||data.error||data.status||"Teleport response")+(data.warning?"\\nWarning: "+data.warning:"")+"\\nEndpoint: "+(data.endpoint||"-")+"\\nCommand: "+(data.command||"-")+"\\nPayload:\\n"+JSON.stringify(data.request||{},null,2)+(data.response?"\\n\\nReceiver response:\\n"+JSON.stringify(data.response,null,2):"")+(data.reasons?.length?"\\n\\nReadiness:\\n"+data.reasons.join("\\n"):"");}
async function refreshAfterTeleport(payload,data){if(!data?.ok||!liveMap)return;const playerId=String(payload.playerId||data.request?.playerId||data.request?.fls_id||"").trim();const target={x:Number(data.request?.x??payload.x),y:Number(data.request?.y??payload.y),z:Number(data.request?.z??payload.z)};if(!playerId||!Number.isFinite(target.x)||!Number.isFinite(target.y))return;const oldPosition=liveMapPosition(findLiveMapPlayerByTeleportId(playerId));liveTeleportPending={playerId,target:{x:target.x,y:target.y,z:Number.isFinite(target.z)?target.z:null},oldPosition,sentAt:Date.now()};console.debug("[AlphaNine Live Map] teleport sent, refreshing player position",{playerId,oldPosition,target:liveTeleportPending.target});addActivity("maps","Teleport sent, waiting for server position update","Player "+playerId+" target "+formatLivePosition(liveTeleportPending.target));clearCachedTeleportPlayer(playerId);renderLiveMapLayers();const log=document.getElementById("teleportLog");if(log)log.textContent+=(log.textContent?"\\n\\n":"")+"Teleport sent, waiting for server position update...";await refreshLiveMap();}
async function refreshTeleportReadiness(){const button=document.getElementById("liveTeleportButton");const playerButton=document.getElementById("liveTeleportToPlayerButton");const status=document.getElementById("teleportReadiness");try{const data=await getJson("/api/live-map/teleport/status");liveTeleportReady=Boolean(data.canTeleport);if(button)button.disabled=!liveTeleportReady;if(playerButton)playerButton.disabled=!liveTeleportReady;if(status){status.className=liveTeleportReady?"empty mt":"warning mt";status.textContent=liveTeleportReady?"Live Teleport ready: server healthy, receiver reachable, and hook configured.":(data.reasons||["Live Teleport unavailable."]).join(" ");}return data;}catch(e){liveTeleportReady=false;if(button)button.disabled=true;if(playerButton)playerButton.disabled=true;if(status){status.className="warning mt";status.textContent=betterError(e);}return null;}}
async function previewTeleport(){const payload=teleportPayload();try{const data=await getJson("/api/live-map/teleport",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("teleportLog").textContent=renderTeleportResult(data);await refreshTeleportReadiness();playUiSound("success");}catch(e){document.getElementById("teleportLog").textContent=betterError(e);playUiSound("warning");}}
async function executeLiveTeleport(){const payload=teleportPayload();try{const ready=await refreshTeleportReadiness();if(!ready?.canTeleport)throw new Error((ready?.reasons||["Live Teleport unavailable."]).join(" "));const data=await getJson("/api/live-map/teleport/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("teleportLog").textContent=renderTeleportResult(data);playUiSound(data.ok?"success":"warning");await refreshAfterTeleport(payload,data);}catch(e){document.getElementById("teleportLog").textContent=betterError(e);playUiSound("warning");}finally{refreshTeleportReadiness();}}
function renderActivity(){const html=activity.length?activity.map(a=>'<div class="activity-item"><div class="activity-time">'+esc(a.time)+' / '+esc(a.type)+'</div><strong>'+esc(a.message)+'</strong>'+(a.detail?'<div class="subtle">'+esc(a.detail)+'</div>':'')+'</div>').join(""):'<div class="empty">No activity yet.</div>';document.getElementById("activityFeed").innerHTML=html;const logs=document.getElementById("activityFeedLogs");if(logs)logs.innerHTML=html;}
function syncLogs(){const server=document.getElementById("serverLog");const mirror=document.getElementById("serverLogMirror");if(server&&mirror)mirror.textContent=server.textContent;}
async function getJson(url, options={}){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(options.timeoutMs||15000));let r,t="",d={};try{const request={...options,signal:controller.signal};delete request.timeoutMs;r=await fetch(url,request);try{t=await r.text();}catch(error){throw new Error("Request body read failed for "+url+": "+error.message);}try{d=t?JSON.parse(t):{};}catch{d={raw:t};}if(!r.ok)throw new Error(d.error||d.message||t||("Request failed for "+url+" with HTTP "+r.status));return d;}catch(error){if(error.name==="AbortError")throw new Error("Request timed out for "+url);if(error instanceof TypeError)throw new Error("Network request failed for "+url+": "+error.message);throw error;}finally{clearTimeout(timeout);}}
function setValue(id,value){const el=document.getElementById(id);if(el)el.value=value==null?"":String(value);}
function getValue(id){return document.getElementById(id)?.value||"";}
function setChecked(id,value){const el=document.getElementById(id);if(el)el.checked=Boolean(value);}
function resultBox(id,data){const el=document.getElementById(id);if(!el)return;el.className="test-result "+(data.ok?"ok":"bad");el.textContent=(data.message||data.status||data.error||"Done")+(data.error?"\\n"+data.error:"");}
function configPayload(prefix){const payload={serverType:getValue(prefix+"ServerType"),vmName:getValue(prefix+"VmName"),vmIp:getValue(prefix+"VmIp"),serverInstallPath:getValue(prefix+"ServerInstallPath"),databaseHost:getValue(prefix+"DatabaseHost"),databasePort:getValue(prefix+"DatabasePort"),databaseName:getValue(prefix+"DatabaseName"),databaseUser:getValue(prefix+"DatabaseUser"),receiverHost:getValue(prefix+"ReceiverHost"),receiverPort:getValue(prefix+"ReceiverPort"),receiverSshHost:getValue(prefix+"ReceiverSshHost"),receiverSshUser:getValue(prefix+"ReceiverSshUser"),receiverSshKey:getValue(prefix+"ReceiverSshKey")};const dbPass=getValue(prefix+"DatabasePassword");const token=getValue(prefix+"ReceiverToken");if(dbPass&&dbPass!=="********")payload.databasePassword=dbPass;if(token&&token!=="********")payload.receiverToken=token;return payload;}
function fillSetup(config){setValue("setupServerType",config.serverType||"local-hyperv");setValue("setupServerInstallPath",config.serverInstallPath||"");setValue("setupVmName",config.vmName||"");setValue("setupVmIp",config.vmIp||"");setValue("setupDatabaseHost",config.databaseHost||"");setValue("setupDatabasePort",config.databasePort||15432);setValue("setupDatabaseName",config.databaseName||"dune");setValue("setupDatabaseUser",config.databaseUser||"postgres");setValue("setupReceiverHost",config.receiverHost||"127.0.0.1");setValue("setupReceiverPort",config.receiverPort||5055);setValue("setupReceiverSshHost",config.receiverSshHost||config.vmIp||"");setValue("setupReceiverSshUser",config.receiverSshUser||config.sshUser||"dune");setValue("setupReceiverSshKey",config.receiverSshKey||config.sshKey||"");setServerInstallPathWarning("setupServerInstallPathWarning",config.serverInstallPathStatus);}
function setSshKeyWarning(id,status){const el=document.getElementById(id);if(!el)return;const ok=Boolean(status?.exists);el.className=ok?"empty mt":"warning mt";el.textContent=status?.message||"SSH key file not found.";if(status?.path)el.textContent+=" "+status.path;}
async function refreshSshKeyWarning(inputId,warningId){try{const path=getValue(inputId);const data=await getJson("/api/ssh-key/status?path="+encodeURIComponent(path));setSshKeyWarning(warningId,data.sshKey);}catch(e){setSshKeyWarning(warningId,{exists:false,message:betterError(e)});}}
async function browseSshKey(inputId,warningId){try{if(!window.alphaNineSuite?.chooseSshKey)throw new Error("File picker is not available in this desktop build.");const result=await window.alphaNineSuite.chooseSshKey();if(result?.filePath){setValue(inputId,result.filePath);await refreshSshKeyWarning(inputId,warningId);}}catch(e){setSshKeyWarning(warningId,{exists:false,message:betterError(e)});}}
function setServerInstallPathWarning(id,status){const el=document.getElementById(id);if(!el)return;const ok=Boolean(status?.valid);el.className=ok?"empty mt":"warning mt";let text=status?.message||"Selected folder does not appear to be a valid Dune Awakening server installation.";if(status?.path)text+=" "+status.path;const checks=(status?.checks||[]).filter(item=>item.ok).map(item=>item.name);if(checks.length)text+="\nDetected: "+checks.join(", ");el.textContent=text;}
async function refreshServerInstallPathWarning(inputId,warningId){try{const path=getValue(inputId);const data=await getJson("/api/server-install-path/status?path="+encodeURIComponent(path));setServerInstallPathWarning(warningId,data.serverInstallPath);}catch(e){setServerInstallPathWarning(warningId,{valid:false,message:betterError(e)});}}
async function browseServerInstallPath(inputId,warningId){try{if(!window.alphaNineSuite?.chooseServerInstallFolder)throw new Error("Folder picker is not available in this desktop build.");const result=await window.alphaNineSuite.chooseServerInstallFolder();if(result?.folderPath){setValue(inputId,result.folderPath);await refreshServerInstallPathWarning(inputId,warningId);}}catch(e){setServerInstallPathWarning(warningId,{valid:false,message:betterError(e)});}}
function fillSettings(config){appConfig=config;setValue("settingsServerType",config.serverType||"local-hyperv");setValue("settingsVmName",config.vmName||"");setValue("settingsVmIp",config.vmIp||"");setValue("settingsSshUser",config.sshUser||"dune");setValue("settingsSshKey",config.sshKey||"");setValue("settingsServerInstallPath",config.serverInstallPath||"");setValue("settingsDatabaseHost",config.databaseHost||"");setValue("settingsDatabasePort",config.databasePort||15432);setValue("settingsDatabaseName",config.databaseName||"dune");setValue("settingsDatabaseUser",config.databaseUser||"postgres");setValue("settingsReceiverHost",config.receiverHost||"127.0.0.1");setValue("settingsReceiverPort",config.receiverPort||5055);setValue("settingsReceiverSshHost",config.receiverSshHost||"");setValue("settingsReceiverSshUser",config.receiverSshUser||"dune");setValue("settingsReceiverSshKey",config.receiverSshKey||"");setValue("settingsMapDefault",config.mapDefault||"HaggaBasin");setValue("settingsLogLevel",config.logLevel||"info");setValue("settingsUpdateRepo",config.updateRepo||"");setChecked("settingsLiveTeleportEnabled",config.liveTeleportEnabled===true);setValue("settingsTeleportEndpointPath",config.teleportEndpointPath||"/api/v1/players/teleport-coords");setValue("settingsTeleportCommandTemplate",config.teleportCommandTemplate||"");setValue("settingsTeleportPayloadTemplate",config.teleportPayloadTemplate||"");setChecked("settingsProgressionEditingEnabled",config.progressionEditingEnabled===true);setText("settingsConfigPath",config.configPath||"App data");setSshKeyWarning("settingsSshKeyWarning",config.sshKeyStatus);setSshKeyWarning("settingsReceiverSshKeyWarning",config.receiverSshKeyStatus);setServerInstallPathWarning("settingsServerInstallPathWarning",config.serverInstallPathStatus);}
function collectSettings(){const payload=configPayload("settings");payload.sshUser=getValue("settingsSshUser");payload.sshKey=getValue("settingsSshKey");payload.mapDefault=getValue("settingsMapDefault");payload.logLevel=getValue("settingsLogLevel");payload.updateRepo=getValue("settingsUpdateRepo");payload.liveTeleportEnabled=document.getElementById("settingsLiveTeleportEnabled")?.checked===true;payload.teleportEndpointPath=getValue("settingsTeleportEndpointPath");payload.teleportCommandTemplate=getValue("settingsTeleportCommandTemplate");payload.teleportPayloadTemplate=getValue("settingsTeleportPayloadTemplate");payload.progressionEditingEnabled=document.getElementById("settingsProgressionEditingEnabled")?.checked===true;payload.setupComplete=true;return payload;}
function updateSetupStep(){document.querySelectorAll(".setup-page").forEach((p,i)=>p.classList.toggle("active",i===setupStep));document.querySelectorAll(".setup-step").forEach((p,i)=>p.classList.toggle("active",i===setupStep));}
function setupNext(){setupStep=Math.min(4,setupStep+1);updateSetupStep();}
function setupPrev(){setupStep=Math.max(0,setupStep-1);updateSetupStep();}
function openSetupWizard(){setupStep=0;updateSetupStep();document.getElementById("setupWizard")?.classList.remove("hidden");}
function closeSetupWizard(){document.getElementById("setupWizard")?.classList.add("hidden");}
function openAboutDialog(){document.getElementById("aboutDialog")?.classList.remove("hidden");playUiSound("click");}
function closeAboutDialog(){document.getElementById("aboutDialog")?.classList.add("hidden");playUiSound("click");}
function openSupportDiscord(){window.open("https://discord.gg/tuUv3hYTv","_blank","noopener");playUiSound("click");}
function openSupportKofi(){window.open("https://ko-fi.com/E1W220NMPA","_blank","noopener");playUiSound("click");}
async function initSetup(){try{const data=await getJson("/api/setup/status");const config=data.config||{};fillSetup(config);fillSettings(config);if(!data.setupComplete)openSetupWizard();if(data.discovery)document.getElementById("setupDiscoveryLog").textContent=JSON.stringify(data.discovery,null,2);refreshReceiverStatus();}catch(e){addActivity("error","Setup status failed",e.message);}}
async function runDiscovery(){const log=document.getElementById("setupDiscoveryLog");if(log)log.textContent="Running discovery...";try{const data=await getJson("/api/discovery");if(log)log.textContent=JSON.stringify(data,null,2);if(data.localIps?.[0]&&!getValue("setupVmIp"))setValue("setupVmIp",data.localIps[0]);if(data.server?.installPath){setValue("setupServerInstallPath",data.server.installPath);await refreshServerInstallPathWarning("setupServerInstallPath","setupServerInstallPathWarning");}if(data.server?.vmName)setValue("setupVmName",data.server.vmName);if(data.receiver){setValue("setupReceiverHost",data.receiver.host);setValue("setupReceiverPort",data.receiver.port);}playUiSound("success");}catch(e){if(log)log.textContent=betterError(e);playUiSound("warning");}}
async function runConnectionTest(target,resultId){resultBox(resultId,{ok:true,message:"Testing "+target+"..."});try{const data=await getJson("/api/test/"+target,{method:"POST"});resultBox(resultId,data);playUiSound(data.ok?"success":"warning");return data;}catch(e){const data={ok:false,message:target+" test failed",error:betterError(e)};resultBox(resultId,data);playUiSound("warning");return data;}}
async function finishSetup(){try{const payload={...configPayload("setup"),setupComplete:true};const pathCheck=await getJson("/api/server-install-path/status?path="+encodeURIComponent(payload.serverInstallPath||""));setServerInstallPathWarning("setupServerInstallPathWarning",pathCheck.serverInstallPath);if(!pathCheck.serverInstallPath?.valid)throw new Error("Selected folder does not appear to be a valid Dune Awakening server installation.");const data=await getJson("/api/setup/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(!data.verified)throw new Error("Setup config save verification failed.");document.getElementById("setupFinishResult").textContent="Setup saved and verified. Config: "+(data.configPath||"App data");fillSetup(data.config||payload);fillSettings(data.config||payload);closeSetupWizard();refreshAll();playUiSound("success");}catch(e){document.getElementById("setupFinishResult").textContent=betterError(e);playUiSound("warning");}}
async function loadSettings(){try{const cfg=await getJson("/api/config");fillSettings(cfg);refreshReceiverStatus();}catch(e){setText("settingsSaveStatus",betterError(e));}}
async function saveSettings(){try{const data=await getJson("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...appConfig,...collectSettings()})});fillSettings(data.config||{});setText("settingsSaveStatus","Settings saved. Restart the suite for receiver startup environment changes.");playUiSound("success");}catch(e){setText("settingsSaveStatus",betterError(e));playUiSound("warning");}}
async function refreshReceiverStatus(){try{const data=await getJson("/api/receiver/status");const label=data.ok?"Receiver Online":"Receiver Offline";setText("receiverManagerStatus",label+" / "+data.healthUrl);setText("settingsReceiver",label);tone("receiverState",label);if(!data.ok)tone("rabbitState","Dry Run Active");return data;}catch(e){setText("receiverManagerStatus",betterError(e));tone("receiverState","Receiver Offline");tone("rabbitState","Dry Run Active");}}
async function receiverAction(action){try{if(action==="start")await saveSettings();const data=await getJson("/api/receiver/"+action,{method:"POST"});setText("receiverManagerStatus",data.message||data.status||"Receiver action complete");await refreshReceiverStatus();playUiSound(data.ok?"success":"warning");}catch(e){setText("receiverManagerStatus",betterError(e));playUiSound("warning");}}
async function exportSettings(){try{const data=await getJson("/api/settings/export");const text=JSON.stringify(data,null,2);document.getElementById("settingsBackupStatus").textContent=text;const blob=new Blob([text],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="alphanine-settings-"+new Date().toISOString().slice(0,10)+".json";a.click();URL.revokeObjectURL(a.href);playUiSound("success");}catch(e){setText("settingsBackupStatus",betterError(e));playUiSound("warning");}}
async function importSettings(){try{const raw=getValue("settingsImportText");if(!raw.trim())throw new Error("Paste exported settings JSON first.");const data=await getJson("/api/settings/import",{method:"POST",headers:{"Content-Type":"application/json"},body:raw});fillSettings(data.config||{});setText("settingsBackupStatus","Settings imported. Restart the suite if receiver or environment values changed.");playUiSound("success");}catch(e){setText("settingsBackupStatus",betterError(e));playUiSound("warning");}}
async function checkUpdates(){try{const repo=getValue("settingsUpdateRepo");const data=await getJson("/api/updates/check"+(repo?"?repo="+encodeURIComponent(repo):""));setText("settingsSaveStatus",data.ok?("Current "+data.currentVersion+" / Latest "+data.latestVersion+"\\n"+data.url):("Update check failed: "+data.error));if(data.ok&&data.url)window.open(data.url,"_blank");playUiSound(data.ok?"success":"warning");}catch(e){setText("settingsSaveStatus",betterError(e));playUiSound("warning");}}
async function refreshDiagnostics(){try{const data=await getJson("/api/diagnostics");diagnosticsData=data;setText("diagDatabase",data.database?.ok?"Reachable":"Failed");setText("diagReceiver",data.receiver?.ok?"Online":"Offline");setText("diagApi",data.api?.status||"Unknown");setText("diagVersion",data.version||"Unknown");renderDiagnosticLog();}catch(e){setText("diagnosticLog",betterError(e));}}
function renderDiagnosticLog(){const key=getValue("diagnosticLogSelect")||"suite";const text=diagnosticsData?.logs?.[key]||"No log data loaded.";setText("diagnosticLog",text);}
const UI_SOUND_DEFAULTS={enabled:true,volume:100};
let uiSoundPrefs={...UI_SOUND_DEFAULTS},uiSoundContext=null,lastHoverSound=0,uiSoundSaveTimer=null;
function clampSoundVolume(value){return Math.max(0,Math.min(100,Number(value)||0));}
function uiSoundGain(scale=1){return Math.min(.18,(clampSoundVolume(uiSoundPrefs.volume)/100)*scale);}
function ensureUiSoundContext(){if(!uiSoundContext){const AudioCtor=window.AudioContext||window.webkitAudioContext;if(!AudioCtor)return null;uiSoundContext=new AudioCtor();}if(uiSoundContext.state==="suspended")uiSoundContext.resume().catch(()=>{});return uiSoundContext;}
function playTone(freq,duration=70,type="sine",delay=0,gainScale=.8,endFreq){const ctx=ensureUiSoundContext();if(!ctx||!uiSoundPrefs.enabled||uiSoundPrefs.volume<=0)return;const osc=ctx.createOscillator();const gain=ctx.createGain();const now=ctx.currentTime+delay;const level=uiSoundGain(gainScale);osc.type=type;osc.frequency.setValueAtTime(freq,now);if(endFreq)osc.frequency.exponentialRampToValueAtTime(Math.max(1,endFreq),now+duration/1000);gain.gain.setValueAtTime(0.0001,now);gain.gain.exponentialRampToValueAtTime(Math.max(0.0002,level),now+.012);gain.gain.exponentialRampToValueAtTime(0.0001,now+duration/1000);osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+duration/1000+.025);}
function playUiSound(kind){if(!uiSoundPrefs.enabled||uiSoundPrefs.volume<=0)return;try{if(kind==="hover")playTone(880,45,"sine",0,.26,1040);else if(kind==="click")playTone(520,65,"triangle",0,.42,420);else if(kind==="tab"){playTone(360,55,"sine",0,.36,480);playTone(760,65,"sine",.055,.26,920);}else if(kind==="success"){playTone(520,70,"triangle",0,.38,680);playTone(920,90,"sine",.075,.28,1180);}else if(kind==="warning"){playTone(320,95,"triangle",0,.34,220);playTone(180,110,"sine",.09,.24,150);}}catch{}}
function syncUiSoundSettings(){const enabled=document.getElementById("uiSoundsEnabled");const volume=document.getElementById("uiSoundVolume");const label=document.getElementById("uiSoundVolumeLabel");const status=document.getElementById("uiSoundStatus");const dashToggle=document.getElementById("dashboardSoundToggle");const dashVolume=document.getElementById("dashboardSoundVolume");const dashLabel=document.getElementById("dashboardSoundVolumeLabel");const pct=clampSoundVolume(uiSoundPrefs.volume);if(enabled)enabled.checked=Boolean(uiSoundPrefs.enabled);if(volume)volume.value=String(pct);if(label)label.textContent=pct+"%";if(dashToggle){dashToggle.textContent=uiSoundPrefs.enabled?"🔊 Sounds ON":"🔇 Sounds OFF";dashToggle.classList.toggle("primary",Boolean(uiSoundPrefs.enabled));}if(dashVolume)dashVolume.value=String(pct);if(dashLabel)dashLabel.textContent=pct+"%";if(status){status.className=uiSoundPrefs.enabled?"empty":"warning";status.textContent=(uiSoundPrefs.enabled?"Sounds ON. ":"Sounds OFF. ")+"Volume "+pct+"%.";}}
async function saveUiSoundSettings(){try{const current=await getJson("/api/config");const config={...current,uiSoundsEnabled:Boolean(uiSoundPrefs.enabled),uiSoundVolume:clampSoundVolume(uiSoundPrefs.volume)};await getJson("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(config)});syncUiSoundSettings();}catch(e){const status=document.getElementById("uiSoundStatus");if(status){status.className="warning";status.textContent="Could not save UI sound preference: "+betterError(e);}playUiSound("warning");}}
function scheduleUiSoundSave(){clearTimeout(uiSoundSaveTimer);uiSoundSaveTimer=setTimeout(saveUiSoundSettings,300);}
async function loadUiSoundSettings(){try{const cfg=await getJson("/api/config");uiSoundPrefs.enabled=cfg.uiSoundsEnabled===true;uiSoundPrefs.volume=clampSoundVolume(cfg.uiSoundVolume ?? UI_SOUND_DEFAULTS.volume);}catch{}syncUiSoundSettings();}
function wireUiSounds(){document.addEventListener("pointerover",(event)=>{const target=event.target.closest("button,.tab,select,input[type='checkbox'],input[type='range']");if(!target||target.disabled)return;const now=Date.now();if(now-lastHoverSound<160)return;lastHoverSound=now;playUiSound("hover");},true);document.addEventListener("click",(event)=>{const target=event.target.closest("button,select,input[type='checkbox'],input[type='range']");if(!target||target.disabled)return;if(target.classList.contains("tab"))return;playUiSound("click");},true);const enabled=document.getElementById("uiSoundsEnabled");const volume=document.getElementById("uiSoundVolume");const dashToggle=document.getElementById("dashboardSoundToggle");const dashVolume=document.getElementById("dashboardSoundVolume");if(enabled)enabled.addEventListener("change",()=>{uiSoundPrefs.enabled=enabled.checked;syncUiSoundSettings();saveUiSoundSettings();});if(dashToggle)dashToggle.addEventListener("click",()=>{uiSoundPrefs.enabled=!uiSoundPrefs.enabled;syncUiSoundSettings();saveUiSoundSettings();});[volume,dashVolume].forEach(control=>{if(!control)return;control.addEventListener("input",()=>{uiSoundPrefs.volume=clampSoundVolume(control.value);syncUiSoundSettings();scheduleUiSoundSave();});control.addEventListener("change",()=>{uiSoundPrefs.volume=clampSoundVolume(control.value);saveUiSoundSettings();});});}
function relativeTime(value){if(!value)return"";const date=new Date(value);if(Number.isNaN(date.getTime()))return value;const seconds=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));if(seconds<60)return"just now";const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+"m ago";const hours=Math.floor(minutes/60);if(hours<24)return hours+"h ago";const days=Math.floor(hours/24);return days+"d ago";}
function renderPlayerFeed(players){const wrap=document.getElementById("playerFeed");if(!wrap)return;if(!players.length){wrap.innerHTML='<div class="empty">No players discovered yet.</div>';return;}wrap.innerHTML=players.map(p=>{const status=["online","offline","unknown"].includes(p.status)?p.status:"unknown";const level=p.level?"Level "+esc(p.level):"Level: Unknown";const id=p.character_id||p.player_controller_id||p.account_id||p.id||"";const offline=status==="offline"&&p.last_seen?(" - Last seen "+relativeTime(p.last_seen)):"";const statusText=status.charAt(0).toUpperCase()+status.slice(1)+offline;return '<div class="feed-row"><span class="feed-dot '+esc(status)+'"></span><div class="feed-name"><strong>'+esc(p.name||p.character_name||p.account_id||"Unknown")+'</strong><div class="feed-id">'+(id?"ID "+esc(id):"ID unavailable")+'</div></div><div class="feed-level">'+level+'</div><div class="feed-status '+esc(status)+'">'+esc(statusText)+'</div></div>';}).join("");}
async function refreshPlayerFeed(){const stamp=document.getElementById("playerFeedStamp");try{const data=await getJson("/api/players/feed");renderPlayerFeed(data.players||[]);if(stamp)stamp.textContent="Updated "+new Date().toLocaleTimeString();}catch(e){const wrap=document.getElementById("playerFeed");if(wrap)wrap.innerHTML='<div class="empty">'+esc(betterError(e))+'</div>';if(stamp)stamp.textContent="Feed error";}}
function vmDisplayStatus(vm){const raw=String(vm?.state||vm?.status||vm?.label||"").trim().toLowerCase();return ["running","started","online","healthy"].includes(raw)?"Running":"Offline";}
function renderVmStatus(vm){const status=vmDisplayStatus(vm);tone("vm",status);tone("dashboardVmStatus",status);setText("vmControlStatus",status);}
function vmDisplayMessage(data){return vmDisplayStatus(data?.vm||data||{});}
async function refresh(){try{const data=await getJson("/api/status");const s=data.status?.summary||{};const mapped=data.serverStatus||data.runtimeTransport?.serverStatusMapped||mapServerSummary(data);const topMapped=data.topServerStatus||mapped;const servers=data.status?.servers||[];const total=servers.reduce((sum,row)=>sum+(parseInt(row.players,10)||0),0);const telemetry=data.telemetry||data.resources||data.status?.telemetry||data.status?.resources||null;const hasResourceTelemetry=renderServerResources(telemetry);renderVmStatus(data.vm);tone("battlegroup",mapped.label==="Online"?(s.status||s.phase||"Online"):(mapped.label||"Warning"));tone("players",String(total));tone("sdb",s.database||"Unknown");tone("suptime",s.uptime||"Unknown");badge("topServer","Server "+(topMapped.label||"Warning"));document.getElementById("serverLog").textContent=data.status?.raw||"Ready.";syncLogs();addActivity(hasResourceTelemetry?"status":"warn",hasResourceTelemetry?"Server telemetry refreshed":"Server telemetry unavailable",hasResourceTelemetry?telemetrySourceLabel(telemetry?.source):(s.status||mapped.label||"No real resource telemetry source"));await refreshLiveGiveEnv();if(document.getElementById("database")?.classList.contains("active"))refreshDatabaseImportReadiness();}catch(e){renderServerResources(null);renderVmStatus({state:"Status error"});tone("battlegroup","Offline");tone("players","0");badge("topServer","Server error");document.getElementById("serverLog").textContent=betterError(e);syncLogs();addActivity("error","Server status failed",e.message);if(document.getElementById("database")?.classList.contains("active"))refreshDatabaseImportReadiness();}}
function monitorKindClass(kind){return kind==="ok"?"ok":kind==="warn"?"warn":"bad";}
function monitorStatusLabel(open){if(open===null||open===undefined)return"Not Configured";return open?"Open":"Closed";}
function monitorMs(value){return Number.isFinite(Number(value))?Math.round(Number(value))+" ms":"-- ms";}
function renderMonitorRows(rows){return rows.length?rows.map(row=>'<div class="vm-row"><div><strong>'+esc(row.label)+'</strong><small>'+esc(row.host?row.host+":"+row.port:(row.responseMs!=null?monitorMs(row.responseMs):row.error||""))+'</small></div><span class="status-pill '+monitorKindClass(row.open?"ok":"bad")+'">'+esc(monitorStatusLabel(row.open))+'</span></div>').join(""):'<div class="empty">No configured ports.</div>';}
function renderServiceRows(services){const rows=Object.values(services||{});return rows.length?rows.map(row=>'<div class="vm-row"><div><strong>'+esc(row.label)+'</strong><small>'+esc(row.responseMs!=null?monitorMs(row.responseMs):(row.error||""))+'</small></div><span class="status-pill '+monitorKindClass(row.reachable===null?"warn":row.reachable?"ok":"bad")+'">'+esc(row.reachable===null?"N/A":row.reachable?"Reachable":"Offline")+'</span></div>').join(""):'<div class="empty">No service checks.</div>';}
function renderPingGraph(history){const graph=document.getElementById("vmPingGraph");if(!graph)return;const values=(history||[]).slice(-60);const max=Math.max(80,...values.map(row=>Number(row.ms)||0));graph.innerHTML=values.length?values.map(row=>{const ms=Number(row.ms);const ok=Number.isFinite(ms);const h=ok?Math.max(8,Math.round((ms/max)*64)):8;const kind=!ok?"bad":ms<120?"ok":ms<250?"warn":"bad";return '<span class="ping-bar '+kind+'" title="'+(ok?ms+' ms':'offline')+'" style="height:'+h+'px"></span>';}).join(""):'<div class="empty">Ping history will appear after checks.</div>';}
async function refreshVmMonitor(){try{const data=await getJson("/api/vm-monitor");const kind=monitorKindClass(data.kind);setText("vmMonitorStatus",data.status||"Unknown");setText("vmMonitorAddress",data.vm?.address||"Unknown");setText("vmMonitorHost",data.vm?.hostname||"Unknown");setText("vmUptime",data.vm?.uptime||"Unknown");setText("vmHealthScore",Number.isFinite(Number(data.healthScore))?Math.round(Number(data.healthScore))+"%":"--");setText("vmPingCurrent",monitorMs(data.latency?.current));setText("vmPingAverage",monitorMs(data.latency?.average));setText("vmPingMin",monitorMs(data.latency?.min));setText("vmPingMax",monitorMs(data.latency?.max));setText("vmMonitorStamp","Last check "+new Date(data.checkedAt||Date.now()).toLocaleTimeString());setText("vmLastSuccess",data.lastSuccessfulConnection&&data.lastSuccessfulConnection!=="None yet"?new Date(data.lastSuccessfulConnection).toLocaleString():data.lastSuccessfulConnection||"None yet");["vmStatusCard","vmLatencyCard"].forEach(id=>{const el=document.getElementById(id);if(el)el.className="vm-status-card "+kind;});const ports=data.ports||[];const services=data.services||{};document.getElementById("vmPortList").innerHTML=renderMonitorRows(ports);document.getElementById("vmServiceList").innerHTML=renderServiceRows(services);document.getElementById("vmPortDetailList").innerHTML=ports.length?ports.map(row=>'<div>'+esc(row.label)+": "+esc(monitorStatusLabel(row.open))+" / "+esc(row.responseMs!=null?monitorMs(row.responseMs):row.error||"No response")+'</div>').join(""):'<div>No configured ports.</div>';document.getElementById("vmErrorList").innerHTML=(data.lastErrors||[]).length?data.lastErrors.map(error=>'<div>'+esc(error)+'</div>').join(""):'<div>No recent connection errors.</div>';renderPingGraph(data.latency?.history||[]);badge("topSsh",services.ssh?.reachable?"SSH reachable":"SSH offline");addActivity("vm","VM connection monitor",(data.status||"Unknown")+" / "+Math.round(Number(data.healthScore)||0)+"%");}catch(e){setText("vmMonitorStatus","Monitor error");setText("vmMonitorStamp",betterError(e));const card=document.getElementById("vmStatusCard");if(card)card.className="vm-status-card bad";addActivity("error","VM monitor failed",e.message);}}
function betterError(e){return e&&e.message?e.message:"Command failed. Check that the suite is running as Administrator and the Dune VM is reachable.";}
async function refreshVmStatus(){const log=document.getElementById("vmControlLog");try{const data=await getJson("/api/vm/status");renderVmStatus(data.vm);if(log)log.textContent=vmDisplayMessage(data);addActivity("vm","VM status refreshed",data.vm?.state||data.status||"Unknown");return data;}catch(e){renderVmStatus({state:"Error"});if(log)log.textContent=betterError(e);addActivity("error","VM status failed",e.message);return null;}}
async function runVmAction(action){const log=document.getElementById("vmControlLog");try{if((action==="stop"||action==="restart")&&!confirm("Are you sure you want to "+action+" the VM?"))return;if(log)log.textContent="Running VM "+action+"...";addActivity("vm","Running VM "+action);const data=await getJson("/api/vm/"+action+(action==="start"?"?wait=1":""),{method:"POST",timeoutMs:120000});renderVmStatus(data.vm||data);if(log)log.textContent=vmDisplayMessage(data);addActivity("vm","VM "+action+" completed",data.vm?.state||data.status||data.error||"");playUiSound(data.ok?"success":"warning");setTimeout(()=>{refresh();refreshVmMonitor();},1200);return data;}catch(e){if(log)log.textContent=betterError(e);addActivity("error","VM "+action+" failed",e.message);playUiSound("warning");return null;}}
async function ensureVmRunningBeforeBattlegroupStart(){const data=await getJson("/api/vm/status");const vm=data.vm||{};renderVmStatus(vm);if(!vm.configured)throw new Error("VM name is not configured. Set VM Name in Settings before starting the Battlegroup.");if(vm.hyperv&&!vm.hyperv.available)throw new Error(vm.hyperv.message||"Hyper-V not detected on this system.");if(vm.state==="Running")return true;if(vm.state==="Stopped"){if(!confirm("VM is stopped. Start VM first?"))return false;const started=await runVmAction("start");if(!started?.ok)throw new Error(started?.error||started?.waited?.error||"VM failed to reach Running before timeout.");if((started.vm?.state||started.state)!=="Running")throw new Error("VM failed to reach Running before timeout. Battlegroup start aborted.");return true;}return true;}
async function act(action){document.getElementById("serverLog").textContent="Running "+action+"...";addActivity("action","Running "+action);try{if(action==="start"){const shouldContinue=await ensureVmRunningBeforeBattlegroupStart();if(!shouldContinue){document.getElementById("serverLog").textContent="Battlegroup start cancelled.";syncLogs();return;}}const data=await getJson("/api/action/"+action,{method:"POST"});document.getElementById("serverLog").textContent=data.stdout||data.stderr||data.error||"Done.";syncLogs();addActivity("action",action+" completed",(data.error||"").slice(0,120));playUiSound(data.error?"warning":"success");setTimeout(refresh,1200);}catch(e){document.getElementById("serverLog").textContent=betterError(e);syncLogs();addActivity("error",action+" failed",e.message);playUiSound("warning");}}
async function openDirector(){try{const data=await getJson("/api/director");if(data.url) window.open(data.url,"_blank");else document.getElementById("serverLog").textContent=data.error||"Director URL unavailable.";}catch(e){document.getElementById("serverLog").textContent=betterError(e);}}
async function refreshMaps(){try{const data=await getJson("/api/maps");const maps=data.maps||[];const select=document.getElementById("mapSelect");const selected=select.value;const active=maps.reduce((sum,m)=>sum+(Number(m.running)||0),0);const wanted=maps.reduce((sum,m)=>sum+(Number(m.replicas)||0),0);tone("mapBattlegroup",data.battlegroup||"Unknown");tone("activeMaps",String(active));tone("wantedMaps",String(wanted));tone("mapMemory","Check RAM");select.innerHTML=maps.map(m=>'<option value="'+esc(m.map)+'">'+esc(m.map)+(m.dedicatedScaling?' (Dedicated)':'')+'</option>').join("")||'<option value="">No maps found</option>';if(selected)select.value=selected;document.getElementById("mapRows").innerHTML=maps.length?maps.map(m=>'<tr><td class="'+(m.running?'ok':'')+'">'+esc(m.map)+'</td><td>'+esc(m.deploymentMode||'Standard')+'</td><td>'+m.replicas+'</td><td>'+m.running+'</td><td>'+esc(m.memory||'-')+'</td></tr>').join(""):'<tr><td colspan="5">No map deployments found.</td></tr>';addActivity("maps","Map deployment refreshed",active+" active / "+wanted+" wanted");}catch(e){document.getElementById("mapRows").innerHTML='<tr><td colspan="5">'+esc(e.message)+'</td></tr>';document.getElementById("mapLog").textContent=betterError(e);addActivity("error","Map refresh failed",e.message);}}
function setText(id,value){const el=document.getElementById(id);if(el)el.textContent=String(value);}
async function deployMap(){const map=document.getElementById("mapSelect").value;const replicas=Number(document.getElementById("mapReplicas").value||1);document.getElementById("mapLog").textContent="Setting "+map+" to "+replicas+" replica(s)...";try{const data=await getJson("/api/maps/deploy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({map,replicas})});document.getElementById("mapLog").textContent=data.stdout||data.stderr||"Map deployment updated.";addActivity("maps","Map deployment updated",map+" -> "+replicas);playUiSound("success");setTimeout(()=>{refresh();refreshMaps();},1800);}catch(e){document.getElementById("mapLog").textContent=betterError(e);addActivity("error","Map deployment failed",e.message);playUiSound("warning");}}
function stopSelectedMap(){document.getElementById("mapReplicas").value=0;deployMap();}
function liveGiveTransportMessage(transport){const missing=transport?.missingEnv||[];if(missing.includes("DUNE_ADMIN_GIVE_ITEM_TRANSPORT"))return"Live Give unavailable: missing DUNE_ADMIN_GIVE_ITEM_TRANSPORT.";if(missing.length)return"Live Give unavailable: missing "+missing.join(", ")+".";return"Live Give unavailable: "+(transport?.dryRunReason||transport?.reason||"transport is not configured.");}
function renderEnvSetupLegacy(data=null){if(data?.activeRuntimeConfig)liveGiveEnvDiagnostics=data;const status=document.getElementById("envLiveStatus");const vars=document.getElementById("envMissingVars");if(!status||!vars)return;const missing=liveGiveTransport?.missingEnv||[];status.className=adminLiveGiveAvailable?"empty mt":"warning mt";status.textContent=adminLiveGiveAvailable?"Live Give transport is configured and reachable. Published grants still require inventory verification before they are called verified.":liveGiveUnavailableMessage;if(missing.length){vars.innerHTML=missing.map(name=>'<div class="detail-row"><span class="subtle">Missing</span><strong>'+esc(name)+'</strong></div>').join("");}else{vars.innerHTML='<div class="detail-row"><span class="subtle">Transport</span><strong>'+esc(liveGiveTransport?.mode||"Unknown")+'</strong></div><div class="detail-row"><span class="subtle">Reachable</span><strong>'+esc(liveGiveTransport?.reachable?"Yes":"No")+'</strong></div>';}const runtime=(data?.activeRuntimeConfig||liveGiveEnvDiagnostics?.activeRuntimeConfig||{});const help=(data?.requiredModesHelp||liveGiveEnvDiagnostics?.requiredModesHelp||null);const paths=document.getElementById("envRuntimePaths");const values=document.getElementById("envRuntimeValues");const priority=document.getElementById("envSourcePriority");const guide=document.getElementById("envLiveGuide");if(paths){const envFiles=(runtime.envFiles||[]).map(file=>'<div class="detail-row"><span class="subtle">'+esc(file.label)+(file.override?" override":"")+'</span><strong>'+esc((file.exists?"Found: ":"Missing: ")+(file.path||""))+'</strong></div>').join("");paths.innerHTML='<div class="detail-row"><span class="subtle">Active config</span><strong>'+esc(runtime.activeConfigPath||"Unknown")+'</strong></div><div class="detail-row"><span class="subtle">Backend config</span><strong>'+esc(runtime.backendConfigPath||"Unknown")+'</strong></div><div class="detail-row"><span class="subtle">Manager config</span><strong>'+esc(runtime.managerConfigPath||"Unknown")+'</strong></div>'+envFiles;}if(values){const envValues=runtime.loadedEnvironmentVariables||runtime.values||[];const rows=envValues.map(item=>'<div class="detail-row"><span class="subtle">'+esc(item.name)+'<br>'+esc(item.source||"unknown")+(item.detail?' · '+esc(item.detail):'')+'</span><strong>'+esc(item.displayValue||item.value||"(empty)")+'</strong></div>').join("");values.innerHTML=rows||'<div class="empty">No runtime environment details returned.</div>';}if(priority){priority.innerHTML=(runtime.sourcePriority||[]).map((item,index)=>'<div class="detail-row"><span class="subtle">'+(index+1)+'</span><strong>'+esc(item)+'</strong></div>').join("")||'<div class="empty">No source priority returned.</div>';}if(guide&&help){guide.textContent=[help.note||"",...(help.lines||[])].filter(Boolean).join("\\n\\n");}}
function envValueRow(item){return '<div class="env-var-row"><div><div class="env-var-name">'+esc(item.name)+'</div><span class="env-var-source">'+esc(item.source||"unknown")+(item.detail?' · '+esc(item.detail):'')+'</span></div><div class="env-var-value">'+esc(item.displayValue||item.value||"(empty)")+'</div></div>';}
function renderEnvSetup(data=null){if(data?.activeRuntimeConfig)liveGiveEnvDiagnostics=data;const status=document.getElementById("envLiveStatus");const vars=document.getElementById("envMissingVars");if(!status||!vars)return;const missing=liveGiveTransport?.missingEnv||[];status.className=adminLiveGiveAvailable?"empty mt":"warning mt";status.textContent=adminLiveGiveAvailable?"Live Give transport is configured and reachable. Published grants still require inventory verification before they are called verified.":liveGiveUnavailableMessage;if(missing.length){vars.innerHTML=missing.map(name=>'<div class="detail-row"><span class="subtle">Missing</span><strong class="env-path-value">'+esc(name)+'</strong></div>').join("");}else{vars.innerHTML='<div class="detail-row"><span class="subtle">Transport</span><strong>'+esc(liveGiveTransport?.mode||"Unknown")+'</strong></div><div class="detail-row"><span class="subtle">Reachable</span><strong>'+esc(liveGiveTransport?.reachable?"Yes":"No")+'</strong></div>';}const runtime=(data?.activeRuntimeConfig||liveGiveEnvDiagnostics?.activeRuntimeConfig||{});const help=(data?.requiredModesHelp||liveGiveEnvDiagnostics?.requiredModesHelp||null);const overview=document.getElementById("envRuntimeOverview");const paths=document.getElementById("envRuntimePaths");const values=document.getElementById("envRuntimeValues");const priority=document.getElementById("envSourcePriority");const guide=document.getElementById("envLiveGuide");if(overview){overview.innerHTML=['<div class="env-card"><span>Active config</span><strong>'+esc(runtime.activeConfigPath||"Unknown")+'</strong></div>','<div class="env-card"><span>App data</span><strong>'+esc(runtime.appDataDir||"Unknown")+'</strong></div>','<div class="env-card"><span>Manager data</span><strong>'+esc(runtime.managerDataDir||"Unknown")+'</strong></div>'].join("");}if(paths){const envFiles=(runtime.envFiles||[]).map(file=>'<div class="detail-row"><span class="subtle">'+esc(file.label)+(file.override?" override":"")+'</span><strong class="env-path-value">'+esc((file.exists?"Found: ":"Missing: ")+(file.path||""))+'</strong></div>').join("");paths.innerHTML='<div class="detail-row"><span class="subtle">Backend config</span><strong class="env-path-value">'+esc(runtime.backendConfigPath||"Unknown")+'</strong></div><div class="detail-row"><span class="subtle">Manager config</span><strong class="env-path-value">'+esc(runtime.managerConfigPath||"Unknown")+'</strong></div>'+envFiles;}if(values){const envValues=runtime.loadedEnvironmentVariables||runtime.values||[];values.innerHTML=envValues.length?envValues.map(envValueRow).join(""):'<div class="empty">No runtime environment details returned.</div>';}if(priority){priority.innerHTML=(runtime.sourcePriority||[]).map((item,index)=>'<div class="detail-row"><span class="subtle">'+(index+1)+'</span><strong class="env-path-value">'+esc(item)+'</strong></div>').join("")||'<div class="empty">No source priority returned.</div>';}if(guide&&help){guide.textContent=[help.note||"",...(help.lines||[])].filter(Boolean).join("\\n\\n");}}
function syncLiveGiveTransportStatus(){const el=document.getElementById("liveGiveTransportStatus");const transport=liveGiveTransport?.mode||"dry-run";if(el){el.textContent=adminLiveGiveAvailable?("Transport: "+transport+" / Live Give Available. Result will be published/queued unless inventory verification confirms it."):("Transport: "+transport+" / "+(liveGiveUnavailableMessage||"Live Give Unavailable."));el.className=adminLiveGiveAvailable?"empty mt":"warning mt";}const mode=document.getElementById("liveGiveMode");if(mode){const liveOption=[...mode.options].find(o=>o.value==="execute");if(liveOption)liveOption.disabled=!adminLiveGiveAvailable;if(!adminLiveGiveAvailable&&mode.value==="execute")mode.value="dry-run";}renderEnvSetup();syncGiveItemControls();}
async function refreshLiveGiveEnv(){try{const data=await getJson("/api/live-give/env");adminLiveGiveAvailable=Boolean(data.liveGiveAvailable);liveGiveTransport=data.giveTransport||null;liveGiveUnavailableMessage=adminLiveGiveAvailable?"":(data.message||liveGiveTransportMessage(liveGiveTransport||data));syncLiveGiveTransportStatus();renderEnvSetup(data);badge("topLive",adminLiveGiveAvailable?"Live give available":"Live give unavailable");tone("adminLive",adminLiveGiveAvailable?"Available":"Unavailable");tone("adminLiveMirror",adminLiveGiveAvailable?"Available":"Unavailable");}catch(e){adminLiveGiveAvailable=false;liveGiveUnavailableMessage=betterError(e);syncLiveGiveTransportStatus();renderEnvSetup();}}
function renderDatabaseStatus(data){tone("dbMgmtStatus",data?.ok?"Online":(data?.status||"Unavailable"));setText("dbMgmtStatusDetail",data?.ok?("Uptime "+(data.uptime||"unknown")+" / "+(data.durationMs||0)+" ms"):(data?.error||"Database unavailable."));tone("dbMgmtSize",data?.size||"--");tone("dbMgmtConnections",data?.ok?((data.connections||"0")+" / "+(data.activeQueries||"0")):"--");badge("topDb",data?.ok?"DB reachable":"DB unavailable");}
function renderDatabaseLocation(data){const folder=data?.folder||"";setText("dbBackupPath",folder||"Unknown");setText("dbBackupDefaultPath",data?.defaultFolder||"Unknown");tone("dbMgmtBackupFolderState",folder?"Configured":"Missing");}
function backupAvailabilityLabel(row){if(row?.availabilityStatus)return row.availabilityStatus;if(row?.vmBackupPath||row?.vmPath)return"Metadata only";return"Local file";}
function importAvailabilityLabel(source){if(!source)return"Metadata only";if(source.sourceType==="local")return"Local file";if(source.availability?.available)return"Available on VM";if(source.availability?.known)return"Missing on VM";return"Metadata only";}
function renderDatabaseBackups(data){const rows=document.getElementById("dbBackupRows");if(!rows)return;const backups=data?.backups||[];window.databaseBackupRows=backups;if(!backups.length){rows.innerHTML='<tr><td colspan="5">No backups found in the selected folder.</td></tr>';return;}rows.innerHTML=backups.map((row,index)=>{const target=row.vmBackupPath||row.vmPath?("VM: "+(row.vmBackupPath||row.vmPath)):row.path;const availability=backupAvailabilityLabel(row);return '<tr><td>'+esc(row.filename)+'<div class="subtle">'+esc(availability)+'</div></td><td>'+esc(new Date(row.date).toLocaleString())+'</td><td>'+esc(row.sizeLabel||row.size)+'</td><td><div class="env-path-value">'+esc(target)+'</div>'+(row.vmBackupFilename?'<div class="subtle">Import argument: '+esc(row.vmBackupFilename)+'</div>':'')+(row.vmPath?'<div class="subtle">Metadata: '+esc(row.path)+'</div>':'')+'</td><td><div class="action-row"><button onclick="copyDatabaseBackupPath('+index+')">Copy path</button><button onclick="selectDatabaseRestoreBackup('+index+')">Select for Import</button></div></td></tr>';}).join("");}
async function refreshDatabaseStatus(){try{renderDatabaseStatus(await getJson("/api/database/status",{timeoutMs:15000}));}catch(e){renderDatabaseStatus({ok:false,status:"unavailable",error:betterError(e)});}}
async function refreshDatabaseLocation(){try{renderDatabaseLocation(await getJson("/api/database/backup-location"));}catch(e){renderDatabaseLocation({ok:false,folder:"",defaultFolder:"",error:betterError(e)});setText("dbLocationResult",betterError(e));}}
async function refreshDatabaseBackups(){try{const data=await getJson("/api/database/backups");renderDatabaseBackups(data);}catch(e){const rows=document.getElementById("dbBackupRows");if(rows)rows.innerHTML='<tr><td colspan="5">'+esc(betterError(e))+'</td></tr>';}}
async function refreshDatabaseManagement(){await Promise.all([refreshDatabaseStatus(),refreshDatabaseLocation(),refreshDatabaseBackups()]);await refreshDatabaseImportReadiness();const activeJob=window.activeDatabaseRestoreJobId||localStorage.getItem("activeDatabaseRestoreJobId")||"";if(activeJob){const el=document.getElementById("dbRestoreResult");if(el){el.className="warning mt";el.textContent="Import job is still running. Reconnecting to import status...";}pollDatabaseRestoreStatus(activeJob).catch(e=>setText("dbRestoreResult",betterError(e)));}addActivity("database","Database management refreshed","Status, backup location, and recent backups loaded.");}
async function chooseDatabaseBackupFolder(){try{let folder="";if(window.alphaNineSuite?.chooseDatabaseBackupFolder){const result=await window.alphaNineSuite.chooseDatabaseBackupFolder();if(result?.canceled)return;folder=result.folderPath||"";}else{folder=prompt("Backup folder path","")||"";}if(!folder)return;const data=await getJson("/api/database/backup-location",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({folder})});renderDatabaseLocation(data);setText("dbLocationResult","Backup folder saved: "+data.folder);await refreshDatabaseBackups();playUiSound("success");}catch(e){setText("dbLocationResult",betterError(e));playUiSound("warning");}}
async function openDatabaseBackupFolder(){try{const folder=document.getElementById("dbBackupPath")?.textContent||"";if(window.alphaNineSuite?.openPath)await window.alphaNineSuite.openPath(folder);else window.open("file:///"+folder.replace(/\\\\/g,"/"),"_blank");}catch(e){setText("dbLocationResult",betterError(e));}}
async function resetDatabaseBackupFolder(){try{const data=await getJson("/api/database/backup-location",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reset:true})});renderDatabaseLocation(data);setText("dbLocationResult","Backup folder reset: "+data.folder);await refreshDatabaseBackups();playUiSound("success");}catch(e){setText("dbLocationResult",betterError(e));playUiSound("warning");}}
async function createDatabaseBackup(){const el=document.getElementById("dbBackupResult");try{el.className="empty mt";el.textContent="Creating Battlegroup backup...";const data=await getJson("/api/database/backup",{method:"POST",timeoutMs:900000});if(!data.ok)throw new Error(data.error||"Backup failed.");el.className="empty mt";el.textContent="Battlegroup backup created.\\nBackup: "+(data.backupName||data.backupId||"--")+"\\nVM path: "+(data.vmPath||"Not reported by Battlegroup command")+"\\nLocal metadata: "+(data.localMetadataPath||data.filePath||"--")+"\\nStorage: "+(data.storage||"--")+"\\nElapsed: "+(data.elapsed||restoreElapsed(data))+"\\n\\nOutput:\\n"+(data.output||data.stderr||"--");addActivity("database","Battlegroup backup created",data.backupName||data.backupId||data.filePath);await refreshDatabaseBackups();playUiSound("success");}catch(e){el.className="warning mt";el.textContent=betterError(e);addActivity("error","Battlegroup backup failed",e.message);playUiSound("warning");}}
async function createSafetyBackupOnly(){const el=document.getElementById("dbBackupResult");let timer=null;const started=Date.now();try{el.className="warning mt";el.textContent="Safety backup: Starting";timer=setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);el.textContent="Safety backup still running... "+Math.min(seconds,120)+"s / 120s";},1000);const data=await getJson("/api/database/safety-backup",{method:"POST",timeoutMs:130000});if(timer){clearInterval(timer);timer=null;}if(!data.ok)throw new Error(data.error||"Safety backup failed.");el.className="empty mt";el.textContent="Safety backup succeeded.\\nOperation: "+(data.dumpOperationName||"--")+"\\nPhase: "+(data.phase||"Succeeded")+"\\nVM path: "+(data.vmPath||"Not reported by Battlegroup command")+"\\nLocal metadata: "+(data.localMetadataPath||data.filePath||"--")+"\\nElapsed: "+(data.elapsed||restoreElapsed(data));addActivity("database","Safety backup succeeded",data.dumpOperationName||data.filePath);await refreshDatabaseBackups();playUiSound("success");}catch(e){if(timer)clearInterval(timer);el.className="warning mt";el.textContent=betterError(e);addActivity("error","Safety backup failed",e.message);playUiSound("warning");}}
async function chooseDatabaseRestoreFile(){try{let filePath="";if(window.alphaNineSuite?.chooseDatabaseBackupFile){const result=await window.alphaNineSuite.chooseDatabaseBackupFile();if(result?.canceled)return;filePath=result.filePath||"";}else{filePath=prompt("Backup file path","")||"";}if(filePath)document.getElementById("dbRestoreFile").value=filePath;await refreshDatabaseImportReadiness();}catch(e){setText("dbRestoreResult",betterError(e));}}
function selectDatabaseRestoreBackup(index){const row=(window.databaseBackupRows||[])[index];if(!row)return;document.getElementById("dbRestoreFile").value=row.path;document.getElementById("dbRestoreConfirm").value="";const vmPath=row.vmBackupPath||row.vmPath;const detail=vmPath?("Selected metadata: "+row.path+"\\nResolved VM backup: "+vmPath+"\\nImport argument: "+(row.vmBackupFilename||vmPath.split('/').pop())):("Selected backup file: "+row.path);document.getElementById("dbRestoreResult").textContent=detail+"\\nStop the server and type IMPORT before importing.";refreshDatabaseImportReadiness();}
function copyDatabaseBackupPath(index){const row=(window.databaseBackupRows||[])[index];if(row)copyTextToClipboard(row.path);}
async function copyTextToClipboard(text){try{if(navigator.clipboard)await navigator.clipboard.writeText(text);setText("dbLocationResult","Path copied.");playUiSound("click");}catch(e){setText("dbLocationResult",betterError(e));}}
function importReadinessRow(ok,label,detail){return '<div class="detail-row"><span class="'+(ok?'ok':'bad')+'">'+(ok?'&#10003;':'&#10007;')+'</span><strong>'+esc(label)+'</strong></div>'+(detail?'<div class="subtle">'+esc(detail)+'</div>':'');}
function importSourceHtml(source){if(!source)return "";const rows=[];if(source.metadataPath)rows.push('<div class="detail-row"><span class="subtle">Metadata file</span><strong class="env-path-value">'+esc(source.metadataPath)+'</strong></div>');if(source.vmBackupPath||source.remotePath)rows.push('<div class="detail-row"><span class="subtle">Actual VM backup</span><strong class="env-path-value">'+esc(source.vmBackupPath||source.remotePath)+'</strong></div>');if(source.vmYamlPath)rows.push('<div class="detail-row"><span class="subtle">Sidecar YAML</span><strong class="env-path-value">'+esc(source.vmYamlPath)+'</strong></div>');if(source.vmBackupFilename)rows.push('<div class="detail-row"><span class="subtle">Import argument</span><strong class="env-path-value">'+esc(source.vmBackupFilename)+'</strong></div>');if(source.localPath)rows.push('<div class="detail-row"><span class="subtle">Local backup file</span><strong class="env-path-value">'+esc(source.localPath)+'</strong></div>');rows.push('<div class="detail-row"><span class="subtle">Backup availability</span><strong>'+esc(source.availability?.message||"Unknown")+'</strong></div>');return rows.length?'<div class="detail-list mt">'+rows.join("")+'</div>':"";}
function renderDatabaseImportControls(){const filePath=getValue("dbRestoreFile");const confirmText=getValue("dbRestoreConfirm");const readiness=databaseImportReadiness||{conditions:{},message:"Checking import readiness.",reasonCode:"checking"};const c=readiness.conditions||{};const canType=Boolean(!databaseImportRunning&&readiness.canTypeConfirmation);const confirmationOk=confirmText==="IMPORT";const canImport=Boolean(canType&&confirmationOk);const file=document.getElementById("dbRestoreFile");const choose=document.getElementById("dbChooseRestoreFileButton");const confirm=document.getElementById("dbRestoreConfirm");const button=document.getElementById("dbRestoreButton");if(file)file.disabled=databaseImportRunning;if(choose)choose.disabled=databaseImportRunning;if(confirm)confirm.disabled=!canType;if(button)button.disabled=!canImport;const panel=document.getElementById("dbImportReadiness");if(panel){panel.className=canImport?"empty mt":"warning mt";const backupDetail=readiness.importSource?.remotePath?("Resolved to VM backup: "+readiness.importSource.remotePath):(filePath||"No backup selected.");const backupOk=Boolean(filePath&&c.backupSelected&&c.backupValid&&c.backupResolved);const runningOk=Boolean(c.noImportRunning&&!databaseImportRunning);const runningDetail=runningOk?"No import job running.":"Another import is currently running.";const confirmDetail=confirmationOk?"IMPORT entered.":(canType?"Type IMPORT to enable the import button.":"Confirmation is locked until backup, server, and job checks pass.");panel.innerHTML='<div class="label">Import Readiness</div><div class="detail-list mt">'+importReadinessRow(backupOk,"Backup selected",backupDetail)+importReadinessRow(Boolean(c.statusKnown&&c.serverOffline),"Server offline",c.statusKnown?(c.serverOffline?"Server is stopped.":"Server is still running."):"Unable to determine server status.")+importReadinessRow(runningOk,"No import running",runningDetail)+importReadinessRow(confirmationOk,confirmationOk?"Confirmation entered":"Confirmation missing",confirmDetail)+'</div>'+importSourceHtml(readiness.importSource)+'<div class="subtle mt">'+esc(readiness.message||"")+'</div>';}}
function setDatabaseRestoreRunning(running){databaseImportRunning=Boolean(running);renderDatabaseImportControls();}
async function refreshDatabaseImportReadiness(){const filePath=getValue("dbRestoreFile");try{databaseImportReadiness=await getJson("/api/database/import-readiness",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filePath}),timeoutMs:8000});}catch(e){databaseImportReadiness={ok:false,canTypeConfirmation:false,canImport:false,reasonCode:"server_status_unknown",message:betterError(e),conditions:{backupSelected:Boolean(filePath),backupValid:Boolean(filePath),serverOffline:false,noImportRunning:!databaseImportRunning,statusKnown:false}};}const selected=(window.databaseBackupRows||[]).find(row=>row.path===filePath);if(selected&&databaseImportReadiness?.importSource){selected.availabilityStatus=importAvailabilityLabel(databaseImportReadiness.importSource);renderDatabaseBackups({backups:window.databaseBackupRows});}renderDatabaseImportControls();return databaseImportReadiness;}
async function ensureBattlegroupStoppedBeforeImport(){const data=await getJson("/api/status",{timeoutMs:5000});const mapped=data.serverStatus||data.runtimeTransport?.serverStatusMapped||mapServerSummary(data);if(mapped?.online)throw new Error("Server is online. Stop the server before importing a backup.");return data;}
function restoreElapsed(job){if(job?.elapsed)return job.elapsed;const ms=Number(job?.durationMs||0);const total=Math.max(0,Math.floor(ms/1000));const h=Math.floor(total/3600);const m=Math.floor((total%3600)/60);const s=total%60;return h?(h+" hr "+m+" min "+s+" sec"):(m?(m+" min "+s+" sec"):(s+" sec"));}
function restoreStatusBadge(job){const resultStatus=job?.result?.status||"";if(job?.status==="success")return '<span class="status-pill ok">Completed</span>';if(resultStatus==="verification_failed")return '<span class="status-pill warn">Verification Failed</span>';if(job?.status==="failed")return '<span class="status-pill bad">Failed</span>';return '<span class="status-pill warn">Running</span>';}
function restoreTimelineHtml(job){const timeline=job?.timeline||["Preparing import","Checking Battlegroup offline","Preparing backup source","Uploading backup if needed","Backup source ready","Creating safety backup","Safety backup complete","Safety backup verified","Importing Battlegroup backup","Verifying imported database","Completed"];const history=(job?.history||[]).map(row=>row.step);const current=job?.step||"";const currentIndex=timeline.indexOf(current);const failed=job?.status==="failed";return '<div class="restore-timeline">'+timeline.map((step,index)=>{const done=history.includes(step)||job?.status==="success"||(currentIndex>-1&&index<currentIndex);const active=step===current&&job?.status!=="success"&&!failed;const icon=done?"&#10003;":(active?"&#9203;":"&#9633;");const cls=done?"ok":(active?"warn":"");return '<div class="restore-step '+cls+'"><span>'+icon+'</span><strong>'+esc(step)+'</strong></div>';}).join("")+(failed?'<div class="restore-step bad"><span>&#9888;</span><strong>'+esc(current||"Failed")+'</strong></div>':"")+'</div>';}
function verificationSummaryHtml(verification){if(!verification)return '<div class="detail-row"><span class="subtle">Verification</span><strong>Not completed</strong></div>';const checks=verification.checks||{};const db=verification.database||{};return '<div class="detail-row"><span class="subtle">Import command</span><strong>&#10003; Completed</strong></div><div class="detail-row"><span class="subtle">Database reachable</span><strong>'+esc(checks.databaseReachable?"✓ Yes":"No")+'</strong></div><div class="detail-row"><span class="subtle">Database size</span><strong>'+esc(db.size||"--")+'</strong></div><div class="detail-row"><span class="subtle">Game server online required</span><strong>No</strong></div>';}
function restoreFinalSummaryHtml(job){const result=job?.result||{};const ok=job?.status==="success";const verificationFailed=result.status==="verification_failed";const title=ok?"Import completed successfully. You may now start the server.":(verificationFailed?"Battlegroup import completed but database verification failed":"Battlegroup import failed or could not be verified");const path=result.importedFrom||"";const safety=result.safetyBackup?.path||result.safetyBackup?.filename||"";return '<div class="'+(ok?'empty':'warning')+' mt"><div class="panel-head"><div><strong>'+esc(title)+'</strong><div class="subtle">Elapsed: '+esc(result.elapsed||restoreElapsed(job))+'</div></div>'+restoreStatusBadge(job)+'</div><div class="detail-list mt"><div class="detail-row"><span class="subtle">Backup</span><strong class="env-path-value">'+esc(path||"--")+'</strong></div><div class="detail-row"><span class="subtle">VM import source</span><strong class="env-path-value">'+esc(result.remotePath||"--")+'</strong></div><div class="detail-row"><span class="subtle">Import argument</span><strong class="env-path-value">'+esc(result.importArg||"--")+'</strong></div><div class="detail-row"><span class="subtle">Safety Backup</span><strong class="env-path-value">'+esc(safety||"--")+'</strong></div>'+verificationSummaryHtml(result.verification)+'<div class="detail-row"><span class="subtle">Log</span><strong class="env-path-value">'+esc(job.logPath||result.logPath||"--")+'</strong></div></div>'+(result.error?'<div class="warning mt">'+esc(result.error)+'</div>':"")+'<button class="mt" onclick="openRestoreLog()">Open Import Log</button></div>';}
function renderDatabaseRestoreStatus(job){const el=document.getElementById("dbRestoreProgress");if(!el)return;el.className=job.status==="failed"?"warning mt":(job.status==="success"?"empty mt":"warning mt");const verification=job.verificationSubstep?'<div class="detail-list mt"><div class="detail-row"><span class="subtle">Verification substep</span><strong>'+esc(job.verificationSubstep)+'</strong></div>'+(job.verificationDetail?'<div class="detail-row"><span class="subtle">Command</span><strong class="env-path-value">'+esc(job.verificationDetail)+'</strong></div>':'')+'</div>':"";el.innerHTML='<div class="panel-head"><div><strong>Import Status</strong><div class="subtle">Elapsed: '+esc(restoreElapsed(job))+'</div></div>'+restoreStatusBadge(job)+'</div>'+restoreTimelineHtml(job)+verification+(job.error?'<div class="warning mt">'+esc(job.error)+'</div>':"")+'<div class="subtle mt">Job: '+esc(job.jobId||"--")+'</div>';}
async function openRestoreLog(){const path=window.lastDatabaseRestoreLogPath||"";try{if(!path)throw new Error("Import log path is unavailable.");if(window.alphaNineSuite?.openPath)await window.alphaNineSuite.openPath(path);else window.open("file:///"+path.replace(/\\\\/g,"/"),"_blank");}catch(e){setText("dbRestoreResult",betterError(e));}}
async function pollDatabaseRestoreStatus(jobId){if(window.databaseRestorePolling===jobId)return;window.databaseRestorePolling=jobId;window.activeDatabaseRestoreJobId=jobId;localStorage.setItem("activeDatabaseRestoreJobId",jobId);setDatabaseRestoreRunning(true);let finalJob=null;let pollError=null;try{for(let i=0;i<720;i++){try{const job=await getJson("/api/database/import-status/"+encodeURIComponent(jobId),{timeoutMs:5000});window.lastDatabaseRestoreLogPath=job.logPath||job.result?.logPath||"";renderDatabaseRestoreStatus(job);if(job.status==="success"||job.status==="failed"){finalJob=job;break;}}catch(e){pollError=e;break;}await new Promise(resolve=>setTimeout(resolve,2000));}}finally{window.databaseRestorePolling="";setDatabaseRestoreRunning(false);window.activeDatabaseRestoreJobId="";localStorage.removeItem("activeDatabaseRestoreJobId");await refreshDatabaseImportReadiness().catch(()=>{});}const el=document.getElementById("dbRestoreResult");if(pollError){const msg=betterError(pollError);if(el){el.className="warning mt";el.textContent=/not found|was not found|missing/i.test(msg)?"Import job not found. Cleared stale import state.":msg;}const progress=document.getElementById("dbRestoreProgress");if(progress){progress.className="empty mt";progress.textContent="No import job running.";}addActivity("warn","Import status cleared",msg);return;}if(!finalJob){if(el){el.className="warning mt";el.textContent="Import status polling timed out. Check audit log for details.";}return;}if(el)el.innerHTML=restoreFinalSummaryHtml(finalJob);if(finalJob.status==="success"){document.getElementById("dbRestoreConfirm").value="";addActivity("database","Battlegroup import completed and verified",finalJob.jobId);await refreshDatabaseBackups();playUiSound("success");}else{addActivity("error","Battlegroup import failed",finalJob.error||finalJob.jobId);playUiSound("warning");}}
async function restoreDatabaseBackup(){const el=document.getElementById("dbRestoreResult");try{const filePath=document.getElementById("dbRestoreFile")?.value||"";const confirmText=document.getElementById("dbRestoreConfirm")?.value||"";if(confirmText!=="IMPORT")throw new Error("Type IMPORT before importing.");await ensureBattlegroupStoppedBeforeImport();if(!confirm("Import Battlegroup backup from this file? Stop the server first. A safety Battlegroup backup will be created first."))return;setDatabaseRestoreRunning(true);el.className="warning mt";el.textContent="Import job starting...";const data=await getJson("/api/database/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filePath,confirmText}),timeoutMs:15000});if(!data.jobId)throw new Error(data.error||"Import job was not created.");renderDatabaseRestoreStatus(data);addActivity("database","Battlegroup import started",data.jobId);await pollDatabaseRestoreStatus(data.jobId);}catch(e){setDatabaseRestoreRunning(false);el.className="warning mt";el.textContent=betterError(e);addActivity("error","Battlegroup import blocked",e.message);playUiSound("warning");}}
function wireDatabaseImportControls(){const file=document.getElementById("dbRestoreFile");const confirm=document.getElementById("dbRestoreConfirm");if(file){file.addEventListener("input",()=>refreshDatabaseImportReadiness());file.addEventListener("change",()=>refreshDatabaseImportReadiness());}if(confirm){confirm.addEventListener("input",renderDatabaseImportControls);confirm.addEventListener("change",renderDatabaseImportControls);}renderDatabaseImportControls();}
async function refreshAdmin(){const log=document.getElementById("adminLog");log.textContent="Loading admin data...";try{const safeGet=async(url,fallback)=>{try{return await getJson(url);}catch(e){return {...fallback,error:e.message};}};const [probe,players,items,channels]=await Promise.all([safeGet("/api/admin/probe",{ok:false,liveGiveAvailable:false,giveTransport:null}),safeGet("/api/admin/players",{ok:false,players:[],details:[]}),safeGet("/api/admin/items",{ok:false,items:[],report:{}}),safeGet("/api/admin/tuned-channels",{ok:false,rows:[]})]);adminLiveGiveAvailable=Boolean(probe.liveGiveAvailable);liveGiveTransport=probe.giveTransport||null;liveGiveUnavailableMessage=adminLiveGiveAvailable?"":liveGiveTransportMessage(liveGiveTransport||probe);adminPlayers=players.players||[];adminItems=items.items||[];adminItemReport=items.report||null;if(!selectedPlayerId&&adminPlayers[0])selectedPlayerId=adminPlayers[0].id;tone("adminDb",probe.ok?"Reachable":"Limited");tone("adminDbMirror",probe.ok?"Reachable":"Limited");tone("adminLive",adminLiveGiveAvailable?"Available":"Unavailable");tone("adminLiveMirror",adminLiveGiveAvailable?"Available":"Unavailable");tone("receiverState",probe.giveTransport?.reachable?"Receiver Online":"Receiver Offline");tone("rabbitState",adminLiveGiveAvailable?(probe.giveTransport?.mode||probe.transport||"Unknown"):"Dry Run Active");tone("adminPlayersFound",String(adminPlayers.length));tone("adminItemsFound",String(adminItems.length));badge("topDb",probe.ok?"DB reachable":"DB limited");badge("topLive",adminLiveGiveAvailable?"Live give available":"Live give unavailable");badge("topPlayers","Players "+adminPlayers.length);const ssh=players.diagnostics?.sshTarget||"SSH unknown";badge("topSsh",ssh);document.getElementById("settingsSsh").textContent=ssh;document.getElementById("settingsReceiver").textContent=probe.giveTransport?.target||probe.transport||"Unknown";const giveButton=document.getElementById("adminGiveButton");if(giveButton)giveButton.textContent="Give Item";renderPlayerSelect();renderPermissionPlayerSelect();renderPlayers();renderAdminItemFilters();renderAdminItems();renderGearDiscoveryStatus();renderAdminChannels(channels.rows||[]);syncLiveGiveTransportStatus();await refreshPermissions();await refreshSkillReputation();const playerDiag=players.details&&players.details.length?["Player discovery diagnostics:",...players.details].join("\\n"):"";log.textContent=[probe.note,probe.error,players.error,items.error,channels.error,playerDiag].filter(Boolean).join("\\n\\n")||"Admin tools ready.";addActivity("probe","Admin probe refreshed",adminLiveGiveAvailable?"Live give available":"Live give unavailable");}catch(e){tone("adminDb","Error");tone("adminDbMirror","Error");badge("topDb","DB error");log.textContent=betterError(e);addActivity("error","Admin refresh failed",e.message);}}
function playerLabel(p){return (p.character_name||p.name||p.id||"Unknown")+" / account "+(p.account_id||p.id||"-");}
function selectedPlayer(){return adminPlayers.find(row=>row.id===selectedPlayerId)||null;}
function renderPlayerSelect(){const select=document.getElementById("adminPlayer");select.innerHTML=adminPlayers.length?adminPlayers.map(p=>'<option value="'+esc(p.id)+'">'+esc(playerLabel(p))+'</option>').join(""):'<option value="">No players found</option>';if(selectedPlayerId)select.value=selectedPlayerId;}
function renderPermissionPlayerSelect(){const select=document.getElementById("permissionPlayer");if(!select)return;select.innerHTML=adminPlayers.length?adminPlayers.map(p=>'<option value="'+esc(p.id)+'">'+esc(playerLabel(p))+'</option>').join(""):'<option value="">No players found</option>';if(selectedPlayerId)select.value=selectedPlayerId;syncPermissionForms();}
function renderPlayers(){const q=(document.getElementById("playerSearch")?.value||"").toLowerCase();const list=adminPlayers.filter(p=>((p.name||"")+" "+(p.account_id||"")+" "+(p.character_id||"")+" "+(p.character_name||"")+" "+(p.funcom_id||"")+" "+(p.player_controller_id||"")).toLowerCase().includes(q));const wrap=document.getElementById("playerCards");wrap.innerHTML=list.length?list.map(p=>'<button class="player-card '+(p.id===selectedPlayerId?'active':'')+'" data-player-id="'+esc(p.id)+'"><div class="avatar">'+esc((p.name||p.id||"?").slice(0,2).toUpperCase())+'</div><div><strong>'+esc(p.name||p.character_name||p.id)+'</strong><span>Account '+esc(p.account_id||p.id)+' / Controller '+esc(p.player_controller_id||"-")+' / Funcom '+esc(p.funcom_id||"-")+'</span></div></button>').join(""):'<div class="empty">No players match that search.</div>';wrap.querySelectorAll("[data-player-id]").forEach(el=>el.addEventListener("click",()=>selectPlayer(el.dataset.playerId)));renderPlayerDetails();}
function selectPlayer(id){selectedPlayerId=String(id||"");const select=document.getElementById("adminPlayer");if(select)select.value=selectedPlayerId;const perm=document.getElementById("permissionPlayer");if(perm)perm.value=selectedPlayerId;renderPlayers();syncPermissionForms();refreshPermissions();refreshSkillReputation();}
function syncSelectedPlayerFromSelect(){selectedPlayerId=document.getElementById("adminPlayer").value;const perm=document.getElementById("permissionPlayer");if(perm)perm.value=selectedPlayerId;renderPlayers();syncPermissionForms();refreshPermissions();refreshSkillReputation();}
function syncPermissionPlayer(){selectedPlayerId=document.getElementById("permissionPlayer").value;const select=document.getElementById("adminPlayer");if(select)select.value=selectedPlayerId;renderPlayers();syncPermissionForms();refreshPermissions();refreshSkillReputation();}
function renderPlayerDetails(){const p=selectedPlayer();const wrap=document.getElementById("playerDetails");if(!p){wrap.className="empty mt";wrap.innerHTML="Select a player to inspect account and character details.";return;}wrap.className="detail-list";wrap.innerHTML='<div class="detail-row"><span class="subtle">Character</span><strong>'+esc(p.name||p.character_name||p.id)+'</strong></div><div class="detail-row"><span class="subtle">Account ID</span><strong>'+esc(p.account_id||p.id)+'</strong></div><div class="detail-row"><span class="subtle">Funcom ID</span><strong>'+esc(p.funcom_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Player Controller ID</span><strong>'+esc(p.player_controller_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Character ID</span><strong>'+esc(p.character_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Give Item ID</span><strong>'+esc(p.id)+'</strong></div>';}
function syncPermissionForms(){const p=selectedPlayer();const identity=document.getElementById("permissionIdentity");if(identity){identity.className="detail-list";identity.innerHTML=p?'<div class="detail-row"><span class="subtle">Character</span><strong>'+esc(p.character_name||p.name||"-")+'</strong></div><div class="detail-row"><span class="subtle">Account ID</span><strong>'+esc(p.account_id||p.id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Funcom ID</span><strong>'+esc(p.funcom_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Player Controller ID</span><strong>'+esc(p.player_controller_id||"-")+'</strong></div>':'<div class="empty">No player selected.</div>';}if(p){const ctrl=document.getElementById("permControllerId");if(ctrl&&!ctrl.value)ctrl.value=p.player_controller_id||"";const acct=document.getElementById("accessAccountId");if(acct&&!acct.value)acct.value=p.account_id||p.id||"";}updatePermissionPreviews();}
function permissionQuery(){const p=selectedPlayer();return p&&p.player_controller_id?("?playerControllerId="+encodeURIComponent(p.player_controller_id)):"";}
async function refreshPermissions(){const summary=document.getElementById("permissionSummary");if(summary)summary.textContent="Loading permission views...";try{permissionState=await getJson("/api/admin/permissions"+permissionQuery());renderPermissions();addActivity("permissions","Permission views refreshed",permissionState.playerControllerId?("controller "+permissionState.playerControllerId):"all players");}catch(e){if(summary)summary.textContent=betterError(e);addActivity("error","Permission refresh failed",e.message);}}
function renderPermissions(){const data=permissionState||{};const summary=document.getElementById("permissionSummary");if(summary){summary.className=data.isGuildAdmin?"warning mt":"empty mt";summary.innerHTML=data.playerControllerId?('Controller '+esc(data.playerControllerId)+' / Guild admin: <strong>'+esc(data.isGuildAdmin?"yes":"no")+'</strong>'):'All permission rows. Select a player for focused views.';}const guild=document.getElementById("guildRows");if(guild)guild.innerHTML=(data.guildMembers||[]).length?(data.guildMembers||[]).map(row=>'<tr><td>'+esc(row.player_id)+'</td><td>'+esc(row.guild_id)+'</td><td>'+esc(row.role_id)+'</td><td><span class="badge '+(row.is_guild_admin?'ok':'warn')+'">'+esc(row.is_guild_admin?'role_id 100':'no')+'</span></td></tr>').join(""):'<tr><td colspan="4">No guild member rows found for this selection.</td></tr>';const perms=document.getElementById("permissionRows");if(perms)perms.innerHTML=(data.objectPermissions||[]).length?(data.objectPermissions||[]).map(row=>'<tr><td>'+esc(row.actor_id)+'</td><td>'+esc(row.actor_name||"-")+'</td><td>'+esc(row.player_id)+'</td><td>'+esc(row.rank)+'</td></tr>').join(""):'<tr><td colspan="4">No object permission rows found for this selection.</td></tr>';const codes=document.getElementById("accessCodeRows");if(codes)codes.innerHTML=(data.accessCodes||[]).length?(data.accessCodes||[]).map(row=>'<tr><td>'+esc(row.account_id)+'</td><td>'+esc(row.access_code)+'</td><td>'+esc(row.access_code_type)+'</td><td>'+esc(row.is_resettable)+'</td></tr>').join(""):'<tr><td colspan="4">No access codes found for this selection.</td></tr>';syncPermissionForms();}
function updatePermissionPreviews(){const actor=document.getElementById("permActorId")?.value||"actor_id";const ctrl=document.getElementById("permControllerId")?.value||"player_controller_id";const rank=document.getElementById("permRank")?.value||"rank";const map=document.getElementById("permMapId")?.value||"map_id";const p1=document.getElementById("permRankPreview");if(p1)p1.textContent="select dune.permission_set_player_rank("+actor+", "+ctrl+", "+rank+", '"+map.replace(/'/g,"''")+"');";const account=document.getElementById("accessAccountId")?.value||"account_id";const code=document.getElementById("accessCodeValue")?.value||"access_code";const type=document.getElementById("accessCodeType")?.value||"access_code_type";const reset=document.getElementById("accessResettable")?.checked?"true":"false";const p2=document.getElementById("accessCodePreview");if(p2)p2.textContent="select dune.create_server_player_access_codes("+account+", "+code+", "+type+", "+reset+");";}
["permActorId","permControllerId","permRank","permMapId","accessAccountId","accessCodeValue","accessCodeType","accessResettable"].forEach(id=>setTimeout(()=>{const el=document.getElementById(id);if(el)el.addEventListener("input",updatePermissionPreviews);if(el)el.addEventListener("change",updatePermissionPreviews);},0));
async function setPermissionRank(){updatePermissionPreviews();const payload={actorId:document.getElementById("permActorId").value,playerControllerId:document.getElementById("permControllerId").value,rank:document.getElementById("permRank").value,mapId:document.getElementById("permMapId").value,confirmed:document.getElementById("permRankConfirm").checked};try{const data=await getJson("/api/admin/permissions/set-rank",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("adminLog").textContent=data.message+"\\n"+data.sql;document.getElementById("permRankConfirm").checked=false;addActivity("permissions","Object permission function executed",data.sql);playUiSound("success");await refreshPermissions();}catch(e){document.getElementById("adminLog").textContent=betterError(e)+"\\n"+document.getElementById("permRankPreview").textContent;addActivity("error","Object permission function blocked",e.message);playUiSound("warning");}}
async function createAccessCode(){updatePermissionPreviews();const payload={accountId:document.getElementById("accessAccountId").value,accessCode:document.getElementById("accessCodeValue").value,accessCodeType:document.getElementById("accessCodeType").value,isResettable:document.getElementById("accessResettable").checked,confirmed:document.getElementById("accessCodeConfirm").checked};try{const data=await getJson("/api/admin/permissions/create-access-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("adminLog").textContent=data.message+"\\n"+data.sql;document.getElementById("accessCodeConfirm").checked=false;addActivity("permissions","Access code function executed",data.sql);playUiSound("success");await refreshPermissions();}catch(e){document.getElementById("adminLog").textContent=betterError(e)+"\\n"+document.getElementById("accessCodePreview").textContent;addActivity("error","Access code function blocked",e.message);playUiSound("warning");}}
function progressionBadge(status){return '<span class="badge '+statusClass(status)+'">'+esc(status||"unknown")+'</span>';}
function progressionSupportDetails(item){const details=item?.details;if(!details)return"";if(item.label!=="Faction Component Cache Sync")return"";return '<pre class="mt">'+esc(JSON.stringify({actorIds:details.actorIds||[],componentPaths:details.componentPaths||[],arrayPaths:details.arrayPaths||[],factionRelatedPaths:details.factionRelatedPaths||[],error:details.error||""},null,2))+'</pre>';}
function renderProgressionInspector(data){const unavailable=document.getElementById("progressionUnavailable");if(unavailable)unavailable.classList.toggle("hidden",data?.status!=="unavailable");tone("progressionDbStatus",data?.database?.status||"Unknown");tone("progressionSafety",data?.safety?.readOnlyMode?"Read-only active":"Unknown");tone("progressionSchema",data?.database?.schema||"Unknown");tone("progressionDuration",data?.durationMs!=null?data.durationMs+" ms":"--");setText("progressionSignature",data?.schemaSignature||"unknown");const supports=Object.values(data?.supports||{});const supportList=document.getElementById("progressionSupportList");if(supportList)supportList.innerHTML=supports.length?supports.map(item=>'<div class="detail-row"><span class="subtle">'+esc(item.label)+'</span><strong>'+progressionBadge(item.status)+'</strong></div><div class="subtle">'+esc(item.evidence||"")+'</div>'+progressionSupportDetails(item)).join(""):'<div class="empty">No progression support metadata found.</div>';const safety=document.getElementById("progressionSafetyList");if(safety)safety.innerHTML='<div class="detail-row"><span class="subtle">Read-only mode</span><strong>'+progressionBadge(data?.safety?.readOnlyMode?"active":"unknown")+'</strong></div><div class="detail-row"><span class="subtle">Live editing</span><strong>'+progressionBadge(data?.safety?.liveEditingEnabled?"enabled":"disabled")+'</strong></div><div class="detail-row"><span class="subtle">Raw SQL input</span><strong>'+progressionBadge(data?.safety?.rawSqlInputEnabled?"enabled":"disabled")+'</strong></div><div class="subtle">'+esc(data?.safety?.message||"Read-only mode active. Live editing disabled.")+'</div>';const tableRows=document.getElementById("progressionTableRows");if(tableRows)tableRows.innerHTML=(data?.tables||[]).length?(data.tables||[]).map(row=>'<tr><td>'+esc(row.schema)+'</td><td>'+esc(row.table)+'</td><td>'+progressionBadge(row.status)+'</td></tr>').join(""):'<tr><td colspan="3">No target progression tables detected.</td></tr>';const functionRows=document.getElementById("progressionFunctionRows");if(functionRows)functionRows.innerHTML=(data?.functions||[]).length?(data.functions||[]).map(row=>'<tr><td>'+esc(row.schema)+'</td><td>'+esc(row.function)+'</td><td>'+esc(row.arguments||"")+'</td><td>'+progressionBadge(row.status)+'</td></tr>').join(""):'<tr><td colspan="4">No target progression functions detected.</td></tr>';const columnRows=document.getElementById("progressionColumnRows");if(columnRows)columnRows.innerHTML=(data?.columns||[]).length?(data.columns||[]).map(row=>'<tr><td>'+esc(row.schema+"."+row.table)+'</td><td>'+esc(row.column)+'</td><td>'+esc(row.dataType||row.udtName||"")+'</td><td>'+progressionBadge(row.status)+'</td></tr>').join(""):'<tr><td colspan="4">No target progression columns detected.</td></tr>';}
async function refreshProgressionInspector(){addActivity("progression","Progression inspector opened","Read-only metadata discovery");try{const data=await getJson("/api/progression/inspect");renderProgressionInspector(data);if(data.ok)addActivity("progression","Progression schema detected",data.schemaSignature||"schema signature unavailable");else addActivity("warn","Progression database unavailable",data.database?.error||"Database unavailable");}catch(e){renderProgressionInspector({ok:false,status:"unavailable",database:{status:"unavailable",error:e.message},schemaSignature:"unknown",tables:[],functions:[],columns:[],supports:{},safety:{readOnlyMode:true,liveEditingEnabled:false,rawSqlInputEnabled:false,message:"Progression database unavailable."}});addActivity("warn","Progression database unavailable",e.message);}}
function detailRows(rows){return Object.entries(rows||{}).map(([key,value])=>'<div class="detail-row"><span class="subtle">'+esc(key)+'</span><strong>'+esc(value||"--")+'</strong></div>').join("");}
function renderProgressionPlayer(data){const status=document.getElementById("progressionPlayerStatus");if(status){status.className=data?.ok?"empty mt":(data?.status==="not-found"?"warning mt":"warning mt");status.textContent=data?.ok?"Progression player found. Read-only values loaded.":(data?.reason||data?.error||"Progression player lookup failed.");}const identity=document.getElementById("progressionPlayerIdentity");if(identity){const p=data?.player||{};identity.innerHTML=data?.ok?detailRows({"player_id":p.player_id,"actor_id":p.actor_id,"character_actor_id":p.character_actor_id,"character_name":p.character_name,"account_id":p.account_id,"controller_id":p.player_controller_id,"pawn_id":p.player_pawn_id,"online_status":p.online_status,"map":p.map}):'<div class="empty">No player selected.</div>';}const xp=document.getElementById("progressionCharacterXp");if(xp){const character=data?.characterXp||{};const tech=data?.techKnowledge||{};xp.innerHTML=data?.ok?(detailRows({"TotalXPEarned":character.TotalXPEarned||"Unsupported / not found","TotalSkillPoints":character.TotalSkillPoints||"Unsupported / not found","UnspentSkillPoints":character.UnspentSkillPoints||"Unsupported / not found","TechKnowledgePoints":tech.m_TechKnowledgePoints||"Unsupported / not found"})):'<div class="empty">No character XP loaded.</div>';}const warnings=document.getElementById("progressionPlayerWarnings");if(warnings){const items=data?.warnings||[];warnings.innerHTML=items.length?items.map(item=>'<div class="warning">'+esc(item)+'</div>').join(""):'<div class="empty">No warnings.</div>';}renderProgressionCharacterDebug(data);const spec=document.getElementById("progressionSpecRows");if(spec)spec.innerHTML=data?.ok?((data.specializationTracks||[]).length?(data.specializationTracks||[]).map(row=>'<tr><td>'+esc(row.track_type)+'</td><td>'+esc(row.xp_amount)+'</td><td>'+esc(row.level)+'</td></tr>').join(""):'<tr><td colspan="3">No specialization rows found for this player.</td></tr>'):'<tr><td colspan="3">No player loaded.</td></tr>';const factions=document.getElementById("progressionFactionRows");if(factions)factions.innerHTML=data?.ok?((data.factionReputation||[]).length?(data.factionReputation||[]).map(row=>'<tr><td>'+esc(row.faction_id)+'</td><td>'+esc(row.reputation_amount)+'</td></tr>').join(""):'<tr><td colspan="2">No faction reputation rows found for this player.</td></tr>'):'<tr><td colspan="2">No player loaded.</td></tr>';}
function renderProgressionCharacterDebug(data){const el=document.getElementById("progressionCharacterDebug");if(!el)return;const debug=data?.progressionDebug||{};if(!data?.ok){el.textContent="No progression player lookup debug data.";return;}el.textContent=JSON.stringify({checkedActorIds:debug.checkedActorIds||[],fglEntityLinks:debug.fglEntityLinks||[],componentNames:debug.componentNames||[],techKnowledgeTarget:debug.techKnowledgeTarget||null,fieldStatus:debug.fieldStatus||{}},null,2);}
async function lookupProgressionPlayer(){const query=document.getElementById("progressionPlayerQuery")?.value||"";addActivity("progression","Progression player lookup started",query||"empty query");try{const data=await getJson("/api/progression/player?query="+encodeURIComponent(query));renderProgressionPlayer(data);if(data.ok)addActivity("progression","Progression player found",data.player?.character_name||data.player?.actor_id||query);else if(data.status==="unsupported")addActivity("warn","Progression lookup unsupported",data.reason||"Required schema missing");else addActivity("warn","Progression player not found",data.reason||query);}catch(e){renderProgressionPlayer({ok:false,status:"error",reason:betterError(e)});addActivity("error","Progression lookup unsupported",e.message);}}
setTimeout(()=>{const input=document.getElementById("progressionPlayerQuery");if(input)input.addEventListener("keydown",event=>{if(event.key==="Enter")lookupProgressionPlayer();});},0);
function syncProgressionActionFields(){const action=document.getElementById("progressionAction")?.value||"specialization_xp";document.querySelectorAll(".progression-specialization").forEach(el=>el.classList.toggle("hidden",action!=="specialization_xp"));document.querySelectorAll(".progression-faction").forEach(el=>el.classList.toggle("hidden",action!=="faction_reputation"));document.querySelectorAll(".progression-character").forEach(el=>el.classList.toggle("hidden",action!=="character_xp_skill_points"));progressionPreviewState=null;setText("progressionPreviewLog","No live progression preview generated.");}
function progressionPayload(){const action=document.getElementById("progressionAction")?.value||"specialization_xp";const payload={action,query:document.getElementById("progressionPlayerQuery")?.value||""};if(action==="specialization_xp"){payload.trackType=document.getElementById("progressionTrackType")?.value||"";payload.xpAmount=document.getElementById("progressionXpAmount")?.value||0;payload.level=document.getElementById("progressionLevel")?.value||0;}if(action==="faction_reputation"){payload.factionId=document.getElementById("progressionFactionId")?.value||1;payload.reputationAmount=document.getElementById("progressionReputationAmount")?.value||0;}if(action==="character_xp_skill_points"){payload.totalXpEarned=document.getElementById("progressionTotalXp")?.value||0;payload.totalSkillPoints=document.getElementById("progressionTotalSkillPoints")?.value||0;payload.unspentSkillPoints=document.getElementById("progressionUnspentSkillPoints")?.value||0;payload.techKnowledgePoints=document.getElementById("progressionTechKnowledgePoints")?.value||0;}return payload;}
async function previewProgressionApply(){try{const data=await getJson("/api/progression/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(progressionPayload())});if(!data.ok)throw new Error(data.reason||data.error||"Progression preview failed.");progressionPreviewState=data;setText("progressionPreviewLog","Preview generated. Backup created.\\nBackup: "+data.backupPath+"\\n\\nOld values:\\n"+JSON.stringify(data.oldValues,null,2)+"\\n\\nNew values:\\n"+JSON.stringify(data.newValues,null,2)+"\\n\\n"+data.sqlPreview+"\\n\\nType CONFIRM before applying.");addActivity("progression","Progression backup created",data.backupPath);playUiSound("success");}catch(e){progressionPreviewState=null;setText("progressionPreviewLog",betterError(e));addActivity("error","Progression preview failed",e.message);playUiSound("warning");}}
async function applyProgressionLive(){try{if(!progressionPreviewState)throw new Error("Generate Preview + Backup first.");const data=await getJson("/api/progression/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({previewId:progressionPreviewState.previewId,confirmText:document.getElementById("progressionConfirmText")?.value||""})});setText("progressionPreviewLog","Live progression apply complete.\\nBackup: "+data.backupPath+"\\n\\nOld values:\\n"+JSON.stringify(data.oldValues,null,2)+"\\n\\nNew values:\\n"+JSON.stringify(data.newValues,null,2));addActivity("progression","Progression live edit applied",data.action);progressionPreviewState=null;document.getElementById("progressionConfirmText").value="";await lookupProgressionPlayer();playUiSound("success");}catch(e){setText("progressionPreviewLog",betterError(e));addActivity("error","Progression live edit failed",e.message);playUiSound("warning");}}
function skillRepQuery(){const p=selectedPlayer();return p&&p.player_controller_id?("?playerControllerId="+encodeURIComponent(p.player_controller_id)):"";}
async function refreshSkillReputation(){return;}
function renderSkillReputation(){const data=skillRepState||{};const trackSelect=document.getElementById("skillTrack");if(trackSelect){const selected=trackSelect.value;trackSelect.innerHTML=(data.availableTracks||[]).map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join("")||'<option value="">No tracks found</option>';if(selected)trackSelect.value=selected;}const factionSelect=document.getElementById("reputationFaction");if(factionSelect){const selected=factionSelect.value;factionSelect.innerHTML=(data.factions||[]).filter(f=>f.name!=="None").map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+' ('+esc(f.id)+')</option>').join("")||'<option value="">No factions found</option>';if(selected)factionSelect.value=selected;}const skillRows=document.getElementById("skillRows");if(skillRows)skillRows.innerHTML=(data.tracks||[]).length?(data.tracks||[]).map(row=>'<tr><td>'+esc(row.track_type)+'</td><td>'+esc(row.xp_amount)+'</td><td>'+esc(row.level)+'</td></tr>').join(""):'<tr><td colspan="3">No specialization rows found for this selection.</td></tr>';const repRows=document.getElementById("reputationRows");if(repRows){const current=new Map((data.currentFactions||[]).map(row=>[String(row.faction_id),row]));repRows.innerHTML=(data.reputation||[]).length?(data.reputation||[]).map(row=>'<tr><td>'+esc(row.faction_name||row.faction_id)+'</td><td>'+esc(row.reputation_amount)+'</td><td>'+esc(current.has(String(row.faction_id))?'yes':'no')+'</td></tr>').join(""):'<tr><td colspan="3">No reputation rows found for this selection.</td></tr>';}updateSkillReputationPreviews();}
function currentSkillRow(track){return (skillRepState?.tracks||[]).find(row=>row.track_type===track)||null;}
function currentRepRow(factionId){return (skillRepState?.reputation||[]).find(row=>String(row.faction_id)===String(factionId))||null;}
function updateSkillReputationPreviews(){const p=selectedPlayer();const ctrl=p?.player_controller_id||"player_controller_id";const track=document.getElementById("skillTrack")?.value||"Combat";const xp=Number(document.getElementById("skillXpAmount")?.value||0);const levelRaw=document.getElementById("skillLevel")?.value||"";const current=currentSkillRow(track);const level=levelRaw===""?(current?.level||0):levelRaw;const escapedTrack=String(track).replace(/'/g,"''");const giveXp=(Number(current?.xp_amount)||0)+xp;const skillPreview=document.getElementById("skillPreview");if(skillPreview)skillPreview.textContent="Give Skill Points will execute:\\nselect dune.set_specialization_xp_and_level("+ctrl+", '"+escapedTrack+"'::dune.specializationtracktype, "+giveXp+", "+level+");\\n\\nSet Skill Points will execute:\\nselect dune.set_specialization_xp_and_level("+ctrl+", '"+escapedTrack+"'::dune.specializationtracktype, "+xp+", "+level+");";const faction=document.getElementById("reputationFaction")?.value||"faction_id";const rep=Number(document.getElementById("reputationAmount")?.value||0);const currentRep=Number(currentRepRow(faction)?.reputation_amount)||0;const repPreview=document.getElementById("reputationPreview");if(repPreview)repPreview.textContent="Add Reputation will execute:\\nselect dune.set_player_faction_reputation("+ctrl+", "+faction+", "+(currentRep+rep)+");\\n\\nSet Reputation will execute:\\nselect dune.set_player_faction_reputation("+ctrl+", "+faction+", "+rep+");";}
["skillTrack","skillXpAmount","skillLevel","reputationFaction","reputationAmount"].forEach(id=>setTimeout(()=>{const el=document.getElementById(id);if(el)el.addEventListener("input",updateSkillReputationPreviews);if(el)el.addEventListener("change",updateSkillReputationPreviews);},0));
async function runSkillAction(mode){updateSkillReputationPreviews();const p=selectedPlayer();const payload={playerControllerId:p?.player_controller_id||"",trackType:document.getElementById("skillTrack").value,xpAmount:document.getElementById("skillXpAmount").value,level:document.getElementById("skillLevel").value,confirmed:document.getElementById("skillConfirm").checked};try{const data=await getJson("/api/admin/skill-reputation/"+(mode==="add"?"give-skill-points":"set-skill-points"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("adminLog").textContent=data.action+" executed\\n"+data.sql+"\\n\\nPrevious: "+JSON.stringify(data.previous)+"\\nNext: "+JSON.stringify(data.next)+"\\nRollback: "+data.rollbackSql+"\\n"+data.warning;document.getElementById("skillConfirm").checked=false;addActivity("progression",mode==="add"?"Give Skill Points executed":"Set Skill Points executed",data.sql);playUiSound("success");await refreshSkillReputation();}catch(e){document.getElementById("adminLog").textContent=betterError(e)+"\\n"+document.getElementById("skillPreview").textContent;addActivity("error","Skill points action blocked",e.message);playUiSound("warning");}}
function giveSkillPoints(){runSkillAction("add");}
function setSkillPoints(){runSkillAction("set");}
async function runReputationAction(mode){updateSkillReputationPreviews();const p=selectedPlayer();const payload={playerControllerId:p?.player_controller_id||"",factionId:document.getElementById("reputationFaction").value,reputationAmount:document.getElementById("reputationAmount").value,confirmed:document.getElementById("reputationConfirm").checked};try{const data=await getJson("/api/admin/skill-reputation/"+(mode==="add"?"add-reputation":"set-reputation"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("adminLog").textContent=data.action+" executed\\n"+data.sql+"\\n\\nPrevious: "+JSON.stringify(data.previous)+"\\nNext: "+JSON.stringify(data.next)+"\\nRollback: "+data.rollbackSql+"\\n"+data.warning;document.getElementById("reputationConfirm").checked=false;addActivity("progression",mode==="add"?"Add Reputation executed":"Set Reputation executed",data.sql);playUiSound("success");await refreshSkillReputation();}catch(e){document.getElementById("adminLog").textContent=betterError(e)+"\\n"+document.getElementById("reputationPreview").textContent;addActivity("error","Reputation action blocked",e.message);playUiSound("warning");}}
function addReputation(){runReputationAction("add");}
function setReputation(){runReputationAction("set");}
function jumpToGive(){setView("give");renderPlayerSelect();}
function renderAdminChannels(rows){const body=document.getElementById("adminChannels");body.innerHTML=rows.length?rows.map(row=>'<tr><td>'+esc(row.accountId)+'</td><td>'+esc(row.selectedChannel||"-")+'</td><td>'+esc(row.channelName||"-")+'</td><td><span class="badge '+(/^true$/i.test(row.isTuned)?'ok':'warn')+'">'+esc(row.isTuned||"-")+'</span></td></tr>').join(""):'<tr><td colspan="4">No tuned channel rows found.</td></tr>';}
function renderAdminItemFilters(){const select=document.getElementById("adminItemCategory");if(!select)return;const current=select.value;const categories=[...new Set(adminItems.map(item=>item.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b));select.innerHTML='<option value="">All discovered items</option><option value="__unknown">Unknown / unclassified</option>'+categories.map(category=>'<option value="'+esc(category)+'">'+esc(category)+'</option>').join("");select.value=[...categories,"","__unknown"].includes(current)?current:"";}
function renderGearDiscoveryStatus(){const el=document.getElementById("gearDiscoveryStatus");if(!el)return;const report=adminItemReport||{};const total=Number(report.totalItemsFound||adminItems.length||0);const named=Number(report.itemsWithDisplayNames||adminItems.filter(item=>item.hasDisplayName).length||0);const unknown=Number(report.unknownOrUnclassifiedItems||adminItems.filter(item=>!item.hasDisplayName||!item.category).length||0);const pages=Number(report.totalFilesScanned||(report.filesScanned||[]).length||0);const downloaded=Number(report.totalImagesDownloaded||0);const reused=Number(report.totalImagesReused||0);const failed=Number(report.failedImageDownloads||0);const missing=Number(report.missingImages||0);const cache=report.cachePath?'<div class="subtle env-path-value">'+esc(report.cachePath)+'</div>':"";el.className=total?"empty mt":"warning mt";el.innerHTML='<strong>Items imported: '+total+'</strong><div class="subtle">Pages scanned: '+pages+' / Display names: '+named+' / Unknown or unclassified: '+unknown+'</div><div class="subtle">Images downloaded: '+downloaded+' / Reused: '+reused+' / Failed: '+failed+' / Missing: '+missing+'</div>'+cache+(report.message?'<div class="subtle">'+esc(report.message)+'</div>':'');}
async function discoverGearItems(){const status=document.getElementById("gearDiscoveryStatus");try{if(status){status.className="warning mt";status.textContent="Importing Gear items and caching local icons...";}const data=await getJson("/api/gear/discover",{method:"POST",timeoutMs:300000});adminItems=data.items||[];adminItemReport=data.report||null;renderAdminItemFilters();renderAdminItems();renderGearDiscoveryStatus();tone("adminItemsFound",String(adminItems.length));addActivity("gear","Gear item import completed",(adminItemReport?.totalItemsFound||adminItems.length)+" items imported");playUiSound("success");}catch(e){if(status){status.className="warning mt";status.textContent=betterError(e);}addActivity("error","Gear item import failed",e.message);playUiSound("warning");}}
function renderAdminItems(){const q=(document.getElementById("adminSearch")?.value||"").toLowerCase();const category=document.getElementById("adminItemCategory")?.value||"";const filtered=adminItems.filter(item=>{const matchesSearch=(item.name+" "+item.id+" "+item.category+" "+(item.type||"")+" "+(item.subtype||"")+" "+item.detail).toLowerCase().includes(q);const matchesCategory=!category||(category==="__unknown"?(!item.category||!item.hasDisplayName):item.category===category);return matchesSearch&&matchesCategory;});const list=filtered.slice(0,120);const wrap=document.getElementById("adminItems");wrap.innerHTML=list.length?list.map(item=>{const icon=item.icon?'<span class="gear-icon"><img loading="lazy" src="'+esc(item.icon)+'" alt="" onerror="this.style.display=&quot;none&quot;;this.nextElementSibling.style.display=&quot;grid&quot;"><span class="avatar" style="display:none">IT</span></span>':'<div class="avatar">IT</div>';return '<button type="button" class="admin-item '+(selectedAdminItem&&selectedAdminItem.id===item.id?'active':'')+'" data-item-id="'+esc(item.id)+'">'+icon+'<div><strong>'+esc(item.name)+'</strong><span>'+esc(item.id)+' / '+esc(item.category||"Unknown")+' '+esc(item.tier||"")+'</span></div></button>';}).join(""):'<div class="empty">No matching cached item templates. Import Gear items to populate the local cache.</div>';wrap.querySelectorAll("[data-item-id]").forEach(el=>el.addEventListener("click",()=>selectAdminItem(el.dataset.itemId)));}
function selectAdminItem(id){selectedAdminItem=adminItems.find(item=>item.id===id)||null;renderAdminItems();}
function syncQualityWarning(){const warning=document.getElementById("qualityWarning");if(!warning)return;const quality=Number(document.getElementById("adminQuality")?.value||0);warning.classList.toggle("hidden",!(quality>0));}
function adminGivePayload(){if(!selectedAdminItem)throw new Error("Choose an item first.");const payload={playerId:document.getElementById("adminPlayer").value,template:selectedAdminItem.id,qty:Number(document.getElementById("adminQty").value||1),quality:Number(document.getElementById("adminQuality").value||0)};if(!payload.playerId)throw new Error("Choose a player first.");if(!Number.isInteger(payload.qty)||payload.qty<1)throw new Error("Quantity must be greater than 0.");return payload;}
function isServerOnlineStatus(data){if(data?.runtimeTransport&&typeof data.runtimeTransport.serverOnline==="boolean")return data.runtimeTransport.serverOnline;return mapServerSummary(data).online;}
function syncLiveGiveMode(){const mode=document.getElementById("liveGiveMode")?.value||"dry-run";const button=document.getElementById("adminGiveButton");if(button)button.textContent=mode==="execute"?"Publish Live Give":"Give Item";syncLiveGiveTransportStatus();syncGiveItemControls();}
function setGiveServerStatus(message,kind){const el=document.getElementById("liveGiveServerStatus");if(!el)return;el.textContent=message;el.className=kind==="ok"?"empty mt":"warning mt";}
function syncGiveItemControls(){const give=document.getElementById("adminGiveButton");const start=document.getElementById("liveGiveStartServerButton");const mode=document.getElementById("liveGiveMode")?.value||"dry-run";if(give)give.disabled=liveGiveBusy||liveGiveServerChecking||liveGiveServerStarting||!liveGiveServerOnline||(mode==="execute"&&!adminLiveGiveAvailable);if(start)start.disabled=liveGiveBusy||liveGiveServerChecking||liveGiveServerStarting||liveGiveServerOnline;}
async function checkGiveItemServerStatus(){liveGiveServerChecking=true;syncGiveItemControls();setGiveServerStatus("Server Status: Checking","warn");try{const data=await getJson("/api/status");liveGiveServerOnline=isServerOnlineStatus(data);setGiveServerStatus(liveGiveServerOnline?"Server Status: Online. Give Item is available.":"Server Status: Offline. Start the server before using Give Item.",liveGiveServerOnline?"ok":"warn");await refreshLiveGiveEnv();return data;}catch(e){liveGiveServerOnline=false;setGiveServerStatus("Server Status: Offline. "+betterError(e),"warn");return null;}finally{liveGiveServerChecking=false;syncGiveItemControls();}}
async function startGiveItemTool(){const mode=document.getElementById("liveGiveMode");if(mode)mode.value="dry-run";liveGiveBusy=false;liveGiveServerStarting=false;syncLiveGiveMode();await checkGiveItemServerStatus();syncLiveGiveTransportStatus();}
async function startServerForGiveItem(){const log=document.getElementById("adminLog");if(liveGiveBusy||liveGiveServerStarting)return;try{liveGiveServerStarting=true;syncGiveItemControls();setGiveServerStatus("Server Status: Starting Server","warn");if(log)log.textContent="Starting server. Give Item remains disabled until the server is online.";addActivity("server","Starting server","Give Item remains blocked until online.");const data=await getJson("/api/action/start",{method:"POST"});if(!data.ok)throw new Error(data.stderr||data.stdout||data.error||"Server start failed.");if(log)log.textContent="Server start requested. Checking status...\\n"+(data.stdout||data.stderr||"");playUiSound("success");}catch(e){if(log)log.textContent="Server start failed. Give Item remains disabled.\\n"+betterError(e);addActivity("error","Server start failed",e.message);playUiSound("warning");}finally{liveGiveServerStarting=false;await checkGiveItemServerStatus();}}
async function giveAdminItem(){const log=document.getElementById("adminLog");const button=document.getElementById("adminGiveButton");if(liveGiveBusy)return;try{liveGiveBusy=true;if(button)button.disabled=true;log.textContent="Checking server status...";const server=await checkGiveItemServerStatus();if(!isServerOnlineStatus(server)){log.textContent="Server is offline. Start the server before using Give Item.";addActivity("grant","Give Item blocked","Server is offline.");playUiSound("warning");return;}const payload=adminGivePayload();const mode=document.getElementById("liveGiveMode")?.value||"dry-run";if(mode==="execute"){if(!adminLiveGiveAvailable){log.textContent=liveGiveUnavailableMessage||"Live Give unavailable.";addActivity("grant","Live Give unavailable",liveGiveUnavailableMessage);playUiSound("warning");return;}log.textContent="Publishing Live Give...";addActivity("grant","Publishing Live Give",payload.template+" x"+payload.qty);const data=await getJson("/api/admin/give-item",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload,mode:"execute",confirmed:true})});let status="Live Give failed.";if(data.status==="live-verified")status="Live Give verified.";else if(data.status==="live-published")status="Live Give published / queued.";else if(data.status==="live-unavailable")status="Live Give unavailable.";log.textContent=status+"\\n"+(data.stdout||data.stderr||data.error||"")+"\\n\\n"+JSON.stringify({status:data.status,transport:data.transport,verified:Boolean(data.verified),command:data.command||payload,response:data.response||null},null,2);addActivity("grant",status,payload.template+" -> "+payload.playerId);playUiSound(data.status==="live-unavailable"?"warning":"success");return;}log.textContent="Running Dry-Run...";addActivity("grant","Dry-run running",payload.template+" x"+payload.qty);const data=await getJson("/api/admin/give-item",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload,mode:"dry-run"})});log.textContent="Dry-run completed. No live grant executed.\\n"+(data.stdout||data.error||"")+"\\n\\n"+JSON.stringify(data.command||payload,null,2);addActivity("grant","Dry-run completed",payload.template+" -> "+payload.playerId);playUiSound("success");}catch(e){log.textContent=betterError(e);addActivity("error","Give item failed",e.message);playUiSound("warning");}finally{liveGiveBusy=false;syncGiveItemControls();}}
function showToolFrame(src){if(src==="/gear-codex/")setView("codex");else setView("management");}
function refreshAll(){refresh();refreshVmMonitor();refreshMaps();refreshAdmin();refreshPlayerFeed();refreshReceiverStatus();}
renderActivity();syncQualityWarning();syncProgressionActionFields();wireDatabaseImportControls();window.uiSoundReady=true;wireUiSounds();loadUiSoundSettings();initSetup();refreshAll();setInterval(refresh,30000);setInterval(refreshVmMonitor,10000);setInterval(refreshReceiverStatus,10000);setInterval(refreshMaps,30000);
setInterval(refreshPlayerFeed,12000);
setInterval(()=>{if(document.getElementById("live-map")?.classList.contains("active")){refreshLiveMap();refreshTeleportReadiness();}},12000);
</script>
</body>
</html>`;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(res, 200, "text/html", appPage());
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    if (!serveStatic(res, path.join(__dirname, "assets"), url.pathname.replace(/^\/assets\//, ""))) send(res, 404, "text/plain", "Not found");
    return;
  }
  if (url.pathname.startsWith("/vendor/leaflet/")) {
    if (!serveStatic(res, path.join(__dirname, "node_modules", "leaflet", "dist"), url.pathname.replace(/^\/vendor\/leaflet\//, ""))) send(res, 404, "text/plain", "Not found");
    return;
  }
  if (url.pathname === "/api/status") {
    const vm = await vmInfo();
    let status = null;
    let raw = "";
    let statusResult = null;
    const canCheckBattlegroup = Boolean((vm.exists && vm.state === "Running") || VM_IP);
    if (canCheckBattlegroup) {
      statusResult = await battlegroup("status");
      raw = statusResult.stdout || statusResult.stderr || statusResult.error || "";
      status = parseStatus(raw);
    }
    const runtimeTransport = await updateRuntimeGiveTransport({ vm, status, raw }, "status");
    const serverStatus = mapServerSummaryStatus(status?.summary || status);
    const topServerStatus = topServerStatusDecision({ vm, status, raw, statusResult });
    await json(res, { vm, status, serverStatus, topServerStatus, onlineDecisionReason: topServerStatus.onlineDecisionReason, hardOfflineReasons: topServerStatus.hardOfflineReasons, confirmationSources: topServerStatus.confirmationSources, sshKey: sshKeyStatus(SSH_KEY), directorUrl: lastDirectorUrl, runtimeTransport });
    return;
  }
  if (url.pathname === "/api/vm-monitor" && req.method === "GET") {
    try { await json(res, await vmConnectionMonitor()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/config" && req.method === "GET") {
    await json(res, configWithSshDiagnostics());
    return;
  }
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const saved = saveConfig(JSON.parse(await readBody(req) || "{}"));
      const verification = verifyConfigSaved(saved);
      if (!verification.ok) {
        await json(res, { ok: false, error: "Config save verification failed.", configPath: verification.configPath, mismatches: verification.mismatches }, 500);
        return;
      }
      await json(res, { ok: true, verified: true, configPath: verification.configPath, config: configWithSshDiagnostics(verification.config), restartRequired: true });
    }
    catch (error) { await json(res, { ok: false, error: error.message }, 400); }
    return;
  }
  if (url.pathname === "/api/ssh-key/status" && req.method === "GET") {
    await json(res, { ok: true, sshKey: sshKeyStatus(url.searchParams.get("path") || loadConfig().sshKey || defaultSshKeyPath()) });
    return;
  }
  if (url.pathname === "/api/server-install-path/status" && req.method === "GET") {
    await json(res, { ok: true, serverInstallPath: serverInstallPathStatus(url.searchParams.get("path") || loadConfig().serverInstallPath || "") });
    return;
  }
  if (url.pathname === "/api/setup/status" && req.method === "GET") {
    await json(res, { ok: true, config: publicConfig(), setupComplete: Boolean(loadConfig().setupComplete), discovery: await autoDiscovery() });
    return;
  }
  if (url.pathname === "/api/setup/save" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const pathStatus = serverInstallPathStatus(body.serverInstallPath);
      if (!pathStatus.valid) {
        await json(res, { ok: false, error: "Selected folder does not appear to be a valid Dune Awakening server installation.", serverInstallPath: pathStatus }, 400);
        return;
      }
      const saved = saveConfig({ ...loadConfig(), ...body, setupComplete: true });
      const verification = verifyConfigSaved(saved);
      if (!verification.ok) {
        await json(res, { ok: false, error: "Setup config save verification failed.", configPath: verification.configPath, mismatches: verification.mismatches }, 500);
        return;
      }
      await json(res, { ok: true, verified: true, configPath: verification.configPath, config: publicConfig(verification.config), restartRequired: true });
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/discovery" && req.method === "GET") {
    try { await json(res, await autoDiscovery()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname.startsWith("/api/test/") && req.method === "POST") {
    await json(res, await connectionTest(url.pathname.replace("/api/test/", "")));
    return;
  }
  if (url.pathname === "/api/receiver/status" && req.method === "GET") {
    await json(res, await receiverStatus());
    return;
  }
  if (url.pathname === "/api/receiver/start" && req.method === "POST") {
    try { await json(res, await startManagedReceiver()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/receiver/stop" && req.method === "POST") {
    await json(res, stopManagedReceiver());
    return;
  }
  if (url.pathname === "/api/receiver/restart" && req.method === "POST") {
    try {
      stopManagedReceiver();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await json(res, await startManagedReceiver());
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 500);
    }
    return;
  }
  if (url.pathname === "/api/settings/export" && req.method === "GET") {
    await json(res, { ok: true, exportedAt: new Date().toISOString(), version: APP_VERSION, config: loadConfig() });
    return;
  }
  if (url.pathname === "/api/settings/import" && req.method === "POST") {
    try { await json(res, { ok: true, config: publicConfig(importSettings(JSON.parse(await readBody(req) || "{}"))), restartRequired: true }); }
    catch (error) { await json(res, { ok: false, error: error.message }, 400); }
    return;
  }
  if (url.pathname === "/api/diagnostics" && req.method === "GET") {
    try { await json(res, await diagnosticsSnapshot()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/database/status" && req.method === "GET") {
    await json(res, await databaseStatus());
    return;
  }
  if (url.pathname === "/api/database/backup-location" && req.method === "GET") {
    try {
      const folder = ensureDatabaseBackupDir();
      await json(res, { ok: true, folder, defaultFolder: DEFAULT_DATABASE_BACKUP_DIR, exists: true });
    } catch (error) {
      await json(res, { ok: false, folder: databaseBackupDir(), defaultFolder: DEFAULT_DATABASE_BACKUP_DIR, error: error.message }, 500);
    }
    return;
  }
  if (url.pathname === "/api/database/backup-location" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const folder = body.reset ? DEFAULT_DATABASE_BACKUP_DIR : String(body.folder || "").trim();
      if (!folder) throw new Error("Backup folder is required.");
      const resolved = ensureDatabaseBackupDir(folder);
      const saved = saveConfig({ ...loadConfig(), databaseBackupLocation: resolved });
      await json(res, { ok: true, folder: databaseBackupDir(saved), configPath: CONFIG_PATH });
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/database/backup" && req.method === "POST") {
    try {
      const result = await createDatabaseBackup();
      await json(res, result, result.ok ? 200 : 500);
    } catch (error) {
      await json(res, { ok: false, status: "failed", error: error.message }, 500);
    }
    return;
  }
  if (url.pathname === "/api/database/safety-backup" && req.method === "POST") {
    try {
      const result = await createDatabaseBackup({ prefix: "pre-import-safety", safety: true, timeout: 120000 });
      await json(res, result, result.ok ? 200 : 500);
    } catch (error) {
      await json(res, { ok: false, status: "failed", error: error.message }, 500);
    }
    return;
  }
  if (url.pathname === "/api/database/backups" && req.method === "GET") {
    try { await json(res, listDatabaseBackups()); }
    catch (error) { await json(res, { ok: false, backups: [], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/database/import-readiness" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      await json(res, await databaseImportReadiness(body));
    } catch (error) {
      databaseBackupAudit("database_import_readiness", { import_disabled_reason: "readiness_error", error: error.message });
      await json(res, { ok: false, canTypeConfirmation: false, canImport: false, reasonCode: "readiness_error", message: error.message, conditions: { backupSelected: false, backupValid: false, serverOffline: false, noImportRunning: false, statusKnown: false } }, 500);
    }
    return;
  }
  if ((url.pathname.startsWith("/api/database/import-status/") || url.pathname.startsWith("/api/database/restore-status/")) && req.method === "GET") {
    const jobId = decodeURIComponent(url.pathname.replace(/^\/api\/database\/(?:import-status|restore-status)\//, ""));
    const job = databaseRestoreJobs.get(jobId);
    if (!job) await json(res, { ok: false, status: "missing", error: "Import job was not found." }, 404);
    else await json(res, publicRestoreJob(job));
    return;
  }
  if ((url.pathname === "/api/database/import" || url.pathname === "/api/database/restore") && req.method === "POST") {
    try {
      const result = startDatabaseRestoreJob(JSON.parse(await readBody(req) || "{}"));
      await json(res, result, 202);
    } catch (error) {
      await json(res, { ok: false, status: "failed", error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/updates/check" && req.method === "GET") {
    await json(res, await checkGitHubUpdates(url.searchParams.get("repo")));
    return;
  }
  if (url.pathname === "/api/maps" && req.method === "GET") {
    try { await json(res, await mapDeploymentList()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/world-map/metadata" && req.method === "GET") {
    try { await json(res, await worldMapMetadata()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/live-map/entities" && req.method === "GET") {
    try { await json(res, await liveMapEntities()); }
    catch (error) { await json(res, { ok: false, layers: { players: [], vehicles: [], bases: [] }, errors: [error.message], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/live-map/teleport" && req.method === "POST") {
    try { await json(res, await liveMapTeleportPreview(JSON.parse(await readBody(req) || "{}"))); }
    catch (error) { await json(res, { ok: false, error: error.message }, 400); }
    return;
  }
  if (url.pathname === "/api/live-map/teleport/presets" && req.method === "GET") {
    const result = loadTeleportLocationPresets();
    await json(res, result, result.ok ? 200 : 500);
    return;
  }
  if (url.pathname === "/api/live-map/teleport/status" && req.method === "GET") {
    try { await json(res, await liveMapTeleportStatus()); }
    catch (error) { await json(res, { ok: false, canTeleport: false, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/live-map/teleport/execute" && req.method === "POST") {
    try {
      const result = await liveMapTeleportExecute(JSON.parse(await readBody(req) || "{}"));
      await json(res, result, result.ok ? 200 : 400);
    } catch (error) {
      await json(res, { ok: false, status: "failed", error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/maps/deploy" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const result = await setMapReplicas(body.map, body.replicas);
      await json(res, result, result.ok ? 200 : 500);
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/admin/probe" && req.method === "GET") {
    try { await json(res, await adminProbe()); }
    catch (error) { await json(res, adminProbeUnavailable(error)); }
    return;
  }
  if (url.pathname === "/api/live-give/env" && req.method === "GET") {
    try { await json(res, await liveGiveEnvStatus()); }
    catch (error) { await json(res, { ok: false, liveGiveAvailable: false, missingEnv: [], message: error.message, error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/admin/players" && req.method === "GET") {
    try { await json(res, await adminPlayers()); }
    catch (error) { await json(res, { ok: false, players: [], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/players/feed" && req.method === "GET") {
    try { await json(res, await playersFeed()); }
    catch (error) { await json(res, { ok: false, players: [], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/admin/items" && req.method === "GET") {
    const cache = loadDuneItemsCache();
    await json(res, { ok: cache.ok !== false, items: cache.items || [], report: cache.report || {}, generatedAt: cache.generatedAt || "" });
    return;
  }
  if (url.pathname === "/api/gear/discovery" && req.method === "GET") {
    const cache = loadDuneItemsCache();
    await json(res, { ok: cache.ok !== false, items: cache.items || [], report: cache.report || {}, generatedAt: cache.generatedAt || "" });
    return;
  }
  if (url.pathname === "/api/gear/discover" && req.method === "POST") {
    try { await json(res, await discoverDuneItems()); }
    catch (error) { await json(res, { ok: false, items: [], report: { cachePath: DUNE_ITEMS_CACHE_PATH, error: error.message, filesScanned: [], totalItemsFound: 0 } }, 500); }
    return;
  }
  if (url.pathname === "/api/admin/tuned-channels" && req.method === "GET") {
    try { await json(res, await adminTunedChannels()); }
    catch (error) { await json(res, { ok: false, rows: [], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/admin/permissions" && req.method === "GET") {
    try { await json(res, await adminPermissions(url.searchParams.get("playerControllerId"))); }
    catch (error) { await json(res, { ok: false, guildMembers: [], objectPermissions: [], accessCodes: [], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/admin/permissions/set-rank" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      await json(res, await adminSetPermissionRank(body));
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/admin/permissions/create-access-code" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      await json(res, await adminCreateAccessCode(body));
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/progression/inspect" && req.method === "GET") {
    await json(res, await progressionInspector());
    return;
  }
  if (url.pathname === "/api/progression/player" && req.method === "GET") {
    await json(res, await progressionPlayerLookup(url.searchParams.get("query")));
    return;
  }
  if (url.pathname === "/api/progression/preview" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      await json(res, await progressionPreview(body));
    } catch (error) {
      await json(res, { ok: false, status: "error", error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/progression/apply" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      await json(res, await progressionApply(body));
    } catch (error) {
      await json(res, { ok: false, status: "failed", error: error.message }, 400);
    }
    return;
  }
  if (url.pathname === "/api/admin/skill-reputation" && req.method === "GET") {
    await json(res, {
      ok: false,
      status: "deprecated",
      error: "Legacy skill/reputation API is disabled. Use /api/progression/inspect for read-only schema discovery."
    }, 410);
    return;
  }
  if (url.pathname === "/api/admin/skill-reputation/give-skill-points" && req.method === "POST") {
    await json(res, { ok: false, status: "disabled", error: "Progression editing is disabled. Phase 1 is read-only inspection only." }, 403);
    return;
  }
  if (url.pathname === "/api/admin/skill-reputation/set-skill-points" && req.method === "POST") {
    await json(res, { ok: false, status: "disabled", error: "Progression editing is disabled. Phase 1 is read-only inspection only." }, 403);
    return;
  }
  if (url.pathname === "/api/admin/skill-reputation/add-reputation" && req.method === "POST") {
    await json(res, { ok: false, status: "disabled", error: "Progression editing is disabled. Phase 1 is read-only inspection only." }, 403);
    return;
  }
  if (url.pathname === "/api/admin/skill-reputation/set-reputation" && req.method === "POST") {
    await json(res, { ok: false, status: "disabled", error: "Progression editing is disabled. Phase 1 is read-only inspection only." }, 403);
    return;
  }
  if (url.pathname === "/api/admin/give-item" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const result = await adminGiveItem(body);
      await json(res, result, result.ok || result.dryRun ? 200 : 409);
    } catch (error) {
      await json(res, { ok: false, error: error.message }, 400);
    }
    return;
  }
  if (url.pathname.startsWith("/api/action/") && req.method === "POST") {
    const action = decodeURIComponent(url.pathname.split("/").pop());
    const result = await battlegroup(action);
    await json(res, result, result.ok ? 200 : 500);
    return;
  }
  if (url.pathname === "/api/vm/status" && req.method === "GET") {
    const vm = await vmInfo();
    await json(res, { ok: Boolean(vm.ok || vm.exists), status: vm.state || "Unknown", vm });
    return;
  }
  if (url.pathname.startsWith("/api/vm/") && req.method === "POST") {
    const action = decodeURIComponent(url.pathname.split("/").pop());
    const result = await vmAction(action);
    if (result.ok && action === "start" && url.searchParams.get("wait") === "1") {
      const wait = await waitForVmRunning();
      if (!wait.ok) appendVmAudit("start_timeout", { ...result, ok: false, error: wait.error, state: wait.vm?.state || "Unknown" });
      await json(res, { ...result, waited: wait, vm: wait.vm, ok: Boolean(wait.ok) }, wait.ok ? 200 : 500);
      return;
    }
    await json(res, { ...result, vm: await vmInfo().catch(() => ({ state: result.state || "Unknown" })) }, result.ok ? 200 : 500);
    return;
  }
  if (url.pathname === "/api/director") {
    await json(res, await directorUrl());
    return;
  }
  if (url.pathname.startsWith("/manager-api/")) {
    await proxyToManager(req, res, url.pathname);
    return;
  }
  if (url.pathname === "/manager" || url.pathname === "/manager/") {
    if (!serveStatic(res, MANAGER_DIR, "index.html")) {
      sendManagerUnavailable(res, `Manager UI shell was not found at ${MANAGER_DIR}. Rebuild with manager/** unpacked or reinstall the Suite.`);
    }
    return;
  }
  if (url.pathname.startsWith("/manager/")) {
    if (!serveStatic(res, MANAGER_DIR, url.pathname.replace(/^\/manager\//, ""))) send(res, 404, "text/plain", "Not found");
    return;
  }
  if (url.pathname === "/gear-codex" || url.pathname === "/gear-codex/") {
    serveStatic(res, CODEX_DIR, "index.html");
    return;
  }
  if (url.pathname.startsWith("/gear-codex/")) {
    if (!serveStatic(res, CODEX_DIR, url.pathname.replace(/^\/gear-codex\//, ""))) send(res, 404, "text/plain", "Not found");
    return;
  }
  if (url.pathname.startsWith("/gear-images/")) {
    if (!serveStatic(res, GEAR_IMAGE_CACHE_DIR, decodeURIComponent(url.pathname.replace(/^\/gear-images\//, "")))) send(res, 404, "text/plain", "Not found");
    return;
  }
  send(res, 404, "text/plain", "Not found");
}

startManagerService();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => json(res, { ok: false, error: error.message }, 500));
});

server.listen(PORT, HOST, async () => {
  console.log(`AlphaNine Dune Suite: http://${HOST}:${PORT}`);
  console.log(`Expected server install: ${DEFAULT_SERVER_ROOT}`);
  try {
    await updateRuntimeGiveTransport(null, "startup");
  } catch (error) {
    runtimeGiveTransport.mode = "dry-run";
    runtimeGiveTransport.serverOnline = false;
    runtimeGiveTransport.reason = error.message || "Server Offline or Not Healthy.";
    runtimeGiveTransport.initialized = true;
    appendAdminAudit("startup_transport_dry_run", { source: "startup", transport: "dry-run", serverOnline: false, reason: runtimeGiveTransport.reason });
  }
  setTimeout(() => attemptConfiguredServerStart("startup"), 1000);
  logLiveGiveStartupValidation();
});

process.on("exit", () => {
  if (managerProcess) managerProcess.kill();
});
