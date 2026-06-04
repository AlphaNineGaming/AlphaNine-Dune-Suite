const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const APP_VERSION = "1.1.5";
const defaultConfig = {
  host: "127.0.0.1",
  port: 8787,
  vmName: "dune-awakening",
  sshUser: "dune",
  sshKey: "",
  panelTitle: "Dune Server Control",
  panelSubtitle: "Local panel for your self-hosted server",
  donationUrl: "https://ko-fi.com/alphanine",
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
  const allowed = [
    "host",
    "port",
    "vmName",
    "sshUser",
    "sshKey",
    "panelTitle",
    "panelSubtitle",
    "serverInstallPath",
  ];
  const clean = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, key)) clean[key] = nextConfig[key];
  }
  clean.host = String(clean.host || "127.0.0.1").trim();
  clean.port = Number(clean.port) || 8787;
  clean.vmName = String(clean.vmName || "dune-awakening").trim();
  clean.sshUser = String(clean.sshUser || "dune").trim();
  clean.sshKey = String(clean.sshKey || "").trim();
  clean.panelTitle = String(clean.panelTitle || "Dune Server Control").trim();
  clean.panelSubtitle = String(clean.panelSubtitle || "Local panel for your self-hosted server").trim();
  clean.serverInstallPath = String(clean.serverInstallPath || "").trim();
  if (clean.port < 1 || clean.port > 65535) throw new Error("Port must be between 1 and 65535.");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
  return clean;
}

function publicConfig() {
  const current = loadConfig();
  const { donationUrl, ...safe } = current;
  return safe;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 64) {
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
const HOST = config.host;
const PORT = Number(config.port) || 8787;
const VM_NAME = config.vmName;
const SSH_USER = config.sshUser || "dune";
const SSH_KEY = expandEnvPath(config.sshKey || defaultSshKeyPath());
const DEFAULT_SERVER_ROOT = expandEnvPath(config.serverInstallPath);

let lastDirectorUrl = null;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: options.timeout || 120000,
      maxBuffer: 1024 * 1024 * 8,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error ? String(error.message || error) : "",
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
  if (!info.exists) return { ok: false, stdout: "", stderr: info.error || "VM not found.", error: "VM not found." };
  if (info.state !== "Running") return { ok: false, stdout: "", stderr: "VM is not running.", error: "VM is not running." };
  if (!info.ip) return { ok: false, stdout: "", stderr: "VM IP address was not found.", error: "VM IP address was not found." };
  return run("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "LogLevel=QUIET",
    "-i", SSH_KEY,
    `${SSH_USER}@${info.ip}`,
    command,
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
          age: parts.slice(4).join(" "),
        });
      }
    }
  }
  return { summary, servers, raw: text };
}

function htmlEscape(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

const panelTitle = htmlEscape(config.panelTitle);
const panelSubtitle = htmlEscape(config.panelSubtitle);
const donationButton = `<div class="kofi-widget">
  <script type="text/javascript" src="https://storage.ko-fi.com/cdn/widget/Widget_2.js"></script>
  <script type="text/javascript">kofiwidget2.init('Support me on Ko-fi', '#72a4f2', 'E1W220NMPA');kofiwidget2.draw();</script>
</div>`;
const logoPath = "/assets/alphanine-logo.jpg";

async function battlegroup(action) {
  const allowed = new Set(["status", "start", "restart", "stop", "update", "backup", "logs-export", "operator-logs-export"]);
  if (!allowed.has(action)) return { ok: false, error: "Unsupported action." };
  return sshCommand(`/home/dune/.dune/bin/battlegroup ${action}`, action === "update" ? 600000 : 240000);
}

async function startVm() {
  return ps(`Start-VM -Name '${VM_NAME}'`, 60000);
}

async function stopVm() {
  return ps(`Stop-VM -Name '${VM_NAME}'`, 60000);
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

async function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${panelTitle}</title>
  <style>
    :root {
      --bg: #101114;
      --panel: #1b1d21;
      --panel-2: #23262b;
      --text: #f2eee7;
      --muted: #a9b0b9;
      --line: #343941;
      --good: #5bd19a;
      --warn: #f0c46b;
      --bad: #ff7878;
      --accent: #d8a24c;
      --accent-2: #7bb7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(circle at top left, rgba(216,162,76,.16), transparent 36%), var(--bg);
      color: var(--text);
    }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-logo {
      width: 68px;
      height: 68px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid #2ec7ef;
      box-shadow: 0 0 22px rgba(46, 199, 239, .16), 0 0 18px rgba(226, 36, 92, .12);
      flex: 0 0 auto;
    }
    .brand-copy { min-width: 0; }
    .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: 0; }
    .sub { margin-top: 5px; color: var(--muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .card { background: rgba(27,29,33,.92); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 7px; font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
    .ok { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; }
    .settings-panel { display: none; }
    .settings-panel.open { display: block; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .field label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
    .field input {
      width: 100%;
      min-height: 40px;
      border-radius: 7px;
      border: 1px solid #454b54;
      background: #101216;
      color: var(--text);
      padding: 9px 10px;
      font: inherit;
    }
    .settings-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; align-items: center; }
    .settings-note { color: var(--warn); font-size: 13px; }
    button, a.button {
      appearance: none;
      border: 1px solid #4a4f58;
      border-radius: 7px;
      background: var(--panel-2);
      color: var(--text);
      padding: 10px 13px;
      min-height: 40px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    button.primary { background: #8f6729; border-color: #c8903f; }
    button.blue { background: #1d4f7c; border-color: #4987bd; }
    button.danger { background: #6e2c2c; border-color: #a04c4c; }
    .kofi-widget { display: flex; align-items: center; min-height: 40px; }
    .version { color: #d7dde5; }
    button:disabled { opacity: .55; cursor: progress; }
    .dune-banner {
      position: relative;
      overflow: hidden;
      min-height: 150px;
      margin: 0 0 18px;
      border: 1px solid rgba(216, 162, 76, .36);
      border-radius: 8px;
      background:
        radial-gradient(circle at 78% 18%, rgba(255, 220, 140, .5) 0 7%, rgba(255, 220, 140, .16) 8% 15%, transparent 16%),
        linear-gradient(180deg, rgba(20, 25, 30, .1), rgba(16, 17, 20, .88)),
        linear-gradient(120deg, rgba(216, 162, 76, .32), rgba(123, 183, 255, .12) 54%, rgba(0, 0, 0, .28));
      box-shadow: inset 0 0 85px rgba(0, 0, 0, .42), 0 18px 46px rgba(0, 0, 0, .2);
    }
    .dune-banner::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(168deg, transparent 0 42%, rgba(227, 157, 70, .54) 43%, rgba(227, 157, 70, .14) 56%, transparent 57%),
        linear-gradient(8deg, rgba(67, 45, 29, .74) 0 31%, transparent 32%),
        linear-gradient(350deg, transparent 0 54%, rgba(245, 195, 111, .34) 55%, rgba(245, 195, 111, .08) 68%, transparent 69%);
      opacity: .96;
    }
    .dune-banner::after {
      content: "";
      position: absolute;
      inset: auto -8% 0 -8%;
      height: 48%;
      background:
        linear-gradient(170deg, transparent 0 28%, rgba(164, 92, 39, .62) 29%, rgba(164, 92, 39, .18) 58%, transparent 59%),
        linear-gradient(7deg, rgba(35, 26, 19, .84), rgba(147, 84, 37, .42) 52%, transparent 53%);
    }
    .banner-content {
      position: relative;
      z-index: 1;
      min-height: 150px;
      display: grid;
      align-content: end;
      max-width: 720px;
      padding: 24px;
    }
    .banner-kicker {
      color: #f4d19a;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 7px;
    }
    .banner-title {
      margin: 0;
      font-size: 25px;
      line-height: 1.08;
      text-shadow: 0 2px 18px rgba(0, 0, 0, .56);
    }
    .banner-copy {
      margin: 8px 0 0;
      color: #e7dcc8;
      line-height: 1.45;
    }
    section { margin-top: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 11px 8px; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    pre {
      margin: 0;
      max-height: 330px;
      overflow: auto;
      white-space: pre-wrap;
      background: #0b0c0e;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      color: #d9e2ea;
    }
    .topline { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
    .pill { padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 13px; }
    @media (max-width: 800px) {
      main { padding: 18px; }
      header { display: block; }
      .brand-logo { width: 58px; height: 58px; }
      .header-actions { margin-top: 12px; justify-content: flex-start; }
      .dune-banner, .banner-content { min-height: 170px; }
      .banner-content { padding: 18px; }
      .banner-title { font-size: 21px; }
      .grid { grid-template-columns: repeat(2, 1fr); }
      .settings-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .grid { grid-template-columns: 1fr; }
      button, a.button { width: 100%; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div class="brand">
      <img class="brand-logo" src="${logoPath}" alt="AlphaNineGaming logo">
      <div class="brand-copy">
        <h1>${panelTitle}</h1>
        <div class="sub">${panelSubtitle}</div>
      </div>
    </div>
    <div class="header-actions">
      ${donationButton}
      <span class="pill version">v${APP_VERSION}</span>
      <span id="updated" class="pill">Not refreshed yet</span>
    </div>
  </header>

  <div class="dune-banner" aria-label="Dune Server Control banner">
    <div class="banner-content">
      <div class="banner-kicker">Self-hosted command deck</div>
      <h2 class="banner-title">Keep your Arrakis server visible, steady, and ready.</h2>
      <p class="banner-copy">Monitor the VM, battlegroup health, game server readiness, backups, updates, and logs from one local control panel.</p>
    </div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">VM</div><div id="vm" class="value">...</div></div>
    <div class="card"><div class="label">Battlegroup</div><div id="bg" class="value">...</div></div>
    <div class="card"><div class="label">Database</div><div id="db" class="value">...</div></div>
    <div class="card"><div class="label">Uptime</div><div id="uptime" class="value">...</div></div>
  </div>

  <div class="controls">
    <button class="blue" onclick="refresh()">Refresh</button>
    <button class="primary" onclick="act('start')">Start Server</button>
    <button onclick="act('restart')">Restart Server</button>
    <button class="danger" onclick="act('stop')">Stop Server</button>
    <button onclick="act('backup')">Backup</button>
    <button onclick="act('update')">Update</button>
    <button onclick="openDirector()">Open Director</button>
    <button onclick="act('logs-export')">Export Logs</button>
    <button onclick="toggleSettings()">Settings</button>
  </div>

  <section id="settingsPanel" class="card settings-panel">
    <div class="topline"><div class="label">Settings</div><span class="pill">Restart required after save</span></div>
    <div class="settings-grid">
      <div class="field"><label for="setHost">Host</label><input id="setHost" autocomplete="off"></div>
      <div class="field"><label for="setPort">Panel port</label><input id="setPort" type="number" min="1" max="65535"></div>
      <div class="field"><label for="setVmName">Hyper-V VM name</label><input id="setVmName" autocomplete="off"></div>
      <div class="field"><label for="setSshUser">SSH user</label><input id="setSshUser" autocomplete="off"></div>
      <div class="field"><label for="setSshKey">SSH key override</label><input id="setSshKey" autocomplete="off" placeholder="Leave blank for default"></div>
      <div class="field"><label for="setServerInstallPath">Server tools path</label><input id="setServerInstallPath" autocomplete="off"></div>
      <div class="field"><label for="setPanelTitle">Panel title</label><input id="setPanelTitle" autocomplete="off"></div>
      <div class="field"><label for="setPanelSubtitle">Panel subtitle</label><input id="setPanelSubtitle" autocomplete="off"></div>
    </div>
    <div class="settings-actions">
      <button class="primary" onclick="saveSettings()">Save Settings</button>
      <button onclick="loadSettings()">Reload Settings</button>
      <span id="settingsMessage" class="settings-note"></span>
    </div>
  </section>

  <section class="card">
    <div class="topline"><div class="label">Game Servers</div><span id="players" class="pill">Players: 0</span></div>
    <table>
      <thead><tr><th>Map</th><th>Phase</th><th>Ready</th><th>Players</th><th>Age</th></tr></thead>
      <tbody id="servers"><tr><td colspan="5">No data yet</td></tr></tbody>
    </table>
  </section>

  <section>
    <div class="topline"><div class="label">Output</div><span id="busy" class="pill">Idle</span></div>
    <pre id="log">Ready.</pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let loading = false;
function tone(el, value) {
  el.className = "value";
  const text = String(value || "");
  if (/healthy|ready|running|true/i.test(text)) el.classList.add("ok");
  else if (/startup|pending|starting/i.test(text)) el.classList.add("warn");
  else if (/unhealthy|false|stopped|missing|error/i.test(text)) el.classList.add("bad");
}
function setBusy(isBusy, text = "Working") {
  loading = isBusy;
  $("busy").textContent = isBusy ? text : "Idle";
  document.querySelectorAll("button").forEach((b) => b.disabled = isBusy);
}
async function getJson(url, opts) {
  const r = await fetch(url, opts);
  return await r.json();
}
function setField(id, value) {
  $(id).value = value == null ? "" : String(value);
}
function getField(id) {
  return $(id).value.trim();
}
async function loadSettings() {
  try {
    const data = await getJson("/api/config");
    setField("setHost", data.host);
    setField("setPort", data.port);
    setField("setVmName", data.vmName);
    setField("setSshUser", data.sshUser);
    setField("setSshKey", data.sshKey);
    setField("setServerInstallPath", data.serverInstallPath);
    setField("setPanelTitle", data.panelTitle);
    setField("setPanelSubtitle", data.panelSubtitle);
    $("settingsMessage").textContent = "";
  } catch (e) {
    $("settingsMessage").textContent = String(e);
  }
}
async function saveSettings() {
  const payload = {
    host: getField("setHost"),
    port: Number(getField("setPort")),
    vmName: getField("setVmName"),
    sshUser: getField("setSshUser"),
    sshKey: getField("setSshKey"),
    serverInstallPath: getField("setServerInstallPath"),
    panelTitle: getField("setPanelTitle"),
    panelSubtitle: getField("setPanelSubtitle"),
  };
  try {
    const data = await getJson("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("settingsMessage").textContent = data.ok ? "Saved. Restart the panel to apply changes." : (data.error || "Save failed.");
  } catch (e) {
    $("settingsMessage").textContent = String(e);
  }
}
function toggleSettings() {
  const panel = $("settingsPanel");
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) loadSettings();
}
function render(data) {
  const vmText = data.vm?.exists ? (data.vm.state + (data.vm.ip ? " - " + data.vm.ip : "")) : (data.vm?.needsAdmin ? "Admin needed" : "Missing");
  $("vm").textContent = vmText; tone($("vm"), vmText);
  const s = data.status?.summary || {};
  $("bg").textContent = s.status || "Unknown"; tone($("bg"), s.status);
  $("db").textContent = s.database || "Unknown"; tone($("db"), s.database);
  $("uptime").textContent = s.uptime || data.vm?.uptime || "-";
  const servers = data.status?.servers || [];
  const totalPlayers = servers.reduce((sum, srv) => sum + (parseInt(srv.players, 10) || 0), 0);
  $("players").textContent = "Players: " + totalPlayers;
  $("servers").innerHTML = servers.length ? servers.map((srv) =>
    "<tr><td>" + srv.map + "</td><td>" + srv.phase + "</td><td class='" + (/true/i.test(srv.ready) ? "ok" : "warn") + "'>" + srv.ready + "</td><td>" + srv.players + "</td><td>" + srv.age + "</td></tr>"
  ).join("") : "<tr><td colspan='5'>No game server rows found</td></tr>";
  $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
  if (data.vm?.needsAdmin) $("log").textContent = "Run start-control-panel.ps1 as Administrator so the panel can read Hyper-V.";
  else if (data.status?.raw) $("log").textContent = data.status.raw;
}
async function refresh() {
  if (loading) return;
  setBusy(true, "Refreshing");
  try {
    const data = await getJson("/api/status");
    render(data);
  } catch (e) {
    $("log").textContent = String(e);
  } finally {
    setBusy(false);
  }
}
async function act(action) {
  if (loading) return;
  if ((action === "stop" || action === "restart") && !confirm("Are you sure you want to " + action + " the server?")) return;
  setBusy(true, action);
  $("log").textContent = "Running " + action + "...";
  try {
    const data = await getJson("/api/action/" + action, { method: "POST" });
    $("log").textContent = [data.stdout, data.stderr, data.error].filter(Boolean).join("\n") || "Done.";
    await refresh();
  } catch (e) {
    $("log").textContent = String(e);
  } finally {
    setBusy(false);
  }
}
async function openDirector() {
  if (loading) return;
  setBusy(true, "Director");
  try {
    const data = await getJson("/api/director");
    if (data.ok && data.url) {
      window.open(data.url, "_blank");
      $("log").textContent = "Director: " + data.url;
    } else {
      $("log").textContent = data.error || "Could not open director.";
    }
  } finally {
    setBusy(false);
  }
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const assetName = path.basename(url.pathname);
    const assetPath = path.join(__dirname, "assets", assetName);
    if (fs.existsSync(assetPath)) {
      res.writeHead(200, { "Content-Type": contentTypeFor(assetPath) });
      fs.createReadStream(assetPath).pipe(res);
      return;
    }
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
    await json(res, publicConfig());
    return;
  }
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const saved = saveConfig(JSON.parse(body || "{}"));
      await json(res, { ok: true, config: saved, restartRequired: true });
    } catch (error) {
      await json(res, { ok: false, error: String(error.message || error) }, 400);
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
  if (url.pathname === "/api/vm/start" && req.method === "POST") {
    await json(res, await startVm());
    return;
  }
  if (url.pathname === "/api/vm/stop" && req.method === "POST") {
    await json(res, await stopVm());
    return;
  }
  await json(res, { ok: false, error: "Not found." }, 404);
});

server.listen(PORT, HOST, () => {
  console.log(`Dune control panel: http://localhost:${PORT}`);
  console.log("Using configured/default SSH key.");
  console.log(`Expected server install: ${DEFAULT_SERVER_ROOT}`);
});
