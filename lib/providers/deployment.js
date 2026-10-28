"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { rootCommand } = require("./remote-linux-path");
const KINDS = ["auto", "native", "systemd", "docker", "kubernetes"];
const STATE_VALUES = ["running", "stopped", "active", "inactive", "failed", "activating", "deactivating", "exited", "paused", "restarting", "created", "dead", "Running", "Pending", "Failed", "Succeeded", "Unknown"];
const CONFIG_SLOTS = ["userGame", "userEngine", "manifest", "revision"];
const FILE_STATES = ["readable", "unreadable", "missing", "unsafe", "oversized"];
const SETTINGS = { m_GlobalXPMultiplier: [0, 100], m_GlobalFameMultiplier: [0, 100], m_GlobalProgressionSpeedMultiplier: [0, 100], m_MaxNumLandclaimSegments: [1, 64] };
function validateDeployment(root, input = {}) {
  rootCommand(root);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_deployment_selector");
  const allowed = ["kind", "unit", "userService", "socket", "container", "kubeConfig", "context", "namespace", "pod"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("invalid_deployment_selector");
  const kind = input.kind || "auto";
  if (!KINDS.includes(kind)) throw new Error("invalid_deployment_selector");
  const result = { root, kind };
  if (kind === "systemd") {
    if (typeof input.unit !== "string" || !/^[A-Za-z0-9_.@-]{1,128}\.service$/.test(input.unit)) throw new Error("invalid_deployment_selector");
    result.unit = input.unit; result.userService = input.userService === true;
  }
  if (kind === "docker") {
    if (typeof input.container !== "string" || !/^[a-f0-9]{12,64}$/.test(input.container)) throw new Error("invalid_deployment_selector");
    rootCommand(input.socket || "/var/run/docker.sock");
    result.container = input.container; result.socket = input.socket || "/var/run/docker.sock";
  }
  if (kind === "kubernetes") {
    rootCommand(input.kubeConfig);
    if (typeof input.context !== "string" || input.context.length > 128 || /[\x00-\x1f\x7f]/.test(input.context) || ![input.namespace, input.pod].every(value => typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value))) throw new Error("invalid_deployment_selector");
    Object.assign(result, { kubeConfig: input.kubeConfig, context: input.context, namespace: input.namespace, pod: input.pod });
  }
  return result;
}
function deploymentProbe(root, spec) {
  const validated = validateDeployment(root, spec);
  const argument = Buffer.from(JSON.stringify(validated)).toString("base64");
  return { command: `python3 -B -I - '${argument}'`, input: fs.readFileSync(path.join(__dirname, "deployment-inspect.py"), "utf8") };
}
const enumValue = (value, allowed, fallback = "unknown") => allowed.includes(value) ? value : fallback;
function projectDeployment(raw = {}) {
  const layout = enumValue(raw.layout, ["native-v1", "appliance-v1"]);
  const identityEstablished = layout !== "unknown" && raw.identityEstablished === true && raw.runtime?.bound === true;
  const runtimeState = enumValue(raw.runtime?.state, STATE_VALUES);
  const configuration = Object.fromEntries(CONFIG_SLOTS.map(key => [key, enumValue(raw.configuration?.[key], FILE_STATES)]));
  const configurationReadable = layout !== "unknown" && configuration.userGame === "readable" && configuration.userEngine === "readable";
  const settings = {};
  if (configurationReadable) for (const [key, [min, max]] of Object.entries(SETTINGS)) if (typeof raw.settings?.[key] === "number" && Number.isFinite(raw.settings[key]) && raw.settings[key] >= min && raw.settings[key] <= max) settings[key] = raw.settings[key];
  const numberVersion = value => typeof value === "string" && /^[0-9]{1,8}(?:\.[0-9]{1,8}){0,3}$/.test(value) ? value : null;
  const steamBuild = typeof raw.version?.steamBuild === "string" && /^[0-9]{1,12}$/.test(raw.version.steamBuild) ? raw.version.steamBuild : null;
  const result = {
    layout, classification: layout === "unknown" ? "Unsupported" : "Experimental", identityEstablished,
    runtime: { kind: enumValue(raw.runtime?.kind, ["native", "systemd", "docker", "kubernetes"]), state: runtimeState, bound: identityEstablished, scope: enumValue(raw.runtime?.scope, ["process", "service", "workload"]), health: enumValue(raw.runtime?.health, ["healthy", "unhealthy", "starting"]), ready: typeof raw.runtime?.ready === "boolean" ? raw.runtime.ready : null },
    configuration, settings, version: { steamBuild, revision: numberVersion(raw.version?.revision) },
    permissions: { rootReadable: raw.rootReadable === true || raw.permissions?.rootReadable === true, processScanComplete: raw.processScanComplete === true || raw.permissions?.processScanComplete === true, runtimeReadable: raw.runtime?.readable === true || raw.permissions?.runtimeReadable === true },
    process: { gameProcessCount: Number.isInteger(raw.gameProcessCount ?? raw.process?.gameProcessCount) && (raw.gameProcessCount ?? raw.process?.gameProcessCount) >= 0 && (raw.gameProcessCount ?? raw.process?.gameProcessCount) <= 256 ? (raw.gameProcessCount ?? raw.process?.gameProcessCount) : 0 },
    databaseEvidence: { processObserved: typeof (raw.postgresProcessObserved ?? raw.databaseEvidence?.processObserved) === "boolean" ? (raw.postgresProcessObserved ?? raw.databaseEvidence?.processObserved) : null, listenerObserved: typeof (raw.postgresListenerObserved ?? raw.databaseEvidence?.listenerObserved) === "boolean" ? (raw.postgresListenerObserved ?? raw.databaseEvidence?.listenerObserved) : null, connectionMethod: "not_configured" },
    administrative: { configured: raw.administrative?.configured === true, functional: false, reason: "protocol_not_validated" },
    software: { python: numberVersion(raw.pythonVersion ?? raw.software?.python), containerEngine: numberVersion(raw.runtime?.version ?? raw.software?.containerEngine) },
    applicationHealth: "not_probed", errors: Array.isArray(raw.errors) ? [...new Set(raw.errors.filter(value => ["unsafe_path", "permission_denied", "missing", "output_limit", "probe_failed", "timeout", "unsupported_auth", "identity_unbound"].includes(value)))].slice(0, 8) : []
  };
  return result;
}
function deploymentCapabilities(deployment) {
  return { identityEstablished: deployment.identityEstablished, runtimeKnown: deployment.identityEstablished && deployment.runtime.state !== "unknown", configurationReadable: deployment.layout !== "unknown" && deployment.configuration.userGame === "readable" && deployment.configuration.userEngine === "readable", versionKnown: deployment.layout !== "unknown" && Boolean(deployment.version.steamBuild || deployment.version.revision) };
}
module.exports = { validateDeployment, deploymentProbe, projectDeployment, deploymentCapabilities };
