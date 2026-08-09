"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { strictJsonParse } = require("./market-bot-evidence");
const { stableStringify } = require("./market-bot-verification");

const CONFIRMATION = "RECONCILE PAUSED MARKET BOT STATE";
const STATE_VERSION = 1;
const PHASES = Object.freeze({
  PREPARED: "prepared",
  LOCAL_PERSISTED: "local-persisted",
  REMOTE_PUBLISHED: "remote-published",
  RECOVERY: "recovery",
  COMPLETE: "complete"
});

class MarketBotReconciliationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MarketBotReconciliationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarketBotReconciliationError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function canonicalGeneration(value, label = "generation") {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(text)) fail("market_bot_reconciliation_generation", `${label} must be a canonical decimal string.`);
  return text;
}

function nextGeneration(...values) {
  let highest = 0n;
  for (const value of values) {
    const text = canonicalGeneration(value ?? "0");
    const candidate = BigInt(text);
    if (candidate > highest) highest = candidate;
  }
  return (highest + 1n).toString(10);
}

function assertNewGeneration(candidate, ...existingValues) {
  const generation = canonicalGeneration(candidate);
  if (existingValues.some((value) => BigInt(generation) <= BigInt(canonicalGeneration(value ?? "0")))) {
    fail("market_bot_reconciliation_generation_collision", "The new pause generation must be greater than every persisted generation.");
  }
  return generation;
}

function semanticConfigView(config = {}) {
  return {
    activation: {
      enabled: config.enabled,
      paused: config.paused,
      activated: config.activated
    },
    target: {
      battlegroup: String(config.battlegroup ?? ""),
      namespace: String(config.namespace ?? ""),
      dbPod: String(config.dbPod ?? ""),
      dbService: String(config.dbService ?? ""),
      exchangeName: String(config.exchangeName ?? "")
    },
    policy: {
      economyStyle: config.economyStyle,
      listingCategory: String(config.listingCategory ?? ""),
      intervalMinutes: config.intervalMinutes,
      expiryDays: config.expiryDays,
      safety: config.safety,
      items: config.items
    }
  };
}

function semanticDifferenceCategories(localRuntime, remoteRuntime) {
  const local = semanticConfigView(localRuntime);
  const remote = semanticConfigView(remoteRuntime);
  return Object.keys(local).filter((category) => stableStringify(local[category]) !== stableStringify(remote[category]));
}

function classifyLocalState(rawText, normalized = {}) {
  if (rawText === null || rawText === undefined) return { classification: "legacy-incompatible", code: "market_bot_reconciliation_local_missing_current_evidence" };
  let raw;
  try { raw = strictJsonParse(String(rawText)); }
  catch { return { classification: "malformed-current", code: "market_bot_reconciliation_local_malformed" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { classification: "malformed-current", code: "market_bot_reconciliation_local_malformed" };
  const fingerprint = raw.runtimeFingerprint;
  if (fingerprint !== undefined && fingerprint !== "" && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) {
    return { classification: "malformed-current", code: "market_bot_reconciliation_local_malformed_fingerprint" };
  }
  const generationFields = [raw.configGeneration, raw.pauseGeneration].filter((value) => value !== undefined);
  if (generationFields.some((value) => typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))) {
    return { classification: "malformed-current", code: "market_bot_reconciliation_local_malformed_generation" };
  }
  const current = Number(raw.schemaVersion || 0) >= 2 && /^[a-f0-9]{64}$/.test(String(fingerprint || ""))
    && typeof raw.configGeneration === "string" && typeof raw.pauseGeneration === "string";
  if (current) return { classification: "current", code: "market_bot_reconciliation_local_current", normalized };
  return { classification: "legacy-incompatible", code: "market_bot_reconciliation_local_legacy", normalized };
}

function boundaryView(samples = [], writers = []) {
  return {
    samples: samples.map((sample) => ({
      advisoryLocks: String(sample.advisoryLocks),
      incompleteCycles: String(sample.incompleteCycles),
      cycleEvidenceRows: String(sample.cycleEvidenceRows),
      cycleEvidenceDigest: String(sample.cycleEvidenceDigest),
      activeTracking: String(sample.activeTracking),
      totalTracking: String(sample.totalTracking),
      protectedOrders: String(sample.protectedOrders),
      protectedSellOrders: String(sample.protectedSellOrders),
      protectedItems: String(sample.protectedItems),
      fulfilledPayments: String(sample.fulfilledPayments),
      invalidBotTracking: String(sample.invalidBotTracking),
      invalidProtected: String(sample.invalidProtected),
      protectedDigest: String(sample.protectedDigest),
      botOwnedDigest: String(sample.botOwnedDigest)
    })),
    writers: writers.map((writer) => ({
      unexpectedActiveClients: String(writer.unexpectedActiveClients),
      openTransactions: String(writer.openTransactions)
    }))
  };
}

function boundaryDigest(samples, writers) {
  return sha256(boundaryView(samples, writers));
}

function validateRemoteQuiescence({ remote = {}, samples = [], writers = [], expectedVersion = "", expectedConfigFingerprint = "", expectedBinaryHash = "", remoteBinaryHash = "" } = {}) {
  const reasons = [];
  const config = remote.config || {};
  const state = remote.state || {};
  if (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 2) reasons.push("remote-schema");
  if (!/^[a-f0-9]{64}$/.test(String(config.configFingerprint || ""))) reasons.push("configuration-fingerprint");
  if (expectedConfigFingerprint && String(config.configFingerprint || "") !== expectedConfigFingerprint) reasons.push("configuration-fingerprint");
  if (expectedVersion && (String(config.runtimeVersion || "") !== expectedVersion || String(state.installedVersion || "") !== expectedVersion)) reasons.push("runtime-version");
  if (!/^[a-f0-9]{64}$/.test(String(remoteBinaryHash || "")) || remoteBinaryHash !== expectedBinaryHash) reasons.push("runtime-binary");
  if (config.paused !== true || config.pauseState !== "Pause requested") reasons.push("remote-pause-configuration");
  if (state.status !== "Quiescent" || state.pauseState !== "Quiescent") reasons.push("runtime-state");
  const generations = [config.configGeneration, config.pauseGeneration, state.configGeneration, state.pauseGeneration].map(String);
  if (generations.some((value) => !/^(?:0|[1-9]\d*)$/.test(value)) || new Set(generations).size !== 1) reasons.push("remote-generation");
  if (state.cycleQueued !== false || state.cycleRunning !== false || state.incompleteCycle !== false) reasons.push("runtime-cycle-state");
  if (samples.length !== 2 || stableStringify(boundaryView([samples[0] || {}], [])) !== stableStringify(boundaryView([samples[1] || {}], []))) reasons.push("unstable-boundary");
  for (const sample of samples) {
    if (String(sample.advisoryLocks) !== "0") reasons.push("advisory-lock");
    if (String(sample.incompleteCycles) !== "0") reasons.push("incomplete-cycle");
    if (String(sample.invalidBotTracking) !== "0" || String(sample.invalidProtected) !== "0") reasons.push("relational-invalidity");
  }
  if (writers.length !== 2 || writers.some((writer) => String(writer.unexpectedActiveClients) !== "0" || String(writer.openTransactions) !== "0")) reasons.push("writer-state");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], generation: generations[0] || "0" };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("market_bot_reconciliation_state", "Reconciliation state must be an object.");
  const expected = ["version", "active", "phase", "generation", "boundaryDigest", "semanticDigest", "attempt", "createdAt", "updatedAt", "errorCode"];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) fail("market_bot_reconciliation_state", "Reconciliation state contains missing or unknown fields.");
  if (value.version !== STATE_VERSION || typeof value.active !== "boolean" || !Object.values(PHASES).includes(value.phase)) fail("market_bot_reconciliation_state", "Reconciliation state version or phase is invalid.");
  canonicalGeneration(value.generation);
  if (!/^[a-f0-9]{64}$/.test(value.boundaryDigest) || !/^[a-f0-9]{64}$/.test(value.semanticDigest)) fail("market_bot_reconciliation_state", "Reconciliation state digests are invalid.");
  if (!Number.isInteger(value.attempt) || value.attempt < 1) fail("market_bot_reconciliation_state", "Reconciliation attempt is invalid.");
  for (const field of ["createdAt", "updatedAt", "errorCode"]) if (typeof value[field] !== "string") fail("market_bot_reconciliation_state", `Reconciliation ${field} must be a string.`);
  return { ...value };
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${crypto.randomUUID()}`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  try { fs.renameSync(temporary, filePath); }
  finally { fs.rmSync(temporary, { force: true }); }
}

class PauseReconciliationState {
  constructor(statePath, now = () => new Date().toISOString()) {
    this.statePath = path.resolve(statePath);
    this.recoveryPath = `${this.statePath}.previous`;
    this.now = now;
  }

  read(filePath) {
    try { return { kind: "valid", value: validateState(strictJsonParse(fs.readFileSync(filePath, "utf8"))) }; }
    catch (error) { return { kind: error?.code === "ENOENT" ? "missing" : "invalid" }; }
  }

  status() {
    const primary = this.read(this.statePath);
    const recovery = this.read(this.recoveryPath);
    if (primary.kind === "missing" && recovery.kind === "missing") return { active: false, phase: "inactive", failClosed: false, generation: "0", boundaryDigest: "", semanticDigest: "", attempt: 0 };
    if (primary.kind !== "valid" || recovery.kind !== "valid" || stableStringify(primary.value) !== stableStringify(recovery.value)) {
      return { active: true, phase: PHASES.RECOVERY, failClosed: true, generation: "unknown", boundaryDigest: "", semanticDigest: "", attempt: 0, errorCode: "market_bot_reconciliation_state_ambiguous" };
    }
    return { ...primary.value, failClosed: primary.value.active === true };
  }

  persist(value) {
    const state = validateState(value);
    atomicWrite(this.statePath, state);
    fs.copyFileSync(this.statePath, this.recoveryPath);
    const handle = fs.openSync(this.recoveryPath, "r+");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    return state;
  }

  begin({ generation, boundaryDigest: beforeBoundary, semanticDigest: beforeSemantic }) {
    const previous = this.status();
    if (previous.active && !beforeBoundary) fail("market_bot_reconciliation_recovery", "A prior reconciliation requires review.");
    if (previous.active && previous.boundaryDigest && previous.boundaryDigest !== beforeBoundary) fail("market_bot_reconciliation_boundary_drift", "The Exchange boundary changed after an interrupted reconciliation.");
    const next = canonicalGeneration(generation);
    if (previous.attempt > 0 && /^\d+$/.test(String(previous.generation || ""))) assertNewGeneration(next, previous.generation);
    const now = this.now();
    return this.persist({
      version: STATE_VERSION,
      active: true,
      phase: PHASES.PREPARED,
      generation: next,
      boundaryDigest: beforeBoundary,
      semanticDigest: beforeSemantic,
      attempt: Number(previous.attempt || 0) + 1,
      createdAt: previous.createdAt || now,
      updatedAt: now,
      errorCode: ""
    });
  }

  transition(phase, errorCode = "") {
    const current = this.status();
    if (!current.active || !Object.values(PHASES).includes(phase) || phase === PHASES.COMPLETE) fail("market_bot_reconciliation_transition", "Reconciliation transition is invalid.");
    const { failClosed: _failClosed, ...stored } = current;
    return this.persist({ ...stored, version: STATE_VERSION, phase, updatedAt: this.now(), errorCode: String(errorCode || "") });
  }

  recover(errorCode) {
    return this.transition(PHASES.RECOVERY, String(errorCode || "market_bot_reconciliation_failed"));
  }

  complete() {
    const current = this.status();
    if (!current.active) fail("market_bot_reconciliation_transition", "No active reconciliation can be completed.");
    const { failClosed: _failClosed, ...stored } = current;
    return this.persist({ ...stored, version: STATE_VERSION, active: false, phase: PHASES.COMPLETE, updatedAt: this.now(), errorCode: "" });
  }

  startupHold() {
    const state = this.status();
    return state.active ? { active: true, source: "market-bot-pause-reconciliation", error: "Market Bot pause reconciliation is incomplete and requires local review." } : { active: false };
  }
}

async function runPauseReconciliation(steps = {}) {
  const required = ["preflight", "generation", "prepare", "persistLocal", "publishPause", "markRemotePublished", "waitQuiescent", "postflight", "complete", "recover"];
  for (const name of required) if (typeof steps[name] !== "function") throw new TypeError(`Pause reconciliation step ${name} is required.`);
  let prepared = false;
  let stage = "preflight";
  try {
    const before = await steps.preflight();
    if (!before?.ok) fail("market_bot_reconciliation_preflight", before?.error || "Pause reconciliation preflight failed.");
    const generation = await steps.generation(before);
    stage = "prepared";
    await steps.prepare({ before, generation });
    prepared = true;
    stage = "local-persisted";
    await steps.persistLocal({ before, generation });
    stage = "remote-published";
    await steps.publishPause({ before, generation });
    await steps.markRemotePublished({ before, generation });
    stage = "quiescent";
    await steps.waitQuiescent({ before, generation });
    stage = "postflight";
    const after = await steps.postflight({ before, generation });
    if (!after?.ok) fail("market_bot_reconciliation_postflight", after?.error || "Pause reconciliation postflight failed closed.");
    if (after.boundaryDigest !== before.boundaryDigest) fail("market_bot_reconciliation_boundary_drift", "Counts or canonical digests changed during reconciliation.");
    stage = "complete";
    await steps.complete({ before, after, generation });
    return { ok: true, before, after, generation };
  } catch (error) {
    if (prepared) await steps.recover(error.code || "market_bot_reconciliation_failed", stage);
    error.reconciliationStage = stage;
    throw error;
  }
}

module.exports = {
  CONFIRMATION,
  PHASES,
  MarketBotReconciliationError,
  canonicalGeneration,
  nextGeneration,
  assertNewGeneration,
  semanticConfigView,
  semanticDifferenceCategories,
  classifyLocalState,
  boundaryView,
  boundaryDigest,
  validateRemoteQuiescence,
  PauseReconciliationState,
  runPauseReconciliation
};
