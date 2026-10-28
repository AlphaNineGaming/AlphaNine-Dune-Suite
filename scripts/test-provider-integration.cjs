"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { startupPermissions, selection, routeDecision, createSuiteProviders, readBootstrapConfig } = require("../lib/providers/suite-provider");
const { ROUTES } = require("../lib/providers/feature-router");
const { createStartupPolicy } = require("../lib/startup-policy");
const ROOT = path.resolve(__dirname, "..");
const preload = path.join(__dirname, "provider-lab/safe-backend-preload.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = http.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function backend(t, initial, { isolated = false, recognized = false, slow = false, readOnlyDatabase = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "a9-provider-http-"));
  const configPath = path.join(temp, "config.json"), key = path.join(temp, "fixture-key"), known = path.join(temp, "known hosts");
  fs.writeFileSync(key, "fixture-not-a-real-key"); fs.writeFileSync(known, "fixture-not-real-trust");
  const config = { serverType: "local-hyperv", setupComplete: true, receiverToken: "token-canary", adminGiveItemToken: "token-canary", databasePassword: "secret-canary", sshHost: "fixture.example", sshUser: "diagnostic", sshKey: key, sshKnownHostsPath: known, sshPort: 22222, remoteRuntimeRoot: "/fixture", unknownCompatibilityField: { retained: true }, ...initial };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const port = await freePort();
  const logPath = path.join(temp, "calls.jsonl");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:DUNE_|ALPHANINE_)/.test(name)) delete env[name];
  Object.assign(env, { PORT: String(port), APPDATA: temp, LOCALAPPDATA: temp, ALPHANINE_CONFIG_PATH: configPath, ALPHANINE_DATA_DIR: temp, ALPHANINE_TEST_CALL_LOG: logPath, ALPHANINE_DISABLE_SERVER_ITEM_DISCOVERY: "1", ...(isolated ? { ALPHANINE_SKIP_STARTUP_SERVICES: "1" } : {}), ...(recognized ? { ALPHANINE_TEST_RECOGNIZED_DEPLOYMENT: "1" } : {}), ...(slow ? { ALPHANINE_TEST_PROBE_DELAY_MS: "300" } : {}), ...(readOnlyDatabase ? { ALPHANINE_TEST_READONLY_DATABASE: "1" } : {}) });
  const child = spawn(process.execPath, ["--require", preload, path.join(ROOT, "server.js")], { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) child.kill(); for (let i = 0; child.exitCode === null && i < 50; i++) await sleep(20); fs.rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let lastResponse = "";
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Disposable backend exited: " + output);
    try { const response = await fetch(base + "/api/providers/status"); if (response.ok) break; lastResponse = response.status + " " + await response.text(); } catch (error) { lastResponse = error.message + " " + JSON.stringify(error.cause); }
    if (i === 99) throw new Error("Disposable backend did not start: " + lastResponse + "\n" + output);
    await sleep(30);
  }
  return { base, config, configPath, temp, logPath, child, async request(route, body, method = body ? "POST" : "GET") { const response = await fetch(base + route, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }); return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text() }; }, calls() { return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; } };
}

test("startup permissions preserve established/missing-version legacy profiles and isolate new/remote/unknown", () => {
  for (const type of [undefined, "local-hyperv", "remote-vm", "remote", "manual", "hyper-v", "local-windows"]) {
    assert.equal(startupPermissions({ serverType: type }).allowAutomation, true);
    assert.equal(startupPermissions({ serverType: type, setupComplete: true }).allowAutomation, true);
  }
  for (const config of [{ serverType: "remote-linux", setupComplete: true }, { serverType: "docker" }, { setupComplete: false }]) {
    const policy = createStartupPolicy({ providerIsolation: !startupPermissions(config).allowAutomation, env: {}, argv: [] });
    for (const name of ["allowManager", "allowAuxiliaryListeners", "allowInternetTunnelTimer", "allowStartupAutomation", "allowBackgroundWriters", "allowDesktopReceiver"]) assert.equal(policy[name], false);
  }
});
test("route policy rejects all unimplemented operations regardless of method and allows legacy unchanged", () => {
  for (const type of ["remote-linux", "docker", "proxmox", "managed-hosting", "typo"]) for (const route of ["/api/action/start", "/api/vm/start", "/api/database/backup", "/api/database/restore", "/api/database/import", "/api/receiver/start", "/api/scheduler/action", "/manager", "/api/unregistered-read"]) for (const method of ["GET", "POST", "DELETE"]) assert.equal(routeDecision({ serverType: type }, route, method).allowed, false);
  for (const route of ROUTES) assert.equal(routeDecision({ serverType: "remote-linux" }, route.path, route.method).allowed, true);
  assert.equal(routeDecision({ serverType: "local-hyperv" }, "/api/database/restore", "POST").allowed, true);
});
test("real loopback Remote Linux backend does not start services or probes until diagnostics requested", async t => {
  const app = await backend(t, { serverType: "remote-linux" });
  const before = fs.readFileSync(app.configPath, "utf8");
  const setup = await app.request("/api/setup/status"), status = await app.request("/api/providers/status");
  assert.equal(setup.status, 200); assert.equal(setup.body.setupComplete, true); assert.equal(status.body.diagnosticOnly, true);
  assert.equal(app.calls().length, 0); assert.equal(fs.existsSync(path.join(app.temp, ".env")), false);
  const endpoints = ["/api/database/backup", "/api/database/safety-backup", "/api/database/restore", "/api/database/import", "/api/action/restart", "/api/vm/compact", "/api/receiver/restart", "/api/scheduler/action", "/api/market-bot/install", "/api/setup/test-database", "/api/setup/detect-database", "/api/setup/save-test", "/manager"];
  for (const route of endpoints) for (const method of ["GET", "POST"]) { const result = await app.request(route, method === "POST" ? {} : undefined, method); assert.equal(result.status, 403, route); }
  assert.equal(app.calls().length, 0);
  const diagnosed = await app.request("/api/providers/diagnose", {});
  assert.equal(diagnosed.status, 200); assert.equal(diagnosed.body.report.environment.os, "linux");
  assert.equal(app.calls().length, 6); assert(app.calls().every(call => call.kind === "fixture-ssh-read"));
  assert.equal((await app.request("/api/providers/read", { operation: "status" })).status, 409);
  for (const headers of [{ Origin: "https://attacker.example" }, { Host: "attacker.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const statusCode = await new Promise((resolve, reject) => {
      const request = http.request(app.base + "/api/providers/read", { method: "POST", headers: { ...headers, "Content-Type": "application/json" } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end(JSON.stringify({ operation: "players" }));
    });
    assert.equal(statusCode, 403, JSON.stringify(headers));
  }
  const exported = await app.request("/api/providers/report");
  assert.equal(exported.status, 200); assert(!JSON.stringify(exported.body).includes("canary")); assert(!JSON.stringify(exported.body).includes("fixture.example"));
  assert.equal(exported.body.capabilities["database.write"].available, false);
  assert.equal(fs.readFileSync(app.configPath, "utf8"), before);
  const html = await (await fetch(app.base + "/")).text();
  for (const needle of ["/assets/provider-ui.js", "setupWelcomeServerType", "setupSshKnownHostsPath", "Remote Linux / VPS", "Proxmox", "managed-hosting"]) assert(html.includes(needle), needle);
  assert(html.includes("window.suiteProviderReadOnly=true"));
  const asset = await fetch(app.base + "/assets/provider-ui.js"); assert.equal(asset.status, 200);
});
test("unsupported persisted provider is fail-closed and can never run diagnostic transport", async t => {
  const app = await backend(t, { serverType: "docker" });
  assert.equal((await app.request("/api/providers/status")).body.provider, "unsupported");
  assert.equal((await app.request("/api/providers/diagnose", {})).status, 400);
  assert.equal((await app.request("/api/action/start", {})).status, 403);
  assert.equal(app.calls().length, 0);
});

test("recognized synthetic deployment enables scoped HTTP reads only; no DB or mutation admission", async t => {
  const app = await backend(t, { serverType: "remote-linux" }, { recognized: true });
  const before = fs.readFileSync(app.configPath, "utf8");
  for (const operation of ["status", "health", "configuration", "version"]) {
    const result = await app.request("/api/providers/read", { operation });
    assert.equal(result.status, 200); assert.equal(result.body.classification, "Experimental");
  }
  for (const operation of ["database", "players", "runtime.stop"]) assert.equal((await app.request("/api/providers/read", { operation })).status, 409);
  assert.equal((await app.request("/api/action/restart", {})).status, 403);
  assert(app.calls().every(call => call.kind === "fixture-ssh-read")); assert.equal(fs.readFileSync(app.configPath, "utf8"), before);
  const html = await (await fetch(app.base)).text();
  for (const id of ["setupDeploymentKind", "setupRemoteDatabasePassword", "setupContainerId", "setupKubePod"]) assert(html.includes(id));
});

test("Remote Linux credentials persist masked without legacy DB reuse or connection side effects", async t => {
  const app = await backend(t, { serverType: "remote-linux" });
  const saved = await app.request("/api/config", { remoteDatabaseEnabled: true, remoteDatabaseHost: "db.fixture.example", remoteDatabasePort: 5432, remoteDatabaseName: "dune", remoteDatabaseUser: "reader", remoteDatabasePassword: "new-private-canary", remoteDeployment: { kind: "auto" } });
  assert.equal(saved.status, 200); assert.equal(saved.body.config.remoteDatabasePassword, "********"); assert.equal(saved.body.config.remoteDatabasePasswordSet, true); assert(!JSON.stringify(saved.body).includes("new-private-canary"));
  assert.equal((await app.request("/api/config", { remoteDatabasePassword: "********" })).status, 200);
  const config = JSON.parse(fs.readFileSync(app.configPath)); assert.equal(config.remoteDatabasePassword, "new-private-canary"); assert.equal(config.databasePassword, "secret-canary"); assert.equal(app.calls().length, 0);
  await app.request("/api/providers/diagnose", {}); assert(app.calls().every(call => call.kind === "fixture-ssh-read"));
  assert(!JSON.stringify((await app.request("/api/providers/report")).body).includes("canary"));
});

test("shared Suite routes dispatch Remote Linux reads and deny every unvalidated adapted feature", async t => {
  const app = await backend(t, { serverType: "remote-linux" }, { recognized: true });
  for (const route of ROUTES) {
    const input = route.operation === "explorer.rows" ? { schema: "dune", table: "player_state", pageSize: 50, offset: 0 } : undefined;
    const result = await app.request(route.path, input, route.method);
    const supported = ["status", "health", "configuration", "version"].includes(route.operation);
    assert.equal(result.status, supported ? 200 : 409, route.path);
    if (supported) assert.equal(result.body.readOnly, true);
  }
  assert.equal((await app.request("/api/usergame-settings", { values: {} })).status, 403);
  assert.equal((await app.request("/api/server-update/start", {})).status, 403);
  assert(app.calls().every(call => call.kind === "fixture-ssh-read"));
  const html = await (await fetch(app.base)).text();
  for (const id of ["dashboard", "server-health", "players", "database-explorer", "usergame-settings"]) assert(html.includes('id="' + id + '"'));
  const asset = await (await fetch(app.base + "/assets/provider-ui.js")).text(); assert(!asset.includes("providerDashboard"));
});

test("an active read pins its target and refuses configuration changes until it completes", async t => {
  const app = await backend(t, { serverType: "remote-linux" }, { recognized: true, slow: true });
  const pending = app.request("/api/status");
  for (let i = 0; i < 50 && app.calls().length === 0; i++) await sleep(10);
  const before = fs.readFileSync(app.configPath, "utf8");
  const blocked = await app.request("/api/config", { sshHost: "changed.example" });
  assert.equal(blocked.status, 400); assert.match(blocked.body.error, /active provider reads/); assert.equal(fs.readFileSync(app.configPath, "utf8"), before);
  assert.equal((await pending).status, 200);
  const statusBefore = (await app.request("/api/providers/status")).body;
  assert.equal((await app.request("/api/config", { sshHost: "changed.example" })).status, 200);
  assert.notEqual((await app.request("/api/providers/status")).body.targetRevision, statusBefore.targetRevision);
});
test("every shared route succeeds with synthetic validated evidence; Explorer/player data stays private", async t => {
  const app = await backend(t, { serverType: "remote-linux", remoteDatabaseEnabled: true, remoteDatabaseHost: "db.fixture.example", remoteDatabaseName: "dune", remoteDatabaseUser: "reader", remoteDatabasePassword: "fixture-password" }, { recognized: true, readOnlyDatabase: true });
  for (const route of ROUTES) {
    const suffix = route.operation === "explorer.tables" ? "?schema=dune" : route.operation === "explorer.describe" ? "?schema=dune&table=player_state" : "";
    const body = route.operation === "explorer.rows" ? { schema: "dune", table: "player_state", pageSize: 50, offset: 0, sort: { column: "id", direction: "asc" }, filters: [] } : undefined;
    const result = await app.request(route.path + suffix, body, route.method); assert.equal(result.status, 200, route.path); assert.equal(result.body.readOnly, true);
    if (route.operation === "explorer.rows") { assert.equal(result.body.rows[0].character_name, "private-player-canary"); assert.equal(result.body.rows[0].forbidden, undefined); }
  }
  const report = await app.request("/api/providers/report"); assert(!JSON.stringify(report.body).includes("canary"));
  for (const route of ["/api/admin/give-item", "/api/live-map/teleport/execute", "/api/market-bot/activate", "/api/database/restore"]) assert.equal((await app.request(route, {})).status, 403);
  assert(app.calls().every(call => ["fixture-ssh-read", "fixture-read-only-sql"].includes(call.kind)));
});
test("unknown deployments reject all shared feature reads and wrong methods cannot bypass routing", async t => {
  const app = await backend(t, { serverType: "remote-linux" });
  for (const route of ROUTES) {
    const body = route.method === "POST" ? { schema: "dune", table: "player_state" } : undefined;
    assert.equal((await app.request(route.path, body, route.method)).status, 409, route.path);
    assert.equal((await app.request(route.path, {}, "DELETE")).status, 403, route.path);
  }
  assert(app.calls().every(call => call.kind === "fixture-ssh-read"));
});
test("isolated fresh wizard can persist Remote Linux without paths/DB tests and retain compatibility fields", async t => {
  const app = await backend(t, { setupComplete: false }, { isolated: true });
  const payload = { serverType: "remote-linux", sshHost: app.config.sshHost, sshUser: app.config.sshUser, sshKey: app.config.sshKey, sshPort: app.config.sshPort, sshKnownHostsPath: app.config.sshKnownHostsPath, remoteRuntimeRoot: app.config.remoteRuntimeRoot };
  const result = await app.request("/api/setup/save", payload);
  assert.equal(result.status, 200); assert.equal(result.body.verified, true);
  const saved = JSON.parse(fs.readFileSync(app.configPath));
  assert.equal(saved.serverType, "remote-linux"); assert.equal(saved.setupComplete, true); assert.equal(saved.databasePassword, "secret-canary"); assert.deepEqual(saved.unknownCompatibilityField, { retained: true });
  assert.equal((await app.request("/api/database/backup", {})).status, 403);
});
test("operational Hyper-V profile cannot be converted accidentally; provider preview leaves it intact", async t => {
  const app = await backend(t, {}, { isolated: true });
  const before = fs.readFileSync(app.configPath, "utf8");
  const body = { serverType: "remote-linux", sshHost: app.config.sshHost, sshUser: app.config.sshUser, sshKey: app.config.sshKey, sshKnownHostsPath: app.config.sshKnownHostsPath, sshPort: app.config.sshPort };
  const saved = await app.request("/api/setup/save", body);
  assert.equal(saved.status, 400); assert.match(saved.body.error, /separate diagnostic profile/);
  assert.equal(fs.readFileSync(app.configPath, "utf8"), before);
  const preview = await app.request("/api/providers/diagnose", body);
  assert.equal(preview.status, 200); assert.equal(preview.body.report.environment.os, "linux");
  assert.equal((await app.request("/api/providers/status")).body.provider, "hyperv-legacy");
  assert.equal((await app.request("/api/providers/report")).status, 409);
  assert.equal(fs.readFileSync(app.configPath, "utf8"), before);
  assert.equal((await app.request("/api/database/backup", {}, "OPTIONS")).status, 404); // No provider rejection of a legacy path.
});
test("report identity invalidates after endpoint edit; disabled maintenance routes remain unavailable", async t => {
  const app = await backend(t, { serverType: "remote-linux" });
  await app.request("/api/providers/diagnose", {});
  assert.equal((await app.request("/api/providers/report")).status, 200);
  const edited = await app.request("/api/config", { sshHost: "different.example" });
  assert.equal(edited.status, 200); assert.equal((await app.request("/api/providers/report")).status, 409);
  const legacy = await backend(t, {}, { isolated: true });
  for (const route of ["/api/migration-maintenance/enter", "/api/server-migration/import", "/api/maintenance-bootstrap/enter"]) assert.equal((await legacy.request(route, {})).status, 404);
  const source = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert(!source.includes("function executeMigrationEmptyMarket(")); assert(!source.includes("function revalidateMigrationMarketBotSafety("));
  for (const route of ['"/api/database/backup"', '"/api/database/restore"', '"/api/database/import"']) assert(source.includes(route));
  assert(!fs.existsSync(path.join(__dirname, "test-migration-ssh-retry.js")));
});
test("bootstrap missing/malformed config is isolated without changing old files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "a9-provider-bootstrap-"));
  try { const file = path.join(temp, "config.json"); assert.equal(startupPermissions(readBootstrapConfig({ configPath: file })).allowAutomation, false); fs.writeFileSync(file, "invalid"); assert.equal(selection(readBootstrapConfig({ configPath: file })), "unsupported"); assert.equal(fs.readFileSync(file, "utf8"), "invalid"); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
