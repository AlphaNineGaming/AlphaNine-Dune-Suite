"use strict";

const DEFAULT_STALE_MS = 15000;
const PROGRESS_API_VERSION = "migration-progress-v1";

function iso(now = Date.now()) { return new Date(now).toISOString(); }

function initialize(job, now = Date.now()) {
  const at = iso(now);
  job.stageStartedAt ||= at;
  job.lastActivityAt ||= at;
  job.activity ||= null;
  return job;
}

function begin(job, stage, substep, options = {}) {
  const now = Number(options.now ?? Date.now());
  job.stage = String(stage || "Working");
  job.stageStartedAt = iso(now);
  job.lastActivityAt = job.stageStartedAt;
  job.activity = {
    mode: options.totalBytes === undefined ? "indeterminate" : "bytes",
    substep: String(substep || stage || "Working"),
    bytes: options.totalBytes === undefined ? null : "0",
    totalBytes: options.totalBytes === undefined ? null : String(options.totalBytes),
    percent: options.totalBytes === undefined ? null : 0
  };
  return job.activity;
}

function heartbeat(job, substep, options = {}) {
  initialize(job, Number(options.now ?? Date.now()));
  const now = Number(options.now ?? Date.now());
  job.lastActivityAt = iso(now);
  job.activity ||= { mode: "indeterminate", substep: "Working", bytes: null, totalBytes: null, percent: null };
  if (substep) job.activity.substep = String(substep);
  if (options.totalBytes !== undefined) bytes(job, options.bytes ?? 0, options.totalBytes, substep, { now });
  return job.activity;
}

function bytes(job, value, total, substep, options = {}) {
  const current = BigInt(String(value));
  const maximum = BigInt(String(total));
  if (current < 0n || maximum <= 0n || current > maximum) throw new Error("Migration job byte progress is invalid.");
  const now = Number(options.now ?? Date.now());
  job.lastActivityAt = iso(now);
  job.activity = {
    mode: "bytes",
    substep: String(substep || job.activity?.substep || job.stage || "Working"),
    bytes: current.toString(10),
    totalBytes: maximum.toString(10),
    percent: Number((current * 10000n) / maximum) / 100
  };
  return job.activity;
}

function publicView(job, options = {}) {
  initialize(job);
  const now = Number(options.now ?? Date.now());
  const staleMs = Number(options.staleMs ?? DEFAULT_STALE_MS);
  const terminal = ["success", "failed", "rolled-back"].includes(String(job.status));
  const elapsedMs = Math.max(0, now - Date.parse(job.stageStartedAt || job.startedAt || iso(now)));
  const inactivityMs = Math.max(0, now - Date.parse(job.lastActivityAt || job.stageStartedAt || iso(now)));
  const state = job.status === "success" ? "verified" : (job.status === "failed" || job.status === "rolled-back" ? "failed" : (inactivityMs > staleMs ? "stale" : "working"));
  return {
    state,
    terminal,
    stageStartedAt: job.stageStartedAt || "",
    lastActivityAt: job.lastActivityAt || "",
    elapsedMs,
    inactivityMs,
    staleAfterMs: staleMs,
    activity: job.activity ? { ...job.activity } : { mode: "indeterminate", substep: job.stage || "Working", bytes: null, totalBytes: null, percent: null }
  };
}

async function whileAlive(job, stage, substep, task, options = {}) {
  begin(job, stage, substep, options);
  const intervalMs = Math.max(250, Number(options.intervalMs || 1000));
  let callbackError = null;
  const publish = () => {
    if (callbackError) return;
    heartbeat(job, substep);
    try { options.onHeartbeat?.(publicView(job)); }
    catch (error) {
      callbackError = new Error(`Migration progress reporting failed: ${String(error?.message || error || "unknown callback error")}`);
      callbackError.code = "migration_progress_reporting_failed";
    }
  };
  publish();
  if (callbackError) throw callbackError;
  const timer = setInterval(publish, intervalMs);
  let result;
  let taskError = null;
  try { result = await task(); }
  catch (error) { taskError = error; }
  finally { clearInterval(timer); publish(); }
  if (taskError) throw taskError;
  if (callbackError) throw callbackError;
  return result;
}

module.exports = { DEFAULT_STALE_MS, PROGRESS_API_VERSION, begin, bytes, heartbeat, initialize, publicView, whileAlive };
