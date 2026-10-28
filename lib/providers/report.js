"use strict";
const { TOOLS } = require("./remote-linux");
const { capabilities } = require("./foundation");
const { projectDeployment, deploymentCapabilities } = require("./deployment");
const { publicDatabase } = require("./remote-database");

// Reconstruct from approved values; never recursively serialize or regex-redact input.
function sanitizeReport(input) {
  const env = input?.environment || {};
  const pick = (value, allowed, fallback = "unknown") => allowed.includes(value) ? value : fallback;
  const os = pick(env.os, ["linux"]);
  const root = pick(env.runtimeRoot, ["readable", "unavailable", "not_probed"]);
  const checks = {};
  for (const id of ["os", "architecture", "distribution", "tools", "root", "deployment"]) {
    if (Object.hasOwn(input?.checks || {}, id)) {
      const check = input.checks[id];
      const code = pick(check?.code, ["observed", "timeout", "output_limit", "probe_failed"], "probe_failed");
      checks[id] = { ok: check?.ok === true && code === "observed", code };
    }
  }
  const deployment = projectDeployment(input?.deployment || {});
  // projectDeployment accepts both raw agent and previously projected reports.
  if (os !== "linux" || root !== "readable") {
    deployment.layout = "unknown"; deployment.classification = "Unsupported"; deployment.identityEstablished = false; deployment.runtime.bound = false;
    deployment.settings = {}; deployment.version = { steamBuild: null, revision: null };
  }
  const database = publicDatabase(input?.database || {});
  if (!deployment.identityEstablished) { database.authenticated = false; database.schemaValidated = false; database.readOnlyRole = false; database.schemaProfile = "unsupported"; database.reason = "deployment_not_established"; }
  return { schemaVersion: 1, provider: "remote-linux", classification: "Experimental", environment: { os, architecture: pick(env.architecture, ["x86_64", "aarch64"]), distribution: pick(env.distribution, ["alpine", "ubuntu", "debian", "fedora", "rocky", "almalinux", "rhel", "arch", "opensuse"]), tools: Object.fromEntries(TOOLS.map(tool => [tool, typeof env.tools?.[tool] === "boolean" ? env.tools[tool] : null])), runtimeRoot: root }, deployment, database, checks, capabilities: capabilities({ linux: os === "linux", rootReadable: os === "linux" && root === "readable", ...deploymentCapabilities(deployment), databaseAuthenticated: database.authenticated, playersValidated: database.schemaValidated }), limitations: ["application_health_not_probed", "no_real_deployment_evidence", "mutations_unavailable", "player_data_excluded_from_report"] };
}
module.exports = { sanitizeReport };
