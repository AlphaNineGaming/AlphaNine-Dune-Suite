"use strict";

class MaintenanceBootstrapError extends Error {
  constructor(message, stage, cause = null) {
    super(message);
    this.name = "MaintenanceBootstrapError";
    this.code = "maintenance_bootstrap";
    this.stage = stage;
    this.cause = cause || undefined;
  }
}

async function runMaintenanceBootstrap(steps = {}) {
  const required = ["preflight", "beginProvisional", "checkpoint", "deployRemote", "verifyRemote", "markRemoteGuarded", "revalidate", "finalize", "recover"];
  for (const name of required) if (typeof steps[name] !== "function") throw new TypeError(`Maintenance bootstrap step ${name} is required.`);
  const history = [];
  const record = (stage, status, detail = "") => {
    const row = { stage, status, detail: String(detail || "") };
    history.push(row);
    if (typeof steps.onStage === "function") steps.onStage(row, history.slice());
  };
  let checkpoint = null;
  let stage = "Initial read-only preflight";
  try {
    record(stage, "running");
    const before = await steps.preflight();
    if (!before?.ok) throw new Error(before?.error || "Maintenance bootstrap preflight failed closed.");
    if (!/^[a-f0-9]{64}$/.test(String(before.evidenceDigest || ""))) throw new Error("Preflight evidence digest is missing or invalid.");
    record(stage, "passed", "Offline, writer, operation, count, and digest gates passed.");

    stage = "Persist provisional local hold";
    record(stage, "running");
    await steps.beginProvisional();
    checkpoint = await steps.checkpoint("provisional");
    record(stage, "passed", "Local and recovery holds agree.");

    stage = "Deploy VM scheduler guard and sentinel";
    record(stage, "running");
    await steps.deployRemote(checkpoint);
    await steps.verifyRemote(checkpoint);
    record(stage, "passed", "VM generation and hold digest agree.");

    stage = "Persist remote-guarded hold";
    record(stage, "running");
    await steps.markRemoteGuarded(checkpoint);
    checkpoint = await steps.checkpoint("remote-guarded");
    await steps.verifyRemote(checkpoint);
    record(stage, "passed", "Local, recovery, and VM evidence agree.");

    stage = "Revalidate offline and quiescent evidence";
    record(stage, "running");
    const after = await steps.revalidate();
    if (!after?.ok) throw new Error(after?.error || "Maintenance bootstrap revalidation failed closed.");
    if (String(after.evidenceDigest || "") !== String(before.evidenceDigest || "")) throw new Error("Counts or canonical digests changed during maintenance bootstrap.");
    await steps.verifyRemote(checkpoint);
    record(stage, "passed", "Preflight evidence remained stable.");

    stage = "Finalize active maintenance hold";
    record(stage, "running");
    const finalState = await steps.finalize(checkpoint);
    const finalCheckpoint = await steps.checkpoint("active");
    await steps.verifyRemote(finalCheckpoint);
    record(stage, "passed", "Active maintenance state is durable and remotely guarded.");
    return { ok: true, history, before, after, state: finalState, checkpoint: finalCheckpoint };
  } catch (cause) {
    record(stage, "failed", cause?.message || String(cause));
    if (checkpoint) {
      try {
        const recovery = await steps.recover(checkpoint, cause);
        record("Retain fail-closed recovery hold", "passed", "Normal startup remains blocked pending review.");
        const error = new MaintenanceBootstrapError(cause?.message || String(cause), stage, cause);
        error.history = history;
        error.recovery = recovery;
        throw error;
      } catch (recoveryError) {
        if (recoveryError instanceof MaintenanceBootstrapError) throw recoveryError;
        record("Retain fail-closed recovery hold", "failed", recoveryError?.message || String(recoveryError));
      }
    }
    const error = new MaintenanceBootstrapError(cause?.message || String(cause), stage, cause);
    error.history = history;
    throw error;
  }
}

async function runMaintenanceBootstrapRecovery(steps = {}) {
  const required = ["preflight", "recoveryCheckpoint", "checkpoint", "deployRemote", "verifyRemote", "markRemoteGuarded", "revalidate", "finalize", "recover"];
  for (const name of required) if (typeof steps[name] !== "function") throw new TypeError(`Maintenance bootstrap recovery step ${name} is required.`);
  const history = [];
  const record = (stage, status, detail = "") => {
    const row = { stage, status, detail: String(detail || "") };
    history.push(row);
    if (typeof steps.onStage === "function") steps.onStage(row, history.slice());
  };
  let checkpoint = null;
  let stage = "Recovery read-only preflight";
  try {
    record(stage, "running");
    const before = await steps.preflight();
    if (!before?.ok) throw new Error(before?.error || "Maintenance recovery preflight failed closed.");
    if (!/^[a-f0-9]{64}$/.test(String(before.evidenceDigest || ""))) throw new Error("Recovery preflight evidence digest is missing or invalid.");
    record(stage, "passed", "Offline, writer, operation, count, and digest gates passed.");

    stage = "Resume fail-closed recovery hold";
    record(stage, "running");
    checkpoint = await steps.recoveryCheckpoint();
    if (!checkpoint || checkpoint.phase !== "recovery") throw new Error("The exact recovery checkpoint is unavailable.");
    record(stage, "passed", "Existing recovery generation and digest were retained.");

    stage = "Deploy VM scheduler guard and sentinel";
    record(stage, "running");
    await steps.deployRemote(checkpoint);
    await steps.verifyRemote(checkpoint);
    record(stage, "passed", "VM generation, hold digest, and artifact hashes agree.");

    stage = "Persist remote-guarded hold";
    record(stage, "running");
    await steps.markRemoteGuarded(checkpoint);
    checkpoint = await steps.checkpoint("remote-guarded");
    await steps.verifyRemote(checkpoint);
    record(stage, "passed", "Local, recovery, and VM evidence agree.");

    stage = "Revalidate offline and quiescent evidence";
    record(stage, "running");
    const after = await steps.revalidate();
    if (!after?.ok) throw new Error(after?.error || "Maintenance recovery revalidation failed closed.");
    if (String(after.evidenceDigest || "") !== String(before.evidenceDigest || "")) throw new Error("Counts or canonical digests changed during maintenance recovery.");
    await steps.verifyRemote(checkpoint);
    record(stage, "passed", "Preflight evidence remained stable.");

    stage = "Finalize active maintenance hold";
    record(stage, "running");
    const finalState = await steps.finalize(checkpoint);
    const finalCheckpoint = await steps.checkpoint("active");
    await steps.verifyRemote(finalCheckpoint);
    record(stage, "passed", "Active maintenance state is durable and remotely guarded.");
    return { ok: true, history, before, after, state: finalState, checkpoint: finalCheckpoint, resumedRecovery: true };
  } catch (cause) {
    record(stage, "failed", cause?.message || String(cause));
    if (checkpoint) {
      try {
        const recovery = await steps.recover(checkpoint, cause);
        record("Retain fail-closed recovery hold", "passed", "The same maintenance generation remains blocked pending review.");
        const error = new MaintenanceBootstrapError(cause?.message || String(cause), stage, cause);
        error.history = history;
        error.recovery = recovery;
        throw error;
      } catch (recoveryError) {
        if (recoveryError instanceof MaintenanceBootstrapError) throw recoveryError;
        record("Retain fail-closed recovery hold", "failed", recoveryError?.message || String(recoveryError));
      }
    }
    const error = new MaintenanceBootstrapError(cause?.message || String(cause), stage, cause);
    error.history = history;
    throw error;
  }
}

module.exports = { MaintenanceBootstrapError, runMaintenanceBootstrap, runMaintenanceBootstrapRecovery };
