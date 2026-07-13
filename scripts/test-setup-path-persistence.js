const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

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

async function request(baseUrl, route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function startServer(configPath, appData) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      ALPHANINE_HTTPS_PORT: String(port + 1),
      APPDATA: appData,
      LOCALAPPDATA: path.join(appData, "Local"),
      ALPHANINE_CONFIG_PATH: configPath,
      ALPHANINE_SKIP_MANAGER: "1"
    },
    stdio: "ignore"
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return { child, baseUrl };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("Server did not become ready.");
}

async function stopServer(instance) {
  if (!instance) return;
  try { await fetch(`${instance.baseUrl}/api/receiver/stop`, { method: "POST" }); } catch {}
  instance.child.kill();
  await Promise.race([
    new Promise((resolve) => instance.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-setup-paths-"));
  const serverInstallPath = path.join(testRoot, "DuneServerInstall");
  const awakeningServerPath = path.join(testRoot, "DuneAwakeningServer");
  fs.mkdirSync(serverInstallPath, { recursive: true });
  fs.mkdirSync(awakeningServerPath, { recursive: true });
  let instance;

  try {
    // Fresh install: no developer path is generated and the wizard remains required.
    const freshRoot = path.join(testRoot, "fresh");
    const freshConfig = path.join(freshRoot, "config.json");
    const freshAppData = path.join(freshRoot, "AppData");
    fs.mkdirSync(freshRoot, { recursive: true });
    instance = await startServer(freshConfig, freshAppData);
    let result = await request(instance.baseUrl, "/api/setup/status");
    assert.equal(result.payload.setupComplete, false);
    assert.equal(result.payload.config.serverInstallPath, "");
    assert.equal(result.payload.config.awakeningServerPath, "");
    await stopServer(instance); instance = null;

    // Valid legacy upgrade: preserve the old user value and seed the new field once.
    const validRoot = path.join(testRoot, "valid-upgrade");
    const validConfig = path.join(validRoot, "config.json");
    const validAppData = path.join(validRoot, "AppData");
    fs.mkdirSync(validRoot, { recursive: true });
    fs.writeFileSync(validConfig, JSON.stringify({ setupComplete: true, serverInstallPath }, null, 2));
    instance = await startServer(validConfig, validAppData);
    result = await request(instance.baseUrl, "/api/setup/status");
    assert.equal(result.payload.setupComplete, true);
    assert.equal(readJson(validConfig).serverInstallPath, serverInstallPath);
    assert.equal(readJson(validConfig).awakeningServerPath, serverInstallPath);
    await stopServer(instance); instance = null;

    // Invalid legacy path: migrate for visibility, force the wizard, and do not export it.
    const invalidRoot = path.join(testRoot, "invalid-upgrade");
    const invalidConfig = path.join(invalidRoot, "config.json");
    const invalidAppData = path.join(invalidRoot, "AppData");
    const oldDeveloperPath = "D:\\Developer\\Missing Dune Server";
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(invalidConfig, JSON.stringify({ setupComplete: true, serverInstallPath: oldDeveloperPath }, null, 2));
    instance = await startServer(invalidConfig, invalidAppData);
    result = await request(instance.baseUrl, "/api/setup/status");
    assert.equal(result.payload.setupComplete, false);
    assert.equal(readJson(invalidConfig).serverInstallPath, oldDeveloperPath);
    assert.equal(readJson(invalidConfig).awakeningServerPath, oldDeveloperPath);
    const managedEnvPath = path.join(invalidAppData, "AlphaNine Dune Suite", ".env");
    let managedEnv = fs.readFileSync(managedEnvPath, "utf8");
    assert.match(managedEnv, /DUNE_SERVER_INSTALL_PATH=""/);
    assert.match(managedEnv, /DUNE_AWAKENING_SERVER_PATH=""/);

    for (const placeholder of ["<set>", "set", "***", "********"]) {
      result = await request(instance.baseUrl, `/api/server-install-path/status?path=${encodeURIComponent(placeholder)}`);
      assert.equal(result.payload.serverInstallPath.valid, false, `${placeholder} was accepted`);
    }
    result = await request(instance.baseUrl, "/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverInstallPath: "<set>" })
    });
    assert.equal(result.response.status, 400);
    assert.match(result.payload.error, /placeholder/i);

    // Save: both selected paths must be present in config.json and the managed .env.
    result = await request(instance.baseUrl, "/api/setup/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverInstallPath, awakeningServerPath })
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.pathsVerified, true);
    const saved = readJson(invalidConfig);
    assert.equal(saved.serverInstallPath, serverInstallPath);
    assert.equal(saved.awakeningServerPath, awakeningServerPath);
    managedEnv = fs.readFileSync(managedEnvPath, "utf8");
    assert.ok(managedEnv.includes(`DUNE_SERVER_INSTALL_PATH=${JSON.stringify(serverInstallPath)}`));
    assert.ok(managedEnv.includes(`DUNE_AWAKENING_SERVER_PATH=${JSON.stringify(awakeningServerPath)}`));

    console.log("Setup path persistence tests passed.");
  } finally {
    await stopServer(instance);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
