"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PHASES,
  PauseReconciliationState,
  assertNewGeneration,
  boundaryDigest,
  classifyLocalState,
  nextGeneration,
  runPauseReconciliation,
  semanticDifferenceCategories,
  validateRemoteQuiescence
} = require("../lib/market-bot-reconciliation");
const { createMigrationMaintenance } = require("../lib/migration-maintenance");

const digest = (character) => character.repeat(64);
const sample = Object.freeze({
  advisoryLocks: "0", incompleteCycles: "0", cycleEvidenceRows: "0", cycleEvidenceDigest: digest("0"), activeTracking: "775", totalTracking: "1675",
  protectedOrders: "41", protectedSellOrders: "40", protectedItems: "40", fulfilledPayments: "1",
  invalidBotTracking: "0", invalidProtected: "0", protectedDigest: digest("a"), botOwnedDigest: digest("b")
});
const writer = Object.freeze({ unexpectedActiveClients: "0", openTransactions: "0" });
const remote = Object.freeze({
  installed: true,
  config: {
    schemaVersion: 2, configFingerprint: digest("c"), runtimeVersion: "1.0.84", paused: true,
    pauseState: "Pause requested", configGeneration: "9007199254740993", pauseGeneration: "9007199254740993"
  },
  state: {
    installedVersion: "1.0.84", status: "Quiescent", pauseState: "Quiescent",
    configGeneration: "9007199254740993", pauseGeneration: "9007199254740993",
    cycleQueued: false, cycleRunning: false, incompleteCycle: false
  }
});

function remoteCheck(overrides = {}) {
  return validateRemoteQuiescence({
    remote: overrides.remote || remote,
    samples: overrides.samples || [sample, sample],
    writers: overrides.writers || [writer, writer],
    expectedVersion: "1.0.84",
    expectedConfigFingerprint: digest("c"),
    expectedBinaryHash: digest("d"),
    remoteBinaryHash: overrides.remoteBinaryHash || digest("d")
  });
}

assert.equal(nextGeneration("9007199254740993", "9"), "9007199254740994", "Generations must remain exact beyond Number.MAX_SAFE_INTEGER.");
assert.equal(assertNewGeneration("9007199254740994", "9007199254740993"), "9007199254740994");
assert.throws(() => assertNewGeneration("9007199254740993", "9007199254740993"), /generation_collision/, "A generation collision must fail closed.");

assert.equal(classifyLocalState(null, {}).classification, "legacy-incompatible");
assert.equal(classifyLocalState(JSON.stringify({ schemaVersion: 1, configGeneration: "2", pauseGeneration: "2", runtimeFingerprint: "" }), {}).classification, "legacy-incompatible");
assert.equal(classifyLocalState(JSON.stringify({ schemaVersion: 2, configGeneration: "2", pauseGeneration: "2", runtimeFingerprint: digest("c") }), {}).classification, "current");
assert.equal(classifyLocalState(JSON.stringify({ schemaVersion: 2, configGeneration: 2, pauseGeneration: "2", runtimeFingerprint: digest("c") }), {}).classification, "malformed-current");
assert.equal(classifyLocalState("{broken", {}).classification, "malformed-current");

const semantic = {
  enabled: true, paused: true, activated: true, battlegroup: "group", namespace: "ns", dbPod: "db", dbService: "svc",
  exchangeName: "Exchange", economyStyle: "Expensive", listingCategory: "", intervalMinutes: 30, expiryDays: 3,
  safety: { maxCreatesPerCycle: 25 }, items: [{ id: "item", unitPrice: 10 }]
};
assert.deepEqual(semanticDifferenceCategories({ ...semantic, configGeneration: "1" }, { ...semantic, configGeneration: "2" }), [], "Generation evidence must not be a semantic policy difference.");
assert.deepEqual(semanticDifferenceCategories(semantic, { ...semantic, economyStyle: "Cheap" }), ["policy"], "Semantic mismatch reports categories without exposing values.");

assert.equal(remoteCheck().ok, true);
assert(remoteCheck({ remote: { ...remote, state: { ...remote.state, cycleQueued: true } } }).reasons.includes("runtime-cycle-state"), "A queued tick must reject reconciliation.");
assert(remoteCheck({ remote: { ...remote, state: { ...remote.state, cycleRunning: true } } }).reasons.includes("runtime-cycle-state"), "A running cycle must reject reconciliation.");
assert(remoteCheck({ remote: { ...remote, config: { ...remote.config, configFingerprint: digest("e") } } }).reasons.includes("configuration-fingerprint"), "A fingerprint mismatch must reject reconciliation.");
assert(remoteCheck({ samples: [sample, { ...sample, activeTracking: "776" }] }).reasons.includes("unstable-boundary"), "Count drift must reject reconciliation.");
assert(remoteCheck({ writers: [writer, { unexpectedActiveClients: "1", openTransactions: "0" }] }).reasons.includes("writer-state"), "An active writer must reject reconciliation.");

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-pause-reconcile-"));
  const statePath = path.join(scratch, "reconciliation.json");
  try {
    const journal = new PauseReconciliationState(statePath, () => "2026-08-04T10:00:00.000Z");
    const before = { ok: true, boundaryDigest: boundaryDigest([sample, sample], [writer, writer]), semanticDigest: digest("f") };
    const events = [];
    const result = await runPauseReconciliation({
      preflight: async () => before,
      generation: async () => "9007199254740994",
      prepare: async ({ generation }) => { journal.begin({ generation, boundaryDigest: before.boundaryDigest, semanticDigest: before.semanticDigest }); events.push("prepared"); },
      persistLocal: async () => { journal.transition(PHASES.LOCAL_PERSISTED); events.push("local"); },
      publishPause: async () => events.push("pause"),
      markRemotePublished: async () => { journal.transition(PHASES.REMOTE_PUBLISHED); events.push("remote"); },
      waitQuiescent: async () => events.push("quiescent"),
      postflight: async () => ({ ...before }),
      complete: async () => journal.complete(),
      recover: async (code) => journal.recover(code)
    });
    assert.equal(result.ok, true);
    assert.deepEqual(events, ["prepared", "local", "pause", "remote", "quiescent"]);
    assert.equal(journal.status().active, false);

    const interrupted = new PauseReconciliationState(path.join(scratch, "interrupted.json"));
    interrupted.begin({ generation: "8", boundaryDigest: before.boundaryDigest, semanticDigest: before.semanticDigest });
    interrupted.transition(PHASES.LOCAL_PERSISTED);
    const restarted = new PauseReconciliationState(path.join(scratch, "interrupted.json"));
    assert.equal(restarted.startupHold().active, true, "Restart during reconciliation must retain a fail-closed startup hold.");
    const maintenance = createMigrationMaintenance({ statePath: path.join(scratch, "maintenance.json"), journalActive: () => false, externalHold: () => restarted.startupHold() });
    assert.equal(maintenance.startupPolicy().allowServerStartHook, false, "Reconciliation recovery must suppress normal startup automation.");
    assert.throws(() => maintenance.beginProvisional("ENTER MIGRATION MAINTENANCE"), /external fail-closed/, "Maintenance entry must remain blocked until reconciliation completes.");

    restarted.recover("interrupted");
    const retried = restarted.begin({ generation: "9", boundaryDigest: before.boundaryDigest, semanticDigest: before.semanticDigest });
    assert.equal(retried.attempt, 2, "A durable recovery may be retried idempotently with a fresh generation.");
    assert.throws(() => restarted.begin({ generation: "10", boundaryDigest: digest("1"), semanticDigest: before.semanticDigest }), /boundary_drift/, "Retry must reject count or digest drift.");

    let recovered = false;
    await assert.rejects(() => runPauseReconciliation({
      preflight: async () => before,
      generation: async () => "11",
      prepare: async () => {},
      persistLocal: async () => {},
      publishPause: async () => { throw Object.assign(new Error("queued cycle"), { code: "queued_cycle" }); },
      markRemotePublished: async () => {}, waitQuiescent: async () => {}, postflight: async () => before, complete: async () => {},
      recover: async () => { recovered = true; }
    }), /queued cycle/);
    assert.equal(recovered, true, "Pause failure after durable preparation must enter recovery before releasing the operation lock.");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("Market Bot pause reconciliation classification, state-machine, drift, collision, quiescence, and restart-recovery tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
