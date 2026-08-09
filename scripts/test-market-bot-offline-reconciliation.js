"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  CONFIRMATION,
  EXPECTED,
  PHASES,
  OfflineMarketBotReconciliationState,
  assertAllowedLocalEvidenceUpdate,
  assertIdentityStable,
  runOfflineMarketBotReconciliation
} = require("../lib/market-bot-offline-reconciliation");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "a9-offline-market-bot-reconciliation-"));
const boundaryDigest = "a".repeat(64);
const semanticDigest = "b".repeat(64);
const offlineDigest = "c".repeat(64);
const localBeforeSha256 = "d".repeat(64);
const localAfterSha256 = "e".repeat(64);

function identity(extra = {}) {
  return {
    offlineGeneration: EXPECTED.offlineGeneration,
    offlineDigest,
    remoteGeneration: EXPECTED.remoteGeneration,
    remoteFingerprint: EXPECTED.configFingerprint,
    catalogItemCount: EXPECTED.catalogItemCount,
    catalogFingerprint: EXPECTED.catalogFingerprint,
    boundaryDigest,
    semanticDigest,
    localBeforeSha256,
    ...extra
  };
}

function testExactScope() {
  assert.equal(CONFIRMATION, "RECONCILE LOCAL MARKET BOT EVIDENCE");
  assert.equal(EXPECTED.remoteGeneration, "6");
  assert.equal(EXPECTED.catalogItemCount, "2131");
  const before = {
    schemaVersion: 2,
    enabled: true,
    paused: true,
    pauseState: "Unknown",
    configGeneration: "0",
    pauseGeneration: "0",
    runtimeFingerprint: "",
    economyStyle: "Expensive",
    intervalMinutes: 30,
    catalogPolicy: { mode: "dynamic", itemCount: "0", fingerprint: "", items: [] },
    updatedAt: "before"
  };
  const after = {
    ...before,
    pauseState: "Pause requested",
    configGeneration: "6",
    pauseGeneration: "6",
    runtimeFingerprint: EXPECTED.configFingerprint,
    catalogPolicy: { mode: "pinned", itemCount: "2131", fingerprint: EXPECTED.catalogFingerprint, items: [{ id: "fixture" }] },
    updatedAt: "after"
  };
  const scope = assertAllowedLocalEvidenceUpdate(before, after);
  assert.deepEqual(scope.evidenceFields, ["catalogPolicy", "configGeneration", "pauseGeneration", "pauseState", "runtimeFingerprint"]);
  assert.throws(() => assertAllowedLocalEvidenceUpdate(before, { ...after, economyStyle: "Cheap" }), /forbidden configuration categories/);
  assert.throws(() => assertAllowedLocalEvidenceUpdate(before, { ...after, enabled: false }), /forbidden configuration categories/);

  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const workflowSource = serverSource.slice(
    serverSource.indexOf("async function reconcileLocalMarketBotEvidenceInOfflineMode"),
    serverSource.indexOf("async function enterMigrationMaintenanceFromBootstrap")
  );
  assert.match(workflowSource, /MIGRATION_STARTUP_SUPPRESSED_RUNNER/);
  assert.match(workflowSource, /marketBotStore\.save/);
  assert.match(workflowSource, /migrationOfflineMode\.verifyCheckpoint/);
  assert.doesNotMatch(workflowSource, /publishPinnedPausedMarketBotPolicy|buildMarketBotActionCommand|publishPause|\bresume\b|\brestock\b|\bclean\b/i, "local evidence repair must have no remote Market Bot mutation surface");
}

async function testDurableSuccessAndCheckpointPreservation() {
  const statePath = path.join(root, "success.json");
  const state = new OfflineMarketBotReconciliationState(statePath, (() => {
    let tick = 0;
    return () => `2026-08-04T00:00:0${tick++}.000Z`;
  })());
  const checkpoints = [];
  const calls = [];
  const before = { ok: true, ...identity(), localAlreadyReconciled: false, offlineCheckpoint: { version: 1, generation: "1", digest: offlineDigest } };
  const result = await runOfflineMarketBotReconciliation({
    preflight: async () => { calls.push("preflight"); return before; },
    prepare: async (value) => { calls.push("prepare"); return state.begin(value); },
    verifyCheckpoint: async (checkpoint, stage) => { checkpoints.push({ checkpoint, stage }); },
    persistLocal: async () => { calls.push("persist-local"); return { sha256: localAfterSha256 }; },
    markLocalPersisted: async (sha256) => { calls.push("mark-local"); return state.markLocalPersisted(sha256); },
    postflight: async () => { calls.push("postflight"); return { ok: true, ...identity(), localCurrentSha256: localAfterSha256 }; },
    markVerified: async () => { calls.push("verified"); return state.markVerified(); },
    complete: async () => { calls.push("complete"); return state.complete(); },
    recover: async (code) => state.recover(code)
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["preflight", "prepare", "persist-local", "mark-local", "postflight", "verified", "complete"]);
  assert.equal(checkpoints.length, 3, "Offline Mode must be checked before, immediately after, and after revalidation");
  assert(checkpoints.every((row) => row.checkpoint.generation === "1" && row.checkpoint.digest === offlineDigest));
  assert.equal(state.status().active, false);
  assert.equal(state.status().phase, PHASES.COMPLETE);
  assert.equal(fs.readFileSync(statePath, "utf8"), fs.readFileSync(`${statePath}.previous`, "utf8"), "journal primary and recovery copies must match byte-for-byte");
}

async function testInterruptionAndDriftFailClosed() {
  const statePath = path.join(root, "interrupted.json");
  const state = new OfflineMarketBotReconciliationState(statePath);
  const before = { ok: true, ...identity(), localAlreadyReconciled: false, offlineCheckpoint: { version: 1, generation: "1", digest: offlineDigest } };
  await assert.rejects(() => runOfflineMarketBotReconciliation({
    preflight: async () => before,
    prepare: async (value) => state.begin(value),
    verifyCheckpoint: async () => {},
    persistLocal: async () => { throw Object.assign(new Error("interrupted"), { code: "simulated_interruption" }); },
    markLocalPersisted: async (sha256) => state.markLocalPersisted(sha256),
    postflight: async () => ({}),
    markVerified: async () => state.markVerified(),
    complete: async () => state.complete(),
    recover: async (code) => state.recover(code)
  }), /interrupted/);
  const recovery = state.status();
  assert.equal(recovery.active, true);
  assert.equal(recovery.failClosed, true);
  assert.equal(recovery.phase, PHASES.RECOVERY);
  assert.equal(recovery.errorCode, "simulated_interruption");
  assert.throws(() => state.begin(identity({ boundaryDigest: "f".repeat(64) })), /drift/);
  assert.throws(() => assertIdentityStable(identity(), identity({ remoteGeneration: "7" })), /drift/);

  fs.writeFileSync(`${statePath}.previous`, "{}\n", "utf8");
  const ambiguous = state.status();
  assert.equal(ambiguous.active, true);
  assert.equal(ambiguous.failClosed, true);
  assert.equal(ambiguous.phase, PHASES.RECOVERY);
}

async function main() {
  try {
    testExactScope();
    await testDurableSuccessAndCheckpointPreservation();
    await testInterruptionAndDriftFailClosed();
    console.log("Offline Mode Market Bot local-evidence scope, durability, checkpoint, recovery, and drift tests passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
