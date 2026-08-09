"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  BANNER,
  CANCEL_RECOVERY_CONFIRMATION,
  ENTER_CONFIRMATION,
  EXIT_CONFIRMATION,
  PHASES,
  createMigrationMaintenance,
  readOperationJournal,
  validateState
} = require("../lib/migration-maintenance");
const { runMaintenanceBootstrap } = require("../lib/maintenance-bootstrap");
const { operationsConflict } = require("../lib/operations");

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "a9-maintenance-test-"));
  const statePath = path.join(directory, "migration-maintenance.json");
  const journalPath = path.join(directory, "operations.json");
  const clock = options.clock || (() => "2026-08-03T20:00:00.000Z");
  const maintenance = createMigrationMaintenance({
    statePath,
    sideEffectFree: options.sideEffectFree === true,
    now: clock,
    journalActive: () => readOperationJournal(journalPath)
  });
  return { directory, statePath, journalPath, maintenance, clock };
}

function remove(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

{
  const test = fixture();
  try {
    test.maintenance.persist({ version: 1, active: true, generation: "1", enteredAt: "2026-08-03T20:00:00.000Z", updatedAt: "2026-08-03T20:00:00.000Z", phase: PHASES.RECOVERY });
    assert.throws(() => test.maintenance.cancelLocalRecovery(CANCEL_RECOVERY_CONFIRMATION, {}), /read-only proof/);
    const cancelled = test.maintenance.cancelLocalRecovery(CANCEL_RECOVERY_CONFIRMATION, {
      remoteSentinelAbsent: true,
      remoteSchedulerGuardAbsent: true,
      remoteTemporaryArtifactsAbsent: true,
      verifiedAt: "2026-08-04T09:00:00.000Z"
    });
    assert.equal(cancelled.active, false);
    assert.equal(cancelled.phase, PHASES.CANCELLED);
    assert.equal(cancelled.generation, "1", "Cancellation must preserve the recovery identity.");
    assert.equal(cancelled.cancellationJournal.status, "cancelled");
    assert.equal(cancelled.cancellationJournal.holdDigest.length, 64);
    assert.equal(cancelled.cancellationJournal.cancellationDigest.length, 64);
    assert.equal(test.maintenance.startupPolicy().allowServerStartHook, true);
    assert.equal(JSON.parse(fs.readFileSync(`${test.statePath}.previous`, "utf8")).phase, PHASES.CANCELLED);
    assert.equal(JSON.parse(fs.readFileSync(`${test.statePath}.cancelled.json`, "utf8")).generation, "1");
  } finally { remove(test.directory); }
}

{
  const test = fixture();
  try {
    assert.equal(test.maintenance.status().active, false, "Missing state without a journal must preserve normal startup behavior.");
    assert.equal(test.maintenance.startupPolicy().allowServerStartHook, true, "Normal startup must retain its existing start hook outside maintenance.");
    assert.throws(() => test.maintenance.enter("wrong"), /Type ENTER MIGRATION MAINTENANCE exactly/);
    assert.throws(() => test.maintenance.enter(ENTER_CONFIRMATION), /--maintenance-bootstrap/);
    const provisional = test.maintenance.beginProvisional(ENTER_CONFIRMATION);
    assert.equal(provisional.active, true);
    assert.equal(provisional.phase, PHASES.PROVISIONAL);
    assert.equal(provisional.banner, BANNER);
    assert.equal(test.maintenance.startupPolicy().allowServerStartHook, false);
    assert.equal(test.maintenance.startupPolicy().allowVmAndPostgresConnectivity, true);
    assert.equal(test.maintenance.startupPolicy().allowBackgroundWriters, false);
    assert.throws(() => test.maintenance.assertWorkloadStartAllowed("start the battlegroup"), /Game Server Held Offline/);
    const persisted = JSON.parse(fs.readFileSync(test.statePath, "utf8"));
    assert.deepEqual(Object.keys(persisted).sort(), ["active", "enteredAt", "generation", "holdDigest", "phase", "updatedAt", "version"]);
    assert(!/password|credential|path|player/i.test(JSON.stringify(persisted)), "Persisted state must contain no secrets, paths, or player data.");

    const provisionalRestart = createMigrationMaintenance({ statePath: test.statePath, now: test.clock, journalActive: () => false });
    assert.equal(provisionalRestart.status().failClosed, true, "A Suite restart during bootstrap must recover fail closed.");
    assert.equal(provisionalRestart.startupPolicy().allowServerStartHook, false, "Restart recovery must suppress server startup.");
    const provisionalCheckpoint = test.maintenance.bootstrapCheckpoint(PHASES.PROVISIONAL);
    test.maintenance.transitionBootstrap(provisionalCheckpoint, PHASES.REMOTE_GUARDED);
    const guardedCheckpoint = test.maintenance.bootstrapCheckpoint(PHASES.REMOTE_GUARDED);
    const entered = test.maintenance.transitionBootstrap(guardedCheckpoint, PHASES.ACTIVE);
    assert.equal(entered.failClosed, false);
    assert.equal(entered.holdDigest, guardedCheckpoint.holdDigest, "The hold digest must remain invariant through bootstrap phases.");

    const restarted = createMigrationMaintenance({ statePath: test.statePath, now: test.clock, journalActive: () => false });
    assert.equal(restarted.status().phase, PHASES.ACTIVE, "Finalized maintenance must survive Suite restart.");
    assert.equal(restarted.startupPolicy().allowServerStartHook, false, "Finalized maintenance must suppress server startup.");

    const backupCheckpoint = restarted.captureCheckpoint("Verified database backup");
    const exportCheckpoint = restarted.captureCheckpoint("Server Migration export");
    restarted.persist({ version: 1, active: true, generation: "2", enteredAt: persisted.enteredAt, updatedAt: "2026-08-03T20:01:00.000Z", phase: PHASES.ACTIVE });
    assert.throws(() => restarted.verifyCheckpoint(backupCheckpoint, "before publication"), /changed.*aborted/i, "Backup must abort if maintenance changes mid-operation.");
    assert.throws(() => restarted.verifyCheckpoint(exportCheckpoint, "before publication"), /changed.*aborted/i, "Export must abort if maintenance changes mid-operation.");

    assert.throws(() => restarted.exit("wrong"), /Type EXIT MIGRATION MAINTENANCE exactly/);
    const exited = restarted.exit(EXIT_CONFIRMATION);
    assert.equal(exited.active, false);
    assert.equal(exited.generation, "3");
    assert.equal(restarted.startupPolicy().allowServerStartHook, true, "Exit restores controls without invoking a start hook.");
  } finally { remove(test.directory); }
}

{
  const test = fixture();
  try {
    test.maintenance.beginProvisional(ENTER_CONFIRMATION);
    fs.rmSync(`${test.statePath}.previous`);
    assert.throws(
      () => test.maintenance.retainBootstrapRecovery({ generation: "1", holdDigest: "untrusted" }),
      /unreadable|inconsistent/,
      "Bootstrap recovery must not report success unless both durable hold copies can be verified."
    );
    const recovered = createMigrationMaintenance({ statePath: test.statePath, now: test.clock, journalActive: () => false });
    assert.equal(recovered.status().failClosed, true, "A missing recovery copy must never be treated as active maintenance success.");
    assert.equal(recovered.startupPolicy().allowServerStartHook, false);
  } finally { remove(test.directory); }
}

{
  const test = fixture();
  try {
    fs.writeFileSync(test.journalPath, JSON.stringify({ version: 1, operations: [{ key: "maintenance:bootstrap", status: "running" }] }));
    const recovered = createMigrationMaintenance({ statePath: test.statePath, now: test.clock, journalActive: () => readOperationJournal(test.journalPath) });
    assert.equal(recovered.status().active, true);
    assert.equal(recovered.status().phase, PHASES.RECOVERY);
    assert.equal(recovered.startupPolicy().allowServerStartHook, false, "A missing intermediate bootstrap state must recover before normal startup.");
    assert.equal(recovered.bootstrapCheckpoint(PHASES.RECOVERY).holdDigest.length, 64, "Recovered local and recovery copies must carry a valid hold digest.");
  } finally { remove(test.directory); }
}

{
  const test = fixture({ sideEffectFree: true });
  try {
    const policy = test.maintenance.startupPolicy();
    assert.equal(policy.allowServerStartHook, false);
    assert.equal(policy.allowBackgroundWriters, false);
    assert.equal(policy.allowVmAndPostgresConnectivity, true);
    assert.throws(() => test.maintenance.assertWorkloadStartAllowed("start workloads"), /Side-effect-free|Game Server Held Offline/);
    assert.throws(() => test.maintenance.captureCheckpoint("backup"), /Side-effect-free runner cannot execute/);
    assert.throws(() => test.maintenance.enter(ENTER_CONFIRMATION), /cannot be changed/);
    assert.throws(() => test.maintenance.beginProvisional(ENTER_CONFIRMATION), /cannot be changed/);
  } finally { remove(test.directory); }
}

{
  const test = fixture();
  try {
    fs.writeFileSync(test.journalPath, JSON.stringify({ version: 1, operations: [{ key: "migration:export", status: "running" }] }));
    fs.writeFileSync(test.statePath, "{malformed");
    const recovered = createMigrationMaintenance({ statePath: test.statePath, now: test.clock, journalActive: () => readOperationJournal(test.journalPath) });
    assert.equal(recovered.status().active, true);
    assert.equal(recovered.status().failClosed, true, "Malformed state with an active journal must fail closed.");
    assert.equal(recovered.startupPolicy().allowServerStartHook, false);
    assert.throws(() => recovered.exit(EXIT_CONFIRMATION), /reviewed and repaired/);
  } finally { remove(test.directory); }
}

{
  const test = fixture();
  try {
    fs.writeFileSync(test.journalPath, JSON.stringify({ version: 1, operations: [{ key: "database:backup", status: "running" }] }));
    const recovered = createMigrationMaintenance({ statePath: test.statePath, now: test.clock, journalActive: () => readOperationJournal(test.journalPath) });
    assert.equal(recovered.status().active, true);
    assert.equal(recovered.startupState.source, "journal-recovery");
    assert.equal(validateState(JSON.parse(fs.readFileSync(test.statePath, "utf8"))).active, true, "Missing state must be durably recovered when a journal exists.");
  } finally { remove(test.directory); }
}

{
  const test = fixture();
  try {
    test.maintenance.persist({ version: 1, active: true, generation: "9007199254740993", enteredAt: "2026-08-03T20:00:00.000Z", updatedAt: "2026-08-03T20:00:00.000Z" });
    assert.equal(test.maintenance.exit(EXIT_CONFIRMATION).generation, "9007199254740994", "Maintenance generations must remain exact beyond Number.MAX_SAFE_INTEGER.");
  } finally { remove(test.directory); }
}

for (const key of ["battlegroup:control", "scheduler:restart", "battlegroup:update", "database:import", "market-bot:clean", "migration:export", "maintenance:bootstrap"]) {
  assert.equal(operationsConflict("maintenance:mode", key), true, `Maintenance control must conflict with ${key}.`);
}

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
const scheduler = fs.readFileSync(path.join(__dirname, "..", "assets", "scheduler", "alphanine-scheduler.sh"), "utf8");
assert(server.includes("createStartupPolicy()"), "Controlled runners must load the centralized startup policy before optional components.");
assert(server.includes('code: "maintenance_bootstrap"'), "Bootstrap must return a dedicated blocked-action code.");
assert(server.includes("if (SUITE_STARTUP_POLICY.allowManager && migrationMaintenance.startupPolicy().allowBackgroundWriters && migrationOfflineMode.startupPolicy().allowBackgroundWriters) startManagerService()"), "Bootstrap, startup suppression, and Offline Mode must not start the Manager service.");
assert(server.includes("requestMaintenanceBootstrapShutdown"), "Successful bootstrap must shut down cleanly.");
assert(desktop.includes("createStartupPolicy()"), "The desktop runtime must use the centralized runner policy.");
assert(desktop.includes("runnerArgs = MAINTENANCE_BOOTSTRAP_RUNNER") && desktop.includes('? ["--maintenance-bootstrap"]'), "Electron must forward bootstrap mode to the backend.");
assert(desktop.includes("DESKTOP_STARTUP_POLICY.allowDesktopReceiver"), "Electron must suppress Receiver startup in isolated modes.");
assert(server.includes("startupPolicy.allowServerStartHook"), "Startup must use the shared maintenance guard.");
assert(server.includes("maintenanceAtStartup.sideEffectFree"), "The side-effect-free runner itself must suppress startup services.");
assert(server.includes('assertWorkloadStartAllowed("update or restart the battlegroup")'), "Updater must be guarded.");
assert(server.includes('assertWorkloadStartAllowed("resume Market Bot")'), "Market Bot resume must be guarded.");
assert(server.includes("await verifyMaintenanceCheckpointRemote"), "Protected workflows must revalidate local and VM maintenance generations.");
assert(server.includes(BANNER), "The maintenance banner must be prominent in the rendered UI.");
assert(scheduler.includes("maintenance_active()"), "The VM scheduler must honor the persistent maintenance hold.");
assert(scheduler.includes("no recovery start was requested"), "A mid-restart maintenance transition must fail closed.");

(async () => {
  const digest = "a".repeat(64);
  const events = [];
  const success = await runMaintenanceBootstrap({
    preflight: async () => ({ ok: true, evidenceDigest: digest }),
    beginProvisional: async () => events.push("provisional"),
    checkpoint: async (phase) => ({ generation: "9007199254740993", holdDigest: "b".repeat(64), phase }),
    deployRemote: async () => events.push("remote"),
    verifyRemote: async () => true,
    markRemoteGuarded: async () => events.push("guarded"),
    revalidate: async () => ({ ok: true, evidenceDigest: digest }),
    finalize: async () => ({ active: true, phase: PHASES.ACTIVE }),
    recover: async () => events.push("recover")
  });
  assert.equal(success.ok, true);
  assert.deepEqual(events, ["provisional", "remote", "guarded"]);

  let recoveredBefore = 0;
  await assert.rejects(() => runMaintenanceBootstrap({
    preflight: async () => ({ ok: false, error: "offline gate failed" }),
    beginProvisional: async () => {}, checkpoint: async () => ({}), deployRemote: async () => {}, verifyRemote: async () => {}, markRemoteGuarded: async () => {}, revalidate: async () => ({}), finalize: async () => {}, recover: async () => { recoveredBefore += 1; }
  }), /offline gate failed/);
  assert.equal(recoveredBefore, 0, "A failure before provisional persistence has no intermediate hold to recover.");

  let recoveredAfter = 0;
  await assert.rejects(() => runMaintenanceBootstrap({
    preflight: async () => ({ ok: true, evidenceDigest: digest }),
    beginProvisional: async () => {},
    checkpoint: async (phase) => ({ generation: "1", holdDigest: "c".repeat(64), phase }),
    deployRemote: async () => {}, verifyRemote: async () => true, markRemoteGuarded: async () => {},
    revalidate: async () => ({ ok: false, error: "counts changed" }), finalize: async () => {},
    recover: async () => { recoveredAfter += 1; return { active: true, phase: PHASES.RECOVERY }; }
  }), /counts changed/);
  assert.equal(recoveredAfter, 1, "A post-sentinel failure must retain a fail-closed recovery hold.");

  let remoteChecks = 0;
  let mismatchRecovered = 0;
  await assert.rejects(() => runMaintenanceBootstrap({
    preflight: async () => ({ ok: true, evidenceDigest: digest }), beginProvisional: async () => {},
    checkpoint: async (phase) => ({ generation: "2", holdDigest: "d".repeat(64), phase }), deployRemote: async () => {},
    verifyRemote: async () => { remoteChecks += 1; if (remoteChecks > 1) throw new Error("remote digest mismatch"); },
    markRemoteGuarded: async () => {}, revalidate: async () => ({ ok: true, evidenceDigest: digest }), finalize: async () => {},
    recover: async () => { mismatchRecovered += 1; return { active: true, phase: PHASES.RECOVERY }; }
  }), /remote digest mismatch/);
  assert.equal(mismatchRecovered, 1, "A remote generation or digest mismatch must retain recovery state.");
  console.log("Migration Maintenance bootstrap, persistence, startup, runner, operation, scheduler, and checkpoint tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
