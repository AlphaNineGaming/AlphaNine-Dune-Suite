"use strict";

const EVIDENCE_VERSION = 1;
const SAMPLE_FIELDS = Object.freeze([
  "advisoryLocks", "incompleteCycles", "cycleEvidenceRows", "cycleEvidenceDigest", "activeTracking", "totalTracking",
  "protectedOrders", "protectedSellOrders", "protectedItems", "fulfilledPayments",
  "invalidBotTracking", "invalidProtected", "protectedDigest", "botOwnedDigest"
]);
const DECIMAL_SAMPLE_FIELDS = Object.freeze(SAMPLE_FIELDS.filter((field) => !field.endsWith("Digest")));

class MarketBotEvidenceError extends Error {
  constructor(code, message, structure = null) {
    super(message);
    this.name = "MarketBotEvidenceError";
    this.code = code;
    this.structure = structure;
  }
}

function evidenceError(code, message, structure = null) {
  throw new MarketBotEvidenceError(code, `${code}: ${message}`, structure);
}

function inspectTransportStructure(result = {}) {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const trimmed = stdout.replace(/^\uFEFF/, "").trim();
  const lines = trimmed ? trimmed.split(/\r?\n/).filter((line) => line.trim()) : [];
  let firstToken = "empty";
  if (trimmed.startsWith("{")) firstToken = "json-object";
  else if (trimmed.startsWith("[")) firstToken = "json-array";
  else if (/^[A-Z][A-Z _-]*(?:\r?\n|$)/.test(trimmed)) firstToken = "command-status";
  else if (trimmed) firstToken = "other";
  return {
    stdoutType: typeof result.stdout,
    stdoutLength: stdout.length,
    nonEmptyLineCount: lines.length,
    firstToken,
    envelopeCount: countTopLevelValues(trimmed),
    stderrPresent: stderr.length > 0,
    stderrLength: stderr.length
  };
}

function countTopLevelValues(text) {
  let index = 0;
  let count = 0;
  const source = String(text || "");
  const whitespace = () => { while (/\s/.test(source[index] || "")) index += 1; };
  const skipString = () => {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === '"') return true;
    }
    return false;
  };
  const skipComposite = () => {
    const stack = [source[index++]];
    while (index < source.length && stack.length) {
      const character = source[index];
      if (character === '"') {
        if (!skipString()) return false;
      } else {
        index += 1;
        if (character === "{" || character === "[") stack.push(character);
        else if (character === "}" || character === "]") stack.pop();
      }
    }
    return stack.length === 0;
  };
  while (index < source.length) {
    whitespace();
    if (index >= source.length) break;
    if (source[index] !== "{" && source[index] !== "[") return count;
    if (!skipComposite()) return count;
    count += 1;
  }
  return count;
}

function strictJsonParse(input, structure = null) {
  const source = String(input ?? "").replace(/^\uFEFF/, "");
  let index = 0;
  const fail = (code, message) => evidenceError(code, message, structure);
  const whitespace = () => { while (/\s/.test(source[index] || "")) index += 1; };
  const parseString = () => {
    const start = index;
    if (source[index] !== '"') fail("market_bot_evidence_invalid_json", "Expected a JSON string.");
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === '"') {
        index += 1;
        try { return JSON.parse(source.slice(start, index)); }
        catch { fail("market_bot_evidence_invalid_json", "A JSON string escape is malformed."); }
      }
      if (source.charCodeAt(index) < 0x20) fail("market_bot_evidence_invalid_json", "A JSON string contains a control character.");
      index += 1;
    }
    fail("market_bot_evidence_truncated", "JSON string output ended unexpectedly.");
  };
  const parseValue = () => {
    whitespace();
    const character = source[index];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    for (const [token, value] of [["true", true], ["false", false], ["null", null]]) {
      if (source.startsWith(token, index)) { index += token.length; return value; }
    }
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match) { index += match[0].length; return Number(match[0]); }
    if (index >= source.length) fail("market_bot_evidence_truncated", "JSON output ended unexpectedly.");
    fail("market_bot_evidence_invalid_json", "JSON contains an invalid token.");
  };
  const parseObject = () => {
    const result = {};
    const keys = new Set();
    index += 1;
    whitespace();
    if (source[index] === "}") { index += 1; return result; }
    while (index < source.length) {
      whitespace();
      const key = parseString();
      if (keys.has(key)) fail("market_bot_evidence_duplicate_field", "A JSON object contains a duplicate field.");
      keys.add(key);
      whitespace();
      if (source[index++] !== ":") fail("market_bot_evidence_invalid_json", "Expected a colon after a JSON field name.");
      result[key] = parseValue();
      whitespace();
      const delimiter = source[index++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") fail(index > source.length ? "market_bot_evidence_truncated" : "market_bot_evidence_invalid_json", "Expected a comma or closing brace.");
    }
    fail("market_bot_evidence_truncated", "JSON object output ended unexpectedly.");
  };
  const parseArray = () => {
    const result = [];
    index += 1;
    whitespace();
    if (source[index] === "]") { index += 1; return result; }
    while (index < source.length) {
      result.push(parseValue());
      whitespace();
      const delimiter = source[index++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") fail(index > source.length ? "market_bot_evidence_truncated" : "market_bot_evidence_invalid_json", "Expected a comma or closing bracket.");
    }
    fail("market_bot_evidence_truncated", "JSON array output ended unexpectedly.");
  };
  whitespace();
  const value = parseValue();
  whitespace();
  if (index !== source.length) fail("market_bot_evidence_duplicate_envelope", "JSON stdout contains more than one value or non-JSON output.");
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) evidenceError("market_bot_evidence_type", `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, position) => key !== wanted[position])) {
    evidenceError("market_bot_evidence_fields", `${label} contains missing or unknown-critical fields.`);
  }
}

function decimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) evidenceError("market_bot_evidence_decimal", `${label} must be a canonical decimal string.`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) evidenceError("market_bot_evidence_digest", `${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function optionalTimestamp(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    evidenceError("market_bot_evidence_timestamp", `${label} must be null or an RFC 3339 timestamp.`);
  }
  return value;
}

function validateSample(sample) {
  exactKeys(sample, SAMPLE_FIELDS, "Market Bot database sample");
  for (const field of DECIMAL_SAMPLE_FIELDS) decimalString(sample[field], `sample.${field}`);
  digest(sample.protectedDigest, "sample.protectedDigest");
  digest(sample.botOwnedDigest, "sample.botOwnedDigest");
  digest(sample.cycleEvidenceDigest, "sample.cycleEvidenceDigest");
  return { ...sample };
}

function parseDatabaseEnvelope(result = {}) {
  const structure = inspectTransportStructure(result);
  const stdout = String(result.stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (!stdout) evidenceError("market_bot_evidence_empty", "The database evidence stdout is empty.", structure);
  if (!stdout.startsWith("{")) evidenceError("market_bot_evidence_non_json_prefix", "The database evidence stdout begins with non-JSON command output.", structure);
  let envelope;
  try { envelope = strictJsonParse(stdout, structure); }
  catch (error) {
    if (error instanceof MarketBotEvidenceError) throw error;
    evidenceError("market_bot_evidence_invalid_json", "The database evidence JSON is malformed.", structure);
  }
  exactKeys(envelope, ["version", "sample"], "Market Bot database envelope");
  if (envelope.version !== EVIDENCE_VERSION) evidenceError("market_bot_evidence_version", "The database evidence version is unsupported.", structure);
  return { version: EVIDENCE_VERSION, sample: validateSample(envelope.sample), diagnostics: structure };
}

function parseSingleObject(result = {}, label = "Market Bot remote evidence") {
  const structure = inspectTransportStructure(result);
  const stdout = String(result.stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (!stdout) evidenceError("market_bot_evidence_empty", `${label} stdout is empty.`, structure);
  if (!stdout.startsWith("{")) evidenceError("market_bot_evidence_non_json_prefix", `${label} stdout begins with non-JSON output.`, structure);
  const value = strictJsonParse(stdout, structure);
  if (!value || typeof value !== "object" || Array.isArray(value)) evidenceError("market_bot_evidence_type", `${label} must be one JSON object.`, structure);
  return { value, diagnostics: structure };
}

function normalizeTimestamp(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function buildEvidenceEnvelope({ localConfig = {}, remote = {}, samples = [], writers = [] } = {}) {
  const config = remote.config || {};
  const state = remote.state || {};
  return {
    version: EVIDENCE_VERSION,
    localConfiguration: {
      persisted: localConfig.evidencePersisted !== false,
      readable: !localConfig.loadError,
      schemaVersion: localConfig.schemaVersion,
      paused: localConfig.paused,
      pauseState: localConfig.pauseState,
      configGeneration: String(localConfig.configGeneration ?? ""),
      pauseGeneration: String(localConfig.pauseGeneration ?? ""),
      runtimeFingerprint: String(localConfig.runtimeFingerprint ?? "")
    },
    remoteConfiguration: {
      schemaVersion: config.schemaVersion,
      paused: config.paused,
      pauseState: config.pauseState,
      configGeneration: String(config.configGeneration ?? ""),
      pauseGeneration: String(config.pauseGeneration ?? ""),
      configFingerprint: String(config.configFingerprint ?? ""),
      runtimeVersion: String(config.runtimeVersion ?? remote.version ?? "")
    },
    runtime: {
      status: state.status,
      pauseState: state.pauseState,
      configGeneration: String(state.configGeneration ?? ""),
      pauseGeneration: String(state.pauseGeneration ?? ""),
      runtimeFingerprint: String(config.configFingerprint ?? ""),
      installedVersion: String(state.installedVersion ?? remote.installedVersion ?? ""),
      cycleQueued: state.cycleQueued,
      cycleRunning: state.cycleRunning,
      incompleteCycle: state.incompleteCycle,
      lastRunAt: normalizeTimestamp(state.lastRunAt),
      nextRunAt: normalizeTimestamp(state.nextRunAt),
      updatedAt: normalizeTimestamp(state.updatedAt)
    },
    database: {
      samples: samples.map((sample) => ({ ...sample })),
      writers: writers.map((writer) => ({ ...writer }))
    }
  };
}

function validateBoolean(value, label) {
  if (typeof value !== "boolean") evidenceError("market_bot_evidence_type", `${label} must be boolean.`);
}

function validateEvidenceEnvelope(envelope) {
  exactKeys(envelope, ["version", "localConfiguration", "remoteConfiguration", "runtime", "database"], "Market Bot evidence envelope");
  if (envelope.version !== EVIDENCE_VERSION) evidenceError("market_bot_evidence_version", "The Market Bot evidence version is unsupported.");
  const local = envelope.localConfiguration;
  exactKeys(local, ["persisted", "readable", "schemaVersion", "paused", "pauseState", "configGeneration", "pauseGeneration", "runtimeFingerprint"], "local configuration evidence");
  validateBoolean(local.persisted, "localConfiguration.persisted");
  validateBoolean(local.readable, "localConfiguration.readable");
  if (!local.persisted) evidenceError("market_bot_evidence_local_missing", "The persisted local Market Bot configuration is missing.");
  if (!local.readable) evidenceError("market_bot_evidence_local_unreadable", "The persisted local Market Bot configuration could not be parsed.");
  if (!Number.isInteger(local.schemaVersion) || local.schemaVersion < 2) evidenceError("market_bot_evidence_local_legacy_incompatible", "The persisted local Market Bot configuration predates the pause/drain evidence protocol.");
  validateBoolean(local.paused, "localConfiguration.paused");
  if (typeof local.pauseState !== "string") evidenceError("market_bot_evidence_type", "localConfiguration.pauseState must be a string.");
  decimalString(local.configGeneration, "localConfiguration.configGeneration");
  decimalString(local.pauseGeneration, "localConfiguration.pauseGeneration");
  if (!local.runtimeFingerprint) evidenceError("market_bot_evidence_local_legacy_incompatible", "The persisted local Market Bot configuration predates authoritative runtime fingerprint evidence.");
  digest(local.runtimeFingerprint, "localConfiguration.runtimeFingerprint");

  const remote = envelope.remoteConfiguration;
  exactKeys(remote, ["schemaVersion", "paused", "pauseState", "configGeneration", "pauseGeneration", "configFingerprint", "runtimeVersion"], "remote configuration evidence");
  if (!Number.isInteger(remote.schemaVersion) || remote.schemaVersion < 2) evidenceError("market_bot_evidence_legacy_incompatible", "The remote Market Bot state predates the pause/drain evidence protocol.");
  validateBoolean(remote.paused, "remoteConfiguration.paused");
  if (typeof remote.pauseState !== "string" || typeof remote.runtimeVersion !== "string" || !remote.runtimeVersion) evidenceError("market_bot_evidence_type", "Remote pause state and runtime version must be explicit strings.");
  decimalString(remote.configGeneration, "remoteConfiguration.configGeneration");
  decimalString(remote.pauseGeneration, "remoteConfiguration.pauseGeneration");
  digest(remote.configFingerprint, "remoteConfiguration.configFingerprint");

  const runtime = envelope.runtime;
  exactKeys(runtime, ["status", "pauseState", "configGeneration", "pauseGeneration", "runtimeFingerprint", "installedVersion", "cycleQueued", "cycleRunning", "incompleteCycle", "lastRunAt", "nextRunAt", "updatedAt"], "runtime evidence");
  if (typeof runtime.status !== "string" || typeof runtime.pauseState !== "string" || typeof runtime.installedVersion !== "string" || !runtime.installedVersion) evidenceError("market_bot_evidence_type", "Runtime state/version fields must be explicit strings.");
  decimalString(runtime.configGeneration, "runtime.configGeneration");
  decimalString(runtime.pauseGeneration, "runtime.pauseGeneration");
  digest(runtime.runtimeFingerprint, "runtime.runtimeFingerprint");
  validateBoolean(runtime.cycleQueued, "runtime.cycleQueued");
  validateBoolean(runtime.cycleRunning, "runtime.cycleRunning");
  validateBoolean(runtime.incompleteCycle, "runtime.incompleteCycle");
  optionalTimestamp(runtime.lastRunAt, "runtime.lastRunAt");
  optionalTimestamp(runtime.nextRunAt, "runtime.nextRunAt");
  optionalTimestamp(runtime.updatedAt, "runtime.updatedAt");

  const database = envelope.database;
  exactKeys(database, ["samples", "writers"], "database evidence");
  if (!Array.isArray(database.samples) || database.samples.length !== 2) evidenceError("market_bot_evidence_samples", "Exactly two independent database samples are required.");
  if (!Array.isArray(database.writers) || database.writers.length !== 2) evidenceError("market_bot_evidence_samples", "Exactly two independent writer samples are required.");
  database.samples = database.samples.map(validateSample);
  database.writers = database.writers.map((writer) => {
    exactKeys(writer, ["unexpectedActiveClients", "openTransactions"], "writer evidence");
    decimalString(writer.unexpectedActiveClients, "writer.unexpectedActiveClients");
    decimalString(writer.openTransactions, "writer.openTransactions");
    return { ...writer };
  });
  return envelope;
}

function evaluationInput(envelope) {
  const validated = validateEvidenceEnvelope(envelope);
  if (validated.runtime.runtimeFingerprint !== validated.remoteConfiguration.configFingerprint
    || validated.runtime.installedVersion !== validated.remoteConfiguration.runtimeVersion) {
    evidenceError("market_bot_evidence_runtime_disagreement", "Remote configuration and runtime fingerprint/version evidence do not agree.");
  }
  return {
    localConfig: {
      paused: validated.localConfiguration.paused,
      pauseState: validated.localConfiguration.pauseState,
      configGeneration: validated.localConfiguration.configGeneration,
      pauseGeneration: validated.localConfiguration.pauseGeneration,
      runtimeFingerprint: validated.localConfiguration.runtimeFingerprint
    },
    remote: {
      config: {
        paused: validated.remoteConfiguration.paused,
        pauseState: validated.remoteConfiguration.pauseState,
        configGeneration: validated.remoteConfiguration.configGeneration,
        pauseGeneration: validated.remoteConfiguration.pauseGeneration,
        configFingerprint: validated.remoteConfiguration.configFingerprint
      },
      state: {
        status: validated.runtime.status,
        pauseState: validated.runtime.pauseState,
        configGeneration: validated.runtime.configGeneration,
        pauseGeneration: validated.runtime.pauseGeneration,
        cycleQueued: validated.runtime.cycleQueued,
        cycleRunning: validated.runtime.cycleRunning,
        incompleteCycle: validated.runtime.incompleteCycle
      }
    },
    samples: validated.database.samples,
    writers: validated.database.writers
  };
}

module.exports = {
  EVIDENCE_VERSION,
  SAMPLE_FIELDS,
  MarketBotEvidenceError,
  inspectTransportStructure,
  strictJsonParse,
  validateSample,
  parseDatabaseEnvelope,
  parseSingleObject,
  buildEvidenceEnvelope,
  validateEvidenceEnvelope,
  evaluationInput
};
