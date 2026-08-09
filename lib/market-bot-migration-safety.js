"use strict";

const { validateMarketBotInfrastructureEvidence } = require("./migration-preflight");

const SAFETY_MODES = Object.freeze({
  SERVICE_STOPPED: "service-stopped",
  SERVICE_ABSENT: "service-absent"
});

class MarketBotMigrationSafetyError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "MarketBotMigrationSafetyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new MarketBotMigrationSafetyError(code, message, details);
}

function validateStoppedServices(samples = [], options = {}) {
  if (samples.length !== 2) fail("market_bot_migration_service_samples", "Exactly two Market Bot infrastructure samples are required.");
  let first;
  try {
    first = validateMarketBotInfrastructureEvidence(samples[0], options);
    validateMarketBotInfrastructureEvidence(samples[1], options);
  } catch (error) {
    fail(error.code || "market_bot_migration_infrastructure", error.message);
  }
  if (JSON.stringify(samples[0]) !== JSON.stringify(samples[1])) {
    fail("market_bot_migration_service_drift", "Market Bot service or process evidence changed between bounded samples.");
  }
  return first;
}

function evaluateMigrationMarketBotSafety(input = {}) {
  const proof = validateStoppedServices(input.serviceSamples || [], { requireAbsent: input.requireAbsent === true });
  const mode = proof.mode === SAFETY_MODES.SERVICE_ABSENT ? SAFETY_MODES.SERVICE_ABSENT : SAFETY_MODES.SERVICE_STOPPED;
  const checkpoint = {
    version: 2,
    mode,
    serviceInstalled: proof.serviceInstalled,
    runtimeInstalled: proof.runtimeInstalled,
    matchingProcessCount: proof.matchingProcessCount,
    supervisorProcessCount: proof.supervisorProcessCount
  };
  return {
    ok: true,
    mode,
    state: proof.serviceState === "absent" ? "Service absent" : "Service stopped",
    service: proof,
    samples: input.serviceSamples,
    checkpoint,
    verificationEvidence: { ...checkpoint }
  };
}

function assertMigrationSafetyCheckpoint(expected, observed, stage = "migration checkpoint") {
  if (!expected || !observed) fail("market_bot_migration_safety_changed", `Market Bot infrastructure evidence is missing at ${stage}.`);
  for (const key of Object.keys(expected)) {
    if (String(expected[key] ?? "") !== String(observed[key] ?? "")) {
      fail("market_bot_migration_safety_changed", `Market Bot service or process evidence changed at ${stage}.`, { field: key });
    }
  }
  return true;
}

module.exports = {
  MarketBotMigrationSafetyError,
  SAFETY_MODES,
  assertMigrationSafetyCheckpoint,
  evaluateMigrationMarketBotSafety,
  validateStoppedServices
};
