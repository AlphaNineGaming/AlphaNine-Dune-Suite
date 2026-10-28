"use strict";

const LOCAL_ALIASES = new Set(["local-hyperv", "local-windows", "hyperv", "hyper-v", "local", "remote-vm", "remote", "manual"]);
const FACETS = Object.freeze({ vm: ["inspect"], runtime: ["inspect"], database: ["inspect"], filesystem: ["inspect"] });
const MUTATIONS = Object.freeze(["vm.start", "vm.stop", "vm.restart", "vm.compact", "runtime.start", "runtime.stop", "runtime.update", "database.write", "database.restore", "filesystem.write", "filesystem.delete"]);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function providerId(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid_config");
  const type = config.serverType == null ? "local-hyperv" : String(config.serverType).trim().toLowerCase();
  if (!type || LOCAL_ALIASES.has(type)) return "hyperv-legacy";
  if (type === "remote-linux") return "remote-linux";
  throw new Error("unsupported_provider");
}
// An in-memory view only. It never rewrites the legacy configuration file.
function projectConfig(config) {
  const original = copy(config);
  return { schemaVersion: 1, provider: providerId(original), original };
}
function rollbackProjection(view) {
  if (!view || view.schemaVersion !== 1 || !view.original || providerId(view.original) !== view.provider) throw new Error("invalid_projection");
  return copy(view.original);
}
function createLegacyHyperVProvider(readers = {}) {
  const provider = { id: "hyperv-legacy", classification: "Experimental", evidence: "static-baseline-only" };
  for (const [facet, methods] of Object.entries(FACETS)) {
    provider[facet] = Object.freeze(Object.fromEntries(methods.map(method => [method, (...args) => {
      if (typeof readers[facet]?.[method] !== "function") throw new Error("legacy_reader_not_bound");
      return readers[facet][method](...args);
    }])));
  }
  return Object.freeze(provider);
}
function capabilities({ linux = false, rootReadable = false, identityEstablished = false, runtimeKnown = false, configurationReadable = false, versionKnown = false, databaseAuthenticated = false, playersValidated = false } = {}) {
  const observed = (available, reason) => Object.freeze({ available, classification: available ? "Experimental" : "Unsupported", reason, evidence: available ? "read-probe-only" : "none" });
  const result = {
    "diagnostics.read": observed(linux === true, linux === true ? "linux_observed" : "linux_not_established"),
    "filesystem.inspect": observed(rootReadable === true, rootReadable === true ? "root_readable" : "root_not_established"),
    "runtime.inspect": observed(identityEstablished && runtimeKnown, identityEstablished && runtimeKnown ? "scoped_runtime_observed" : "runtime_identity_not_validated"),
    "server.status": observed(identityEstablished && runtimeKnown, identityEstablished && runtimeKnown ? "scoped_runtime_observed" : "runtime_identity_not_validated"),
    "runtime.health": observed(identityEstablished && runtimeKnown, identityEstablished && runtimeKnown ? "process_or_workload_health_only" : "runtime_identity_not_validated"),
    "configuration.inspect": observed(identityEstablished && configurationReadable, identityEstablished && configurationReadable ? "allowlisted_configuration_read" : "layout_not_established"),
    "server.version": observed(identityEstablished && versionKnown, identityEstablished && versionKnown ? "version_metadata_observed" : "version_not_established"),
    "database.inspect": observed(databaseAuthenticated, databaseAuthenticated ? "authenticated_read_only_transaction" : "database_not_probed"),
    "players.read": observed(playersValidated, playersValidated ? "schema_and_read_only_role_validated" : "schema_or_permissions_not_validated"),
    "database.explorer": observed(playersValidated, playersValidated ? "allowlisted_table_schema_and_permissions_validated" : "schema_or_permissions_not_validated")
  };
  for (const feature of MUTATIONS) result[feature] = observed(false, "not_implemented");
  return Object.freeze(result);
}
function requireFeature(snapshot, feature) {
  // Caller-supplied observations cannot unlock mutations, even if labelled Verified.
  if (!Object.hasOwn(capabilities(), feature) || MUTATIONS.includes(feature) || !Object.hasOwn(snapshot || {}, feature) || snapshot[feature]?.available !== true) throw new Error("feature_unavailable");
}
module.exports = { LOCAL_ALIASES, FACETS, MUTATIONS, providerId, projectConfig, rollbackProjection, createLegacyHyperVProvider, capabilities, requireFeature };
