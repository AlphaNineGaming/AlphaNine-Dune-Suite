"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { stableStringify } = require("./market-bot-verification");

const CONFIRMATION = "RECONCILE LOCAL MARKET BOT EVIDENCE";
const STATE_VERSION = 1;
const EXPECTED = Object.freeze({
  offlineGeneration: "1",
  remoteGeneration: "6",
  configFingerprint: "5477bea78e106f495bbdf8fb67af887c3801791a0b2efa2f585b3d3432e746e8",
  runtimeBinarySha256: "68d09137a68ba6098f879d4f66409bda622a76750805515104d6517e19e1fef3",
  catalogItemCount: "2131",
  catalogFingerprint: "2eca833dfdf94e63128ffe76f9ba42bbd267ba48240e7ad7ee17b153d8947cce"
});
const PHASES = Object.freeze({
  PREPARED: "prepared",
  LOCAL_PERSISTED: "local-persisted",
  VERIFIED: "verified",
  RECOVERY: "recovery",
  COMPLETE: "complete"
});

class OfflineMarketBotReconciliationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "OfflineMarketBotReconciliationError";
    this.code = code;
  }
}

function fail(code, message) { throw new OfflineMarketBotReconciliationError(code, message); }
function digest(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function digestFile(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function validDigest(value, allowEmpty = false) { return (allowEmpty && value === "") || /^[a-f0-9]{64}$/.test(String(value || "")); }
function canonicalDecimal(value, label) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)$/.test(text)) fail("offline_market_bot_reconciliation_identity", `${label} must be a canonical decimal string.`);
  return text;
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("offline_market_bot_reconciliation_state", "Reconciliation state must be an object.");
  const expectedKeys = [
    "version", "active", "phase", "attempt", "offlineGeneration", "offlineDigest", "remoteGeneration",
    "remoteFingerprint", "catalogItemCount", "catalogFingerprint", "boundaryDigest", "semanticDigest",
    "localBeforeSha256", "localAfterSha256", "createdAt", "updatedAt", "errorCode"
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail("offline_market_bot_reconciliation_state", "Reconciliation state contains missing or unknown fields.");
  }
  if (value.version !== STATE_VERSION || typeof value.active !== "boolean" || !Object.values(PHASES).includes(value.phase)) {
    fail("offline_market_bot_reconciliation_state", "Reconciliation state version or phase is invalid.");
  }
  if (!Number.isInteger(value.attempt) || value.attempt < 1) fail("offline_market_bot_reconciliation_state", "Reconciliation attempt is invalid.");
  canonicalDecimal(value.offlineGeneration, "Offline generation");
  canonicalDecimal(value.remoteGeneration, "Remote generation");
  canonicalDecimal(value.catalogItemCount, "Catalog item count");
  for (const field of ["offlineDigest", "remoteFingerprint", "catalogFingerprint", "boundaryDigest", "semanticDigest", "localBeforeSha256"]) {
    if (!validDigest(value[field])) fail("offline_market_bot_reconciliation_state", `${field} is invalid.`);
  }
  if (!validDigest(value.localAfterSha256, true)) fail("offline_market_bot_reconciliation_state", "localAfterSha256 is invalid.");
  for (const field of ["createdAt", "updatedAt", "errorCode"]) if (typeof value[field] !== "string") fail("offline_market_bot_reconciliation_state", `${field} must be a string.`);
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

function stateIdentity(value = {}) {
  return {
    offlineGeneration: String(value.offlineGeneration || ""),
    offlineDigest: String(value.offlineDigest || ""),
    remoteGeneration: String(value.remoteGeneration || ""),
    remoteFingerprint: String(value.remoteFingerprint || ""),
    catalogItemCount: String(value.catalogItemCount || ""),
    catalogFingerprint: String(value.catalogFingerprint || ""),
    boundaryDigest: String(value.boundaryDigest || ""),
    semanticDigest: String(value.semanticDigest || "")
  };
}

class OfflineMarketBotReconciliationState {
  constructor(statePath, now = () => new Date().toISOString()) {
    this.statePath = path.resolve(statePath);
    this.recoveryPath = `${this.statePath}.previous`;
    this.now = now;
  }

  read(filePath) {
    try { return { kind: "valid", value: validateState(JSON.parse(fs.readFileSync(filePath, "utf8"))) }; }
    catch (error) { return { kind: error?.code === "ENOENT" ? "missing" : "invalid" }; }
  }

  status() {
    const primary = this.read(this.statePath);
    const recovery = this.read(this.recoveryPath);
    if (primary.kind === "missing" && recovery.kind === "missing") return { active: false, failClosed: false, phase: "inactive", attempt: 0 };
    if (primary.kind !== "valid" || recovery.kind !== "valid" || stableStringify(primary.value) !== stableStringify(recovery.value)) {
      return { active: true, failClosed: true, phase: PHASES.RECOVERY, attempt: 0, errorCode: "offline_market_bot_reconciliation_state_ambiguous" };
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

  begin(input) {
    const identity = stateIdentity(input);
    const previous = this.status();
    if (previous.active) {
      if (previous.attempt < 1 || stableStringify(stateIdentity(previous)) !== stableStringify(identity)) {
        fail("offline_market_bot_reconciliation_drift", "Recovery evidence does not match the current Offline Mode, remote policy, or database boundary.");
      }
      return previous;
    }
    const now = this.now();
    return this.persist({
      version: STATE_VERSION,
      active: true,
      phase: PHASES.PREPARED,
      attempt: Number(previous.attempt || 0) + 1,
      ...identity,
      localBeforeSha256: String(input.localBeforeSha256 || ""),
      localAfterSha256: "",
      createdAt: now,
      updatedAt: now,
      errorCode: ""
    });
  }

  transition(phase, changes = {}) {
    const current = this.status();
    if (!current.active || !Object.values(PHASES).includes(phase) || phase === PHASES.COMPLETE) fail("offline_market_bot_reconciliation_transition", "Reconciliation transition is invalid.");
    const { failClosed: _failClosed, ...stored } = current;
    return this.persist({ ...stored, ...changes, version: STATE_VERSION, phase, updatedAt: this.now() });
  }

  markLocalPersisted(localAfterSha256) {
    if (!validDigest(localAfterSha256)) fail("offline_market_bot_reconciliation_local_digest", "The reconciled local evidence digest is invalid.");
    return this.transition(PHASES.LOCAL_PERSISTED, { localAfterSha256, errorCode: "" });
  }

  markVerified() { return this.transition(PHASES.VERIFIED, { errorCode: "" }); }
  recover(errorCode) { return this.transition(PHASES.RECOVERY, { errorCode: String(errorCode || "offline_market_bot_reconciliation_failed") }); }

  complete() {
    const current = this.status();
    if (!current.active || !validDigest(current.localAfterSha256)) fail("offline_market_bot_reconciliation_transition", "Verified local evidence is unavailable.");
    const { failClosed: _failClosed, ...stored } = current;
    return this.persist({ ...stored, version: STATE_VERSION, active: false, phase: PHASES.COMPLETE, updatedAt: this.now(), errorCode: "" });
  }
}

function changedTopLevelFields(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => stableStringify(before?.[key]) !== stableStringify(after?.[key])).sort();
}

function assertAllowedLocalEvidenceUpdate(before, after) {
  const changed = changedTopLevelFields(before, after);
  const allowed = new Set(["pauseState", "configGeneration", "pauseGeneration", "runtimeFingerprint", "catalogPolicy", "updatedAt"]);
  const forbidden = changed.filter((field) => !allowed.has(field));
  if (forbidden.length) fail("offline_market_bot_reconciliation_scope", `Local reconciliation would change forbidden configuration categories: ${forbidden.join(", ")}.`);
  return { changed, evidenceFields: changed.filter((field) => field !== "updatedAt") };
}

function assertIdentityStable(before, after) {
  if (stableStringify(stateIdentity(before)) !== stableStringify(stateIdentity(after))) {
    fail("offline_market_bot_reconciliation_drift", "Offline Mode, remote policy, or database boundary evidence changed during reconciliation.");
  }
}

async function runOfflineMarketBotReconciliation(steps = {}) {
  const required = ["preflight", "prepare", "verifyCheckpoint", "persistLocal", "markLocalPersisted", "postflight", "markVerified", "complete", "recover"];
  for (const name of required) if (typeof steps[name] !== "function") throw new TypeError(`Offline Market Bot reconciliation step ${name} is required.`);
  let prepared = false;
  let stage = "preflight";
  try {
    const before = await steps.preflight();
    if (!before?.ok) fail("offline_market_bot_reconciliation_preflight", before?.error || "Local Market Bot evidence reconciliation preflight failed.");
    stage = "prepared";
    await steps.prepare(before);
    prepared = true;
    await steps.verifyCheckpoint(before.offlineCheckpoint, "before local Market Bot evidence update");
    stage = "local-persisted";
    const local = await steps.persistLocal(before);
    await steps.markLocalPersisted(local.sha256);
    await steps.verifyCheckpoint(before.offlineCheckpoint, "after local Market Bot evidence update");
    stage = "postflight";
    const after = await steps.postflight(before, local);
    if (!after?.ok) fail("offline_market_bot_reconciliation_postflight", after?.error || "Local Market Bot evidence revalidation failed.");
    assertIdentityStable(before, after);
    if (String(after.localCurrentSha256 || "") !== String(local.sha256 || "")) fail("offline_market_bot_reconciliation_local_drift", "The reconciled local evidence changed during verification.");
    await steps.verifyCheckpoint(before.offlineCheckpoint, "after local Market Bot evidence revalidation");
    stage = "verified";
    await steps.markVerified(after);
    stage = "complete";
    await steps.complete(after);
    return { ok: true, before, after, local };
  } catch (error) {
    if (prepared) await steps.recover(error.code || "offline_market_bot_reconciliation_failed", stage);
    error.reconciliationStage = stage;
    throw error;
  }
}

module.exports = {
  CONFIRMATION,
  EXPECTED,
  PHASES,
  OfflineMarketBotReconciliationError,
  OfflineMarketBotReconciliationState,
  assertAllowedLocalEvidenceUpdate,
  assertIdentityStable,
  changedTopLevelFields,
  digest,
  digestFile,
  runOfflineMarketBotReconciliation,
  stateIdentity,
  validateState
};
