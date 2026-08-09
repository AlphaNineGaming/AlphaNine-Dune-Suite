"use strict";

const { classifyMigrationOfflineStatus } = require("./server-migration");

class MigrationPreflightEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationPreflightEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MigrationPreflightEvidenceError(code, message);
}

function decimal(value, label) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)$/.test(text)) fail("migration_preflight_decimal", `${label} must be a canonical decimal string.`);
  return text;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("migration_preflight_envelope", `${label} is missing.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("migration_preflight_envelope", `${label} contains missing or unknown fields.`);
  }
}

// This is the one canonical parser for the vendor battlegroup status text used by
// migration and Empty Market. It accepts both key/value and tabular status forms.
function parseBattlegroupStatus(text) {
  if (typeof text !== "string") fail("migration_battlegroup_output_type", "Battlegroup status output must be text.");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = {};
  const servers = [];
  let inServers = false;
  let statusColumns = [];
  for (const line of lines) {
    if (/^Battlegroup:/.test(line)) summary.battlegroup = line.replace(/^Battlegroup:\s*/, "");
    const keyValues = [...line.matchAll(/\b(PHASE|SERVERGROUP|GATEWAY|DIRECTOR)\s*[:=]\s*([A-Za-z-]+)/gi)];
    for (const match of keyValues) {
      const key = match[1].toLowerCase();
      const value = match[2];
      if (key === "phase") {
        summary.phase = value;
        summary.status = value;
      } else if (key === "servergroup") summary.servergroup = value;
      else summary[key] = value;
    }
    if (/^(Status|Phase)\s+/i.test(line) && /(Gateway|Director)/i.test(line)) {
      statusColumns = line.split(/\s+/).map((part) => part.toLowerCase());
      continue;
    }
    if (/^(Healthy|Reconciling|Running|Updating|Starting|Progressing|Unhealthy|Ready|Pending|Stopped|Offline|Failed|Error|Unreachable|Missing)\s+/i.test(line)
      && (!summary.status || !summary.gateway || !summary.director || !summary.servergroup)) {
      const parts = line.split(/\s+/);
      summary.status = parts[0];
      summary.phase = parts[0];
      if (statusColumns.length) {
        for (let index = 1; index < statusColumns.length && index < parts.length; index += 1) {
          const column = statusColumns[index];
          if (column === "servergroup" || column === "server-group") summary.servergroup = parts[index];
          else if (column === "database") summary.database = parts[index];
          else if (column === "gateway") summary.gateway = parts[index];
          else if (column === "director") summary.director = parts[index];
          else if (column === "uptime") summary.uptime = parts.slice(index).join(" ");
        }
      } else {
        summary.database = parts[1];
        summary.gateway = parts[2];
        summary.director = parts[3];
        summary.uptime = parts.slice(4).join(" ");
      }
    }
    if (/^Game Servers/i.test(line)) {
      inServers = true;
      continue;
    }
    if (inServers && !/^[-\s]*$/.test(line) && !/^Map\s+/i.test(line)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 5) servers.push({ map: parts[0], phase: parts[1], ready: parts[2], players: parts[3], age: parts.slice(4).join(" ") });
    }
  }
  return { summary, servers, raw: text };
}

const INFRASTRUCTURE_KEYS = Object.freeze([
  "version", "serviceManager", "serviceState", "serviceInstalled", "runtimeInstalled",
  "serviceAuthoritative", "statusExit", "pidFilePresent", "matchingProcessCount",
  "supervisorProcessCount", "defaultRunlevelRegistered", "restartPathActive"
]);

function validateMarketBotInfrastructureEvidence(value, options = {}) {
  exactKeys(value, INFRASTRUCTURE_KEYS, "Market Bot infrastructure evidence");
  if (value.version !== 3) fail("migration_market_bot_evidence_version", "Market Bot infrastructure evidence version is unsupported.");
  if (!['openrc', 'none', 'unknown'].includes(value.serviceManager)) fail("migration_market_bot_service_manager", "Market Bot service manager is unknown.");
  if (!['stopped', 'absent', 'started', 'unknown'].includes(value.serviceState)) fail("migration_market_bot_service_state", "Market Bot service state is invalid.");
  for (const key of ["serviceInstalled", "runtimeInstalled", "serviceAuthoritative", "pidFilePresent", "defaultRunlevelRegistered", "restartPathActive"]) {
    if (typeof value[key] !== "boolean") fail("migration_market_bot_evidence_type", `Market Bot ${key} evidence must be boolean.`);
  }
  const matchingProcessCount = decimal(value.matchingProcessCount, "Market Bot matching process count");
  const supervisorProcessCount = decimal(value.supervisorProcessCount, "Market Bot supervisor process count");
  const stopped = value.serviceInstalled === true && value.serviceManager === "openrc"
    && value.serviceState === "stopped" && value.serviceAuthoritative === true;
  const absent = value.serviceInstalled === false && value.serviceState === "absent" && value.serviceAuthoritative === true;
  const inactive = (stopped || absent) && value.pidFilePresent === false
    && matchingProcessCount === "0" && supervisorProcessCount === "0"
    && value.defaultRunlevelRegistered === false && value.restartPathActive === false;
  if (!inactive) fail("migration_market_bot_infrastructure_active", "Market Bot service or process infrastructure is active or ambiguous.");
  if (options.requireAbsent === true && (!absent || value.runtimeInstalled !== false)) {
    fail("migration_market_bot_infrastructure_present", "Market Bot service and runtime were not fully removed after cleanup.");
  }
  return {
    version: 3,
    safe: true,
    mode: absent ? "service-absent" : "service-stopped",
    serviceState: value.serviceState,
    serviceInstalled: value.serviceInstalled,
    runtimeInstalled: value.runtimeInstalled,
    matchingProcessCount,
    supervisorProcessCount,
    evidence: value
  };
}

function validateMarketBotStopCompletion(result, evidence) {
  if (!result || Number(result.code) !== 0) {
    fail("migration_market_bot_stop_failed", "The supported Market Bot stop operation did not exit successfully.");
  }
  // stderr is diagnostic-only. OpenRC can emit an informational warning when
  // an already-stopped service is stopped again; safety comes from this fresh,
  // independently captured infrastructure postcondition, never the warning text.
  return validateMarketBotInfrastructureEvidence(evidence);
}

function gate(name, evaluate) {
  try {
    const detail = evaluate();
    return { name, ok: true, code: "ok", detail };
  } catch (error) {
    return { name, ok: false, code: String(error?.code || "migration_preflight_gate_failed"), detail: null };
  }
}

// Each gate is evaluated in its own exception boundary. A battlegroup parser error
// can never suppress PostgreSQL or Market Bot classification again.
function evaluateReadOnlySafetyGates(input = {}) {
  let offline = null;
  const battlegroup = gate("battlegroup-stopped", () => {
    if (input.battlegroup?.ok !== true) fail("migration_battlegroup_transport", "Battlegroup transport failed.");
    if (input.kubernetes?.ok !== true) fail("migration_kubernetes_transport", "Kubernetes transport failed.");
    const parsed = parseBattlegroupStatus(input.battlegroup.stdout);
    offline = classifyMigrationOfflineStatus(parsed.summary, input.kubernetes.value);
    if (!offline.authoritativePhaseOffline) fail("migration_battlegroup_online", "Battlegroup phase is not stopped or offline.");
    return { phase: offline.battlegroupPhase };
  });
  const controllers = gate("controllers-suspended", () => {
    if (!offline) {
      if (input.battlegroup?.ok !== true || input.kubernetes?.ok !== true) fail("migration_controller_dependency", "Controller evidence transport is unavailable.");
      offline = classifyMigrationOfflineStatus(parseBattlegroupStatus(input.battlegroup.stdout).summary, input.kubernetes.value);
    }
    if (!offline.componentsOffline || offline.componentStates.gateway !== "suspended" || offline.componentStates.director !== "suspended") {
      fail("migration_controllers_not_suspended", "Battlegroup controllers are not suspended.");
    }
    return { states: offline.componentStates };
  });
  const workloads = gate("game-workloads-zero", () => {
    if (input.kubernetes?.ok !== true) fail("migration_kubernetes_transport", "Kubernetes transport failed.");
    const state = classifyMigrationOfflineStatus({ phase: "stopped", servergroup: "stopped", gateway: "suspended", director: "suspended" }, input.kubernetes.value);
    if (state.runningGamePods !== "0") fail("migration_game_workloads_running", "Game workloads are running.");
    return { runningGameWorkloads: state.runningGamePods };
  });
  const postgresql = gate("postgresql-healthy", () => {
    if (input.postgresql?.ok !== true) fail("migration_postgresql_transport", "PostgreSQL evidence transport failed.");
    const value = input.postgresql.value || {};
    if (value.reachable !== true || String(value.database || "") !== "dune") fail("migration_postgresql_unhealthy", "PostgreSQL is unavailable or the database identity is wrong.");
    return { healthy: true };
  });
  const marketBot = gate("market-bot-infrastructure-safe", () => {
    if (input.marketBot?.ok !== true) fail("migration_market_bot_transport", "Market Bot infrastructure evidence transport failed.");
    return validateMarketBotInfrastructureEvidence(input.marketBot.value, input.marketBot.options || {});
  });
  const gates = { battlegroup, controllers, workloads, postgresql, marketBot };
  return { ok: Object.values(gates).every((entry) => entry.ok), gates };
}

module.exports = {
  INFRASTRUCTURE_KEYS,
  validateMarketBotStopCompletion,
  MigrationPreflightEvidenceError,
  evaluateReadOnlySafetyGates,
  parseBattlegroupStatus,
  validateMarketBotInfrastructureEvidence
};
