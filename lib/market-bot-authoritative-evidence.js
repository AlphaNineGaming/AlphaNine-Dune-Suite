"use strict";

const {
  activationFingerprint,
  pinnedCatalogPolicy
} = require("./market-bot");
const {
  buildEvidenceEnvelope,
  evaluationInput
} = require("./market-bot-evidence");
const {
  PAUSE_STATES,
  evaluateAuthoritativeQuiescence,
  stableStringify
} = require("./market-bot-verification");
const { validateRemoteQuiescence } = require("./market-bot-reconciliation");

class MarketBotAuthoritativeEvidenceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MarketBotAuthoritativeEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarketBotAuthoritativeEvidenceError(code, message);
}

function digest(value, label) {
  const text = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(text)) fail("market_bot_authoritative_digest", `${label} is missing or malformed.`);
  return text;
}

function decimal(value, label) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)$/.test(text)) fail("market_bot_authoritative_generation", `${label} must be a canonical decimal string.`);
  return text;
}

function configurationSummary(config = {}) {
  return {
    schemaVersion: config.schemaVersion,
    paused: config.paused,
    pauseState: config.pauseState,
    configGeneration: String(config.configGeneration ?? ""),
    pauseGeneration: String(config.pauseGeneration ?? ""),
    configFingerprint: String(config.configFingerprint ?? ""),
    runtimeVersion: String(config.runtimeVersion ?? "")
  };
}

function runtimeStateSummary(state = {}) {
  return {
    status: state.status,
    pauseState: state.pauseState,
    configGeneration: String(state.configGeneration ?? ""),
    pauseGeneration: String(state.pauseGeneration ?? ""),
    installedVersion: String(state.installedVersion ?? ""),
    cycleQueued: state.cycleQueued,
    cycleRunning: state.cycleRunning,
    incompleteCycle: state.incompleteCycle
  };
}

function validateStatusSummary(status = {}, authoritativeConfig = {}, position = 0) {
  const statusConfig = configurationSummary(status.config || {});
  const runtimeConfig = configurationSummary(authoritativeConfig);
  if (stableStringify(statusConfig) !== stableStringify(runtimeConfig)) {
    fail("market_bot_authoritative_status_disagreement", `Public status summary ${position + 1} disagrees with authoritative runtime configuration evidence.`);
  }
  const state = runtimeStateSummary(status.state || {});
  if (state.status !== PAUSE_STATES.QUIESCENT || state.pauseState !== PAUSE_STATES.QUIESCENT) {
    fail("market_bot_authoritative_not_quiescent", `Runtime status sample ${position + 1} is not authoritatively Quiescent.`);
  }
  return state;
}

function validateRuntimeCapture(capture = {}, position = 0) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)
    || !capture.config || typeof capture.config !== "object" || Array.isArray(capture.config)) {
    fail("market_bot_authoritative_configuration_missing", `Authoritative runtime configuration sample ${position + 1} is missing or malformed.`);
  }
  return {
    config: capture.config,
    configSha256: digest(capture.configSha256, `Runtime configuration sample ${position + 1} SHA-256`),
    remoteBinaryHash: digest(capture.remoteBinaryHash, `Runtime binary sample ${position + 1} SHA-256`)
  };
}

function buildAuthoritativeMarketBotEvidence(input = {}) {
  const statusSamples = Array.isArray(input.statusSamples) ? input.statusSamples : [];
  const runtimeCaptures = Array.isArray(input.runtimeCaptures) ? input.runtimeCaptures : [];
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const writers = Array.isArray(input.writers) ? input.writers : [];
  const expected = input.expected || {};
  if (statusSamples.length !== 2 || runtimeCaptures.length !== 2) {
    fail("market_bot_authoritative_samples", "Exactly two status and authoritative runtime-configuration samples are required.");
  }
  if (samples.length !== 2 || writers.length !== 2) {
    fail("market_bot_authoritative_database_samples", "Exactly two database and writer samples are required.");
  }

  const captures = runtimeCaptures.map(validateRuntimeCapture);
  if (captures[0].configSha256 !== captures[1].configSha256
    || captures[0].remoteBinaryHash !== captures[1].remoteBinaryHash
    || stableStringify(captures[0].config) !== stableStringify(captures[1].config)) {
    fail("market_bot_authoritative_configuration_drift", "Authoritative runtime configuration or binary evidence changed between bounded samples.");
  }

  const config = captures[0].config;
  if (!Array.isArray(config.items) || config.items.length === 0) {
    fail("market_bot_authoritative_catalog_missing", "The authoritative runtime configuration does not contain a complete pinned catalog.");
  }
  let catalogPolicy;
  try { catalogPolicy = pinnedCatalogPolicy(config.items); }
  catch {
    fail("market_bot_authoritative_catalog_invalid", "The authoritative pinned catalog is malformed.");
  }

  const canonicalFingerprint = activationFingerprint(config);
  const storedFingerprint = digest(config.configFingerprint, "Authoritative configuration fingerprint");
  if (canonicalFingerprint !== storedFingerprint) {
    fail("market_bot_authoritative_configuration_fingerprint", "The stored authoritative configuration fingerprint does not match its canonical policy.");
  }
  const generation = decimal(config.configGeneration, "Authoritative configuration generation");
  if (decimal(config.pauseGeneration, "Authoritative pause generation") !== generation) {
    fail("market_bot_authoritative_generation", "Authoritative configuration and pause generations do not match.");
  }
  if (config.paused !== true || config.pauseState !== PAUSE_STATES.REQUESTED) {
    fail("market_bot_authoritative_pause_configuration", "The authoritative runtime configuration is not a persisted pause request.");
  }

  if (expected.generation !== undefined && generation !== String(expected.generation)) {
    fail("market_bot_authoritative_generation", "The authoritative pause generation does not match the supported profile.");
  }
  if (expected.configFingerprint && storedFingerprint !== String(expected.configFingerprint)) {
    fail("market_bot_authoritative_configuration_fingerprint", "The authoritative configuration fingerprint does not match the supported profile.");
  }
  if (expected.runtimeBinarySha256 && captures[0].remoteBinaryHash !== String(expected.runtimeBinarySha256)) {
    fail("market_bot_authoritative_runtime_fingerprint", "The authoritative runtime binary fingerprint does not match the supported profile.");
  }
  if (expected.catalogItemCount !== undefined && catalogPolicy.itemCount !== String(expected.catalogItemCount)) {
    fail("market_bot_authoritative_catalog_count", "The authoritative pinned catalog item count does not match the supported profile.");
  }
  if (expected.catalogFingerprint && catalogPolicy.fingerprint !== String(expected.catalogFingerprint)) {
    fail("market_bot_authoritative_catalog_fingerprint", "The authoritative pinned catalog fingerprint does not match the supported profile.");
  }

  const states = statusSamples.map((status, position) => validateStatusSummary(status, config, position));
  if (stableStringify(states[0]) !== stableStringify(states[1])) {
    fail("market_bot_authoritative_runtime_drift", "Authoritative Quiescent runtime state changed between bounded samples.");
  }
  const remoteBinaryHash = captures[0].remoteBinaryHash;
  const expectedVersion = String(expected.runtimeVersion || config.runtimeVersion || "");
  if (!expectedVersion) fail("market_bot_authoritative_runtime_version", "The authoritative runtime version is missing.");
  const expectedBinaryHash = String(expected.runtimeBinarySha256 || remoteBinaryHash);
  const remote = {
    ...statusSamples[0],
    config,
    state: statusSamples[0].state || {}
  };
  for (const status of statusSamples) {
    const check = validateRemoteQuiescence({
      remote: { ...status, config, state: status.state || {} },
      samples,
      writers,
      expectedVersion,
      expectedConfigFingerprint: String(expected.configFingerprint || storedFingerprint),
      expectedBinaryHash,
      remoteBinaryHash
    });
    if (!check.ok || check.generation !== generation) {
      fail("market_bot_authoritative_quiescence", `Authoritative Market Bot quiescence validation failed (${check.reasons.join(",") || "generation"}).`);
    }
  }

  const localConfig = input.requireLocalAgreement === false
    ? {
        schemaVersion: config.schemaVersion,
        paused: config.paused,
        pauseState: config.pauseState,
        configGeneration: generation,
        pauseGeneration: generation,
        runtimeFingerprint: storedFingerprint,
        evidencePersisted: true
      }
    : { ...(input.localConfig || {}), evidencePersisted: input.localConfig?.evidencePersisted !== false };
  const envelope = buildEvidenceEnvelope({ localConfig, remote, samples, writers });
  const quiescence = evaluateAuthoritativeQuiescence(evaluationInput(envelope));
  if (!quiescence.ok || quiescence.generation !== generation) {
    fail("market_bot_authoritative_local_disagreement", `Local and authoritative Market Bot evidence does not agree (${quiescence.reasons.join(";") || "generation"}).`);
  }

  return {
    ok: true,
    configuration: config,
    catalogPolicy,
    samples,
    writers,
    quiescence,
    publicEvidence: {
      state: PAUSE_STATES.QUIESCENT,
      generation,
      configurationFingerprint: storedFingerprint,
      runtimeBinaryFingerprint: remoteBinaryHash,
      runtimeVersion: expectedVersion,
      configurationSha256: captures[0].configSha256,
      catalogPolicy: {
        mode: catalogPolicy.mode,
        version: catalogPolicy.version,
        itemCount: catalogPolicy.itemCount,
        fingerprint: catalogPolicy.fingerprint
      }
    }
  };
}

module.exports = {
  MarketBotAuthoritativeEvidenceError,
  buildAuthoritativeMarketBotEvidence,
  configurationSummary,
  runtimeStateSummary
};
