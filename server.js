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
      coalesce(ac.funcom_id, ac.user, '') as funcom_id,
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
      const [accountId = "", funcomId = "", playerControllerId = "", characterId = "", characterName = "", resolved = "false"] = line.split("\t");
      return {
        id: accountId,
        name: characterName || accountId || "Unknown",
        account_id: accountId,
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

async function adminGiveItem(payload) {
  const command = validateGiveItemPayload(payload);
  return sendLiveGiveItem(command);
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

function requireConfirmed(value) {
  if (value !== true && value !== "true" && value !== 1 && value !== "1") {
    throw new Error("Confirm the exact function call before running this permission action.");
  }
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
    :root {
      --bg:#07090c; --bg-2:#0d1116; --panel:rgba(18,22,28,.82); --panel-2:rgba(28,33,40,.78);
      --glass:rgba(255,255,255,.045); --line:rgba(220,168,82,.28); --line-blue:rgba(108,166,255,.34);
      --text:#f4eddf; --muted:#9fa9b7; --sand:#d9b26f; --gold:#f0c56b; --blue:#72a4f2;
      --good:#56d68f; --warn:#eabf62; --bad:#ff6666; --shadow:0 24px 80px rgba(0,0,0,.45);
      color-scheme:dark; font-family:"Segoe UI",system-ui,sans-serif;
    }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--text); background:
      radial-gradient(circle at 76% 12%, rgba(114,164,242,.14), transparent 24%),
      radial-gradient(circle at 18% 0%, rgba(240,197,107,.14), transparent 26%),
      linear-gradient(160deg, #07090c 0%, #0d0f12 48%, #07090c 100%); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.2; background:
      linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px); background-size:42px 42px; }
    button, input, select { font:inherit; }
    button { cursor:pointer; }
    .shell { min-height:100vh; display:grid; grid-template-columns:260px minmax(0,1fr); }
    .sidebar { position:sticky; top:0; height:100vh; padding:22px 16px; border-right:1px solid var(--line); background:linear-gradient(180deg, rgba(12,15,20,.96), rgba(9,10,12,.91)); box-shadow:var(--shadow); }
    .brand { padding:12px 10px 18px; border-bottom:1px solid rgba(217,178,111,.22); }
    .brand h1 { margin:0; font-size:23px; line-height:1.05; }
    .brand p { margin:8px 0 0; color:var(--sand); font-size:13px; text-transform:uppercase; letter-spacing:.08em; }
    .version { display:inline-block; margin-top:12px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:5px 8px; font-size:12px; background:var(--glass); }
    .nav { display:grid; gap:8px; margin-top:18px; }
    .tab { width:100%; min-height:42px; display:flex; align-items:center; gap:10px; border:1px solid transparent; border-radius:6px; padding:0 12px; background:transparent; color:var(--muted); text-align:left; }
    .tab::before { content:""; width:8px; height:8px; border:1px solid currentColor; transform:rotate(45deg); }
    .tab.active, .tab:hover { color:var(--text); border-color:var(--line); background:linear-gradient(90deg, rgba(217,178,111,.17), rgba(114,164,242,.05)); box-shadow:inset 0 0 18px rgba(240,197,107,.05); }
    .sidebar-foot { position:absolute; left:16px; right:16px; bottom:18px; color:var(--muted); font-size:12px; line-height:1.5; }
    .content { min-width:0; padding:18px 22px 28px; }
    .topbar { position:sticky; top:0; z-index:3; display:grid; grid-template-columns:minmax(220px,1fr) auto; gap:16px; align-items:center; margin:-18px -22px 18px; padding:14px 22px; backdrop-filter:blur(18px); background:rgba(7,9,12,.76); border-bottom:1px solid rgba(217,178,111,.18); }
    .title h2 { margin:0; font-size:22px; }
    .title p { margin:4px 0 0; color:var(--muted); }
    .status-strip { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
    .badge { display:inline-flex; min-height:28px; align-items:center; gap:7px; border:1px solid var(--line); border-radius:999px; padding:0 10px; background:rgba(255,255,255,.04); color:var(--muted); font-size:12px; white-space:nowrap; }
    .badge::before { content:""; width:7px; height:7px; border-radius:999px; background:currentColor; box-shadow:0 0 10px currentColor; }
    .badge.ok { color:var(--good); border-color:rgba(86,214,143,.35); }
    .badge.warn { color:var(--warn); border-color:rgba(234,191,98,.35); }
    .badge.bad { color:var(--bad); border-color:rgba(255,102,102,.35); }
    .view { display:none; animation:fade .16s ease-out; }
    .view.active { display:block; }
    @keyframes fade { from { opacity:.2; transform:translateY(4px); } to { opacity:1; transform:none; } }
    .hero { position:relative; overflow:hidden; min-height:170px; margin-bottom:16px; border:1px solid var(--line); border-radius:8px; background:
      linear-gradient(180deg, rgba(7,9,12,.05), rgba(7,9,12,.85)),
      radial-gradient(circle at 82% 16%, rgba(240,197,107,.48) 0 6%, rgba(240,197,107,.13) 7% 15%, transparent 16%),
      linear-gradient(135deg, rgba(217,178,111,.23), rgba(114,164,242,.09) 50%, rgba(7,9,12,.3)); box-shadow:var(--shadow), inset 0 0 90px rgba(0,0,0,.38); }
    .hero::before { content:""; position:absolute; inset:0; background:linear-gradient(164deg, transparent 0 45%, rgba(218,139,62,.56) 46%, rgba(218,139,62,.14) 62%, transparent 63%), linear-gradient(8deg, rgba(39,28,20,.88) 0 32%, transparent 33%); }
    .hero-body { position:relative; min-height:170px; display:grid; align-content:end; max-width:760px; padding:24px; }
    .kicker, .label { color:var(--sand); font-size:12px; text-transform:uppercase; letter-spacing:.09em; font-weight:800; }
    .hero h3 { margin:8px 0 0; font-size:30px; line-height:1.08; }
    .hero p { margin:10px 0 0; color:#ded3c1; line-height:1.45; }
    .grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; }
    .grid.four { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .panel { position:relative; border:1px solid var(--line); border-radius:8px; background:linear-gradient(180deg, var(--panel), rgba(10,12,15,.78)); box-shadow:inset 0 0 0 1px rgba(255,255,255,.025), 0 16px 42px rgba(0,0,0,.25); }
    .panel::after { content:""; position:absolute; inset:0; border-radius:8px; pointer-events:none; box-shadow:inset 0 0 26px rgba(114,164,242,.035); }
    .panel.pad { padding:16px; }
    .value { margin-top:8px; font-size:23px; font-weight:850; overflow-wrap:anywhere; }
    .subtle { color:var(--muted); font-size:13px; line-height:1.45; }
    .layout-2 { display:grid; grid-template-columns:minmax(300px,390px) minmax(0,1fr); gap:12px; align-items:start; }
    .layout-3 { display:grid; grid-template-columns:1.1fr .9fr; gap:12px; align-items:start; }
    .controls, .action-row { display:flex; flex-wrap:wrap; gap:10px; }
    .field-grid { display:grid; gap:10px; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    select, input { width:100%; min-height:42px; border:1px solid rgba(217,178,111,.25); border-radius:6px; background:rgba(6,8,10,.86); color:var(--text); padding:0 12px; outline:none; }
    select:focus, input:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(114,164,242,.12); }
    .button, .controls button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; border:1px solid rgba(217,178,111,.32); border-radius:6px; background:linear-gradient(180deg, rgba(45,50,58,.92), rgba(24,28,34,.92)); color:var(--text); padding:0 13px; text-decoration:none; }
    .primary { background:linear-gradient(180deg, rgba(169,116,42,.98), rgba(112,75,31,.98)) !important; border-color:rgba(240,197,107,.72) !important; color:#fff6e2 !important; box-shadow:0 0 22px rgba(240,197,107,.12); }
    .danger { background:linear-gradient(180deg, rgba(112,42,42,.98), rgba(63,25,25,.98)) !important; border-color:rgba(255,102,102,.5) !important; }
    .player-list, .admin-items { display:grid; gap:8px; max-height:520px; overflow:auto; padding-right:4px; }
    .player-card, .admin-item { display:grid; grid-template-columns:46px minmax(0,1fr); gap:10px; align-items:center; width:100%; border:1px solid rgba(217,178,111,.22); border-radius:7px; padding:10px; background:rgba(255,255,255,.035); color:var(--text); text-align:left; }
    .player-card.active, .admin-item.active { border-color:var(--gold); background:rgba(217,178,111,.13); box-shadow:0 0 18px rgba(240,197,107,.08); }
    .avatar { width:46px; height:46px; display:grid; place-items:center; border:1px solid var(--line-blue); border-radius:6px; background:linear-gradient(135deg, rgba(114,164,242,.18), rgba(217,178,111,.08)); color:var(--blue); font-weight:900; }
    .admin-item img { width:46px; height:46px; object-fit:contain; border-radius:6px; background:#0b0e12; }
    .admin-item span, .player-card span { color:var(--muted); font-size:12px; display:block; overflow-wrap:anywhere; }
    .detail-list { display:grid; gap:8px; margin-top:12px; }
    .detail-row { display:grid; grid-template-columns:130px minmax(0,1fr); gap:8px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,.06); }
    .warning { border:1px solid rgba(234,191,98,.38); color:#f4d99c; background:rgba(234,191,98,.08); border-radius:6px; padding:10px; font-size:13px; line-height:1.4; }
    .warning.hidden { display:none; }
    .check-row { display:flex; align-items:center; gap:9px; color:var(--muted); font-size:13px; text-transform:none; letter-spacing:0; }
    .check-row input { width:auto; min-height:0; }
    .activity { display:grid; gap:8px; max-height:380px; overflow:auto; }
    .activity-item { border-left:2px solid var(--line-blue); padding:8px 10px; background:rgba(255,255,255,.035); border-radius:0 6px 6px 0; }
    .activity-time { color:var(--muted); font-size:12px; margin-bottom:3px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; border-bottom:1px solid rgba(255,255,255,.08); padding:9px 8px; overflow-wrap:anywhere; }
    th { color:var(--sand); font-size:12px; text-transform:uppercase; letter-spacing:.07em; }
    pre { white-space:pre-wrap; background:rgba(3,5,8,.72); border:1px solid rgba(217,178,111,.24); border-radius:8px; padding:14px; max-height:430px; overflow:auto; color:#dbe6f5; }
    .frame-wrap { overflow:hidden; min-height:720px; }
    iframe { width:100%; height:78vh; min-height:720px; border:0; display:block; background:#080a0d; }
    .empty { padding:18px; border:1px dashed rgba(217,178,111,.35); border-radius:8px; color:var(--muted); background:rgba(255,255,255,.025); }
    .mt { margin-top:12px; } .mb { margin-bottom:12px; }
    @media (max-width:1050px) { .shell{grid-template-columns:1fr}.sidebar{position:relative;height:auto}.sidebar-foot{position:static;margin-top:16px}.content{padding:14px}.topbar{position:relative;margin:-14px -14px 14px;grid-template-columns:1fr}.status-strip{justify-content:flex-start}.grid,.grid.four,.layout-2,.layout-3{grid-template-columns:1fr}.hero h3{font-size:24px}.frame-wrap,iframe{min-height:620px} }
  </style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <h1>AlphaNine Dune Suite</h1>
      <p>Arrakis Server Command Center</p>
      <span class="version">v${APP_VERSION}</span>
    </div>
    <nav class="nav">
      <button class="tab active" data-view="dashboard">Dashboard</button>
      <button class="tab" data-view="players">Players</button>
      <button class="tab" data-view="give">Give Item</button>
      <button class="tab" data-view="admin">Admin Tools</button>
      <button class="tab" data-view="server">Server Status</button>
      <button class="tab" data-view="logs">Logs</button>
      <button class="tab" data-view="settings">Settings</button>
    </nav>
    <div class="sidebar-foot">
      <div class="kofi-widget"><script type='text/javascript' src='https://storage.ko-fi.com/cdn/widget/Widget_2.js'></script><script type='text/javascript'>kofiwidget2.init('Support me on Ko-fi', '#72a4f2', 'E1W220NMPA');kofiwidget2.draw();</script></div>
    </div>
  </aside>
  <main class="content">
    <div class="topbar">
      <div class="title">
        <h2 id="viewTitle">Dashboard</h2>
        <p id="viewSubtitle">Command overview for your self-hosted Arrakis battlegroup.</p>
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
          <div class="kicker">Command deck online</div>
          <h3>AlphaNine Dune Suite</h3>
          <p>Arrakis Server Command Center for players, live grants, battlegroup status, maps, logs, and manager tools.</p>
        </div>
      </div>
      <div class="grid">
        <div class="panel pad"><div class="label">Players</div><div id="players" class="value">Checking...</div><div class="subtle">Detected from Dune player state.</div></div>
        <div class="panel pad"><div class="label">Database</div><div id="adminDb" class="value">Checking...</div><div class="subtle">Postgres/admin probe.</div></div>
        <div class="panel pad"><div class="label">Live Give</div><div id="adminLive" class="value">Checking...</div><div class="subtle">Grant transport state.</div></div>
        <div class="panel pad"><div class="label">Receiver</div><div id="receiverState" class="value">Checking...</div><div class="subtle">HTTP JSON receiver health.</div></div>
        <div class="panel pad"><div class="label">RabbitMQ</div><div id="rabbitState" class="value">Checking...</div><div class="subtle">Command bridge target.</div></div>
      </div>
      <div class="layout-3 mt">
        <div class="panel pad">
          <div class="label">Recent Activity</div>
          <div id="activityFeed" class="activity mt"><div class="empty">Activity will appear after probes, refreshes, grants, and errors.</div></div>
        </div>
        <div class="panel pad">
          <div class="label">Control Room</div>
          <div class="action-row mt">
            <button class="primary" data-open="give">Give Item</button>
            <button data-open="players">Players</button>
            <button data-open="server">Server Status</button>
            <button onclick="refreshAll()">Refresh All</button>
          </div>
          <pre id="dashboardLog" class="mt">Awaiting telemetry.</pre>
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
            <label>Quantity<input id="adminQty" type="number" min="1" max="9999" value="1"></label>
            <label>Quality<input id="adminQuality" type="number" min="0" max="100" value="0" oninput="syncQualityWarning()"></label>
            <div id="qualityWarning" class="warning hidden">Quality/grade is unsupported by the live RabbitMQ grant path. Set quality back to 0 before sending a live grant.</div>
            <button id="adminGiveButton" class="primary" onclick="giveAdminItem()">Prepare Give Item</button>
            <button onclick="refreshAdmin()">Refresh Admin Data</button>
          </div>
        </div>
        <div class="panel pad">
          <div class="label">Item Templates</div>
          <div id="adminItems" class="admin-items mt"><div class="empty">Loading item templates...</div></div>
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
        <div class="label">Tuned Channels</div>
        <table class="mt">
          <thead><tr><th>Account</th><th>Selected Channel</th><th>Channel</th><th>Tuned</th></tr></thead>
          <tbody id="adminChannels"><tr><td colspan="4">Loading tuned channels...</td></tr></tbody>
        </table>
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

    <section id="logs" class="view">
      <div class="layout-3">
        <div class="panel pad"><div class="label">Recent Activity</div><div id="activityFeedLogs" class="activity mt"></div></div>
        <div class="panel pad"><div class="label">Admin Probe and Errors</div><pre id="adminLog">Ready.</pre></div>
      </div>
      <div class="panel pad mt"><div class="label">Server Log</div><pre id="serverLogMirror">Ready.</pre></div>
    </section>

    <section id="settings" class="view">
      <div class="layout-3">
        <div class="panel pad">
          <div class="label">Settings and Linked Tools</div>
          <div class="action-row mt">
            <button class="primary" onclick="showToolFrame('/manager/')">Open Manager</button>
            <button onclick="showToolFrame('/gear-codex/')">Open Gear Codex</button>
          </div>
          <div class="subtle mt">Manager and Gear Codex remain available inside this command center.</div>
        </div>
        <div class="panel pad">
          <div class="label">Runtime</div>
          <div class="detail-list">
            <div class="detail-row"><span class="subtle">Suite URL</span><strong>http://127.0.0.1:8810</strong></div>
            <div class="detail-row"><span class="subtle">Receiver</span><strong id="settingsReceiver">Checking...</strong></div>
            <div class="detail-row"><span class="subtle">SSH Target</span><strong id="settingsSsh">Unknown</strong></div>
          </div>
        </div>
      </div>
      <div class="panel frame-wrap mt"><iframe id="toolFrame" src="/manager/" title="AlphaNine Dune tools"></iframe></div>
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
  server:["Server Status","Battlegroup controls, maps, and live server telemetry."],
  logs:["Logs","Recent grants, probe results, and errors."],
  settings:["Settings","Manager, Gear Codex, and local runtime details."]
};
function setView(name){tabs.forEach(t=>t.classList.toggle("active",t.dataset.view===name));views.forEach(v=>v.classList.toggle("active",v.id===name));const c=viewCopy[name]||viewCopy.dashboard;document.getElementById("viewTitle").textContent=c[0];document.getElementById("viewSubtitle").textContent=c[1];location.hash=name;if(name==="logs")syncLogs();}
tabs.forEach(t=>t.addEventListener("click",()=>setView(t.dataset.view)));
document.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.open)));
if(location.hash.slice(1)) setView(location.hash.slice(1));
let adminItems=[],selectedAdminItem=null,adminLiveGiveAvailable=false,adminPlayers=[],selectedPlayerId="",permissionState=null,activity=[];
function esc(value){return String(value||"").replace(/[&<>"']/g,ch=>{if(ch==="&")return"&amp;";if(ch==="<")return"&lt;";if(ch===">")return"&gt;";if(ch==='"')return"&quot;";return"&#39;";});}
function statusClass(value){const text=String(value||"");if(/healthy|ready|running|online|enabled|reachable|true/i.test(text))return"ok";if(/offline|failed|error|missing|not|false|unavailable/i.test(text))return"bad";return"warn";}
function tone(id,value){const el=document.getElementById(id);if(!el)return;el.className="value "+statusClass(value);el.textContent=String(value||"Unknown");}
function badge(id,value){const el=document.getElementById(id);if(!el)return;el.className="badge "+statusClass(value);el.textContent=String(value||"Unknown");}
function addActivity(type,message,detail){const item={time:new Date().toLocaleTimeString(),type,message,detail:detail||""};activity.unshift(item);activity=activity.slice(0,40);renderActivity();}
function renderActivity(){const html=activity.length?activity.map(a=>'<div class="activity-item"><div class="activity-time">'+esc(a.time)+' / '+esc(a.type)+'</div><strong>'+esc(a.message)+'</strong>'+(a.detail?'<div class="subtle">'+esc(a.detail)+'</div>':'')+'</div>').join(""):'<div class="empty">No activity yet.</div>';document.getElementById("activityFeed").innerHTML=html;const logs=document.getElementById("activityFeedLogs");if(logs)logs.innerHTML=html;}
function syncLogs(){const server=document.getElementById("serverLog");const mirror=document.getElementById("serverLogMirror");if(server&&mirror)mirror.textContent=server.textContent;}
async function getJson(url, options){const r=await fetch(url,options);const t=await r.text();let d={};try{d=t?JSON.parse(t):{};}catch{d={raw:t};}if(!r.ok)throw new Error(d.error||t||"Request failed");return d;}
async function refresh(){try{const data=await getJson("/api/status");const s=data.status?.summary||{};const servers=data.status?.servers||[];const total=servers.reduce((sum,row)=>sum+(parseInt(row.players,10)||0),0);tone("vm",data.vm?.state||"Unknown");tone("battlegroup",s.status||"Unknown");tone("players",String(total));tone("sdb",s.database||"Unknown");tone("suptime",s.uptime||"Unknown");badge("topServer",s.status?"Server "+s.status:"Server offline");document.getElementById("serverLog").textContent=data.status?.raw||"Ready.";syncLogs();addActivity("status","Server telemetry refreshed",s.status||"Unknown");}catch(e){tone("vm","Status error");tone("battlegroup","Offline");tone("players","0");badge("topServer","Server error");document.getElementById("serverLog").textContent=betterError(e);syncLogs();addActivity("error","Server status failed",e.message);}}
function betterError(e){return e&&e.message?e.message:"Command failed. Check that the suite is running as Administrator and the Dune VM is reachable.";}
async function act(action){document.getElementById("serverLog").textContent="Running "+action+"...";addActivity("action","Running "+action);try{const data=await getJson("/api/action/"+action,{method:"POST"});document.getElementById("serverLog").textContent=data.stdout||data.stderr||data.error||"Done.";syncLogs();addActivity("action",action+" completed",(data.error||"").slice(0,120));setTimeout(refresh,1200);}catch(e){document.getElementById("serverLog").textContent=betterError(e);syncLogs();addActivity("error",action+" failed",e.message);}}
async function openDirector(){try{const data=await getJson("/api/director");if(data.url) window.open(data.url,"_blank");else document.getElementById("serverLog").textContent=data.error||"Director URL unavailable.";}catch(e){document.getElementById("serverLog").textContent=betterError(e);}}
async function refreshMaps(){try{const data=await getJson("/api/maps");const maps=data.maps||[];const select=document.getElementById("mapSelect");const selected=select.value;const active=maps.reduce((sum,m)=>sum+(Number(m.running)||0),0);const wanted=maps.reduce((sum,m)=>sum+(Number(m.replicas)||0),0);tone("mapBattlegroup",data.battlegroup||"Unknown");tone("activeMaps",String(active));tone("wantedMaps",String(wanted));tone("mapMemory","Check RAM");select.innerHTML=maps.map(m=>'<option value="'+esc(m.map)+'">'+esc(m.map)+(m.dedicatedScaling?' (Dedicated)':'')+'</option>').join("")||'<option value="">No maps found</option>';if(selected)select.value=selected;document.getElementById("mapRows").innerHTML=maps.length?maps.map(m=>'<tr><td class="'+(m.running?'ok':'')+'">'+esc(m.map)+'</td><td>'+esc(m.deploymentMode||'Standard')+'</td><td>'+m.replicas+'</td><td>'+m.running+'</td><td>'+esc(m.memory||'-')+'</td></tr>').join(""):'<tr><td colspan="5">No map deployments found.</td></tr>';addActivity("maps","Map deployment refreshed",active+" active / "+wanted+" wanted");}catch(e){document.getElementById("mapRows").innerHTML='<tr><td colspan="5">'+esc(e.message)+'</td></tr>';document.getElementById("mapLog").textContent=betterError(e);addActivity("error","Map refresh failed",e.message);}}
async function deployMap(){const map=document.getElementById("mapSelect").value;const replicas=Number(document.getElementById("mapReplicas").value||1);document.getElementById("mapLog").textContent="Setting "+map+" to "+replicas+" replica(s)...";try{const data=await getJson("/api/maps/deploy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({map,replicas})});document.getElementById("mapLog").textContent=data.stdout||data.stderr||"Map deployment updated.";addActivity("maps","Map deployment updated",map+" -> "+replicas);setTimeout(()=>{refresh();refreshMaps();},1800);}catch(e){document.getElementById("mapLog").textContent=betterError(e);addActivity("error","Map deployment failed",e.message);}}
function stopSelectedMap(){document.getElementById("mapReplicas").value=0;deployMap();}
async function refreshAdmin(){const log=document.getElementById("adminLog");log.textContent="Loading admin data...";try{const [probe,players,items,channels]=await Promise.all([getJson("/api/admin/probe"),getJson("/api/admin/players"),getJson("/api/admin/items"),getJson("/api/admin/tuned-channels")]);adminLiveGiveAvailable=Boolean(probe.liveGiveAvailable);adminPlayers=players.players||[];adminItems=items.items||[];if(!selectedPlayerId&&adminPlayers[0])selectedPlayerId=adminPlayers[0].id;tone("adminDb",probe.ok?"Reachable":"Limited");tone("adminDbMirror",probe.ok?"Reachable":"Limited");tone("adminLive",adminLiveGiveAvailable?"Enabled":"Guarded");tone("adminLiveMirror",adminLiveGiveAvailable?"Enabled":"Guarded");tone("receiverState",probe.giveTransport?.reachable?"Online":(probe.giveTransport?.configured?"Warning":"Dry-run"));tone("rabbitState",probe.giveTransport?.mode||probe.transport||"Unknown");tone("adminPlayersFound",String(adminPlayers.length));tone("adminItemsFound",String(adminItems.length));badge("topDb",probe.ok?"DB reachable":"DB limited");badge("topLive",adminLiveGiveAvailable?"Live give enabled":"Live give guarded");badge("topPlayers","Players "+adminPlayers.length);const ssh=players.diagnostics?.sshTarget||"SSH unknown";badge("topSsh",ssh);document.getElementById("settingsSsh").textContent=ssh;document.getElementById("settingsReceiver").textContent=probe.giveTransport?.target||probe.transport||"Unknown";document.getElementById("adminGiveButton").textContent=adminLiveGiveAvailable?"Give Item":"Prepare Give Item";renderPlayerSelect();renderPermissionPlayerSelect();renderPlayers();renderAdminItems();renderAdminChannels(channels.rows||[]);await refreshPermissions();const playerDiag=players.details&&players.details.length?["Player discovery diagnostics:",...players.details].join("\\n"):"";log.textContent=[probe.note,players.error,playerDiag].filter(Boolean).join("\\n\\n")||"Admin tools ready.";addActivity("probe","Admin probe refreshed",adminLiveGiveAvailable?"Live give enabled":"Live give guarded");}catch(e){tone("adminDb","Error");tone("adminDbMirror","Error");badge("topDb","DB error");log.textContent=betterError(e);addActivity("error","Admin refresh failed",e.message);}}
function playerLabel(p){return (p.character_name||p.name||p.id||"Unknown")+" / account "+(p.account_id||p.id||"-");}
function selectedPlayer(){return adminPlayers.find(row=>row.id===selectedPlayerId)||null;}
function renderPlayerSelect(){const select=document.getElementById("adminPlayer");select.innerHTML=adminPlayers.length?adminPlayers.map(p=>'<option value="'+esc(p.id)+'">'+esc(playerLabel(p))+'</option>').join(""):'<option value="">No players found</option>';if(selectedPlayerId)select.value=selectedPlayerId;}
function renderPermissionPlayerSelect(){const select=document.getElementById("permissionPlayer");if(!select)return;select.innerHTML=adminPlayers.length?adminPlayers.map(p=>'<option value="'+esc(p.id)+'">'+esc(playerLabel(p))+'</option>').join(""):'<option value="">No players found</option>';if(selectedPlayerId)select.value=selectedPlayerId;syncPermissionForms();}
function renderPlayers(){const q=(document.getElementById("playerSearch")?.value||"").toLowerCase();const list=adminPlayers.filter(p=>((p.name||"")+" "+(p.account_id||"")+" "+(p.character_id||"")+" "+(p.character_name||"")+" "+(p.funcom_id||"")+" "+(p.player_controller_id||"")).toLowerCase().includes(q));const wrap=document.getElementById("playerCards");wrap.innerHTML=list.length?list.map(p=>'<button class="player-card '+(p.id===selectedPlayerId?'active':'')+'" data-player-id="'+esc(p.id)+'"><div class="avatar">'+esc((p.name||p.id||"?").slice(0,2).toUpperCase())+'</div><div><strong>'+esc(p.name||p.character_name||p.id)+'</strong><span>Account '+esc(p.account_id||p.id)+' / Controller '+esc(p.player_controller_id||"-")+' / Funcom '+esc(p.funcom_id||"-")+'</span></div></button>').join(""):'<div class="empty">No players match that search.</div>';wrap.querySelectorAll("[data-player-id]").forEach(el=>el.addEventListener("click",()=>selectPlayer(el.dataset.playerId)));renderPlayerDetails();}
function selectPlayer(id){selectedPlayerId=String(id||"");const select=document.getElementById("adminPlayer");if(select)select.value=selectedPlayerId;const perm=document.getElementById("permissionPlayer");if(perm)perm.value=selectedPlayerId;renderPlayers();syncPermissionForms();refreshPermissions();}
function syncSelectedPlayerFromSelect(){selectedPlayerId=document.getElementById("adminPlayer").value;const perm=document.getElementById("permissionPlayer");if(perm)perm.value=selectedPlayerId;renderPlayers();syncPermissionForms();refreshPermissions();}
function syncPermissionPlayer(){selectedPlayerId=document.getElementById("permissionPlayer").value;const select=document.getElementById("adminPlayer");if(select)select.value=selectedPlayerId;renderPlayers();syncPermissionForms();refreshPermissions();}
function renderPlayerDetails(){const p=selectedPlayer();const wrap=document.getElementById("playerDetails");if(!p){wrap.className="empty mt";wrap.innerHTML="Select a player to inspect account and character details.";return;}wrap.className="detail-list";wrap.innerHTML='<div class="detail-row"><span class="subtle">Character</span><strong>'+esc(p.name||p.character_name||p.id)+'</strong></div><div class="detail-row"><span class="subtle">Account ID</span><strong>'+esc(p.account_id||p.id)+'</strong></div><div class="detail-row"><span class="subtle">Funcom ID</span><strong>'+esc(p.funcom_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Player Controller ID</span><strong>'+esc(p.player_controller_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Character ID</span><strong>'+esc(p.character_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Give Item ID</span><strong>'+esc(p.id)+'</strong></div>';}
function syncPermissionForms(){const p=selectedPlayer();const identity=document.getElementById("permissionIdentity");if(identity){identity.className="detail-list";identity.innerHTML=p?'<div class="detail-row"><span class="subtle">Character</span><strong>'+esc(p.character_name||p.name||"-")+'</strong></div><div class="detail-row"><span class="subtle">Account ID</span><strong>'+esc(p.account_id||p.id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Funcom ID</span><strong>'+esc(p.funcom_id||"-")+'</strong></div><div class="detail-row"><span class="subtle">Player Controller ID</span><strong>'+esc(p.player_controller_id||"-")+'</strong></div>':'<div class="empty">No player selected.</div>';}if(p){const ctrl=document.getElementById("permControllerId");if(ctrl&&!ctrl.value)ctrl.value=p.player_controller_id||"";const acct=document.getElementById("accessAccountId");if(acct&&!acct.value)acct.value=p.account_id||p.id||"";}updatePermissionPreviews();}
function permissionQuery(){const p=selectedPlayer();return p&&p.player_controller_id?("?playerControllerId="+encodeURIComponent(p.player_controller_id)):"";}
async function refreshPermissions(){const summary=document.getElementById("permissionSummary");if(summary)summary.textContent="Loading permission views...";try{permissionState=await getJson("/api/admin/permissions"+permissionQuery());renderPermissions();addActivity("permissions","Permission views refreshed",permissionState.playerControllerId?("controller "+permissionState.playerControllerId):"all players");}catch(e){if(summary)summary.textContent=betterError(e);addActivity("error","Permission refresh failed",e.message);}}
function renderPermissions(){const data=permissionState||{};const summary=document.getElementById("permissionSummary");if(summary){summary.className=data.isGuildAdmin?"warning mt":"empty mt";summary.innerHTML=data.playerControllerId?('Controller '+esc(data.playerControllerId)+' / Guild admin: <strong>'+esc(data.isGuildAdmin?"yes":"no")+'</strong>'):'All permission rows. Select a player for focused views.';}const guild=document.getElementById("guildRows");if(guild)guild.innerHTML=(data.guildMembers||[]).length?(data.guildMembers||[]).map(row=>'<tr><td>'+esc(row.player_id)+'</td><td>'+esc(row.guild_id)+'</td><td>'+esc(row.role_id)+'</td><td><span class="badge '+(row.is_guild_admin?'ok':'warn')+'">'+esc(row.is_guild_admin?'role_id 100':'no')+'</span></td></tr>').join(""):'<tr><td colspan="4">No guild member rows found for this selection.</td></tr>';const perms=document.getElementById("permissionRows");if(perms)perms.innerHTML=(data.objectPermissions||[]).length?(data.objectPermissions||[]).map(row=>'<tr><td>'+esc(row.actor_id)+'</td><td>'+esc(row.actor_name||"-")+'</td><td>'+esc(row.player_id)+'</td><td>'+esc(row.rank)+'</td></tr>').join(""):'<tr><td colspan="4">No object permission rows found for this selection.</td></tr>';const codes=document.getElementById("accessCodeRows");if(codes)codes.innerHTML=(data.accessCodes||[]).length?(data.accessCodes||[]).map(row=>'<tr><td>'+esc(row.account_id)+'</td><td>'+esc(row.access_code)+'</td><td>'+esc(row.access_code_type)+'</td><td>'+esc(row.is_resettable)+'</td></tr>').join(""):'<tr><td colspan="4">No access codes found for this selection.</td></tr>';syncPermissionForms();}
function updatePermissionPreviews(){const actor=document.getElementById("permActorId")?.value||"actor_id";const ctrl=document.getElementById("permControllerId")?.value||"player_controller_id";const rank=document.getElementById("permRank")?.value||"rank";const map=document.getElementById("permMapId")?.value||"map_id";const p1=document.getElementById("permRankPreview");if(p1)p1.textContent="select dune.permission_set_player_rank("+actor+", "+ctrl+", "+rank+", '"+map.replace(/'/g,"''")+"');";const account=document.getElementById("accessAccountId")?.value||"account_id";const code=document.getElementById("accessCodeValue")?.value||"access_code";const type=document.getElementById("accessCodeType")?.value||"access_code_type";const reset=document.getElementById("accessResettable")?.checked?"true":"false";const p2=document.getElementById("accessCodePreview");if(p2)p2.textContent="select dune.create_server_player_access_codes("+account+", "+code+", "+type+", "+reset+");";}
["permActorId","permControllerId","permRank","permMapId","accessAccountId","accessCodeValue","accessCodeType","accessResettable"].forEach(id=>setTimeout(()=>{const el=document.getElementById(id);if(el)el.addEventListener("input",updatePermissionPreviews);if(el)el.addEventListener("change",updatePermissionPreviews);},0));
async function setPermissionRank(){updatePermissionPreviews();const payload={actorId:document.getElementById("permActorId").value,playerControllerId:document.getElementById("permControllerId").value,rank:document.getElementById("permRank").value,mapId:document.getElementById("permMapId").value,confirmed:document.getElementById("permRankConfirm").checked};try{const data=await getJson("/api/admin/permissions/set-rank",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("adminLog").textContent=data.message+"\\n"+data.sql;document.getElementById("permRankConfirm").checked=false;addActivity("permissions","Object permission function executed",data.sql);await refreshPermissions();}catch(e){document.getElementById("adminLog").textContent=betterError(e)+"\\n"+document.getElementById("permRankPreview").textContent;addActivity("error","Object permission function blocked",e.message);}}
async function createAccessCode(){updatePermissionPreviews();const payload={accountId:document.getElementById("accessAccountId").value,accessCode:document.getElementById("accessCodeValue").value,accessCodeType:document.getElementById("accessCodeType").value,isResettable:document.getElementById("accessResettable").checked,confirmed:document.getElementById("accessCodeConfirm").checked};try{const data=await getJson("/api/admin/permissions/create-access-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});document.getElementById("adminLog").textContent=data.message+"\\n"+data.sql;document.getElementById("accessCodeConfirm").checked=false;addActivity("permissions","Access code function executed",data.sql);await refreshPermissions();}catch(e){document.getElementById("adminLog").textContent=betterError(e)+"\\n"+document.getElementById("accessCodePreview").textContent;addActivity("error","Access code function blocked",e.message);}}
function jumpToGive(){setView("give");renderPlayerSelect();}
function renderAdminChannels(rows){const body=document.getElementById("adminChannels");body.innerHTML=rows.length?rows.map(row=>'<tr><td>'+esc(row.accountId)+'</td><td>'+esc(row.selectedChannel||"-")+'</td><td>'+esc(row.channelName||"-")+'</td><td><span class="badge '+(/^true$/i.test(row.isTuned)?'ok':'warn')+'">'+esc(row.isTuned||"-")+'</span></td></tr>').join(""):'<tr><td colspan="4">No tuned channel rows found.</td></tr>';}
function renderAdminItems(){const q=(document.getElementById("adminSearch")?.value||"").toLowerCase();const list=adminItems.filter(item=>(item.name+" "+item.id+" "+item.category+" "+item.detail).toLowerCase().includes(q)).slice(0,90);const wrap=document.getElementById("adminItems");wrap.innerHTML=list.length?list.map(item=>'<button type="button" class="admin-item '+(selectedAdminItem&&selectedAdminItem.id===item.id?'active':'')+'" data-item-id="'+esc(item.id)+'">'+(item.icon?'<img src="'+esc(item.icon)+'" alt="">':'<div class="avatar">IT</div>')+'<div><strong>'+esc(item.name)+'</strong><span>'+esc(item.id)+' / '+esc(item.category)+' '+esc(item.tier)+'</span></div></button>').join(""):'<div class="empty">No matching item templates.</div>';wrap.querySelectorAll("[data-item-id]").forEach(el=>el.addEventListener("click",()=>selectAdminItem(el.dataset.itemId)));}
function selectAdminItem(id){selectedAdminItem=adminItems.find(item=>item.id===id)||null;renderAdminItems();}
function syncQualityWarning(){const warning=document.getElementById("qualityWarning");if(!warning)return;const quality=Number(document.getElementById("adminQuality")?.value||0);warning.classList.toggle("hidden",!(quality>0));}
async function giveAdminItem(){const log=document.getElementById("adminLog");if(!selectedAdminItem){log.textContent="Choose an item first.";addActivity("warning","Give item blocked","No item selected.");return;}const payload={playerId:document.getElementById("adminPlayer").value,template:selectedAdminItem.id,qty:Number(document.getElementById("adminQty").value||1),quality:Number(document.getElementById("adminQuality").value||0)};if(!payload.playerId){log.textContent="Choose a player first.";addActivity("warning","Give item blocked","No player selected.");return;}log.textContent=adminLiveGiveAvailable?"Giving item...":"Preparing dry-run item grant...";addActivity("grant",adminLiveGiveAvailable?"Sending live item grant":"Preparing dry-run",payload.template+" x"+payload.qty);try{const data=await getJson("/api/admin/give-item",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const status=data.dryRun?"Dry run only.":"Live item grant sent.";log.textContent=status+"\\n"+(data.error||"")+"\\n\\n"+JSON.stringify(data.command||payload,null,2);addActivity("grant",status,payload.template+" -> "+payload.playerId);}catch(e){log.textContent=betterError(e);addActivity("error","Give item failed",e.message);}}
function showToolFrame(src){document.getElementById("toolFrame").src=src;}
function refreshAll(){refresh();refreshMaps();refreshAdmin();}
renderActivity();syncQualityWarning();refreshAll();setInterval(refresh,30000);setInterval(refreshMaps,30000);
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
