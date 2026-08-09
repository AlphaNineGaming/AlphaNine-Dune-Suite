"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const ENTER_CONFIRMATION = "ENTER MIGRATION OFFLINE MODE";
const EXIT_CONFIRMATION = "EXIT MIGRATION OFFLINE MODE";
const BANNER = "Migration Offline Mode — Automatic Startup and Writers Disabled";

class MigrationOfflineError extends Error {
  constructor(message, code = "migration_offline_required") {
    super(message);
    this.name = "MigrationOfflineError";
    this.code = code;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function validIso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.endsWith("Z"); }

function stateDigest(state) {
  return sha256(canonical({ version: STATE_VERSION, active: state.active, generation: String(state.generation), enteredAt: String(state.enteredAt || "") }));
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Offline state is not an object.");
  const keys = Object.keys(value).sort();
  const expected = ["active", "digest", "enteredAt", "generation", "updatedAt", "version"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Offline state fields are invalid.");
  if (value.version !== STATE_VERSION || typeof value.active !== "boolean" || !/^[1-9]\d*$/.test(String(value.generation || "")) || !validIso(value.updatedAt)) throw new Error("Offline state is invalid.");
  if ((value.active && !validIso(value.enteredAt)) || (!value.active && value.enteredAt !== "")) throw new Error("Offline entry timestamp is invalid.");
  const normalized = { version: STATE_VERSION, active: value.active, generation: String(value.generation), enteredAt: String(value.enteredAt), updatedAt: String(value.updatedAt), digest: "" };
  normalized.digest = stateDigest(normalized);
  if (value.digest !== normalized.digest) throw new Error("Offline state digest is invalid.");
  return normalized;
}

function durableAtomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${crypto.randomUUID()}`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(handle, bytes, "utf8"); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  try { fs.renameSync(temporary, filePath); } finally { fs.rmSync(temporary, { force: true }); }
}

class MigrationOfflineMode {
  constructor(options = {}) {
    this.statePath = path.resolve(options.statePath || "migration-offline-mode.json");
    this.recoveryPath = `${this.statePath}.previous`;
    this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
    this.journalActive = typeof options.journalActive === "function" ? options.journalActive : () => false;
    this.sideEffectFree = options.sideEffectFree === true;
    this.startupState = this.load();
  }

  read(filePath) {
    try { return { kind: "valid", state: validateState(JSON.parse(fs.readFileSync(filePath, "utf8"))) }; }
    catch (error) { return error?.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" }; }
  }

  publicState(state) {
    return { active: state.active === true, failClosed: state.failClosed === true, generation: String(state.generation || "0"), digest: String(state.digest || ""), enteredAt: String(state.enteredAt || ""), updatedAt: String(state.updatedAt || ""), source: String(state.source || "persisted"), error: String(state.error || ""), banner: state.active ? BANNER : "" };
  }

  load() {
    if (this.sideEffectFree) return this.publicState({ active: true, failClosed: true, generation: "runner", source: "side-effect-free", error: "Diagnostic runner blocks automatic startup and writers." });
    const primary = this.read(this.statePath);
    const recovery = this.read(this.recoveryPath);
    const journal = this.journalActive() === true;
    if (primary.kind === "valid" && recovery.kind === "valid" && canonical(primary.state) === canonical(recovery.state)) return this.publicState({ ...primary.state, source: "persisted" });
    if (primary.kind === "missing" && recovery.kind === "missing" && !journal) return this.publicState({ active: false, generation: "0", source: "default" });
    if (primary.kind === "valid" && recovery.kind === "missing" && !primary.state.active && !journal) return this.publicState({ ...primary.state, source: "persisted" });
    return this.publicState({ active: true, failClosed: true, generation: "ambiguous", source: "recovery", error: "Migration Offline Mode state is missing, malformed, or inconsistent while safety evidence exists." });
  }

  status() { return this.load(); }
  nextGeneration(value) { return (BigInt(/^\d+$/.test(String(value || "")) ? String(value) : "0") + 1n).toString(10); }

  persist(input) {
    const base = { version: STATE_VERSION, active: input.active === true, generation: String(input.generation), enteredAt: String(input.enteredAt || ""), updatedAt: String(input.updatedAt), digest: "" };
    base.digest = stateDigest(base);
    const state = validateState(base);
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    durableAtomicWrite(this.statePath, bytes);
    fs.copyFileSync(this.statePath, this.recoveryPath);
    const handle = fs.openSync(this.recoveryPath, "r+");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    return state;
  }

  enter(confirmText, localRequest = true) {
    if (this.sideEffectFree) throw new MigrationOfflineError("Diagnostic runner state cannot be changed.", "side_effect_free");
    if (!localRequest) throw new MigrationOfflineError("Migration Offline Mode can only be entered from the local Suite.", "local_only");
    if (String(confirmText || "") !== ENTER_CONFIRMATION) throw new MigrationOfflineError(`Type ${ENTER_CONFIRMATION} exactly.`, "confirmation_required");
    const current = this.status();
    if (current.active && !current.failClosed) return current;
    if (current.failClosed) throw new MigrationOfflineError("Offline-mode recovery evidence requires review.", "migration_offline_recovery");
    const now = this.now();
    return this.publicState({ ...this.persist({ active: true, generation: this.nextGeneration(current.generation), enteredAt: now, updatedAt: now }), source: "persisted" });
  }

  exit(confirmText, options = {}) {
    if (this.sideEffectFree) throw new MigrationOfflineError("Diagnostic runner state cannot be changed.", "side_effect_free");
    if (options.localRequest !== true) throw new MigrationOfflineError("Migration Offline Mode can only be exited from the local Suite.", "local_only");
    if (String(confirmText || "") !== EXIT_CONFIRMATION) throw new MigrationOfflineError(`Type ${EXIT_CONFIRMATION} exactly.`, "confirmation_required");
    const current = this.status();
    if (current.failClosed || this.journalActive() || options.activeWorkflow === true) throw new MigrationOfflineError("An active or interrupted migration workflow must be reviewed before exiting Offline Mode.", "migration_offline_workflow_active");
    const now = this.now();
    return this.publicState({ ...this.persist({ active: false, generation: this.nextGeneration(current.generation), enteredAt: "", updatedAt: now }), source: "persisted" });
  }

  startupPolicy() {
    const state = this.status();
    return { offline: state, allowVmAndPostgresConnectivity: true, allowServerStartHook: !state.active, allowBackgroundWriters: !state.active };
  }

  assertWorkloadStartAllowed(action = "start workloads") {
    const state = this.status();
    if (state.active) throw new MigrationOfflineError(`${BANNER}. Exit Offline Mode locally before attempting to ${action}.`, state.failClosed ? "migration_offline_recovery" : "migration_offline_active");
    return state;
  }

  assertActive(workflow) {
    const state = this.status();
    if (!state.active || state.failClosed || !/^\d+$/.test(state.generation)) throw new MigrationOfflineError(`${workflow} requires explicitly entered, healthy Migration Offline Mode.`, "migration_offline_required");
    return state;
  }

  captureCheckpoint(workflow) {
    const state = this.assertActive(workflow);
    return { version: STATE_VERSION, workflow: String(workflow), generation: state.generation, digest: state.digest };
  }

  verifyCheckpoint(checkpoint, stage = "operation checkpoint") {
    if (!checkpoint || checkpoint.version !== STATE_VERSION || !/^[1-9]\d*$/.test(String(checkpoint.generation || "")) || !/^[a-f0-9]{64}$/.test(String(checkpoint.digest || ""))) throw new MigrationOfflineError(`Offline-mode evidence is invalid at ${stage}.`, "migration_offline_checkpoint_invalid");
    const state = this.assertActive(checkpoint.workflow || "migration workflow");
    if (state.generation !== checkpoint.generation || state.digest !== checkpoint.digest) throw new MigrationOfflineError(`Migration Offline Mode changed at ${stage}; the operation was aborted.`, "migration_offline_checkpoint_changed");
    return state;
  }
}

module.exports = { BANNER, ENTER_CONFIRMATION, EXIT_CONFIRMATION, MigrationOfflineError, MigrationOfflineMode, STATE_VERSION, createMigrationOfflineMode: (options) => new MigrationOfflineMode(options), stateDigest, validateState };
