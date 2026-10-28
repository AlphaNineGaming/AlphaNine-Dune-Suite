"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createLegacyHyperVProvider, capabilities, MUTATIONS, LOCAL_ALIASES, requireFeature } = require("./foundation");
const { createRemoteLinuxProvider, createSshProbeTransport, validateEndpoint, rootCommand } = require("./remote-linux");
const { sanitizeReport } = require("./report");
const { validateDeployment } = require("./deployment");
const { databaseSettings, createRemoteDatabase, publicDatabase, validateExplorer } = require("./remote-database");
const { resolveFeatureRoute, ROUTES } = require("./feature-router");
const { targetIdentity } = require("./target-binding");

const LEGACY_TYPES = new Set(["", ...LOCAL_ALIASES]);
const PLANNED_TYPES = new Set(["docker", "proxmox", "managed-hosting"]);
function selection(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "unsupported";
  const value = String(config.serverType || "local-hyperv").trim().toLowerCase();
  return LEGACY_TYPES.has(value) ? "legacy" : value === "remote-linux" ? "remote-linux" : "unsupported";
}
function startupPermissions(config = {}) {
  // Existing profiles without setupComplete retain their previous startup policy.
  const legacy = selection(config) === "legacy";
  return Object.freeze({ legacy, allowAutomation: legacy && config?.setupComplete !== false, diagnosticOnly: !legacy });
}
function readBootstrapConfig({ configPath, appData, platform = process.platform, env = process.env } = {}) {
  const file = configPath || env.ALPHANINE_CONFIG_PATH || path.join(appData || env.ALPHANINE_DATA_DIR || (platform === "win32" ? path.join(env.APPDATA || "", "AlphaNine Dune Suite") : path.join(env.XDG_DATA_HOME || path.join(require("node:os").homedir(), ".local", "share"), "alphanine-dune-suite")), "config.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { return error.code === "ENOENT" ? { setupComplete: false } : { serverType: "invalid-profile" }; }
}
function remoteEndpoint(config) {
  const endpoint = { host: config.sshHost, user: config.sshUser, port: config.sshPort ?? 22, keyPath: config.sshKey, knownHostsPath: config.sshKnownHostsPath };
  validateEndpoint(endpoint);
  if (config.remoteRuntimeRoot) validateDeployment(config.remoteRuntimeRoot, config.remoteDeployment || {});
  else if (config.remoteDeployment && Object.keys(config.remoteDeployment).length) throw new Error("runtime_root_required");
  databaseSettings(config);
  return endpoint;
}
function validateSelectionChange(current, requested, { allowAutomation }) {
  const next = { ...current, ...requested };
  if (selection(next) === "unsupported") throw new Error("This server type is planned or unsupported. Its server operations are unavailable.");
  if (selection(next) !== selection(current) && allowAutomation) throw new Error("Changing provider requires a separate diagnostic profile or an isolated setup session. The current installation remains unchanged.");
  if (selection(next) === "remote-linux") remoteEndpoint(next);
  return next;
}
const catalog = Object.freeze([
  { id: "local-hyperv", label: "Local Windows / Hyper-V", classification: "Experimental", implemented: true, reason: "Existing behavior retained; no new live verification claim." },
  { id: "remote-linux", label: "Remote Linux / VPS (read-only)", classification: "Experimental", implemented: true, reason: "Scoped reads require fresh deployment and permission evidence; mutations unavailable." },
  ...[["docker", "Docker"], ["proxmox", "Proxmox"], ["managed-hosting", "Managed hosting"]].map(([id, label]) => ({ id, label, classification: "Unsupported", implemented: false, reason: "Planned; no implementation or deployment evidence." }))
]);
function routeDecision(config, pathname, method) {
  if (selection(config) === "legacy") return { allowed: true };
  const type = String(method || "GET").toUpperCase();
  const allowed = Boolean(selection(config) === "remote-linux" && resolveFeatureRoute(pathname, type)) || (type === "GET" && ["/", "/manifest.webmanifest", "/service-worker.js", "/api/config", "/api/setup/status", "/api/providers/status", "/api/providers/report", "/api/providers/catalog"].includes(pathname))
    || (type === "GET" && pathname.startsWith("/assets/"))
    || (type === "POST" && ["/api/config", "/api/setup/save", "/api/providers/diagnose", "/api/providers/read"].includes(pathname));
  return { allowed, code: allowed ? undefined : "provider_feature_unavailable", status: allowed ? 200 : 403 };
}
function fingerprint(config) {
  return targetIdentity(config);
}
const READ_OPERATIONS = Object.freeze({ status: "server.status", health: "runtime.health", configuration: "configuration.inspect", version: "server.version", database: "database.inspect", players: "players.read", "explorer.schemas": "database.explorer", "explorer.tables": "database.explorer", "explorer.describe": "database.explorer", "explorer.rows": "database.explorer" });
function providerLocalRequest(req) {
  try {
    const local = new URL("http://" + req.headers.host);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(local.hostname) || Number(local.port || 80) !== req.socket.localPort || req.headers["sec-fetch-site"] === "cross-site") return false;
    if (req.headers.origin) { const origin = new URL(req.headers.origin); if (origin.origin !== local.origin) return false; }
    return true;
  } catch { return false; }
}
function createSuiteProviders({ configuration, legacyReaders = {}, transportFactory = createSshProbeTransport, database = createRemoteDatabase(), now = Date.now, ttlMs = 60000 }) {
  const legacy = createLegacyHyperVProvider(legacyReaders);
  let last = null, pending = null, uiIdentity = fingerprint(configuration()), targetRevision = crypto.randomUUID();
  const cached = () => last?.identity === fingerprint(configuration()) && now() - last.checkedAt <= ttlMs ? last.report : null;
  async function collect(input, { players = false, limit = 50, explorer } = {}) {
    input = JSON.parse(JSON.stringify(input)); // Pin the provider/target before awaiting.
    if (selection(input) !== "remote-linux") throw new Error("remote_linux_required");
    if (pending) throw new Error("diagnostic_already_running");
    const identity = fingerprint(input);
    const endpoint = remoteEndpoint(input);
    const provider = createRemoteLinuxProvider({ transport: transportFactory(endpoint), ...(input.remoteRuntimeRoot ? { runtimeRoot: input.remoteRuntimeRoot, deployment: input.remoteDeployment || {} } : {}) });
    pending = (async () => {
      const observed = await provider.discover();
      let privatePlayers, privateExplorer;
      if (observed.deployment.identityEstablished && input.remoteDatabaseEnabled === true) {
        const inspected = await database.inspect(input, { players, limit, explorer });
        observed.database = publicDatabase(inspected);
        if (players && inspected.schemaValidated && Array.isArray(inspected.players)) privatePlayers = inspected.players;
        if (explorer && inspected.schemaValidated && inspected.explorer) privateExplorer = inspected.explorer;
      } else observed.database = publicDatabase({ reason: input.remoteDatabaseEnabled ? "deployment_not_established" : "not_configured" });
      const report = sanitizeReport(observed);
      if (fingerprint(configuration()) === identity) last = { identity, checkedAt: now(), report };
      return { identity, report, privatePlayers, privateExplorer };
    })();
    try { return await pending; } finally { pending = null; }
  }
  return Object.freeze({
    current() { return selection(configuration()) === "legacy" ? legacy : null; },
    status() {
      const config = configuration(), mode = selection(config);
      if (fingerprint(config) !== uiIdentity) { uiIdentity = fingerprint(config); targetRevision = crypto.randomUUID(); }
      const report = cached();
      const legacyCapabilities = Object.fromEntries(["diagnostics.read", "vm.inspect", "runtime.inspect", "database.inspect", "filesystem.inspect", ...MUTATIONS].map(id => [id, { available: MUTATIONS.includes(id) ? null : true, classification: "Experimental", evidence: "existing-legacy-path", reason: MUTATIONS.includes(id) ? "Availability remains subject to existing per-action identity, state and permission checks." : "Existing Suite read path; not newly deployment-verified." }]));
      return { ok: true, provider: mode === "legacy" ? "hyperv-legacy" : mode === "remote-linux" ? "remote-linux" : "unsupported", diagnosticOnly: mode !== "legacy", classification: mode === "unsupported" ? "Unsupported" : "Experimental", capabilities: mode === "legacy" ? legacyCapabilities : report?.capabilities || capabilities(), report, catalog, featureRoutes: ROUTES, targetRevision };
    },
    report() { return cached(); },
    async diagnose(input = configuration()) {
      return (await collect(input)).report;
    },
    async read(operation, { limit = 50, input = {} } = {}) {
      if (!Object.hasOwn(READ_OPERATIONS, operation)) throw new Error("feature_unavailable");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("feature_unavailable");
      const explorer = operation.startsWith("explorer.") ? { action: operation.slice(9), input } : undefined;
      if (explorer) validateExplorer(explorer.action, input);
      const result = await collect(configuration(), { players: operation === "players", limit, explorer });
      if (fingerprint(configuration()) !== result.identity) throw new Error("deployment_changed");
      requireFeature(result.report.capabilities, READ_OPERATIONS[operation]);
      if (operation === "players" && !Array.isArray(result.privatePlayers)) throw new Error("feature_unavailable");
      if (explorer && !result.privateExplorer) throw new Error("feature_unavailable");
      const deployment = result.report.deployment;
      const data = operation === "status" ? { layout: deployment.layout, ...deployment.runtime }
        : operation === "health" ? { runtime: deployment.runtime, process: deployment.process, applicationHealth: "not_probed" }
        : operation === "configuration" ? { locations: deployment.configuration, settings: deployment.settings }
        : operation === "version" ? deployment.version
        : operation === "database" ? result.report.database
        : explorer ? result.privateExplorer : { players: result.privatePlayers || [], schemaProfile: result.report.database.schemaProfile };
      return { ok: true, classification: "Experimental", operation, data, limitations: ["no_real_deployment_evidence", "mutations_unavailable"] };
    }
  });
}
module.exports = { LEGACY_TYPES, PLANNED_TYPES, READ_OPERATIONS, providerLocalRequest, selection, startupPermissions, readBootstrapConfig, remoteEndpoint, validateSelectionChange, routeDecision, catalog, createSuiteProviders };
