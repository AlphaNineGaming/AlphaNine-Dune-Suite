"use strict";
const { USER_GAME_SETTINGS_SCHEMA } = require("../user-game-settings");
// The same Suite routes serve every provider. Missing adapters never fall through
// to Hyper-V. Legacy handlers retain their original admission and implementations.
const ROUTES = Object.freeze([
  ["GET", "/api/status", "status", "server.status", "dashboard"],
  ["GET", "/api/server-health", "health", "runtime.health", "server-health"],
  ["GET", "/api/server-update/check", "version", "server.version", "server"],
  ["GET", "/api/usergame-settings", "configuration", "configuration.inspect", "usergame-settings"],
  ["GET", "/api/database/status", "database", "database.inspect", "database"],
  ["GET", "/api/admin/players", "players", "players.read", "players"],
  ["GET", "/api/players/feed", "players", "players.read", "dashboard"],
  ["GET", "/api/database-browser/schemas", "explorer.schemas", "database.explorer", "database-explorer"],
  ["GET", "/api/database-browser/tables", "explorer.tables", "database.explorer", "database-explorer"],
  ["GET", "/api/database-browser/describe", "explorer.describe", "database.explorer", "database-explorer"],
  ["POST", "/api/database-browser/rows", "explorer.rows", "database.explorer", "database-explorer"]
].map(([method, path, operation, capability, page]) => Object.freeze({ method, path, operation, capability, page })));
function resolveFeatureRoute(path, method) { return ROUTES.find(route => route.path === path && route.method === method) || null; }
function adaptFeatureResult(operation, result) {
  const data = result.data, metadata = { provider: "remote-linux", classification: "Experimental", readOnly: true, limitations: result.limitations };
  if (operation.startsWith("explorer.")) return { ...data, ...metadata };
  if (operation === "status") {
    const runtime = data.state, mapped = { label: runtime === "running" || runtime === "active" || runtime === "Running" ? "Running (runtime only)" : runtime, online: false, applicationHealth: "unknown" };
    return { ok: true, ...metadata, status: { summary: { status: mapped.label, uptime: "Unknown" }, servers: [], raw: "Scoped " + data.kind + " state: " + runtime + ". Game protocol health, player totals and resources are unverified." }, serverStatus: mapped, topServerStatus: mapped, vm: { state: "Unavailable", message: "This provider has no VM adapter." }, database: { status: "unknown" }, runtime: data };
  }
  if (operation === "health") return { ok: true, ...metadata, state: "Unknown", checkedAt: new Date().toISOString(), reasons: ["Scoped runtime state: " + data.runtime.state, "Application health and uncollected services/resources are unknown."], summary: { podInventoryAvailable: false }, connectivity: { hyperv: { state: "Unsupported", message: "No VM adapter." }, ssh: { state: "Healthy", message: "Bounded authenticated read completed." }, kubernetes: { state: "Unknown", message: "No cluster health scan." } }, services: { dune: { state: "Unknown", message: "Runtime " + data.runtime.state + "; game protocol not probed." } }, resources: { observed: false }, runtime: data.runtime, process: data.process };
  if (operation === "version") return { ok: true, ...metadata, currentBuildId: data.steamBuild, downloadedRevision: data.revision, deployedRevision: null, updateAvailable: null, updateAssessment: "not_probed", reason: "Observed version metadata only; update availability is unknown." };
  if (operation === "configuration") return { ok: true, ...metadata, schema: USER_GAME_SETTINGS_SCHEMA.filter(setting => Object.hasOwn(data.settings, setting.key)), values: data.settings, missingKeys: [], locations: data.locations, path: "Recognized configuration slots (paths excluded)", content: "Full configuration content is excluded. Only allowlisted typed settings are inspected." };
  if (operation === "database") return { ok: data.authenticated, ...metadata, status: "connected-read-only", message: "TLS connectivity and restricted effective privileges checked; association with this game deployment is operator supplied.", uptime: "Unknown", connections: "Unknown", activeQueries: "Unknown", evidence: data };
  if (operation === "players") return { ok: true, ...metadata, players: data.players.map(player => ({ id: player.id, name: player.name, character_name: player.name, online_status: player.status, account_id: null, character_id: null, player_controller_id: null, player_state_row_id: null, identityScope: "player-state-row-only", mutationsAvailable: false })), playerDirectory: { cacheStatus: "fresh-provider-read", warning: "Limited table rows; account/controller identity and player actions are unavailable." } };
  throw new Error("feature_unavailable");
}
function createFeatureRouter({ providers, selection }) {
  return Object.freeze({
    resolve: resolveFeatureRoute,
    async dispatch(config, route, input = {}) {
      if (selection(config) === "legacy") return { handled: false, adapter: "hyperv-legacy" };
      if (selection(config) !== "remote-linux" || !ROUTES.includes(route)) throw new Error("feature_unavailable");
      const result = await providers.read(route.operation, { limit: 100, input });
      return { handled: true, payload: adaptFeatureResult(route.operation, result) };
    }
  });
}
module.exports = { ROUTES, resolveFeatureRoute, adaptFeatureResult, createFeatureRouter };
