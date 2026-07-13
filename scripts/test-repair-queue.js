"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
for (const required of [
  "REPAIR_QUEUE_PATH",
  "enqueueDurabilityRepair",
  "processRepairQueueItem",
  "previewDurabilityRepair({ query: item.player.query, targetIds: repairableIds })",
  "applyDurabilityRepair({ previewId: preview.previewId, confirmText: REPAIR_CONFIRM_TEXT })",
  "Waiting for player to disconnect.",
  '"/api/admin/repair/queue"',
  '"/api/admin/repair/queue/process"',
  "durability_repair_queue_completed",
  "durability_repair_queue_failed"
]) assert(serverSource.includes(required), `Missing repair queue behavior: ${required}`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-repair-queue-"));
const queuePath = path.join(dataDir, "repair-queue.json");
const queueId = "queue-persistence-test";
fs.writeFileSync(queuePath, JSON.stringify([{
  queueId,
  status: "queued",
  player: { query: "123", characterName: "Queue Test" },
  targetIds: ["item:456"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attempts: 0,
  nextAttemptAt: "2099-01-01T00:00:00.000Z"
}], null, 2));

const port = 18700 + Math.floor(Math.random() * 200);
const child = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(port), ALPHANINE_HTTPS_PORT: String(port + 500), ALPHANINE_DATA_DIR: dataDir, ALPHANINE_SKIP_MANAGER: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});

async function request(url, options) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, options);
      if (response.status < 500) return { response, body: await response.json() };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Repair queue test server did not become ready.");
}

(async () => {
  try {
    const loaded = await request("/api/admin/repair/queue");
    assert.strictEqual(loaded.body.items.length, 1);
    assert.strictEqual(loaded.body.items[0].queueId, queueId);
    const processed = await request("/api/admin/repair/queue/process", { method: "POST" });
    assert.strictEqual(processed.body.items[0].status, "queued", "A future queue item must not execute early.");
    const removed = await request(`/api/admin/repair/queue/${queueId}`, { method: "DELETE" });
    assert.strictEqual(removed.body.ok, true);
    assert.strictEqual(removed.body.queue.items.length, 0);
    const persisted = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    assert.deepStrictEqual(persisted, []);
    console.log("Durable online-player repair queue persistence, timing, API, cancellation, and safe processor checks passed.");
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
