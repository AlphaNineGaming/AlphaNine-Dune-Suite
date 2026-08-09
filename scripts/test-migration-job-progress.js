"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Writable } = require("stream");
const { begin, bytes, heartbeat, initialize, publicView, whileAlive } = require("../lib/migration-job-progress");
const { hashFile, inspectMigrationPackage, streamMigrationEntry, writeMigrationArchive } = require("../lib/migration-package");

async function testTruthfulJobStates() {
  const start = Date.parse("2026-08-06T00:00:00.000Z");
  const healthy = initialize({ status: "running", stage: "Creating database archive", startedAt: new Date(start).toISOString() }, start);
  begin(healthy, "Creating database archive", "pg_dump", { now: start });
  heartbeat(healthy, "Creating database archive — still working", { now: start + 154000 });
  const working = publicView(healthy, { now: start + 155000, staleMs: 15000 });
  assert.equal(working.state, "working");
  assert.equal(working.elapsedMs, 155000);
  assert.match(working.activity.substep, /still working/);

  const stale = publicView(healthy, { now: start + 170001, staleMs: 15000 });
  assert.equal(stale.state, "stale");
  assert.equal(healthy.status, "running", "a stale heartbeat must never cancel or retry a job");

  bytes(healthy, "4606827", "9213654", "Writing package", { now: start + 171000 });
  const exact = publicView(healthy, { now: start + 171001 });
  assert.equal(exact.activity.percent, 50);
  assert.equal(exact.activity.bytes, "4606827");

  healthy.status = "success";
  assert.equal(publicView(healthy, { now: start + 172000 }).state, "verified");
  healthy.status = "failed";
  assert.equal(publicView(healthy, { now: start + 173000 }).state, "failed");

  const long = initialize({ status: "running", stage: "pending", startedAt: new Date(start).toISOString() }, start);
  let published = 0;
  await whileAlive(long, "Reading archive", "pg_restore full read", () => new Promise((resolve) => setTimeout(resolve, 40)), { intervalMs: 10, onHeartbeat: () => { published += 1; } });
  assert(published >= 2, "a live child process must publish repeated heartbeats");

  const failedPublication = initialize({ status: "running", stage: "pending", startedAt: new Date(start).toISOString() }, start);
  await assert.rejects(() => whileAlive(failedPublication, "Reading archive", "pg_restore full read", async () => {
    assert.fail("the task must not start when initial progress publication fails");
  }, { onHeartbeat: () => { throw new Error("journal unavailable"); } }), (error) => error.code === "migration_progress_reporting_failed");
}

async function testExactFileProgress() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a9migration-progress-"));
  try {
    const packagePath = path.join(root, "progress.a9migration");
    const callbacks = [];
    await writeMigrationArchive(packagePath, [
      { path: "manifest.json", mediaType: "application/json", content: Buffer.from("{}") },
      { path: "world.dump", mediaType: "application/vnd.postgresql.custom-dump", content: Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(16384, 4)]) },
      { path: "verification.json", mediaType: "application/json", content: Buffer.from("{}") }
    ], { onProgress: (value) => callbacks.push(value) });
    assert.equal(callbacks.at(-1).bytes, callbacks.at(-1).totalBytes);
    assert.equal(callbacks.at(-1).progress, 100);

    const hashProgress = [];
    const whole = await hashFile(packagePath, { onProgress: (value) => hashProgress.push(value) });
    assert.equal(hashProgress.at(-1).bytes, whole.size);
    assert.equal(hashProgress.at(-1).progress, 100);

    const verifyProgress = [];
    const inspection = await inspectMigrationPackage(packagePath, { onProgress: (value) => verifyProgress.push(value) });
    assert.equal(verifyProgress.at(-1).bytes, verifyProgress.at(-1).totalBytes);
    assert.equal(verifyProgress.at(-1).progress, 100);

    const extracted = [];
    const sink = new Writable({ write(chunk, _encoding, callback) { callback(); } });
    await streamMigrationEntry(packagePath, inspection, "world.dump", sink, { onProgress: (value) => extracted.push(value) });
    assert.equal(extracted.at(-1).bytes, extracted.at(-1).totalBytes);
    assert.equal(extracted.at(-1).progress, 100);

    let destinationDestroyed = false;
    const failingSink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    failingSink.on("close", () => { destinationDestroyed = true; });
    await assert.rejects(() => streamMigrationEntry(packagePath, inspection, "world.dump", failingSink, {
      onProgress: (value) => { if (value.bytes !== "0") throw new Error("entry progress failed"); }
    }), (error) => error.code === "migration_progress_reporting_failed");
    assert.equal(destinationDestroyed, true, "entry source and destination streams must be terminated when progress reporting fails");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testUiAndReconnectWiring() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /\/api\/server-migration\/active-job/);
  assert.match(source, /setTimeout\(reconnectMigrationJob,500\)/, "full page must reconnect after refresh");
  assert.match(source, /setTimeout\(reconnect,250\)/, "startup-suppressed page must reconnect after refresh");
  assert.match(source, /setTimeout\(resolve,1500\)/, "active jobs must poll every 1.5 seconds");
  assert.match(source, /migrationOperationBusy\(\).*Server Migration operation is already active/s, "duplicate starts and preflights must be blocked");
  assert.match(source, /progress\.removeAttribute\("value"\)/, "unknown byte progress must be indeterminate");
  assert.match(source, /No recent activity/);
  assert.match(source, /Do not close the Suite or power off either server\./);
  assert.match(source, /Verification result/);
  assert.match(source, /job\.error/);
}

async function main() {
  await testTruthfulJobStates();
  await testExactFileProgress();
  testUiAndReconnectWiring();
  console.log("Migration live progress, heartbeat, stalled-state, reconnect, duplicate-control, failure, and verified-result tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
