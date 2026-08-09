"use strict";

const assert = require("assert/strict");
const {
  SAFETY_MODES,
  assertMigrationSafetyCheckpoint,
  evaluateMigrationMarketBotSafety
} = require("../lib/market-bot-migration-safety");

function service(overrides = {}) {
  return {
    version: 3,
    serviceManager: "openrc",
    serviceState: "stopped",
    serviceInstalled: true,
    runtimeInstalled: true,
    serviceAuthoritative: true,
    statusExit: "3",
    pidFilePresent: false,
    matchingProcessCount: "0",
    supervisorProcessCount: "0",
    defaultRunlevelRegistered: false,
    restartPathActive: false,
    ...overrides
  };
}

const stopped = evaluateMigrationMarketBotSafety({ serviceSamples: [service(), service()] });
assert.equal(stopped.ok, true);
assert.equal(stopped.mode, SAFETY_MODES.SERVICE_STOPPED);
assert.deepEqual(stopped.verificationEvidence, {
  version: 2, mode: "service-stopped", serviceInstalled: true, runtimeInstalled: true,
  matchingProcessCount: "0", supervisorProcessCount: "0"
});

const absentSample = service({ serviceManager: "none", serviceState: "absent", serviceInstalled: false, runtimeInstalled: false, statusExit: "not-installed" });
const absent = evaluateMigrationMarketBotSafety({ serviceSamples: [absentSample, absentSample], requireAbsent: true });
assert.equal(absent.mode, SAFETY_MODES.SERVICE_ABSENT);

for (const unsafe of [
  service({ serviceState: "started", serviceAuthoritative: false, matchingProcessCount: "1", restartPathActive: true }),
  service({ pidFilePresent: true }),
  service({ matchingProcessCount: "1" }),
  service({ supervisorProcessCount: "1", restartPathActive: true }),
  service({ defaultRunlevelRegistered: true, restartPathActive: true }),
  service({ serviceState: "unknown", serviceAuthoritative: false })
]) assert.throws(() => evaluateMigrationMarketBotSafety({ serviceSamples: [unsafe, unsafe] }), /active|ambiguous|infrastructure/i);

assert.throws(() => evaluateMigrationMarketBotSafety({ serviceSamples: [service(), service({ runtimeInstalled: false })] }), /changed between bounded samples/);
assert.throws(() => evaluateMigrationMarketBotSafety({ serviceSamples: [service()] }), /Exactly two/);
assert.equal(evaluateMigrationMarketBotSafety({ serviceSamples: [absentSample, absentSample], requireAbsent: true, generation: "6" }).mode, SAFETY_MODES.SERVICE_ABSENT, "unused generation input cannot affect infrastructure-only safety");

assert.equal(assertMigrationSafetyCheckpoint(stopped.checkpoint, { ...stopped.checkpoint }, "before dump"), true);
assert.throws(() => assertMigrationSafetyCheckpoint(stopped.checkpoint, { ...stopped.checkpoint, matchingProcessCount: "1" }, "after dump"), /changed/);

const source = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "market-bot-migration-safety.js"), "utf8");
assert.doesNotMatch(source, /generation|Quiescent|catalog|fingerprint|historical|incompleteCycle/i, "migration safety must not reconstruct portable policy from Market Bot runtime metadata");

console.log("Market Bot migration stopped-or-absent infrastructure-only safety and drift tests passed.");
