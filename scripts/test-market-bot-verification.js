"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PAUSE_STATES,
  MARKET_BOT_MIGRATION_SAMPLE_SQL,
  normalizeGeneration,
  nextGeneration,
  sha256Canonical,
  decimalId,
  classifyProtectedOrder,
  canonicalProtectedOrders,
  evaluateAuthoritativeQuiescence
} = require("../lib/market-bot-verification");
const {
  EVIDENCE_VERSION,
  MarketBotEvidenceError,
  inspectTransportStructure,
  parseDatabaseEnvelope,
  parseSingleObject,
  buildEvidenceEnvelope,
  validateEvidenceEnvelope,
  evaluationInput
} = require("../lib/market-bot-evidence");

const generation = "900719925474099312345678901234567890";
const runtimeFingerprint = "c".repeat(64);
const localConfig = { schemaVersion: 2, paused: true, pauseState: PAUSE_STATES.REQUESTED, configGeneration: generation, pauseGeneration: generation, runtimeFingerprint };
const remote = {
  config: { schemaVersion: 2, runtimeVersion: "1.0.84", paused: true, pauseState: PAUSE_STATES.REQUESTED, configGeneration: generation, pauseGeneration: generation, configFingerprint: runtimeFingerprint },
  state: {
    installedVersion: "1.0.84",
    status: PAUSE_STATES.QUIESCENT,
    pauseState: PAUSE_STATES.QUIESCENT,
    configGeneration: generation,
    pauseGeneration: generation,
    cycleQueued: false,
    cycleRunning: false,
    incompleteCycle: false,
    lastRunAt: null,
    nextRunAt: "2026-08-04T09:00:00Z",
    updatedAt: "2026-08-04T08:59:59.123456Z"
  }
};
const sample = {
  advisoryLocks: "0",
  incompleteCycles: "0",
  activeTracking: "775",
  cycleEvidenceRows: "0",
  cycleEvidenceDigest: "0".repeat(64),
  totalTracking: "1675",
  protectedOrders: "41",
  protectedSellOrders: "40",
  protectedItems: "40",
  fulfilledPayments: "1",
  invalidBotTracking: "0",
  invalidProtected: "0",
  protectedDigest: "a".repeat(64),
  botOwnedDigest: "b".repeat(64)
};
const writerSample = { unexpectedActiveClients: "0", openTransactions: "0" };
const writers = [writerSample, { ...writerSample }];

function databasePayload(value = sample) {
  return JSON.stringify({ version: EVIDENCE_VERSION, sample: value });
}

function evidenceFailure(callback, code) {
  assert.throws(callback, (error) => error instanceof MarketBotEvidenceError && error.code === code, `Expected ${code}`);
}

assert.equal(normalizeGeneration("00042"), "42");
assert.equal(nextGeneration(generation), "900719925474099312345678901234567891");
assert.equal(decimalId("9223372036854775807"), "9223372036854775807");
assert.throws(() => decimalId(Number.MAX_SAFE_INTEGER + 1), /decimal string/);

{
  const largeSample = { ...sample, totalTracking: "900719925474099312345678901234567890", incompleteCycles: "0" };
  const parsed = parseDatabaseEnvelope({ stdout: ` \r\n${databasePayload(largeSample)}\n `, stderr: "NOTICE: sanitized diagnostic warning\n" });
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sample.totalTracking, largeSample.totalTracking, "bigint evidence must remain an exact decimal string");
  assert.equal(parsed.sample.incompleteCycles, "0", "an empty cycle-evidence table must be represented explicitly as zero");
  assert.equal(parsed.diagnostics.stderrPresent, true, "stderr warnings must remain separate from JSON stdout");
  assert.equal(parsed.diagnostics.firstToken, "json-object");
}

{
  const structure = inspectTransportStructure({ stdout: `SET\n${databasePayload()}`, stderr: "" });
  assert.equal(structure.firstToken, "command-status");
  assert.equal(structure.nonEmptyLineCount, 2);
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: `SET\n${databasePayload()}`, stderr: "" }), "market_bot_evidence_non_json_prefix");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: databasePayload().slice(0, -5), stderr: "" }), "market_bot_evidence_truncated");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: `${databasePayload()}\n${databasePayload()}`, stderr: "" }), "market_bot_evidence_duplicate_envelope");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: `{"version":1,"version":1,"sample":${JSON.stringify(sample)}}`, stderr: "" }), "market_bot_evidence_duplicate_field");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: JSON.stringify({ version: 1 }), stderr: "" }), "market_bot_evidence_fields");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: JSON.stringify({ version: 2, sample }), stderr: "" }), "market_bot_evidence_version");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: databasePayload({ ...sample, unexpectedCritical: "0" }), stderr: "" }), "market_bot_evidence_fields");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: databasePayload({ ...sample, protectedDigest: "bad" }), stderr: "" }), "market_bot_evidence_digest");
  evidenceFailure(() => parseDatabaseEnvelope({ stdout: databasePayload({ ...sample, totalTracking: Number.MAX_SAFE_INTEGER + 1 }), stderr: "" }), "market_bot_evidence_decimal");
  assert.deepEqual(parseSingleObject({ stdout: `\n${JSON.stringify({ ok: true })}\n`, stderr: "warning" }).value, { ok: true });
  evidenceFailure(() => parseSingleObject({ stdout: `${JSON.stringify({ ok: true })}\n${JSON.stringify({ ok: true })}`, stderr: "" }), "market_bot_evidence_duplicate_envelope");
}

{
  const envelope = buildEvidenceEnvelope({ localConfig, remote, samples: [sample, { ...sample }], writers });
  const validated = validateEvidenceEnvelope(structuredClone(envelope));
  assert.equal(validated.runtime.lastRunAt, null, "optional runtime timestamps may be null");
  const input = evaluationInput(structuredClone(envelope));
  assert.equal(evaluateAuthoritativeQuiescence(input).ok, true);

  const unknownVersion = structuredClone(envelope);
  unknownVersion.version = 2;
  evidenceFailure(() => validateEvidenceEnvelope(unknownVersion), "market_bot_evidence_version");
  const malformedFingerprint = structuredClone(envelope);
  malformedFingerprint.runtime.runtimeFingerprint = "bad";
  evidenceFailure(() => validateEvidenceEnvelope(malformedFingerprint), "market_bot_evidence_digest");
  const absentLocalFingerprint = structuredClone(envelope);
  absentLocalFingerprint.localConfiguration.runtimeFingerprint = "";
  evidenceFailure(() => validateEvidenceEnvelope(absentLocalFingerprint), "market_bot_evidence_local_legacy_incompatible");
  const missingLocal = buildEvidenceEnvelope({ localConfig: { ...localConfig, evidencePersisted: false }, remote, samples: [sample, sample], writers });
  evidenceFailure(() => validateEvidenceEnvelope(missingLocal), "market_bot_evidence_local_missing");
  const unreadableLocal = buildEvidenceEnvelope({ localConfig: { ...localConfig, loadError: "sanitized" }, remote, samples: [sample, sample], writers });
  evidenceFailure(() => validateEvidenceEnvelope(unreadableLocal), "market_bot_evidence_local_unreadable");
  const runtimeDisagreement = structuredClone(envelope);
  runtimeDisagreement.runtime.runtimeFingerprint = "d".repeat(64);
  evidenceFailure(() => evaluationInput(runtimeDisagreement), "market_bot_evidence_runtime_disagreement");
  const legacy = structuredClone(envelope);
  legacy.remoteConfiguration.schemaVersion = 1;
  evidenceFailure(() => validateEvidenceEnvelope(legacy), "market_bot_evidence_legacy_incompatible");
  const missing = structuredClone(envelope);
  delete missing.runtime.cycleQueued;
  evidenceFailure(() => validateEvidenceEnvelope(missing), "market_bot_evidence_fields");
}

{
  const result = evaluateAuthoritativeQuiescence({ localConfig, remote, samples: [sample, { ...sample }], writers });
  assert.equal(result.ok, true, result.reasons.join(" "));
  assert.equal(result.state, PAUSE_STATES.QUIESCENT);
}

{
  const committing = structuredClone(remote);
  committing.state.status = PAUSE_STATES.DRAINING;
  committing.state.pauseState = PAUSE_STATES.DRAINING;
  committing.state.cycleRunning = true;
  committing.state.incompleteCycle = true;
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote: committing, samples: [sample, sample], writers }).ok, false,
    "pause requested during a committing cycle must remain draining");
}

{
  const queued = structuredClone(remote);
  queued.state.status = PAUSE_STATES.DRAINING;
  queued.state.pauseState = PAUSE_STATES.DRAINING;
  queued.state.cycleQueued = true;
  queued.state.incompleteCycle = true;
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote: queued, samples: [sample, sample], writers }).ok, false,
    "a queued tick after pause must block quiescence");
}

{
  const restarted = structuredClone(remote);
  restarted.state.status = PAUSE_STATES.UNKNOWN;
  restarted.state.pauseState = PAUSE_STATES.UNKNOWN;
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote: restarted, samples: [sample, sample], writers }).ok, false,
    "restart without recovered authoritative state must fail closed");
  const stale = structuredClone(remote);
  stale.config.paused = false;
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote: stale, samples: [sample, sample], writers }).ok, false,
    "stale local versus remote pause state must fail closed");
  const mismatch = structuredClone(remote);
  mismatch.state.pauseGeneration = (BigInt(generation) - 1n).toString(10);
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote: mismatch, samples: [sample, sample], writers }).ok, false,
    "pause generation mismatch must fail closed");
  const conflictingConfig = structuredClone(remote);
  conflictingConfig.config.configFingerprint = "d".repeat(64);
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote: conflictingConfig, samples: [sample, sample], writers }).ok, false,
    "conflicting persisted configuration must fail closed");
}

{
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote, samples: [{ ...sample, advisoryLocks: "1" }, sample], writers }).ok, false);
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote, samples: [{ ...sample, incompleteCycles: "1" }, sample], writers }).ok, false);
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote, samples: [{ ...sample, invalidBotTracking: "1" }, sample], writers }).ok, false);
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote, samples: [sample, { ...sample, activeTracking: "776" }], writers }).ok, false,
    "unstable counts must fail closed");
  assert.equal(evaluateAuthoritativeQuiescence({ localConfig, remote, samples: [sample, sample], writers: [writerSample, { ...writerSample, openTransactions: "1" }] }).ok, false);
}

const sell = {
  orderId: "9223372036854775806",
  itemId: "9223372036854775700",
  order: { templateId: "Quoted \"Blade\"" },
  sellOrder: { initialStackSize: "1" },
  item: { templateId: "Quoted \"Blade\"" }
};
const payment = {
  orderId: "9223372036854775807",
  itemId: null,
  order: { isNpcOrder: false },
  fulfilledOrder: { completionType: "4", originalOrderId: "9223372036854775000" }
};
assert.deepEqual(classifyProtectedOrder(sell), { subtype: "sell", valid: true });
assert.deepEqual(classifyProtectedOrder(payment), { subtype: "fulfilled-payment", valid: true });
assert.deepEqual(classifyProtectedOrder({ ...sell, item: null }), { subtype: "invalid", valid: false });
assert.deepEqual(classifyProtectedOrder({ ...sell, fulfilledOrder: payment.fulfilledOrder }), { subtype: "invalid", valid: false });

{
  const first = canonicalProtectedOrders([payment, sell]);
  const second = canonicalProtectedOrders([structuredClone(sell), structuredClone(payment)]);
  assert.equal(sha256Canonical(first), sha256Canonical(second), "canonical protected digest must be stable across sessions and row order");
  assert.equal(first[0].subtype, "sell");
  assert.equal(first[1].subtype, "fulfilled-payment");
}

assert.match(MARKET_BOT_MIGRATION_SAMPLE_SQL, /NOT EXISTS \(SELECT 1 FROM tracking t WHERE t\.order_id=o\.id\)/i,
  "protected boundary must be independent of active tracking state");
assert.match(MARKET_BOT_MIGRATION_SAMPLE_SQL, /fulfilled-payment/);
assert.match(MARKET_BOT_MIGRATION_SAMPLE_SQL, /invalidProtected/);
assert.match(MARKET_BOT_MIGRATION_SAMPLE_SQL, /^\s*WITH\s/i, "query stdout must not be prefixed by a SET command-status line");
assert.match(MARKET_BOT_MIGRATION_SAMPLE_SQL, /'version',1,\s*'sample',jsonb_build_object/i, "query must emit one versioned JSON envelope");
for (const volatile of ["ctid", "xmin", "pg_stat", "current_timestamp", "current_date", "'stats'"]) {
  assert(!MARKET_BOT_MIGRATION_SAMPLE_SQL.toLowerCase().includes(volatile), `canonical digest includes volatile field ${volatile}`);
}

const goSource = fs.readFileSync(path.join(__dirname, "..", "market-bot", "main.go"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert(goSource.includes('recordCycleEvidence(cfg, key, "queued")'));
assert(goSource.includes('recordCycleEvidence(cfg, key, "started")'));
assert(goSource.includes('finishCycleEvidence(cfg, key, "transaction_committed")'));
assert(goSource.includes('finishCycleEvidence(cfg, key, "failed")'));
assert(goSource.includes('recordCycleEvidence(cfg, key, "completed")'));
assert(goSource.includes("clock_timestamp()"), "cycle evidence must use real wall-clock timestamps");
assert(goSource.includes("latest.Paused || latest.ConfigGeneration != cfg.ConfigGeneration"), "queued ticks must recheck pause/config before starting");
assert(goSource.includes("ensurePauseMarker(p.pauseMarker)"), "pause request must persist a cycle-start barrier before config publication");
assert(goSource.includes("acquireCycleLease(p)"), "cycle start must be serialized against the pause marker");
assert(goSource.includes("proveRuntimeQuiescence"), "restart/drain recovery must establish fresh remote evidence");
assert(serverSource.includes('"market-bot-quiescent"'), "migration preflight must require authoritative Market Bot quiescence");
assert(serverSource.includes("MARKET_BOT_MIGRATION_SAMPLE_SQL"), "migration preflight must collect protected Exchange samples");

console.log("Market Bot pause/drain, cycle evidence, protected-order, stable digest, and migration-gate tests passed.");
