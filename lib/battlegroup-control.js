"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VERSION = 1;
const ANNOTATION_PREFIX = "control.alphanine.io/";
const ANNOTATIONS = Object.freeze({
  generation: `${ANNOTATION_PREFIX}generation`,
  operationId: `${ANNOTATION_PREFIX}operation-id`,
  reason: `${ANNOTATION_PREFIX}reason`,
  callSite: `${ANNOTATION_PREFIX}call-site`,
  process: `${ANNOTATION_PREFIX}process`,
  timestamp: `${ANNOTATION_PREFIX}timestamp`,
  profile: `${ANNOTATION_PREFIX}profile`,
  battlegroup: `${ANNOTATION_PREFIX}battlegroup`
});

class BattlegroupControlError extends Error {
  constructor(message, code = "battlegroup_control_failed", details = {}) {
    super(message);
    this.name = "BattlegroupControlError";
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function decimal(value, label = "Control generation") {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new BattlegroupControlError(`${label} is not a canonical decimal.`, "battlegroup_control_generation_invalid");
  return text;
}

function bounded(value, label, max = 120) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new BattlegroupControlError(`${label} is missing or invalid.`, "battlegroup_control_identity_invalid");
  return text;
}

function identityDigest(value) {
  return sha256(bounded(value, "Control identity", 2048));
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(next, filePath);
}

function initialState() {
  return { version: VERSION, generation: "0", updatedAt: "", lastIntent: null };
}

class BattlegroupControlJournal {
  constructor(options = {}) {
    this.statePath = String(options.statePath || "");
    this.auditPath = String(options.auditPath || "");
    if (!this.statePath || !this.auditPath) throw new Error("Battlegroup control journal paths are required.");
  }

  load() {
    if (!fs.existsSync(this.statePath)) return initialState();
    let value;
    try { value = JSON.parse(fs.readFileSync(this.statePath, "utf8")); }
    catch { throw new BattlegroupControlError("Battlegroup control state is unreadable.", "battlegroup_control_state_invalid"); }
    if (!value || value.version !== VERSION) throw new BattlegroupControlError("Battlegroup control state version is invalid.", "battlegroup_control_state_invalid");
    decimal(value.generation);
    return value;
  }

  currentGeneration() { return this.load().generation; }

  begin(input = {}) {
    const previous = this.load();
    const explicit = input.explicit === true;
    const operationId = bounded(input.operationId, "Operation ID", 160);
    const action = bounded(input.action, "Battlegroup action", 24).toLowerCase();
    if (!new Set(["start", "stop", "restart", "update", "import", "scheduler-restart"]).has(action)) {
      throw new BattlegroupControlError("Battlegroup control action is unsupported.", "battlegroup_control_action_invalid");
    }
    let generation;
    if (explicit) {
      const minimumGeneration = decimal(input.minimumGeneration ?? "0", "Remote control generation");
      const baseline = BigInt(previous.generation) > BigInt(minimumGeneration)
        ? BigInt(previous.generation)
        : BigInt(minimumGeneration);
      generation = (baseline + 1n).toString();
    }
    else {
      generation = decimal(input.expectedGeneration, "Expected control generation");
      if (generation !== previous.generation) {
        const rejected = { version: VERSION, at: new Date().toISOString(), outcome: "rejected-stale", action, operationId, expectedGeneration: generation, currentGeneration: previous.generation, reason: String(input.reason || "") };
        this.append(rejected);
        throw new BattlegroupControlError("Stale battlegroup control intent was rejected because a newer explicit operation exists.", "battlegroup_control_stale_intent", rejected);
      }
    }
    const intent = Object.freeze({
      version: VERSION,
      generation,
      action,
      stop: input.stop === true,
      explicit,
      operationId,
      reason: bounded(input.reason, "Control reason", 180),
      callSite: bounded(input.callSite, "Control call site", 180),
      processIdentity: bounded(input.processIdentity, "Process identity", 180),
      profileIdentity: identityDigest(input.profileIdentity),
      battlegroupIdentity: identityDigest(input.battlegroupIdentity),
      createdAt: new Date().toISOString()
    });
    atomicWrite(this.statePath, { version: VERSION, generation, updatedAt: intent.createdAt, lastIntent: intent });
    this.append({ ...intent, outcome: "authorized" });
    return intent;
  }

  assertCurrent(intent) {
    const current = this.load();
    if (!intent || current.generation !== intent.generation || current.lastIntent?.operationId !== intent.operationId) {
      throw new BattlegroupControlError("Battlegroup control intent was superseded before mutation.", "battlegroup_control_superseded", { intentGeneration: intent?.generation || "", currentGeneration: current.generation });
    }
    return true;
  }

  append(entry) {
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  record(intent, before, after, outcome = "applied") {
    this.assertCurrent(intent);
    const entry = {
      version: VERSION,
      at: new Date().toISOString(),
      outcome,
      operationId: intent.operationId,
      generation: intent.generation,
      action: intent.action,
      reason: intent.reason,
      callSite: intent.callSite,
      processIdentity: intent.processIdentity,
      profileIdentity: intent.profileIdentity,
      battlegroupIdentity: intent.battlegroupIdentity,
      oldResourceVersion: bounded(before.resourceVersion, "Old resource version", 80),
      newResourceVersion: bounded(after.resourceVersion, "New resource version", 80),
      oldStop: before.stop === true,
      newStop: after.stop === true
    };
    this.append(entry);
    return entry;
  }
}

function annotationValues(intent) {
  return {
    [ANNOTATIONS.generation]: intent.generation,
    [ANNOTATIONS.operationId]: intent.operationId,
    [ANNOTATIONS.reason]: intent.reason,
    [ANNOTATIONS.callSite]: intent.callSite,
    [ANNOTATIONS.process]: intent.processIdentity,
    [ANNOTATIONS.timestamp]: intent.createdAt,
    [ANNOTATIONS.profile]: intent.profileIdentity,
    [ANNOTATIONS.battlegroup]: intent.battlegroupIdentity
  };
}

function buildMergePatch(intent, resourceVersion) {
  return {
    metadata: {
      resourceVersion: bounded(resourceVersion, "Battlegroup resource version", 80),
      annotations: annotationValues(intent)
    },
    spec: { stop: intent.stop === true }
  };
}

function resourceEvidence(value = {}) {
  const resourceVersion = bounded(value?.metadata?.resourceVersion, "Battlegroup resource version", 80);
  if (typeof value?.spec?.stop !== "boolean") throw new BattlegroupControlError("Battlegroup spec.stop evidence is missing or ambiguous.", "battlegroup_control_resource_invalid");
  return {
    resourceVersion,
    stop: value.spec.stop,
    generation: decimal(value?.metadata?.annotations?.[ANNOTATIONS.generation] || "0", "Remote control generation"),
    operationId: String(value?.metadata?.annotations?.[ANNOTATIONS.operationId] || "")
  };
}

module.exports = {
  ANNOTATIONS,
  BattlegroupControlError,
  BattlegroupControlJournal,
  VERSION,
  annotationValues,
  buildMergePatch,
  identityDigest,
  resourceEvidence,
  sha256
};
