"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-maintenance-bootstrap-server-"));
const port = 18700 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [path.join(root, "server.js"), "--maintenance-bootstrap"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(port + 500),
    ALPHANINE_INTERNET_ORIGIN_PORT: String(port + 700),
    ALPHANINE_DATA_DIR: scratch,
    ALPHANINE_BOOTSTRAP_TEST_NO_EXIT: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

async function waitForRoot() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bootstrap server exited early.\n${stdout}\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.text();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bootstrap server did not become ready.\n${stdout}\n${stderr}`);
}

async function post(pathname, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

(async () => {
  try {
    const html = await waitForRoot();
    assert.match(html, /Preparing Migration Maintenance Mode — Automatic server startup is disabled\./);
    assert.match(html, /Reconcile Paused Market Bot State/);
    assert.match(html, /Existing remote catalog item count/);
    const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
    assert(source.includes('"/api/maintenance-bootstrap/market-bot-pause-preflight"'), "Bootstrap must expose the protected reconciliation preflight only on its local surface.");
    assert(source.includes("expectedRemoteCatalogCount: String(body.catalogPolicy?.expectedItemCount || \"\"),\n          allowCurrent: true"), "The read-only policy preflight must inspect an already-reconciled current local state.");
    assert.match(stdout, /all normal startup automation is disabled/i);
    assert(!/attemptConfiguredServerStart|ensure server running/i.test(stdout), "Bootstrap must never invoke or report a server-start hook.");

    for (const endpoint of ["/api/action/start", "/api/database/backup", "/api/market-bot/resume", "/api/market-bot/restock", "/api/market-bot/clean", "/api/server-migration/export"]) {
      const blocked = await post(endpoint);
      assert.equal(blocked.response.status, 409, `${endpoint} must be blocked by bootstrap.`);
      assert.equal(blocked.body.code, "maintenance_bootstrap");
    }
    const wrongReconciliation = await post("/api/maintenance-bootstrap/reconcile-market-bot-pause", { confirmText: "wrong" });
    assert.equal(wrongReconciliation.response.status, 409);
    assert.match(wrongReconciliation.body.error, /RECONCILE PAUSED MARKET BOT STATE/);
    assert.equal(fs.existsSync(path.join(scratch, "data", "market-bot-pause-reconciliation.json")), false, "Wrong confirmation must not create reconciliation state.");
    const missingCatalogSelection = await post("/api/maintenance-bootstrap/reconcile-market-bot-pause", { confirmText: "RECONCILE PAUSED MARKET BOT STATE" });
    assert.equal(missingCatalogSelection.response.status, 409);
    assert.match(missingCatalogSelection.body.error, /preserve-remote/);
    assert.equal(fs.existsSync(path.join(scratch, "data", "market-bot-pause-reconciliation.json")), false, "Missing explicit remote policy selection must not create reconciliation state.");

    const wrongEntry = await post("/api/maintenance-bootstrap/enter", { confirmText: "wrong" });
    assert.equal(wrongEntry.response.status, 409);
    assert.equal(wrongEntry.body.code, "maintenance_bootstrap");
    assert.equal(fs.existsSync(path.join(scratch, "data", "migration-maintenance.json")), false, "Wrong confirmation must not create a hold.");

    const forbiddenRead = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(forbiddenRead.status, 403, "Bootstrap must expose only its small read-only surface.");
    const shutdown = await post("/api/maintenance-bootstrap/shutdown");
    assert.equal(shutdown.response.status, 200);
    console.log("Maintenance Bootstrap localhost surface, startup isolation, mutation blocking, and shutdown tests passed.");
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
