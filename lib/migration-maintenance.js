"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const ENTER_CONFIRMATION = "ENTER MIGRATION MAINTENANCE";
const EXIT_CONFIRMATION = "EXIT MIGRATION MAINTENANCE";
const CANCEL_RECOVERY_CONFIRMATION = "CANCEL LOCAL MAINTENANCE RECOVERY";
const BANNER = "Migration Maintenance Mode — Game Server Held Offline";
const PHASES = Object.freeze({
  INACTIVE: "inactive",
  PROVISIONAL: "provisional",
  REMOTE_GUARDED: "remote-guarded",
  ACTIVE: "active",
  RECOVERY: "recovery",
  CANCELLED: "cancelled"
});
const ACTIVE_JOURNAL_KEYS = Object.freeze([
  "migration:export",
  "migration:import",
  "database:backup",
  "database:import",
  "market-bot:clean",
  "maintenance:bootstrap"
]);

class MigrationMaintenanceError extends Error {
  constructor(message, code = "migration_maintenance_required") {
    super(message);
    this.name = "MigrationMaintenanceError";
    this.code = code;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestState(state) {
  return crypto.createHash("sha256").update(canonical(state), "utf8").digest("hex");
}

function maintenanceHoldDigest(state) {
  return digestState({
    version: STATE_VERSION,
    active: true,
    generation: String(state.generation || ""),
    enteredAt: String(state.enteredAt || "")
  });
}

function validIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Maintenance state is not an object.");
  const allowed = new Set(["version", "active", "generation", "enteredAt", "updatedAt", "phase", "holdDigest"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Maintenance state contains an unknown field.");
  if (input.version !== STATE_VERSION) throw new Error("Maintenance state version is unsupported.");
  if (typeof input.active !== "boolean") throw new Error("Maintenance state active flag is ambiguous.");
  if (!/^[1-9]\d*$/.test(String(input.generation || ""))) throw new Error("Maintenance generation is invalid.");
  if (!validIsoTimestamp(input.updatedAt)) throw new Error("Maintenance update timestamp is invalid.");
  if (input.active && !validIsoTimestamp(input.enteredAt)) throw new Error("Active maintenance state has no valid entry timestamp.");
  if (!input.active && input.enteredAt !== "") throw new Error("Inactive maintenance state has an ambiguous entry timestamp.");
  const phase = String(input.phase || (input.active ? PHASES.ACTIVE : PHASES.INACTIVE));
  if (input.active && !new Set([PHASES.PROVISIONAL, PHASES.REMOTE_GUARDED, PHASES.ACTIVE, PHASES.RECOVERY]).has(phase)) {
    throw new Error("Active maintenance phase is invalid.");
  }
  if (!input.active && !new Set([PHASES.INACTIVE, PHASES.CANCELLED]).has(phase)) throw new Error("Inactive maintenance phase is ambiguous.");
  const computedHoldDigest = input.active ? maintenanceHoldDigest(input) : "";
  if (input.holdDigest != null && String(input.holdDigest) !== computedHoldDigest) throw new Error("Maintenance hold digest is invalid.");
  return {
    version: STATE_VERSION,
    active: input.active,
    generation: String(input.generation),
    enteredAt: String(input.enteredAt || ""),
    updatedAt: String(input.updatedAt),
    phase,
    holdDigest: computedHoldDigest
  };
}

function readOperationJournal(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const operations = Array.isArray(parsed.operations) ? parsed.operations : [];
    return operations.some((operation) => {
      const key = String(operation?.key || "");
      const status = String(operation?.status || "");
      return (status === "pending" || status === "running")
        && ACTIVE_JOURNAL_KEYS.some((prefix) => key === prefix || key.startsWith(`${prefix}:`));
    });
  } catch (error) {
    return error && error.code === "ENOENT" ? false : true;
  }
}

function writeFileDurably(filePath, bytes) {
  const handle = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, bytes, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

class MigrationMaintenance {
  constructor(options = {}) {
    this.statePath = path.resolve(options.statePath || "migration-maintenance.json");
    this.backupPath = `${this.statePath}.previous`;
    this.cancelledJournalPath = `${this.statePath}.cancelled.json`;
    this.sideEffectFree = options.sideEffectFree === true;
    this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
    this.journalActive = typeof options.journalActive === "function" ? options.journalActive : () => false;
    this.externalHold = typeof options.externalHold === "function" ? options.externalHold : () => ({ active: false });
    this.startupState = this.load({ recoverMissingJournal: true });
  }

  readCandidate(filePath) {
    try {
      return { kind: "valid", state: validateState(JSON.parse(fs.readFileSync(filePath, "utf8"))) };
    } catch (error) {
      if (error && error.code === "ENOENT") return { kind: "missing", error: "Maintenance state is missing." };
      return { kind: "invalid", error: "Maintenance state is malformed or unreadable." };
    }
  }

  load(options = {}) {
    if (this.sideEffectFree) {
      return this.publicState({ active: true, generation: "runner", phase: PHASES.RECOVERY, holdDigest: "", failClosed: true, source: "side-effect-free-runner", error: "Side-effect-free runner blocks workload mutations." });
    }
    if (options.ignoreExternalHold !== true) {
      let external;
      try { external = this.externalHold(); }
      catch { external = { active: true, source: "external-recovery", error: "An external fail-closed hold is unreadable." }; }
      if (external?.active === true) {
        return this.publicState({
          active: true,
          generation: "recovery",
          enteredAt: "",
          updatedAt: "",
          phase: PHASES.RECOVERY,
          holdDigest: "",
          failClosed: true,
          source: String(external.source || "external-recovery"),
          error: String(external.error || "An external fail-closed hold requires local review.")
        });
      }
    }
    const primary = this.readCandidate(this.statePath);
    const backup = this.readCandidate(this.backupPath);
    const journalActive = this.journalActive() === true;
    const valid = [primary, backup].filter((entry) => entry.kind === "valid").map((entry) => entry.state);
    if (valid.length === 2 && canonical(valid[0]) !== canonical(valid[1])) {
      return this.publicState({ active: true, generation: "ambiguous", failClosed: true, source: "ambiguous-state", error: "Persisted maintenance copies disagree." });
    }
    if (primary.kind === "valid" && backup.kind === "valid") {
      const incomplete = primary.state.active && primary.state.phase !== PHASES.ACTIVE;
      return this.publicState({ ...primary.state, failClosed: incomplete, source: incomplete ? "bootstrap-recovery" : "persisted", error: incomplete ? "Maintenance bootstrap did not reach an active terminal state." : "" });
    }
    if (primary.kind === "valid" && backup.kind === "missing" && !primary.state.active) {
      return this.publicState({ ...primary.state, failClosed: false, source: "persisted", error: "" });
    }
    if (primary.kind === "valid" && backup.kind === "missing") {
      return this.publicState({ ...primary.state, failClosed: true, active: true, source: "missing-recovery-copy", error: "The active maintenance recovery copy is missing." });
    }
    if (primary.kind === "missing" && backup.kind === "valid") {
      return this.publicState({ ...backup.state, failClosed: true, active: true, source: "recovered-copy", error: "Primary maintenance state is missing; recovered fail-closed from the durable copy." });
    }
    if (primary.kind === "missing" && backup.kind === "missing" && !journalActive) {
      return this.publicState({ active: false, generation: "0", enteredAt: "", updatedAt: "", phase: PHASES.INACTIVE, holdDigest: "", failClosed: false, source: "default", error: "" });
    }
    if (primary.kind === "missing" && backup.kind === "missing" && journalActive && options.recoverMissingJournal) {
      const now = this.now();
      const recovered = { version: STATE_VERSION, active: true, generation: "1", enteredAt: now, updatedAt: now, phase: PHASES.RECOVERY };
      try {
        this.persist(recovered);
        return this.publicState({ ...recovered, failClosed: true, source: "journal-recovery", error: "An incomplete migration or backup journal restored maintenance mode." });
      } catch {
        return this.publicState({ active: true, generation: "recovery", enteredAt: "", updatedAt: "", failClosed: true, source: "journal-recovery", error: "Maintenance state is unavailable while an incomplete operation journal exists." });
      }
    }
    return this.publicState({ active: true, generation: "invalid", enteredAt: "", updatedAt: "", failClosed: true, source: journalActive ? "journal-recovery" : "invalid-state", error: "Persisted maintenance state is malformed, unreadable, or ambiguous." });
  }

  publicState(state) {
    return {
      active: state.active === true,
      effective: state.active === true,
      failClosed: state.failClosed === true,
      sideEffectFree: this.sideEffectFree,
      generation: String(state.generation || "0"),
      phase: String(state.phase || (state.active ? PHASES.RECOVERY : PHASES.INACTIVE)),
      holdDigest: String(state.holdDigest || ""),
      enteredAt: String(state.enteredAt || ""),
      updatedAt: String(state.updatedAt || ""),
      source: String(state.source || "persisted"),
      error: String(state.error || ""),
      banner: state.active === true ? BANNER : ""
    };
  }

  status() {
    return this.load();
  }

  persistedStatus() {
    return this.load({ ignoreExternalHold: true });
  }

  startupPolicy() {
    const state = this.status();
    return {
      maintenance: state,
      allowVmAndPostgresConnectivity: true,
      allowServerStartHook: !state.active && !state.sideEffectFree,
      allowBackgroundWriters: !state.active && !state.sideEffectFree
    };
  }

  persist(state) {
    const validated = validateState(state);
    const bytes = `${JSON.stringify(validated, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.partial-${crypto.randomUUID()}`;
    writeFileDurably(temporary, bytes);
    try {
      fs.renameSync(temporary, this.statePath);
      fs.copyFileSync(this.statePath, this.backupPath);
      const backupHandle = fs.openSync(this.backupPath, "r+");
      try { fs.fsyncSync(backupHandle); }
      finally { fs.closeSync(backupHandle); }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return validated;
  }

  nextGeneration(current) {
    const value = /^\d+$/.test(String(current || "")) ? BigInt(String(current)) : 0n;
    return (value + 1n).toString(10);
  }

  enter(confirmText) {
    if (this.sideEffectFree) throw new MigrationMaintenanceError("Side-effect-free runner state cannot be changed.", "side_effect_free");
    if (String(confirmText || "") !== ENTER_CONFIRMATION) throw new MigrationMaintenanceError(`Type ${ENTER_CONFIRMATION} exactly.`, "confirmation_required");
    const current = this.status();
    if (current.active && !current.failClosed && current.phase === PHASES.ACTIVE) return current;
    throw new MigrationMaintenanceError("First-time maintenance entry requires the local --maintenance-bootstrap runner.", "maintenance_bootstrap_required");
  }

  beginProvisional(confirmText) {
    if (this.sideEffectFree) throw new MigrationMaintenanceError("Side-effect-free runner state cannot be changed.", "side_effect_free");
    if (String(confirmText || "") !== ENTER_CONFIRMATION) throw new MigrationMaintenanceError(`Type ${ENTER_CONFIRMATION} exactly.`, "confirmation_required");
    let external;
    try { external = this.externalHold(); }
    catch { external = { active: true }; }
    if (external?.active === true) throw new MigrationMaintenanceError("An external fail-closed recovery hold blocks maintenance bootstrap entry.", "maintenance_external_recovery");
    const primary = this.readCandidate(this.statePath);
    const backup = this.readCandidate(this.backupPath);
    const bothMissing = primary.kind === "missing" && backup.kind === "missing";
    const inactiveCopies = primary.kind === "valid" && backup.kind === "valid"
      && canonical(primary.state) === canonical(backup.state) && !primary.state.active;
    if (!bothMissing && !inactiveCopies) throw new MigrationMaintenanceError("An active or recovery maintenance hold already exists.", "maintenance_hold_exists");
    const generation = this.nextGeneration(inactiveCopies ? primary.state.generation : "0");
    const now = this.now();
    const saved = this.persist({ version: STATE_VERSION, active: true, generation, enteredAt: now, updatedAt: now, phase: PHASES.PROVISIONAL });
    return this.publicState({ ...saved, source: "bootstrap-provisional", failClosed: true, error: "Remote maintenance protection has not been verified yet." });
  }

  bootstrapCheckpoint(expectedPhase = "") {
    let primary;
    let backup;
    try {
      primary = validateState(JSON.parse(fs.readFileSync(this.statePath, "utf8")));
      backup = validateState(JSON.parse(fs.readFileSync(this.backupPath, "utf8")));
    } catch {
      throw new MigrationMaintenanceError("Maintenance state or its recovery copy is unreadable.", "maintenance_bootstrap_state_invalid");
    }
    if (canonical(primary) !== canonical(backup) || !primary.active || (expectedPhase && primary.phase !== expectedPhase)) {
      throw new MigrationMaintenanceError("Local and recovery maintenance evidence is missing, ambiguous, or inconsistent.", "maintenance_bootstrap_state_invalid");
    }
    return { version: STATE_VERSION, generation: primary.generation, holdDigest: primary.holdDigest, enteredAt: primary.enteredAt, phase: primary.phase };
  }

  recoveryCheckpoint(confirmText) {
    if (this.sideEffectFree) throw new MigrationMaintenanceError("Side-effect-free runner state cannot be changed.", "side_effect_free");
    if (String(confirmText || "") !== ENTER_CONFIRMATION) throw new MigrationMaintenanceError(`Type ${ENTER_CONFIRMATION} exactly.`, "confirmation_required");
    const checkpoint = this.bootstrapCheckpoint(PHASES.RECOVERY);
    const status = this.status();
    if (!status.active || !status.failClosed || status.generation !== checkpoint.generation || status.holdDigest !== checkpoint.holdDigest) {
      throw new MigrationMaintenanceError("Maintenance recovery evidence is missing, ambiguous, or inconsistent.", "maintenance_bootstrap_state_invalid");
    }
    return checkpoint;
  }

  transitionBootstrap(checkpoint, phase) {
    if (!new Set([PHASES.REMOTE_GUARDED, PHASES.ACTIVE, PHASES.RECOVERY]).has(phase)) throw new MigrationMaintenanceError("Invalid maintenance bootstrap transition.", "maintenance_bootstrap_transition_invalid");
    const current = this.bootstrapCheckpoint();
    if (!checkpoint || current.generation !== String(checkpoint.generation || "") || current.holdDigest !== String(checkpoint.holdDigest || "")) {
      throw new MigrationMaintenanceError("Maintenance bootstrap identity changed unexpectedly.", "maintenance_bootstrap_state_changed");
    }
    const now = this.now();
    const saved = this.persist({ version: STATE_VERSION, active: true, generation: current.generation, enteredAt: current.enteredAt, updatedAt: now, phase });
    return this.publicState({ ...saved, source: phase === PHASES.ACTIVE ? "persisted" : "bootstrap-recovery", failClosed: phase !== PHASES.ACTIVE, error: phase === PHASES.ACTIVE ? "" : "Maintenance bootstrap requires review." });
  }

  retainBootstrapRecovery(checkpoint) {
    const recovered = this.transitionBootstrap(checkpoint, PHASES.RECOVERY);
    this.bootstrapCheckpoint(PHASES.RECOVERY);
    return recovered;
  }

  cancelLocalRecovery(confirmText, proof = {}) {
    if (this.sideEffectFree) throw new MigrationMaintenanceError("Side-effect-free runner state cannot be changed.", "side_effect_free");
    if (String(confirmText || "") !== CANCEL_RECOVERY_CONFIRMATION) throw new MigrationMaintenanceError(`Type ${CANCEL_RECOVERY_CONFIRMATION} exactly.`, "confirmation_required");
    const checkpoint = this.bootstrapCheckpoint(PHASES.RECOVERY);
    const required = ["remoteSentinelAbsent", "remoteSchedulerGuardAbsent", "remoteTemporaryArtifactsAbsent"];
    if (required.some((key) => proof[key] !== true) || !validIsoTimestamp(String(proof.verifiedAt || ""))) {
      throw new MigrationMaintenanceError("Cancellation requires fresh read-only proof that no remote maintenance artifact exists.", "maintenance_cancellation_proof_required");
    }
    const now = this.now();
    const journalBody = {
      version: STATE_VERSION,
      status: PHASES.CANCELLED,
      generation: checkpoint.generation,
      holdDigest: checkpoint.holdDigest,
      enteredAt: checkpoint.enteredAt,
      cancelledAt: now,
      proof: {
        remoteSentinelAbsent: true,
        remoteSchedulerGuardAbsent: true,
        remoteTemporaryArtifactsAbsent: true,
        verifiedAt: String(proof.verifiedAt)
      }
    };
    const journal = { ...journalBody, cancellationDigest: digestState(journalBody) };
    fs.mkdirSync(path.dirname(this.cancelledJournalPath), { recursive: true });
    const temporary = `${this.cancelledJournalPath}.partial-${crypto.randomUUID()}`;
    writeFileDurably(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    try { fs.renameSync(temporary, this.cancelledJournalPath); }
    finally { fs.rmSync(temporary, { force: true }); }
    const saved = this.persist({ version: STATE_VERSION, active: false, generation: checkpoint.generation, enteredAt: "", updatedAt: now, phase: PHASES.CANCELLED });
    return { ...this.publicState({ ...saved, source: "cancelled", failClosed: false, error: "" }), cancellationJournal: journal };
  }

  exit(confirmText, options = {}) {
    if (this.sideEffectFree) throw new MigrationMaintenanceError("Side-effect-free runner state cannot be changed.", "side_effect_free");
    if (String(confirmText || "") !== EXIT_CONFIRMATION) throw new MigrationMaintenanceError(`Type ${EXIT_CONFIRMATION} exactly.`, "confirmation_required");
    const current = this.status();
    if (current.failClosed) throw new MigrationMaintenanceError("Fail-closed maintenance recovery must be reviewed and repaired before exit.", "maintenance_recovery_required");
    if (this.journalActive() || options.activeWorkflow === true) throw new MigrationMaintenanceError("An active or interrupted migration workflow must be reviewed before exiting maintenance mode.", "maintenance_workflow_active");
    const now = this.now();
    const saved = this.persist({ version: STATE_VERSION, active: false, generation: this.nextGeneration(current.generation), enteredAt: "", updatedAt: now, phase: PHASES.INACTIVE });
    return this.publicState({ ...saved, source: "persisted", failClosed: false, error: "" });
  }

  assertWorkloadStartAllowed(action = "start the game server") {
    const state = this.status();
    if (state.active) throw new MigrationMaintenanceError(`${BANNER}. Exit maintenance mode locally before attempting to ${action}.`, this.sideEffectFree ? "side_effect_free" : "maintenance_active");
    return state;
  }

  assertWorkflowActive(workflow) {
    const state = this.status();
    if (this.sideEffectFree) throw new MigrationMaintenanceError(`Side-effect-free runner cannot execute ${workflow}.`, "side_effect_free");
    if (!state.active || state.failClosed || state.phase !== PHASES.ACTIVE) throw new MigrationMaintenanceError(`${workflow} requires a healthy, explicitly entered Migration Maintenance Mode.`, "migration_maintenance_required");
    return state;
  }

  captureCheckpoint(workflow) {
    const state = this.assertWorkflowActive(workflow);
    const persisted = validateState(JSON.parse(fs.readFileSync(this.statePath, "utf8")));
    return { version: STATE_VERSION, workflow: String(workflow || "migration-workflow"), generation: persisted.generation, holdDigest: persisted.holdDigest, digest: digestState(persisted) };
  }

  verifyCheckpoint(checkpoint, stage = "operation checkpoint") {
    if (!checkpoint || checkpoint.version !== STATE_VERSION || !/^[1-9]\d*$/.test(String(checkpoint.generation || "")) || !/^[a-f0-9]{64}$/.test(String(checkpoint.holdDigest || "")) || !/^[a-f0-9]{64}$/.test(String(checkpoint.digest || ""))) {
      throw new MigrationMaintenanceError(`Maintenance evidence is missing or invalid at ${stage}.`, "maintenance_checkpoint_invalid");
    }
    this.assertWorkflowActive(checkpoint.workflow || "migration workflow");
    let persisted;
    try { persisted = validateState(JSON.parse(fs.readFileSync(this.statePath, "utf8"))); }
    catch { throw new MigrationMaintenanceError(`Maintenance state became unreadable at ${stage}; the operation was aborted.`, "maintenance_checkpoint_changed"); }
    if (!persisted.active || persisted.generation !== checkpoint.generation || persisted.holdDigest !== checkpoint.holdDigest || digestState(persisted) !== checkpoint.digest) {
      throw new MigrationMaintenanceError(`Migration Maintenance Mode changed at ${stage}; the operation was aborted.`, "maintenance_checkpoint_changed");
    }
    return this.publicState({ ...persisted, source: "persisted", failClosed: false, error: "" });
  }
}

function createMigrationMaintenance(options) {
  return new MigrationMaintenance(options);
}

module.exports = {
  ACTIVE_JOURNAL_KEYS,
  BANNER,
  CANCEL_RECOVERY_CONFIRMATION,
  ENTER_CONFIRMATION,
  EXIT_CONFIRMATION,
  PHASES,
  MigrationMaintenance,
  MigrationMaintenanceError,
  createMigrationMaintenance,
  digestState,
  maintenanceHoldDigest,
  readOperationJournal,
  validateState
};
