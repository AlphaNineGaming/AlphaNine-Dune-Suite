const http = require("http");
const https = require("https");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_VERSION = "0.1.0-beta";
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8810);
const MANAGER_PORT = 8812;
const CONFIG_PATH = path.join(__dirname, "config.json");
const MANAGER_DIR = path.join(__dirname, "manager");
const CODEX_DIR = path.join(__dirname, "gear-codex");

const defaultConfig = {
  host: "127.0.0.1",
  port: 8810,
  vmName: "dune-awakening",
  vmIp: "",
  sshUser: "dune",
  sshKey: "",
  panelTitle: "AlphaNine Dune Suite",
  panelSubtitle: "Unified local tools for your self-hosted server",
  serverInstallPath: "D:\\SteamLibrary\\steamapps\\common\\Dune Awakening Self-Hosted Server"
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  return { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
}

function saveConfig(nextConfig) {
  const allowed = ["host", "port", "vmName", "vmIp", "sshUser", "sshKey", "panelTitle", "panelSubtitle", "serverInstallPath"];
  const clean = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, key)) clean[key] = nextConfig[key];
  }
  clean.host = String(clean.host || "127.0.0.1").trim();
  clean.port = Number(clean.port) || PORT;
  clean.vmName = String(clean.vmName || "dune-awakening").trim();
  clean.vmIp = String(clean.vmIp || "").trim();
  clean.sshUser = String(clean.sshUser || "dune").trim();
  clean.sshKey = String(clean.sshKey || "").trim();
  clean.panelTitle = String(clean.panelTitle || "AlphaNine Dune Suite").trim();
  clean.panelSubtitle = String(clean.panelSubtitle || "Unified local tools for your self-hosted server").trim();
  clean.serverInstallPath = String(clean.serverInstallPath || "").trim();
  if (clean.port < 1 || clean.port > 65535) throw new Error("Port must be between 1 and 65535.");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
  return clean;
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

const config = loadConfig();
const VM_NAME = config.vmName;
const VM_IP = String(config.vmIp || "").trim();
const SSH_USER = config.sshUser || "dune";
const SSH_KEY = expandEnvPath(config.sshKey || defaultSshKeyPath());
const DEFAULT_SERVER_ROOT = expandEnvPath(config.serverInstallPath);
let lastDirectorUrl = null;
let managerProcess = null;

function envFlag(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

const LIVE_GIVE_SECRET_ENV_NAMES = new Set([
  "DUNE_ADMIN_GIVE_ITEM_TOKEN",
  "DUNE_ADMIN_RABBITMQ_PASSWORD"
]);

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: options.timeout || 120000,
      maxBuffer: 1024 * 1024 * 8
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

async function ps(script, timeout = 120000) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout });
}

async function vmInfo() {
  const script = `
    try {
    $vm = Get-VM -Name '${VM_NAME}' -ErrorAction Stop
    $ips = @(Get-VMNetworkAdapter -VMName '${VM_NAME}' | Select-Object -ExpandProperty IPAddresses | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' })
    @{ exists=$true; state="$($vm.State)"; uptime="$($vm.Uptime)"; memory=$vm.MemoryAssigned; ip=($ips | Select-Object -First 1) } | ConvertTo-Json -Compress
    } catch {
      @{ exists=$false; needsAdmin=$true; error="$($_.Exception.Message)" } | ConvertTo-Json -Compress
    }
  `;
  const result = await ps(script, 30000);
  if (!result.ok) return { exists: false, needsAdmin: true, error: result.stderr || result.error };
  try { return JSON.parse(result.stdout.trim() || "{}"); } catch { return { exists: false, error: result.stdout || result.stderr }; }
}

async function sshCommand(command, timeout = 180000) {
  const info = await vmInfo();
  const ip = info.ip || VM_IP;
  if (!info.exists && !ip) return { ok: false, stdout: "", stderr: info.error || "VM not found.", error: "VM not found." };
  if (info.exists && info.state !== "Running") return { ok: false, stdout: "", stderr: "VM is not running.", error: "VM is not running." };
  if (!ip) return { ok: false, stdout: "", stderr: "VM IP address was not found.", error: "VM IP address was not found." };
  return run("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "LogLevel=QUIET",
    "-i", SSH_KEY,
    `${SSH_USER}@${ip}`,
    command
  ], { timeout });
}

function parseStatus(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = {};
  const servers = [];
  let inServers = false;
  for (const line of lines) {
    if (/^Battlegroup:/.test(line)) summary.battlegroup = line.replace(/^Battlegroup:\s*/, "");
    if (/^Status\s+Database\s+Gateway\s+Director\s+Uptime/i.test(line)) continue;
    if (/^(Healthy|Starting|Unhealthy|Ready|Pending)\s+/i.test(line) && !summary.status) {
      const parts = line.split(/\s+/);
      summary.status = parts[0];
      summary.database = parts[1];
      summary.gateway = parts[2];
      summary.director = parts[3];
      summary.uptime = parts.slice(4).join(" ");
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
  return sshCommand(`/home/dune/.dune/bin/battlegroup ${action}`, action === "update" ? 600000 : 240000);
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
  const filePath = path.join(CODEX_DIR, "index.html");
  if (!fs.existsSync(filePath)) return [];
  const html = fs.readFileSync(filePath, "utf8");
  const match = html.match(/<script id="catalogData" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    return (data.items || []).map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.id || ""),
      category: String(item.category || ""),
      detail: String(item.detail || ""),
      tier: String(item.tier || ""),
      rarity: String(item.rarity || ""),
      maxStack: String(item.maxStack || ""),
      icon: item.icon ? `/gear-codex/${item.icon}` : ""
    })).filter((item) => item.id && item.name);
  } catch {
    return [];
  }
}

async function dbQuery(sql, timeout = 45000) {
  const item = await battlegroupResource();
  const namespace = item.metadata?.namespace;
  const dbPod = `${item.metadata?.name}-db-dbdepl-sts-0`;
  const dbSvc = `${item.metadata?.name}-db-dbdepl-svc`;
  const command = [
    `PW=$(sudo kubectl exec -n ${shQuote(namespace)} ${shQuote(dbPod)} -- printenv POSTGRES_PASSWORD)`,
    `sudo kubectl exec -n ${shQuote(namespace)} ${shQuote(dbPod)} -- env PGPASSWORD="$PW" psql -h ${shQuote(dbSvc)} -p 15432 -U postgres -d dune -At -F $'\\t' -c ${shQuote(sql)}`
  ].join("; ");
  const result = await sshCommand(command, timeout);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || "Database query failed.");
  return result.stdout.trim();
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
    req.on("error", reject);
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
    return ["DUNE_ADMIN_GIVE_ITEM_URL"];
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
  if (!LIVE_GIVE_ENV.transport || LIVE_GIVE_ENV.transport === "dry-run" || LIVE_GIVE_ENV.transport === "disabled") {
    return {
      mode: "dry-run",
      configured: false,
      missingEnv: ["DUNE_ADMIN_GIVE_ITEM_TRANSPORT"],
      reason: "Set DUNE_ADMIN_GIVE_ITEM_TRANSPORT to http-json or rabbitmq-http to enable live item grants."
    };
  }
  if (LIVE_GIVE_ENV.transport === "http-json") {
    const url = LIVE_GIVE_ENV.httpUrl;
    const missingEnv = liveGiveMissingEnv("http-json");
    if (missingEnv.length) return { mode: "http-json", configured: false, missingEnv, reason: `${missingEnv.join(", ")} required for http-json transport.` };
    return {
      mode: "http-json",
      configured: true,
      missingEnv: [],
      url,
      healthUrl: LIVE_GIVE_ENV.httpHealthUrl || url,
      token: LIVE_GIVE_ENV.httpToken
    };
  }
  if (LIVE_GIVE_ENV.transport === "rabbitmq-http") {
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
    mode: LIVE_GIVE_ENV.transport,
    configured: false,
    missingEnv: [],
    reason: `Unsupported DUNE_ADMIN_GIVE_ITEM_TRANSPORT '${LIVE_GIVE_ENV.transport}'. Use http-json, rabbitmq-http, dry-run, or disabled.`
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

async function sendLiveGiveItem(command) {
  const config = await checkGiveTransport();
  if (!config.configured) {
    return {
      ok: false,
      dryRun: true,
      command,
      transport: config.mode,
      missingEnv: config.missingEnv || [],
      error: `Live give-item is unavailable. ${config.dryRunReason || config.reason || "Transport is not configured."}`
    };
  }
  if (!config.reachable) {
    return {
      ok: false,
      dryRun: true,
      command,
      transport: config.mode,
      missingEnv: config.missingEnv || [],
      error: `Live give-item is unavailable. ${config.dryRunReason || "Transport is configured but not reachable."}`
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
    return { ok: true, dryRun: false, transport: "http-json", command, response: response.data };
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
    return { ok: true, dryRun: false, transport: "rabbitmq-http", command, response: { routed: response.data?.routed !== false } };
  }
  return { ok: false, dryRun: true, command, error: `Live give-item is unavailable: unsupported transport '${config.mode}'.` };
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
  const output = await dbQuery(tablesSql);
  const transport = await checkGiveTransport();
  const liveGiveAvailable = Boolean(transport.configured && transport.reachable);
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

function adminProbeUnavailable(error) {
  const transport = giveTransportConfig();
  const checked = {
    ...transport,
    reachable: false,
    error: error?.message || transport.reason || "Admin probe failed."
  };
  const reason = dryRunReason(checked);
  return {
    ok: false,
    transport: transportDisplayName(checked.mode),
    configured: Boolean(checked.configured),
    reachable: false,
    missingEnv: checked.missingEnv || [],
    liveGiveAvailable: false,
    dryRunReason: reason,
    giveTransport: {
      mode: checked.mode,
      configured: Boolean(checked.configured),
      reachable: false,
      statusCode: checked.statusCode || null,
      target: checked.url ? redactUrl(checked.url) : "",
      missingEnv: checked.missingEnv || [],
      reason: checked.reason || checked.error || "",
      dryRunReason: reason
    },
    error: checked.error
  };
}

async function adminPlayers() {
  const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
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
  const metaOutput = await dbQuery(metaSql);
  const idNames = ["player_id", "playerid", "account_id", "accountid", "character_id", "characterid", "id", "uid", "uuid"];
  const nameNames = ["display_name", "displayname", "player_name", "playername", "character_name", "charactername", "name", "username", "nickname"];
  const candidates = metaOutput.split(/\r?\n/).filter(Boolean).map((line) => {
    const [table, columnsRaw = ""] = line.split("\t");
    const columns = columnsRaw.split(",").filter(Boolean);
    const lower = new Map(columns.map((column) => [column.toLowerCase(), column]));
    const idCol = idNames.map((name) => lower.get(name)).find(Boolean) || columns.find((column) => /player.*id|id.*player|character.*id|id$/i.test(column));
    const nameCol = nameNames.map((name) => lower.get(name)).find(Boolean) || columns.find((column) => /name|display/i.test(column));
    if (!table || !idCol) return null;
    const idExpr = quoteIdent(idCol);
    const nameExpr = nameCol ? `coalesce(${quoteIdent(nameCol)}::text, ${idExpr}::text)` : `${idExpr}::text`;
    return {
      table: `dune.${table}`,
      sql: `select distinct ${idExpr}::text, ${nameExpr} from dune.${quoteIdent(table)} where ${idExpr} is not null order by 2 limit 100`
    };
  }).filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const output = await dbQuery(candidate.sql);
      const players = output ? output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [id, name] = line.split("\t");
        return { id: id || "", name: name || id || "Unknown" };
      }) : [];
      return { ok: true, source: candidate.table, players };
    } catch (error) {
      errors.push(`${candidate.table}: ${error.message}`);
    }
  }
  return {
    ok: false,
    players: [],
    error: "Could not auto-detect the player table yet.",
    details: errors.slice(0, 4)
  };
}

async function adminGiveItem(payload) {
  const command = validateGiveItemPayload(payload);
  return sendLiveGiveItem(command);
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

function findPython() {
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  if (fs.existsSync(bundled)) return bundled;
  return "python";
}

function startManagerService() {
  if (managerProcess) return;
  const python = findPython();
  managerProcess = spawn(python, ["manager-server.py", "--no-open"], {
    cwd: MANAGER_DIR,
    windowsHide: true,
    stdio: "ignore"
  });
  managerProcess.on("exit", () => { managerProcess = null; });
}

async function proxyToManager(req, res, pathname) {
  startManagerService();
  const target = `http://127.0.0.1:${MANAGER_PORT}${pathname.replace(/^\/manager-api/, "")}`;
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
    await json(res, { ok: false, error: `Manager service is not ready: ${error.message}` }, 502);
  }
}

function appPage() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AlphaNine Dune Suite</title>
  <style>
    :root { --bg:#101114; --panel:#1b1d21; --panel-2:#23262b; --text:#f2eee7; --muted:#a9b0b9; --line:#343941; --good:#5bd19a; --warn:#f0c46b; --bad:#ff7878; --accent:#d8a24c; --blue:#72a4f2; color-scheme:dark; font-family:"Segoe UI",system-ui,sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 12% 0%, rgba(216,162,76,.18), transparent 32%), var(--bg); color:var(--text); }
    button { font:inherit; }
    main { width:min(1440px, calc(100% - 32px)); margin:0 auto; padding:24px 0 30px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:16px; }
    h1 { margin:0; font-size:30px; letter-spacing:0; }
    .sub { margin-top:5px; color:var(--muted); line-height:1.45; }
    .header-actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .kofi { display:inline-flex; align-items:center; min-height:40px; padding:0 14px; border:1px solid #a9c9ff; border-radius:4px; background:var(--blue); color:#08111f; text-decoration:none; font-weight:800; }
    .pill { border:1px solid var(--line); color:var(--muted); background:rgba(255,255,255,.04); padding:6px 10px; border-radius:999px; font-size:13px; }
    .dune-banner { position:relative; overflow:hidden; min-height:150px; margin:0 0 16px; border:1px solid rgba(216,162,76,.36); border-radius:8px; background:radial-gradient(circle at 78% 18%, rgba(255,220,140,.5) 0 7%, rgba(255,220,140,.16) 8% 15%, transparent 16%), linear-gradient(180deg, rgba(20,25,30,.1), rgba(16,17,20,.88)), linear-gradient(120deg, rgba(216,162,76,.32), rgba(123,183,255,.12) 54%, rgba(0,0,0,.28)); box-shadow:inset 0 0 85px rgba(0,0,0,.42), 0 18px 46px rgba(0,0,0,.2); }
    .dune-banner::before { content:""; position:absolute; inset:0; background:linear-gradient(168deg, transparent 0 42%, rgba(227,157,70,.54) 43%, rgba(227,157,70,.14) 56%, transparent 57%), linear-gradient(8deg, rgba(67,45,29,.74) 0 31%, transparent 32%), linear-gradient(350deg, transparent 0 54%, rgba(245,195,111,.34) 55%, rgba(245,195,111,.08) 68%, transparent 69%); opacity:.96; }
    .dune-banner::after { content:""; position:absolute; inset:auto -8% 0 -8%; height:48%; background:linear-gradient(170deg, transparent 0 28%, rgba(164,92,39,.62) 29%, rgba(164,92,39,.18) 58%, transparent 59%), linear-gradient(7deg, rgba(35,26,19,.84), rgba(147,84,37,.42) 52%, transparent 53%); }
    .banner-content { position:relative; z-index:1; min-height:150px; display:grid; align-content:end; max-width:760px; padding:24px; }
    .banner-kicker { color:#f4d19a; font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; margin-bottom:7px; }
    .banner-title { margin:0; font-size:25px; line-height:1.08; text-shadow:0 2px 18px rgba(0,0,0,.56); }
    .banner-copy { margin:8px 0 0; color:#e7dcc8; line-height:1.45; }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; border-bottom:1px solid var(--line); padding-bottom:10px; }
    .tab { min-height:40px; border:1px solid var(--line); border-radius:7px; background:var(--panel-2); color:var(--text); padding:0 13px; cursor:pointer; }
    .tab.active { background:#8f6729; border-color:#c8903f; color:#fff6e6; }
    .view { display:none; }
    .view.active { display:block; }
    .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .card { background:rgba(27,29,33,.92); border:1px solid var(--line); border-radius:8px; padding:16px; min-height:92px; }
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .value { margin-top:7px; font-size:20px; font-weight:800; overflow-wrap:anywhere; }
    .ok { color:var(--good); } .warn { color:var(--warn); } .bad { color:var(--bad); }
    .controls { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0; }
    .button, .controls button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; border:1px solid #4a4f58; border-radius:7px; background:var(--panel-2); color:var(--text); text-decoration:none; padding:0 13px; cursor:pointer; }
    .primary { background:#8f6729 !important; border-color:#c8903f !important; }
    .danger { background:#6e2c2c !important; border-color:#a04c4c !important; }
    select, input { min-height:40px; border:1px solid #4a4f58; border-radius:7px; background:#111317; color:var(--text); padding:0 11px; }
    .deploy-panel { display:grid; grid-template-columns:minmax(220px,1fr) 110px auto auto; gap:10px; align-items:end; margin:14px 0; padding:14px; border:1px solid var(--line); border-radius:8px; background:rgba(15,16,19,.68); }
    .deploy-panel label { display:grid; gap:6px; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .deploy-panel button { min-height:40px; border:1px solid #4a4f58; border-radius:7px; background:var(--panel-2); color:var(--text); padding:0 13px; cursor:pointer; }
    .admin-layout { display:grid; grid-template-columns:minmax(300px, 420px) minmax(0,1fr); gap:12px; margin-top:16px; align-items:start; }
    .admin-form { display:grid; gap:10px; }
    .admin-form label { display:grid; gap:6px; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .admin-items { display:grid; gap:8px; max-height:420px; overflow:auto; padding-right:4px; }
    .admin-item { display:grid; grid-template-columns:42px minmax(0,1fr); gap:10px; align-items:center; border:1px solid var(--line); border-radius:7px; padding:8px; background:rgba(255,255,255,.03); cursor:pointer; }
    .admin-item.active { border-color:#c8903f; background:rgba(216,162,76,.12); }
    .admin-item img { width:42px; height:42px; object-fit:contain; border-radius:6px; background:#111317; }
    .admin-item strong { display:block; overflow-wrap:anywhere; }
    .admin-item span { color:var(--muted); font-size:12px; }
    .admin-table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
    .admin-table th, .admin-table td { text-align:left; border-bottom:1px solid var(--line); padding:8px 7px; overflow-wrap:anywhere; }
    .admin-table th { color:var(--muted); font-weight:750; }
    .map-table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
    .map-table th, .map-table td { text-align:left; border-bottom:1px solid var(--line); padding:8px 7px; }
    .map-table th { color:var(--muted); font-weight:750; }
    .map-table .active-map { color:var(--good); font-weight:800; }
    .tool-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:12px; }
    .tool-card { min-height:148px; display:grid; align-content:space-between; gap:12px; }
    .tool-card p { margin:0; color:var(--muted); line-height:1.45; }
    .frame-wrap { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#0b0c0e; min-height:720px; }
    iframe { width:100%; height:78vh; min-height:720px; border:0; display:block; background:#0b0c0e; }
    pre { white-space:pre-wrap; background:#0b0c0e; border:1px solid var(--line); border-radius:8px; padding:14px; max-height:300px; overflow:auto; }
    @media (max-width:900px) { header{display:block}.header-actions{justify-content:flex-start;margin-top:12px}.grid,.tool-grid,.deploy-panel,.admin-layout{grid-template-columns:1fr}.banner-title{font-size:21px}.frame-wrap,iframe{min-height:620px} }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>AlphaNine Dune Suite</h1>
      <div class="sub">One local app for Server Control, Manager, and Gear Codex.</div>
    </div>
    <div class="header-actions">
      <div class="kofi-widget"><script type='text/javascript' src='https://storage.ko-fi.com/cdn/widget/Widget_2.js'></script><script type='text/javascript'>kofiwidget2.init('Support me on Ko-fi', '#72a4f2', 'E1W220NMPA');kofiwidget2.draw();</script></div>
      <span class="pill">v${APP_VERSION}</span>
    </div>
  </header>
  <div class="dune-banner">
    <div class="banner-content">
      <div class="banner-kicker">Unified command deck</div>
      <h2 class="banner-title">One console for your Arrakis server tools.</h2>
      <p class="banner-copy">Control the self-hosted server, tune manager settings, and browse the Gear Codex from a single application.</p>
    </div>
  </div>
  <nav class="tabs">
    <button class="tab active" data-view="dashboard">Dashboard</button>
    <button class="tab" data-view="server">Server Control</button>
    <button class="tab" data-view="maps">Maps</button>
    <button class="tab" data-view="admin">Admin Tools</button>
    <button class="tab" data-view="manager">Manager</button>
    <button class="tab" data-view="codex">Gear Codex</button>
  </nav>
  <section id="dashboard" class="view active">
    <div class="grid">
      <div class="card"><div class="label">VM</div><div id="vm" class="value">Checking...</div></div>
      <div class="card"><div class="label">Battlegroup</div><div id="battlegroup" class="value">Checking...</div></div>
      <div class="card"><div class="label">Players</div><div id="players" class="value">Checking...</div></div>
      <div class="card"><div class="label">Manager</div><div id="managerState" class="value">Starting...</div></div>
    </div>
    <div class="tool-grid">
      <div class="card tool-card"><div><div class="label">Server Control</div><div class="value">Actions and status</div><p>Start, stop, restart, update, backup, logs, Director link, and battlegroup status.</p></div><button class="button primary" data-open="server">Open Server Control</button></div>
      <div class="card tool-card"><div><div class="label">Manager</div><div class="value">Settings and profiles</div><p>Server settings interface and admin/player tools through the suite backend.</p></div><button class="button primary" data-open="manager">Open Manager</button></div>
      <div class="card tool-card"><div><div class="label">Gear Codex</div><div class="value">Items and notes</div><p>Search weapons, armor, vehicles, tools, and resources with local icons and notes.</p></div><button class="button primary" data-open="codex">Open Gear Codex</button></div>
      <div class="card tool-card"><div><div class="label">Admin Tools</div><div class="value">Players and item grants</div><p>Find players, search local item templates, and prepare guarded admin item actions.</p></div><button class="button primary" data-open="admin">Open Admin Tools</button></div>
    </div>
  </section>
  <section id="server" class="view">
    <div class="grid">
      <div class="card"><div class="label">VM</div><div id="svm" class="value">Checking...</div></div>
      <div class="card"><div class="label">Battlegroup</div><div id="sbg" class="value">Checking...</div></div>
      <div class="card"><div class="label">Database</div><div id="sdb" class="value">Checking...</div></div>
      <div class="card"><div class="label">Uptime</div><div id="suptime" class="value">Checking...</div></div>
    </div>
    <div class="label" style="margin-top:16px">Battlegroup Actions</div>
    <div class="controls">
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
    <pre id="serverLog">Ready.</pre>
  </section>
  <section id="maps" class="view">
    <div class="grid">
      <div class="card"><div class="label">Battlegroup</div><div id="mapBattlegroup" class="value">Checking...</div></div>
      <div class="card"><div class="label">Active Maps</div><div id="activeMaps" class="value">Checking...</div></div>
      <div class="card"><div class="label">Wanted Servers</div><div id="wantedMaps" class="value">Checking...</div></div>
      <div class="card"><div class="label">Memory</div><div id="mapMemory" class="value">Plan carefully</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="label">Map Deployment</div>
      <div class="deploy-panel">
        <label>Map<select id="mapSelect"></select></label>
        <label>Replicas<input id="mapReplicas" type="number" min="0" max="3" value="1"></label>
        <button class="primary" onclick="deployMap()">Set Map</button>
        <button onclick="stopSelectedMap()">Stop Map</button>
      </div>
      <div class="label">Maps with replicas above 0 are deployed by the battlegroup. Each extra map uses server memory.</div>
      <table class="map-table">
        <thead><tr><th>Map</th><th>Type</th><th>Wanted</th><th>Running</th><th>Memory</th></tr></thead>
        <tbody id="mapRows"><tr><td colspan="4">Loading maps...</td></tr></tbody>
      </table>
    </div>
    <pre id="mapLog">Ready.</pre>
  </section>
  <section id="admin" class="view">
    <div class="grid">
      <div class="card"><div class="label">Database</div><div id="adminDb" class="value">Checking...</div></div>
      <div class="card"><div class="label">Players Found</div><div id="adminPlayersFound" class="value">Checking...</div></div>
      <div class="card"><div class="label">Items Loaded</div><div id="adminItemsFound" class="value">Checking...</div></div>
      <div class="card"><div class="label">Live Grants</div><div id="adminLive" class="value">Guarded</div></div>
    </div>
    <div class="admin-layout">
      <div class="card">
        <div class="label">Give Item</div>
        <div class="admin-form">
          <label>Player<select id="adminPlayer"></select></label>
          <label>Item Search<input id="adminSearch" placeholder="Search item name or template" oninput="renderAdminItems()"></label>
          <label>Quantity<input id="adminQty" type="number" min="1" max="9999" value="1"></label>
          <label>Quality<input id="adminQuality" type="number" min="0" max="100" value="0"></label>
          <button id="adminGiveButton" class="primary" onclick="giveAdminItem()">Prepare Give Item</button>
          <button onclick="refreshAdmin()">Refresh Admin Data</button>
        </div>
      </div>
      <div class="card">
        <div class="label">Item Templates</div>
        <div id="adminItems" class="admin-items"><div class="label">Loading items...</div></div>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="label">Tuned Channels</div>
      <table class="admin-table">
        <thead><tr><th>Account</th><th>Selected Channel</th><th>Channel</th><th>Tuned</th></tr></thead>
        <tbody id="adminChannels"><tr><td colspan="4">Loading tuned channels...</td></tr></tbody>
      </table>
    </div>
    <pre id="adminLog">Ready.</pre>
  </section>
  <section id="manager" class="view"><div class="frame-wrap"><iframe src="/manager/" title="AlphaNine Dune Manager"></iframe></div></section>
  <section id="codex" class="view"><div class="frame-wrap"><iframe src="/gear-codex/" title="Dune Gear Codex"></iframe></div></section>
</main>
<script>
const tabs=[...document.querySelectorAll(".tab")], views=[...document.querySelectorAll(".view")];
function setView(name){tabs.forEach(t=>t.classList.toggle("active",t.dataset.view===name));views.forEach(v=>v.classList.toggle("active",v.id===name));location.hash=name;}
tabs.forEach(t=>t.addEventListener("click",()=>setView(t.dataset.view)));
document.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.open)));
if(location.hash.slice(1)) setView(location.hash.slice(1));
function tone(id,value){const el=document.getElementById(id);el.className="value";const text=String(value||"Unknown");if(/healthy|ready|running|online|true/i.test(text))el.classList.add("ok");else if(/offline|failed|error|missing|not|false/i.test(text))el.classList.add("bad");else el.classList.add("warn");el.textContent=text;}
async function getJson(url, options){const r=await fetch(url,options);const t=await r.text();let d={};try{d=t?JSON.parse(t):{};}catch{d={raw:t};}if(!r.ok)throw new Error(d.error||t||"Request failed");return d;}
async function refresh(){try{const data=await getJson("/api/status");const s=data.status?.summary||{};const servers=data.status?.servers||[];const total=servers.reduce((sum,row)=>sum+(parseInt(row.players,10)||0),0);tone("vm",data.vm?.state||"Unknown");tone("battlegroup",s.status||"Unknown");tone("players",String(total));tone("managerState","Online");tone("svm",data.vm?.state||"Unknown");tone("sbg",s.status||"Unknown");tone("sdb",s.database||"Unknown");tone("suptime",s.uptime||"Unknown");document.getElementById("serverLog").textContent=data.status?.raw||"Ready.";}catch(e){tone("vm","Status error");tone("battlegroup","Offline");tone("players","0");document.getElementById("serverLog").textContent=e.message;}}
async function act(action){document.getElementById("serverLog").textContent="Running "+action+"...";try{const data=await getJson("/api/action/"+action,{method:"POST"});document.getElementById("serverLog").textContent=data.stdout||data.stderr||data.error||"Done.";setTimeout(refresh,1200);}catch(e){document.getElementById("serverLog").textContent=e.message;}}
async function openDirector(){try{const data=await getJson("/api/director");if(data.url) window.open(data.url,"_blank");else document.getElementById("serverLog").textContent=data.error||"Director URL unavailable.";}catch(e){document.getElementById("serverLog").textContent=e.message;}}
async function refreshMaps(){try{const data=await getJson("/api/maps");const maps=data.maps||[];window.mapCatalog=maps;const select=document.getElementById("mapSelect");const selected=select.value;const active=maps.reduce((sum,m)=>sum+(Number(m.running)||0),0);const wanted=maps.reduce((sum,m)=>sum+(Number(m.replicas)||0),0);tone("mapBattlegroup",data.battlegroup||"Unknown");tone("activeMaps",String(active));tone("wantedMaps",String(wanted));tone("mapMemory","Check RAM");select.innerHTML=maps.map(m=>'<option value="'+m.map+'">'+m.map+(m.dedicatedScaling?' (Dedicated)':'')+'</option>').join("");if(selected)select.value=selected;document.getElementById("mapRows").innerHTML=maps.map(m=>'<tr><td class="'+(m.running?'active-map':'')+'">'+m.map+'</td><td>'+(m.deploymentMode||'Standard')+'</td><td>'+m.replicas+'</td><td>'+m.running+'</td><td>'+(m.memory||'-')+'</td></tr>').join("");}catch(e){document.getElementById("mapRows").innerHTML='<tr><td colspan="5">'+e.message+'</td></tr>';document.getElementById("mapLog").textContent=e.message;}}
async function deployMap(){const map=document.getElementById("mapSelect").value;const replicas=Number(document.getElementById("mapReplicas").value||1);document.getElementById("mapLog").textContent="Setting "+map+" to "+replicas+" replica(s)...";try{const data=await getJson("/api/maps/deploy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({map,replicas})});document.getElementById("mapLog").textContent=data.stdout||data.stderr||"Map deployment updated.";setTimeout(()=>{refresh();refreshMaps();},1800);}catch(e){document.getElementById("mapLog").textContent=e.message;}}
function stopSelectedMap(){document.getElementById("mapReplicas").value=0;deployMap();}
let adminItems=[],selectedAdminItem=null,adminLiveGiveAvailable=false;
async function refreshAdmin(){const log=document.getElementById("adminLog");log.textContent="Loading admin data...";try{const [probe,players,items,channels]=await Promise.all([getJson("/api/admin/probe"),getJson("/api/admin/players"),getJson("/api/admin/items"),getJson("/api/admin/tuned-channels")]);adminLiveGiveAvailable=Boolean(probe.liveGiveAvailable);tone("adminDb",probe.ok?"Reachable":"Limited");tone("adminLive",adminLiveGiveAvailable?"Enabled":"Guarded");document.getElementById("adminGiveButton").textContent=adminLiveGiveAvailable?"Give Item":"Prepare Give Item";tone("adminPlayersFound",String((players.players||[]).length));tone("adminItemsFound",String((items.items||[]).length));const playerSelect=document.getElementById("adminPlayer");playerSelect.innerHTML=(players.players||[]).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("")||'<option value="">No players found</option>';adminItems=items.items||[];renderAdminItems();renderAdminChannels(channels.rows||[]);log.textContent=[probe.note,players.error,players.details&&players.details.join("\\n")].filter(Boolean).join("\\n")||"Admin tools ready.";}catch(e){tone("adminDb","Error");log.textContent=e.message;}}
function esc(value){return String(value||"").replace(/[&<>"']/g,ch=>{if(ch==="&")return"&amp;";if(ch==="<")return"&lt;";if(ch===">")return"&gt;";if(ch==='"')return"&quot;";return"&#39;";});}
function renderAdminChannels(rows){const body=document.getElementById("adminChannels");body.innerHTML=rows.length?rows.map(row=>'<tr><td>'+esc(row.accountId)+'</td><td>'+esc(row.selectedChannel||"-")+'</td><td>'+esc(row.channelName||"-")+'</td><td class="'+(/^true$/i.test(row.isTuned)?'ok':'warn')+'">'+esc(row.isTuned||"-")+'</td></tr>').join(""):'<tr><td colspan="4">No tuned channel rows found.</td></tr>';}
function renderAdminItems(){const q=(document.getElementById("adminSearch")?.value||"").toLowerCase();const list=adminItems.filter(item=>(item.name+" "+item.id+" "+item.category+" "+item.detail).toLowerCase().includes(q)).slice(0,80);const wrap=document.getElementById("adminItems");wrap.innerHTML=list.map(item=>'<button type="button" class="admin-item '+(selectedAdminItem&&selectedAdminItem.id===item.id?'active':'')+'" data-item-id="'+esc(item.id)+'">'+(item.icon?'<img src="'+esc(item.icon)+'" alt="">':'<span></span>')+'<div><strong>'+esc(item.name)+'</strong><span>'+esc(item.id)+' - '+esc(item.category)+' '+esc(item.tier)+'</span></div></button>').join("")||'<div class="label">No matching items.</div>';wrap.querySelectorAll("[data-item-id]").forEach(el=>el.addEventListener("click",()=>selectAdminItem(el.dataset.itemId)));}
function selectAdminItem(id){selectedAdminItem=adminItems.find(item=>item.id===id)||null;renderAdminItems();}
async function giveAdminItem(){const log=document.getElementById("adminLog");if(!selectedAdminItem){log.textContent="Choose an item first.";return;}const payload={playerId:document.getElementById("adminPlayer").value,template:selectedAdminItem.id,qty:Number(document.getElementById("adminQty").value||1),quality:Number(document.getElementById("adminQuality").value||0)};log.textContent=adminLiveGiveAvailable?"Giving item...":"Preparing dry-run item grant...";try{const data=await getJson("/api/admin/give-item",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const status=data.dryRun?"Dry run only.":"Live item grant sent.";log.textContent=status+"\\n"+(data.error||"")+"\\n\\n"+JSON.stringify(data.command||payload,null,2);}catch(e){log.textContent=e.message;}}
refresh();refreshMaps();refreshAdmin();setInterval(refresh,30000);setInterval(refreshMaps,30000);
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
  if (url.pathname === "/api/status") {
    const vm = await vmInfo();
    let status = null;
    if (vm.exists && vm.state === "Running") {
      const result = await battlegroup("status");
      status = parseStatus(result.stdout || result.stderr || result.error || "");
    }
    await json(res, { vm, status, directorUrl: lastDirectorUrl });
    return;
  }
  if (url.pathname === "/api/config" && req.method === "GET") {
    await json(res, loadConfig());
    return;
  }
  if (url.pathname === "/api/config" && req.method === "POST") {
    try { await json(res, { ok: true, config: saveConfig(JSON.parse(await readBody(req) || "{}")), restartRequired: true }); }
    catch (error) { await json(res, { ok: false, error: error.message }, 400); }
    return;
  }
  if (url.pathname === "/api/maps" && req.method === "GET") {
    try { await json(res, await mapDeploymentList()); }
    catch (error) { await json(res, { ok: false, error: error.message }, 500); }
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
    catch (error) { await json(res, adminProbeUnavailable(error), 500); }
    return;
  }
  if (url.pathname === "/api/admin/players" && req.method === "GET") {
    try { await json(res, await adminPlayers()); }
    catch (error) { await json(res, { ok: false, players: [], error: error.message }, 500); }
    return;
  }
  if (url.pathname === "/api/admin/items" && req.method === "GET") {
    const items = gearCatalog();
    await json(res, { ok: true, items });
    return;
  }
  if (url.pathname === "/api/admin/tuned-channels" && req.method === "GET") {
    try { await json(res, await adminTunedChannels()); }
    catch (error) { await json(res, { ok: false, rows: [], error: error.message }, 500); }
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
  if (url.pathname === "/api/director") {
    await json(res, await directorUrl());
    return;
  }
  if (url.pathname.startsWith("/manager-api/")) {
    await proxyToManager(req, res, url.pathname);
    return;
  }
  if (url.pathname === "/manager" || url.pathname === "/manager/") {
    serveStatic(res, MANAGER_DIR, "index.html");
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
  send(res, 404, "text/plain", "Not found");
}

startManagerService();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => json(res, { ok: false, error: error.message }, 500));
});

server.listen(PORT, HOST, () => {
  console.log(`AlphaNine Dune Suite: http://${HOST}:${PORT}`);
  console.log(`Expected server install: ${DEFAULT_SERVER_ROOT}`);
  logLiveGiveStartupValidation();
});

process.on("exit", () => {
  if (managerProcess) managerProcess.kill();
});
