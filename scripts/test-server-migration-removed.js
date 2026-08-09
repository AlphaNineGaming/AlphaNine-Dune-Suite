"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-no-server-migration-"));
const dataDir = path.join(dataRoot, "data");
const port = 18700 + Math.floor(Math.random() * 200);
fs.mkdirSync(dataDir, { recursive: true });
for (const filename of ["migration-offline-mode.json", "migration-maintenance.json"]) {
  fs.writeFileSync(path.join(dataDir, filename), JSON.stringify({ active: true, generation: "1", failClosed: false }), "utf8");
}

const child = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(port + 500),
    ALPHANINE_DATA_DIR: dataRoot,
    ALPHANINE_SKIP_STARTUP_SERVICES: "1",
    ALPHANINE_SKIP_MANAGER: "1",
    ALPHANINE_DISABLE_SERVER_ITEM_DISCOVERY: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitForUi() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Suite exited with ${child.exitCode}. ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.text();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Suite did not become reachable. ${stderr}`);
}

(async () => {
  try {
    const html = await waitForUi();
    assert(!html.includes('data-view="server-migration"'), "Server Migration navigation remains rendered.");
    assert(!html.includes('id="server-migration"'), "Server Migration page remains rendered.");
    assert(!html.includes('id="migrationMaintenanceBanner"') && !html.includes('id="migrationOfflineBanner"'), "Migration hold banners remain rendered.");

    for (const [route, method] of [["/api/server-migration/profile", "GET"], ["/api/migration-offline/enter", "POST"], ["/api/migration-maintenance/enter", "POST"]]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method });
      const body = await response.json();
      assert.equal(response.status, 404, `${route} remains reachable.`);
      assert.equal(body.code, "feature_not_in_build", `${route} did not report feature removal.`);
    }

    const giveResponse = await fetch(`http://127.0.0.1:${port}/api/admin/give-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "test-player", template: "radiation_suit", qty: 1, quality: 0 })
    });
    const give = await giveResponse.json();
    assert.equal(giveResponse.status, 200, `Persisted migration state still blocks Give Item dry-run: ${JSON.stringify(give)}`);
    assert.equal(give.dryRun, true, "Removal regression unexpectedly performed a live Give Item operation.");
    console.log("Server Migration is absent from UI/API, legacy holds are ignored, and Give Item remains dry-run safe.");
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
