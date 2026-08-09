"use strict";

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { createStartupPolicy, MIGRATION_STARTUP_SUPPRESSED_FLAG } = require("../lib/startup-policy");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");

const policy = createStartupPolicy({ argv: ["node", "server.js", MIGRATION_STARTUP_SUPPRESSED_FLAG], env: {} });
assert.equal(policy.mode, "migration-startup-suppressed");
assert.equal(policy.allowManager, false);
assert.equal(policy.allowAuxiliaryListeners, false);
assert.equal(policy.allowInternetTunnelTimer, false);
assert.equal(policy.allowStartupAutomation, false);
assert.equal(policy.allowBackgroundWriters, false);
assert.equal(policy.allowDesktopReceiver, false);
assert.equal(policy.allowDesktopUpdater, false);
assert.deepEqual(policy.allowedListeners, ["primary-loopback-backend"]);
assert.throws(() => createStartupPolicy({ argv: ["node", "server.js", "--side-effect-free", MIGRATION_STARTUP_SUPPRESSED_FLAG], env: {} }), /exactly one isolated Suite runner mode/);

for (const required of [
  "SUITE_STARTUP_POLICY.allowManager",
  "SUITE_STARTUP_POLICY.allowAuxiliaryListeners",
  "SUITE_STARTUP_POLICY.allowInternetTunnelTimer",
  "SUITE_STARTUP_POLICY.allowStartupAutomation",
  "startupSuppressed: !SUITE_STARTUP_POLICY.allowBackgroundWriters",
  "MIGRATION_STARTUP_SUPPRESSED_RUNNER"
]) assert(serverSource.includes(required), `Server startup audit is missing ${required}.`);
assert(!serverSource.includes('if (process.env.ALPHANINE_SKIP_MANAGER === "1")'), "Manager still has a separate environment-variable bypass instead of centralized policy.");
for (const required of [
  "DESKTOP_STARTUP_POLICY.allowDesktopEnvironmentMutation",
  "DESKTOP_STARTUP_POLICY.allowDesktopReceiver",
  "DESKTOP_STARTUP_POLICY.allowDesktopUpdater",
  "MIGRATION_STARTUP_SUPPRESSED_FLAG"
]) assert(desktopSource.includes(required), `Desktop startup audit is missing ${required}.`);

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForBackend(port, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Suppressed runner exited early with ${child.exitCode}.\n${output()}`);
    if (await canConnect(port, 150)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Suppressed runner did not bind its loopback backend.\n${output()}`);
}

async function request(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { response, body };
}

function processInventory() {
  if (process.platform !== "win32") return [];
  const command = "Get-Process | Where-Object { $_.ProcessName -match '^(node|python|pythonw|cloudflared|AlphaNine Dune Suite)$' } | Select-Object @{N='pid';E={[string]$_.Id}},@{N='name';E={$_.ProcessName}} | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, `Could not inspect suppressed-runner processes: ${result.stderr || "unknown error"}`);
  const value = String(result.stdout || "").trim();
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function unexpectedProcesses(baseline, allowedPids = []) {
  if (process.platform !== "win32") return [];
  const existing = new Set(baseline.map((row) => String(row.pid)));
  const allowed = new Set(allowedPids.map(String));
  return processInventory().filter((row) => !existing.has(String(row.pid)) && !allowed.has(String(row.pid)));
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-migration-startup-suppressed-"));
  const dataDir = path.join(scratch, "profile");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), `${JSON.stringify({ setupComplete: true, vmName: "dune-awakening-migration-test" }, null, 2)}\n`, "utf8");
  const baselineProcesses = processInventory();
  const ports = await Promise.all([unusedPort(), unusedPort(), unusedPort(), unusedPort()]);
  const [port, httpsPort, originPort, managerPort] = ports;
  const child = spawn(process.execPath, [path.join(root, "server.js"), MIGRATION_STARTUP_SUPPRESSED_FLAG, "--profile-dir", dataDir], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ALPHANINE_HTTPS_PORT: String(httpsPort),
      ALPHANINE_INTERNET_ORIGIN_PORT: String(originPort),
      ALPHANINE_MANAGER_PORT: String(managerPort),
      ALPHANINE_DATA_DIR: dataDir,
      ALPHANINE_DISABLE_SERVER_ITEM_DISCOVERY: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const output = () => `${stdout}\n${stderr}`;
  try {
    await waitForBackend(port, child, output);
    assert.equal(await canConnect(port), true, "Primary loopback backend must listen.");
    for (const auxiliary of [httpsPort, originPort, managerPort]) assert.equal(await canConnect(auxiliary), false, `Auxiliary listener ${auxiliary} must remain closed.`);
    assert.deepEqual(unexpectedProcesses(baselineProcesses, [child.pid]), [], "Suppressed backend must not create Manager, tunnel, Receiver, updater, or other child processes.");

    const mode = await request(port, "/api/migration-startup-suppressed");
    assert.equal(mode.response.status, 200);
    assert.equal(mode.body.mode, "migration-startup-suppressed");
    assert.deepEqual(mode.body.allowedListeners, ["primary-loopback-backend"]);
    const runtimeIdentity = await request(port, "/api/migration-runtime-identity");
    assert.equal(runtimeIdentity.response.status, 200);
    assert.equal(runtimeIdentity.body.verified, true);
    assert.match(runtimeIdentity.body.sourceBuildFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(runtimeIdentity.body.packageFormatVersion, "4");
    assert.equal(runtimeIdentity.body.exportTransportVersion, "pod-native-direct-pgpass-v3");
    assert.equal(runtimeIdentity.body.progressApiVersion, "migration-progress-v1");
    const profile = await request(port, "/api/server-migration/profile");
    assert.equal(profile.response.status, 200, "Server Migration profile must remain available locally.");
    assert.equal(profile.body.selectedProfile?.source, "command-line");
    assert.equal(profile.body.selectedProfile?.profileName, "profile");
    assert.equal(profile.body.selectedProfile?.vmName, "dune-awakening-migration-test");
    assert.match(String(profile.body.selectedProfile?.digest || ""), /^[a-f0-9]{64}$/);
    const offlineBefore = await request(port, "/api/migration-offline");
    assert.equal(offlineBefore.response.status, 200);
    assert.equal(offlineBefore.body.active, false);
    const localEvidenceBefore = await request(port, "/api/migration-offline/market-bot-reconciliation");
    assert.equal(localEvidenceBefore.response.status, 200);
    assert.equal(localEvidenceBefore.body.available, false);
    assert.equal(localEvidenceBefore.body.confirmation, "RECONCILE LOCAL MARKET BOT EVIDENCE");

    const blockedStart = await request(port, "/api/action/start", { method: "POST" });
    assert.equal(blockedStart.response.status, 409);
    assert.equal(blockedStart.body.code, "migration_startup_suppressed");
    const blockedPreflight = await request(port, "/api/server-migration/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(blockedPreflight.response.status, 409);
    assert.equal(blockedPreflight.body.code, "migration_offline_required");
    const blockedImportPreflight = await request(port, "/api/server-migration/import-preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(blockedImportPreflight.response.status, 409);
    assert.equal(blockedImportPreflight.body.code, "migration_offline_required");
    const blockedImport = await request(port, "/api/server-migration/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packagePath: "missing.a9migration", confirmText: "IMPORT SERVER MIGRATION PACKAGE" }) });
    assert.equal(blockedImport.response.status, 409);
    assert.equal(blockedImport.body.code, "migration_offline_required");
    const blockedEvidenceRepair = await request(port, "/api/migration-offline/reconcile-market-bot-evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmText: "RECONCILE LOCAL MARKET BOT EVIDENCE" }) });
    assert.equal(blockedEvidenceRepair.response.status, 409);
    assert.equal(blockedEvidenceRepair.body.code, "migration_offline_required");
    const blockedManager = await request(port, "/manager/");
    assert.equal(blockedManager.response.status, 403);

    const beforeEntry = fs.readdirSync(dataDir).sort();
    assert.deepEqual(beforeEntry, ["config.json"], `Suppressed startup must not write local state before explicit Offline Mode entry; found ${JSON.stringify(beforeEntry)}.`);
    const wrong = await request(port, "/api/migration-offline/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmText: "wrong" }) });
    assert.equal(wrong.response.status, 409);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), beforeEntry, "Rejected confirmation must not create Offline Mode evidence.");

    const entered = await request(port, "/api/migration-offline/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmText: "ENTER MIGRATION OFFLINE MODE" }) });
    assert.equal(entered.response.status, 200);
    assert.equal(entered.body.active, true);
    assert.match(String(entered.body.generation), /^[1-9]\d*$/);
    assert.match(String(entered.body.digest), /^[a-f0-9]{64}$/);
    const primary = path.join(dataDir, "data", "migration-offline-mode.json");
    const recovery = `${primary}.previous`;
    assert(fs.existsSync(primary), "Durable Offline Mode primary evidence is missing.");
    assert(fs.existsSync(recovery), "Durable Offline Mode recovery evidence is missing.");
    assert.equal(fs.readFileSync(primary, "utf8"), fs.readFileSync(recovery, "utf8"), "Offline Mode primary and recovery evidence must match exactly.");
    const offlinePrimaryBeforeRepairAttempt = fs.readFileSync(primary);
    const offlineRecoveryBeforeRepairAttempt = fs.readFileSync(recovery);
    const localEvidenceReady = await request(port, "/api/migration-offline/market-bot-reconciliation");
    assert.equal(localEvidenceReady.response.status, 200);
    assert.equal(localEvidenceReady.body.available, true);
    const wrongEvidenceConfirmation = await request(port, "/api/migration-offline/reconcile-market-bot-evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmText: "wrong" }) });
    assert.equal(wrongEvidenceConfirmation.response.status, 409);
    assert.match(String(wrongEvidenceConfirmation.body.error || ""), /RECONCILE LOCAL MARKET BOT EVIDENCE/);
    assert.equal(fs.existsSync(path.join(dataDir, "data", "market-bot-offline-evidence-reconciliation.json")), false, "Rejected confirmation must not create a reconciliation journal.");
    assert.deepEqual(fs.readFileSync(primary), offlinePrimaryBeforeRepairAttempt, "Rejected reconciliation must not change Offline Mode primary evidence.");
    assert.deepEqual(fs.readFileSync(recovery), offlineRecoveryBeforeRepairAttempt, "Rejected reconciliation must not change Offline Mode recovery evidence.");
    const stillBlocked = await request(port, "/api/market-bot/resume", { method: "POST" });
    assert.equal(stillBlocked.response.status, 409);
    assert.equal(stillBlocked.body.code, "migration_startup_suppressed");
    for (const pathname of ["/api/server-migration/import-preflight-status/missing", "/api/server-migration/import-status/missing"]) {
      const reconnect = await request(port, pathname);
      assert.equal(reconnect.response.status, 404, `${pathname} must reach its read-only status handler instead of startup-suppressed rejection.`);
      assert.notEqual(reconnect.body.code, "migration_startup_suppressed");
    }
    const protectedDeploy = await request(port, "/api/market-bot/deploy-paused-runtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmText: "wrong" }) });
    assert.equal(protectedDeploy.response.status, 500, "The narrowly protected paused-runtime endpoint must be routed in startup-suppressed Offline Mode.");
    assert.match(String(protectedDeploy.body.error || ""), /DEPLOY PAUSED MARKET BOT/);
    assert.deepEqual(unexpectedProcesses(baselineProcesses, [child.pid]), [], "No child process may appear after Offline Mode entry.");
    for (const auxiliary of [httpsPort, originPort, managerPort]) assert.equal(await canConnect(auxiliary), false, "No auxiliary listener may appear after Offline Mode entry.");
    assert(!/ensure server running|receiver became healthy|protected tunnel origin|secure remote portal|manager service/i.test(output()), `Prohibited startup component appeared in logs.\n${output()}`);
    assert.match(serverSource, /Startup-suppressed migration mode refused to start because the local migration runtime identity does not match/);
    assert.match(serverSource, /id="runtime-identity"/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    for (const candidate of ports) assert.equal(await canConnect(candidate), false, `Listener ${candidate} remained after shutdown.`);
    assert.deepEqual(unexpectedProcesses(baselineProcesses), [], "Suppressed runner left a child process after shutdown.");
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("Migration startup-suppressed policy, endpoint gating, process/listener isolation, durable Offline Mode entry, and shutdown tests passed.");
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
