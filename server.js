const http = require("http");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_VERSION = "0.1.0-beta";
const HOST = "127.0.0.1";
const PORT = 8810;
const MANAGER_PORT = 8812;
const CONFIG_PATH = path.join(__dirname, "config.json");
const MANAGER_DIR = path.join(__dirname, "manager");
const CODEX_DIR = path.join(__dirname, "gear-codex");

const defaultConfig = {
  host: "127.0.0.1",
  port: 8810,
  vmName: "dune-awakening",
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
  const allowed = ["host", "port", "vmName", "sshUser", "sshKey", "panelTitle", "panelSubtitle", "serverInstallPath"];
  const clean = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, key)) clean[key] = nextConfig[key];
  }
  clean.host = String(clean.host || "127.0.0.1").trim();
  clean.port = Number(clean.port) || PORT;
  clean.vmName = String(clean.vmName || "dune-awakening").trim();
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
const SSH_USER = config.sshUser || "dune";
const SSH_KEY = expandEnvPath(config.sshKey || defaultSshKeyPath());
const DEFAULT_SERVER_ROOT = expandEnvPath(config.serverInstallPath);
let lastDirectorUrl = null;
let managerProcess = null;

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
  if (!info.exists) return { ok: false, stdout: "", stderr: info.error || "VM not found.", error: "VM not found." };
  if (info.state !== "Running") return { ok: false, stdout: "", stderr: "VM is not running.", error: "VM is not running." };
  if (!info.ip) return { ok: false, stdout: "", stderr: "VM IP address was not found.", error: "VM IP address was not found." };
  return run("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "LogLevel=QUIET",
    "-i", SSH_KEY,
    `${SSH_USER}@${info.ip}`,
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
    .tool-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:12px; }
    .tool-card { min-height:148px; display:grid; align-content:space-between; gap:12px; }
    .tool-card p { margin:0; color:var(--muted); line-height:1.45; }
    .frame-wrap { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#0b0c0e; min-height:720px; }
    iframe { width:100%; height:78vh; min-height:720px; border:0; display:block; background:#0b0c0e; }
    pre { white-space:pre-wrap; background:#0b0c0e; border:1px solid var(--line); border-radius:8px; padding:14px; max-height:300px; overflow:auto; }
    @media (max-width:900px) { header{display:block}.header-actions{justify-content:flex-start;margin-top:12px}.grid,.tool-grid{grid-template-columns:1fr}.banner-title{font-size:21px}.frame-wrap,iframe{min-height:620px} }
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
      <a class="kofi" href="https://ko-fi.com/E1W220NMPA" target="_blank" rel="noopener noreferrer">Support me on Ko-fi</a>
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
    </div>
  </section>
  <section id="server" class="view">
    <div class="grid">
      <div class="card"><div class="label">VM</div><div id="svm" class="value">Checking...</div></div>
      <div class="card"><div class="label">Battlegroup</div><div id="sbg" class="value">Checking...</div></div>
      <div class="card"><div class="label">Database</div><div id="sdb" class="value">Checking...</div></div>
      <div class="card"><div class="label">Uptime</div><div id="suptime" class="value">Checking...</div></div>
    </div>
    <div class="controls">
      <button onclick="refresh()">Refresh</button>
      <button class="primary" onclick="act('start')">Start Server</button>
      <button onclick="act('restart')">Restart Server</button>
      <button class="danger" onclick="act('stop')">Stop Server</button>
      <button onclick="act('backup')">Backup</button>
      <button onclick="act('update')">Update</button>
      <button onclick="openDirector()">Open Director</button>
      <button onclick="act('logs-export')">Export Logs</button>
    </div>
    <pre id="serverLog">Ready.</pre>
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
refresh();setInterval(refresh,30000);
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
});

process.on("exit", () => {
  if (managerProcess) managerProcess.kill();
});
