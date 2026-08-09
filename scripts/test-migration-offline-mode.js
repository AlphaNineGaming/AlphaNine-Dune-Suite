"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BANNER, ENTER_CONFIRMATION, EXIT_CONFIRMATION, createMigrationOfflineMode } = require("../lib/migration-offline-mode");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-offline-"));
try {
  const statePath = path.join(dir, "offline.json");
  let journal = false;
  const mode = createMigrationOfflineMode({ statePath, now: () => "2026-08-04T10:00:00.000Z", journalActive: () => journal });
  assert.equal(mode.startupPolicy().allowServerStartHook, true);
  assert.throws(() => mode.enter("wrong"), /Type ENTER/);
  const active = mode.enter(ENTER_CONFIRMATION, true);
  assert.equal(active.active, true); assert.equal(active.banner, BANNER); assert.equal(active.generation, "1");
  assert.equal(mode.startupPolicy().allowServerStartHook, false); assert.equal(mode.startupPolicy().allowBackgroundWriters, false);
  assert.throws(() => mode.assertWorkloadStartAllowed("resume Market Bot"), /Automatic Startup and Writers Disabled/);
  const checkpoint = mode.captureCheckpoint("Server Migration import");
  assert.equal(mode.verifyCheckpoint(checkpoint).generation, "1");
  const restart = createMigrationOfflineMode({ statePath, journalActive: () => false });
  assert.equal(restart.status().active, true); assert.equal(restart.startupPolicy().allowServerStartHook, false);
  restart.persist({ active: true, generation: "9007199254740993", enteredAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(restart.exit(EXIT_CONFIRMATION, { localRequest: true }).generation, "9007199254740994");
  fs.writeFileSync(statePath, "{bad"); journal = true;
  const failed = createMigrationOfflineMode({ statePath, journalActive: () => journal });
  assert.equal(failed.status().failClosed, true); assert.equal(failed.startupPolicy().allowServerStartHook, false);
  assert.throws(() => failed.exit(EXIT_CONFIRMATION, { localRequest: true }), /reviewed/);
  const sideEffectFree = createMigrationOfflineMode({ statePath: path.join(dir, "runner.json"), sideEffectFree: true });
  assert.equal(sideEffectFree.startupPolicy().allowServerStartHook, false);
  assert.throws(() => sideEffectFree.enter(ENTER_CONFIRMATION), /cannot be changed/);
  console.log("Migration Offline Mode persistence, startup, checkpoints, bigint, and fail-closed tests passed.");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const electronSource = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
assert(serverSource.includes('assertWorkloadStartAllowed("update or restart the battlegroup")'));
assert(serverSource.includes('assertWorkloadStartAllowed("resume Market Bot")'));
assert(serverSource.includes('migrationOfflineMode.verifyCheckpoint(job.offlineCheckpoint, "before migration package publication")'));
assert(serverSource.includes('migrationOfflineMode.startupPolicy().allowBackgroundWriters) startManagerService()'));
assert(electronSource.includes("offlineStartup.active"), "Desktop Receiver startup must load the same Offline Mode guard first.");
