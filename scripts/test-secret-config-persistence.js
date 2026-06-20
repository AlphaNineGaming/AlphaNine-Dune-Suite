const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MASKED_VALUES = ["********", "<set>"];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Server did not become ready.");
}

async function startServer({ port, configPath, appData }) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA: appData,
      ALPHANINE_CONFIG_PATH: configPath,
      DUNE_DATABASE_PASSWORD: "",
      DUNE_RECEIVER_TOKEN: "",
      DUNE_ADMIN_GIVE_ITEM_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await waitForServer(`http://127.0.0.1:${port}`, child);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${output}`);
  }
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function stopSuite(child, baseUrl) {
  try {
    await fetch(`${baseUrl}/api/receiver/stop`, { method: "POST" });
  } catch {}
  await stopServer(child);
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return { response, payload };
}

async function waitForReceiver(baseUrl) {
  let latest;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await getJson(`${baseUrl}/api/receiver/status`);
      latest = result.payload;
      if (result.response.ok && latest.ok) return latest;
    } catch (error) {
      latest = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Receiver did not become healthy: ${JSON.stringify(latest)}`);
}

async function postConfig(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error || JSON.stringify(payload));
  assert.equal(payload.verified, true);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertNoPlaceholders(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  for (const placeholder of MASKED_VALUES) assert.equal(text.includes(placeholder), false, `${filePath} contains ${placeholder}`);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-secret-persistence-"));
  const appData = path.join(testRoot, "AppData");
  const configPath = path.join(testRoot, "config.json");
  const serverInstallPath = path.join(testRoot, "DuneServer");
  const sshKeyPath = path.join(testRoot, "test-ssh-key");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(serverInstallPath, { recursive: true });
  fs.writeFileSync(sshKeyPath, "release-test-key");
  const receiverPort = await freePort();
  fs.writeFileSync(configPath, JSON.stringify({
    setupComplete: true,
    serverType: "remote",
    serverInstallPath,
    receiverHost: "127.0.0.1",
    receiverPort,
    databasePassword: "db-original-real",
    receiverToken: "receiver-original-real",
    adminGiveItemToken: "admin-original-real"
  }, null, 2));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;
  try {
    child = await startServer({ port, configPath, appData });
    await waitForReceiver(baseUrl);

    await postConfig(baseUrl, {
      uiMode: "advanced",
      databasePassword: "********",
      receiverToken: "<set>",
      adminGiveItemToken: "********"
    });
    let saved = readJson(configPath);
    assert.equal(saved.databasePassword, "db-original-real");
    assert.equal(saved.receiverToken, "receiver-original-real");
    assert.equal(saved.adminGiveItemToken, "receiver-original-real");

    await postConfig(baseUrl, { adminGiveItemToken: "admin-new-real" });
    saved = readJson(configPath);
    assert.equal(saved.receiverToken, "admin-new-real");
    assert.equal(saved.adminGiveItemToken, "admin-new-real");

    await postConfig(baseUrl, {
      databasePassword: "db-new-real",
      receiverToken: "receiver-new-real"
    });
    saved = readJson(configPath);
    assert.equal(saved.databasePassword, "db-new-real");
    assert.equal(saved.receiverToken, "receiver-new-real");
    assert.equal(saved.adminGiveItemToken, "receiver-new-real");

    const restartResult = await getJson(`${baseUrl}/api/receiver/restart`, { method: "POST" });
    assert.equal(restartResult.response.ok, true, JSON.stringify(restartResult.payload));
    await waitForReceiver(baseUrl);

    const directReceiver = await fetch(`http://127.0.0.1:${receiverPort}/api/give-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer receiver-new-real" },
      body: JSON.stringify({ playerId: "test-player", template: "test-template", qty: 1 })
    });
    const directReceiverPayload = await directReceiver.json();
    assert.notEqual(directReceiver.status, 401, `Receiver rejected the newly saved receiver token. Restart result: ${JSON.stringify(restartResult.payload)}; receiver response: ${JSON.stringify(directReceiverPayload)}`);
    const wrongReceiverToken = await fetch(`http://127.0.0.1:${receiverPort}/api/give-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ playerId: "test-player", template: "test-template", qty: 1 })
    });
    assert.equal(wrongReceiverToken.status, 401);

    const liveGiveDryRun = await getJson(`${baseUrl}/api/admin/give-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "test-player", template: "radiation_suit", qty: 1, mode: "dry-run" })
    });
    assert.equal(liveGiveDryRun.response.ok, true, JSON.stringify(liveGiveDryRun.payload));
    assert.equal(liveGiveDryRun.payload.status, "dry-run-passed", JSON.stringify(liveGiveDryRun.payload));
    assert.equal(liveGiveDryRun.payload.transport, "http-json");

    const setupSaveTest = await getJson(`${baseUrl}/api/setup/save-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverType: "remote",
        serverInstallPath,
        sshHost: "127.0.0.1",
        sshUser: "test",
        sshKey: sshKeyPath,
        receiverSshHost: "127.0.0.1",
        receiverSshUser: "test",
        receiverSshKey: sshKeyPath,
        databasePort: 15432,
        databaseName: "dune",
        databaseUser: "postgres",
        receiverHost: "127.0.0.1",
        receiverPort,
        databasePassword: "********",
        receiverToken: "<set>",
        adminGiveItemToken: "********"
      })
    });
    assert.equal(setupSaveTest.response.ok, true, JSON.stringify(setupSaveTest.payload));
    assert.equal(setupSaveTest.payload.saved, true);
    assert.equal(setupSaveTest.payload.verified, true);
    assert.equal(setupSaveTest.payload.tests.receiver.ok, true, JSON.stringify(setupSaveTest.payload.tests.receiver));

    await postConfig(baseUrl, { databasePassword: "", sshHost: "", sshKey: "", receiverSshHost: "", receiverSshKey: "" });
    saved = readJson(configPath);
    assert.equal(saved.databasePassword, "");
    assertNoPlaceholders(configPath);
    const envPath = path.join(appData, "AlphaNine Dune Suite", ".env");
    assert.equal(path.resolve(setupSaveTest.payload.managedEnvPath), path.resolve(envPath));
    const managedEnvFiles = fs.readdirSync(testRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === ".env");
    assert.equal(managedEnvFiles.length, 1, `Expected one managed .env file, found ${managedEnvFiles.length}.`);
    assertNoPlaceholders(envPath);
    const envBeforeRestart = fs.readFileSync(envPath, "utf8");
    assert.match(envBeforeRestart, /DUNE_DATABASE_PASSWORD=""/);
    assert.match(envBeforeRestart, /DUNE_RECEIVER_TOKEN="receiver-new-real"/);
    assert.match(envBeforeRestart, /DUNE_ADMIN_GIVE_ITEM_TOKEN="receiver-new-real"/);

    await stopSuite(child, baseUrl);
    child = await startServer({ port, configPath, appData });
    await waitForReceiver(baseUrl);
    saved = readJson(configPath);
    assert.equal(saved.databasePassword, "");
    assert.equal(saved.receiverToken, "receiver-new-real");
    assert.equal(saved.adminGiveItemToken, "receiver-new-real");
    assertNoPlaceholders(configPath);
    assertNoPlaceholders(envPath);

    const afterRestartDryRun = await getJson(`${baseUrl}/api/admin/give-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "test-player", template: "radiation_suit", qty: 1, mode: "dry-run" })
    });
    assert.equal(afterRestartDryRun.response.ok, true, JSON.stringify(afterRestartDryRun.payload));
    assert.equal(afterRestartDryRun.payload.status, "dry-run-passed", JSON.stringify(afterRestartDryRun.payload));

    await stopSuite(child, baseUrl);
    fs.writeFileSync(configPath, JSON.stringify({
      ...saved,
      databasePassword: "********",
      receiverToken: "********",
      adminGiveItemToken: "<set>"
    }, null, 2));
    child = await startServer({ port, configPath, appData });
    await waitForReceiver(baseUrl);
    saved = readJson(configPath);
    assert.equal(saved.databasePassword, "");
    assert.equal(saved.receiverToken, "receiver-new-real");
    assert.equal(saved.adminGiveItemToken, "receiver-new-real");
    assertNoPlaceholders(configPath);
    assertNoPlaceholders(envPath);

    await stopSuite(child, baseUrl);
    fs.rmSync(envPath, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      ...saved,
      databasePassword: "********",
      receiverToken: "********",
      adminGiveItemToken: "<set>"
    }, null, 2));
    child = await startServer({ port, configPath, appData });
    await waitForReceiver(baseUrl);
    const generated = readJson(configPath);
    assert.ok(generated.receiverToken);
    assert.equal(generated.adminGiveItemToken, generated.receiverToken);
    assert.equal(isMasked(generated.receiverToken), false);
    assert.equal(isMasked(generated.adminGiveItemToken), false);
    assertNoPlaceholders(configPath);

    console.log("Release persistence test passed: masked values blocked, unchanged/new/blank secrets verified, receiver token sync and authentication verified, Live Give dry-run passed after restart, Setup Save & Test passed, one managed .env verified, legacy repair passed, and unrecoverable tokens regenerated in sync.");
  } finally {
    await stopSuite(child, baseUrl);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function isMasked(value) {
  return MASKED_VALUES.includes(String(value || "").trim().toLowerCase());
}
