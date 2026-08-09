"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  buildInstallScript,
  buildMaintenanceTransport,
  classifySchedulerInventory,
  validateRemoteEvidence
} = require("../lib/maintenance-transport");
const { runWithStdin } = require("../lib/stdin-process");
const { runMaintenanceBootstrapRecovery } = require("../lib/maintenance-bootstrap");
const { createMigrationMaintenance, ENTER_CONFIRMATION, PHASES } = require("../lib/migration-maintenance");

const digest = (character) => character.repeat(64);
const remote = Object.freeze({
  schedulerPath: "/srv/alphanine/scheduler.sh",
  schedulerConfigPath: "/srv/alphanine/config.json",
  schedulerDir: "/srv/alphanine",
  sentinelPath: "/srv/maintenance/hold.json",
  cronPath: "/etc/crontabs/dune",
  cronBegin: "# BEGIN ALPHANINE",
  cronEnd: "# END ALPHANINE"
});

function evidenceFor(transport, overrides = {}) {
  const sentinel = Buffer.from(`${JSON.stringify({
    version: 1,
    active: true,
    generation: transport.expected.generation,
    holdDigest: transport.expected.holdDigest
  })}\n`);
  return {
    version: 1,
    architecture: "alpine-busybox-crond",
    schedulerMode: "installed",
    schedulerSize: transport.expected.schedulerSize,
    schedulerSha256: transport.expected.schedulerSha256,
    sentinelSize: String(sentinel.length),
    sentinelSha256: require("crypto").createHash("sha256").update(sentinel).digest("hex"),
    sentinelBase64: sentinel.toString("base64"),
    cronRegistrationCount: "1",
    conflictingRegistrationCount: "0",
    temporaryFileCount: "0",
    ...overrides
  };
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-maintenance-transport-"));
  try {
    const marker = "PAYLOAD_MUST_NEVER_APPEAR_IN_ARGUMENTS";
    const scheduler = Buffer.from(`#!/bin/sh\n# ${marker}\n${"# bounded streamed payload\n".repeat(6000)}exit 0\n`, "utf8");
    assert(scheduler.length > 100000, "fixture must exceed Windows command-line limits");
    const transport = buildMaintenanceTransport({ scheduler, generation: "1", holdDigest: digest("a"), ...remote });
    assert(transport.stdin.length > scheduler.length, "stdin bundle must contain the complete scheduler payload");
    assert(transport.command.length < 2000, "SSH remote command must remain bounded");
    assert.equal(transport.verifyCommand, "sh -s", "read-back verification must also use bounded SSH arguments");
    assert(!transport.command.includes(marker) && !transport.verifyCommand.includes(marker), "payload bytes must not appear in process arguments");
    assert(!/base64[^\n]*(?:scheduler|payload)/i.test(transport.command), "scheduler publication must not use command-line Base64 embedding");
    const installScript = buildInstallScript({ scheduler, generation: "1", holdDigest: digest("a"), ...remote });
    assert(transport.command.includes('cat > "$stage/payload.tar"'), "stdin transfer must be captured without text conversion");
    assert(installScript.indexOf("bash -n") < installScript.indexOf("install -o dune"), "syntax validation must precede installation");
    assert(transport.command.includes("trap cleanup_maintenance_transport EXIT HUP INT TERM"), "remote cleanup must cover success, interruption, and termination");
    assert(installScript.includes('mv -f "$scheduler_next"') && installScript.includes('mv -f "$sentinel_next"'), "validated artifacts must publish through atomic renames");
    assert(installScript.indexOf('mv -f "$sentinel_next"') < installScript.indexOf('mv -f "$scheduler_next"'), "the fail-closed sentinel must publish before an installed scheduler update");
    assert(installScript.includes("sha256sum") && installScript.includes("wc -c"), "remote staging must verify exact sizes and hashes");
    assert(!/rc-service|systemctl|service crond/.test(installScript), "maintenance publication must not require a service manager or restart cron");
    assert(installScript.includes("busybox --list") && installScript.includes("command -v crond"), "the real Alpine BusyBox-crond architecture must be detected explicitly");
    assert(installScript.includes("kubectl get cronjobs -A -o yaml"), "Kubernetes CronJobs must be inspected for alternate workload-start registrations");
    assert(!installScript.includes("sed -i") && !installScript.includes("/etc/crontabs/dune.next"), "maintenance publication must preserve every existing schedule byte");
    assert(installScript.includes("install -d -o dune -g dune -m 0750 '/srv/maintenance'"), "a missing sentinel directory must be created narrowly with explicit ownership and permissions");
    assert(!installScript.includes("install -d -o dune -g dune -m 0750 '/srv/alphanine'"), "an absent scheduler must not be installed or have its directory fabricated");
    assert(transport.command.includes('rm -f "$stage/files/"* "$stage/payload.tar"'), "all bounded remote temporary files must be removed by the trap");

    const archivePath = path.join(scratch, "guard.tar");
    fs.writeFileSync(archivePath, transport.stdin);
    const listing = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8", windowsHide: true });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split(/\r?\n/).sort(), [
      "generation", "hold-digest", "install.sh", "scheduler.sh", "scheduler.sha256", "scheduler.size",
      "sentinel.json", "sentinel.sha256", "sentinel.size"
    ]);
    const shellSyntax = spawnSync("bash", ["-n"], { input: transport.command, encoding: "utf8", windowsHide: true });
    if (!shellSyntax.error || shellSyntax.error.code !== "ENOENT") assert.equal(shellSyntax.status, 0, shellSyntax.stderr);
    const installSyntax = spawnSync("bash", ["-n"], { input: installScript, encoding: "utf8", windowsHide: true });
    if (!installSyntax.error || installSyntax.error.code !== "ENOENT") assert.equal(installSyntax.status, 0, installSyntax.stderr);
    const verifySyntax = spawnSync("bash", ["-n"], { input: transport.verifyStdin, encoding: "utf8", windowsHide: true });
    if (!verifySyntax.error || verifySyntax.error.code !== "ENOENT") assert.equal(verifySyntax.status, 0, verifySyntax.stderr);

    const verified = validateRemoteEvidence(evidenceFor(transport), transport.expected);
    assert.equal(verified.ok, true);
    assert.equal(verified.generation, "1");
    assert.equal(verified.schedulerMode, "installed");
    const absent = validateRemoteEvidence(evidenceFor(transport, {
      schedulerMode: "absent", schedulerSize: "0", schedulerSha256: "", cronRegistrationCount: "0"
    }), transport.expected);
    assert.equal(absent.schedulerMode, "absent", "a genuinely absent scheduler must be verified without inventing a runtime or cron entry");
    assert.throws(() => validateRemoteEvidence(evidenceFor(transport, { schedulerSize: "1" }), transport.expected), /schedulerSize/);
    assert.throws(() => validateRemoteEvidence(evidenceFor(transport, { schedulerSha256: digest("b") }), transport.expected), /schedulerSha256/);
    const wrongSentinel = Buffer.from(`${JSON.stringify({ version: 1, active: true, generation: "2", holdDigest: digest("a") })}\n`);
    assert.throws(() => validateRemoteEvidence(evidenceFor(transport, {
      sentinelSize: String(wrongSentinel.length),
      sentinelSha256: require("crypto").createHash("sha256").update(wrongSentinel).digest("hex"),
      sentinelBase64: wrongSentinel.toString("base64")
    }), transport.expected), /generation/);
    assert.throws(() => validateRemoteEvidence(evidenceFor(transport, { conflictingRegistrationCount: "1" }), transport.expected), /conflicting registration/i);
    assert.throws(() => validateRemoteEvidence(evidenceFor(transport, { temporaryFileCount: "1" }), transport.expected), /temporary file/i);

    const inventoryBase = {
      architecture: "alpine-busybox-crond", persistentTarget: true, conflictingRegistrations: "0", activeSchedulerProcesses: "0",
      directoryExists: false, schedulerPersistent: false, scriptExists: false, configExists: false, cronBeginCount: "0", cronEndCount: "0", cronPathReferences: "0"
    };
    assert.equal(classifySchedulerInventory(inventoryBase).mode, "absent");
    const installedInventory = { ...inventoryBase, directoryExists: true, schedulerPersistent: true, scriptExists: true, configExists: true, cronBeginCount: "1", cronEndCount: "1", cronPathReferences: "1" };
    assert.equal(classifySchedulerInventory(installedInventory).mode, "installed");
    assert.throws(() => classifySchedulerInventory({ ...installedInventory, schedulerPersistent: false }), /partial, stale, or ambiguous/);
    assert.throws(() => classifySchedulerInventory({ ...inventoryBase, directoryExists: true }), /partial, stale, or ambiguous/);
    assert.throws(() => classifySchedulerInventory({ ...inventoryBase, persistentTarget: false }), /persistent filesystem/);
    assert.throws(() => classifySchedulerInventory({ ...inventoryBase, conflictingRegistrations: "1" }), /unexpected scheduler registration/);
    assert.throws(() => classifySchedulerInventory({ ...inventoryBase, activeSchedulerProcesses: "1" }), /scheduler process is active/);
    assert.throws(() => classifySchedulerInventory({ ...inventoryBase, architecture: "kubernetes-cronjob" }), /unsupported or ambiguous/);

    const inputPath = path.join(scratch, "stdin.bin");
    fs.writeFileSync(inputPath, Buffer.alloc(2 * 1024 * 1024, 7));
    const complete = await runWithStdin(process.execPath, ["-e", "let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>{process.stdout.write(String(n));process.stderr.write('diagnostic-only')})"], inputPath, { timeout: 10000 });
    assert.equal(complete.ok, true);
    assert.equal(complete.inputComplete, true);
    assert.equal(complete.stdout, String(2 * 1024 * 1024));
    assert.equal(complete.stderr, "diagnostic-only", "stdout and stderr must remain separate");
    const smallInputPath = path.join(scratch, "stdin-small.bin");
    fs.writeFileSync(smallInputPath, Buffer.alloc(32768, 9));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const closeRace = await runWithStdin(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('0+1 records in\\n');process.exit(0)})"], smallInputPath, { timeout: 10000 });
      assert.equal(closeRace.ok, true, `successful close-before-notification transfer ${attempt + 1} must not become a false failure`);
      assert.equal(closeRace.inputComplete, true);
      assert.match(closeRace.stderr, /records in/);
    }

    const partial = await runWithStdin(process.execPath, ["-e", "process.stdin.once('data',()=>process.exit(7))"], inputPath, { timeout: 10000 });
    assert.equal(partial.ok, false, "partial stdin write or SSH disconnect must fail closed");
    assert.equal(partial.inputComplete, false);
    const disconnected = await runWithStdin(process.execPath, ["-e", "process.stdin.destroy();process.exit(9)"], inputPath, { timeout: 10000 });
    assert.equal(disconnected.ok, false, "SSH disconnect must fail closed");
    const timedOut = await runWithStdin(process.execPath, ["-e", "process.stdin.pause();setInterval(()=>{},1000)"], inputPath, { timeout: 100 });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error, /timed out/);

    const maintenanceRoot = path.join(scratch, "recovery");
    const statePath = path.join(maintenanceRoot, "maintenance.json");
    const maintenance = createMigrationMaintenance({ statePath, journalActive: () => false, externalHold: () => ({ active: false }), now: () => "2026-08-04T08:00:00.000Z" });
    maintenance.beginProvisional(ENTER_CONFIRMATION);
    const provisional = maintenance.bootstrapCheckpoint(PHASES.PROVISIONAL);
    maintenance.retainBootstrapRecovery(provisional);
    const primaryBefore = fs.readFileSync(statePath);
    const recoveryBefore = fs.readFileSync(`${statePath}.previous`);
    const exactRecovery = maintenance.recoveryCheckpoint(ENTER_CONFIRMATION);
    assert.equal(exactRecovery.generation, "1");
    assert.equal(exactRecovery.phase, PHASES.RECOVERY);
    assert.deepEqual(fs.readFileSync(statePath), primaryBefore, "reading recovery must not mutate the primary hold");
    assert.deepEqual(fs.readFileSync(`${statePath}.previous`), recoveryBefore, "reading recovery must not mutate its recovery copy");
    assert.equal(maintenance.startupPolicy().allowServerStartHook, false, "recovery must suppress the startup hook");
    assert.equal(maintenance.startupPolicy().allowBackgroundWriters, false, "recovery must suppress background workload mutations");

    const events = [];
    const result = await runMaintenanceBootstrapRecovery({
      preflight: async () => ({ ok: true, evidenceDigest: digest("c") }),
      recoveryCheckpoint: async () => { events.push("recovery"); return maintenance.recoveryCheckpoint(ENTER_CONFIRMATION); },
      checkpoint: async (phase) => maintenance.bootstrapCheckpoint(phase),
      deployRemote: async (checkpoint) => { events.push(`deploy-${checkpoint.generation}`); },
      verifyRemote: async (checkpoint) => { assert.equal(checkpoint.generation, "1"); },
      markRemoteGuarded: async (checkpoint) => maintenance.transitionBootstrap(checkpoint, PHASES.REMOTE_GUARDED),
      revalidate: async () => ({ ok: true, evidenceDigest: digest("c") }),
      finalize: async (checkpoint) => maintenance.transitionBootstrap(checkpoint, PHASES.ACTIVE),
      recover: async (checkpoint) => maintenance.retainBootstrapRecovery(checkpoint)
    });
    assert.equal(result.resumedRecovery, true);
    assert.equal(result.checkpoint.generation, "1", "recovery must not create generation 2");
    assert.deepEqual(events, ["recovery", "deploy-1"]);
    assert(!result.history.some((row) => row.stage === "Persist provisional local hold"), "recovery must not restart the first-entry workflow");

    const failurePath = path.join(scratch, "recovery-failure.json");
    const failedMaintenance = createMigrationMaintenance({ statePath: failurePath, journalActive: () => false, externalHold: () => ({ active: false }) });
    failedMaintenance.beginProvisional(ENTER_CONFIRMATION);
    failedMaintenance.retainBootstrapRecovery(failedMaintenance.bootstrapCheckpoint(PHASES.PROVISIONAL));
    await assert.rejects(() => runMaintenanceBootstrapRecovery({
      preflight: async () => ({ ok: true, evidenceDigest: digest("d") }),
      recoveryCheckpoint: async () => failedMaintenance.recoveryCheckpoint(ENTER_CONFIRMATION),
      checkpoint: async (phase) => failedMaintenance.bootstrapCheckpoint(phase),
      deployRemote: async () => { throw new Error("remote disk full"); },
      verifyRemote: async () => true,
      markRemoteGuarded: async () => {}, revalidate: async () => ({}), finalize: async () => {},
      recover: async (checkpoint) => failedMaintenance.retainBootstrapRecovery(checkpoint)
    }), /remote disk full/);
    const retained = failedMaintenance.bootstrapCheckpoint(PHASES.RECOVERY);
    assert.equal(retained.generation, "1", "transport failure must retain the same recovery generation");

    const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    assert(serverSource.includes('sshCommand(transport.command, 60000, { maxBuffer: 1024 * 1024, inputPath })'), "live transport must stream through SSH stdin");
    assert(serverSource.includes('sshCommand(transport.verifyCommand, 30000, { maxBuffer: 1024 * 1024, inputPath })'), "live read-back must use the bounded stdin verifier");
    assert(serverSource.includes("fs.rmSync(temporaryDirectory, { recursive: true, force: true })"), "local transport temporary files must be cleaned on every exit");
    assert(!serverSource.includes("schedulerPayload = schedulerSource.toString(\"base64\")"), "scheduler payload must not return to command-line embedding");
    assert(serverSource.includes("resumingRecovery ? runMaintenanceBootstrapRecovery : runMaintenanceBootstrap"), "live recovery must select the exact recovery runner");

    console.log("Maintenance scheduler-guard stdin transport, artifact verification, failure cleanup, and exact-generation recovery tests passed.");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
