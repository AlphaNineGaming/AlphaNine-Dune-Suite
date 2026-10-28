"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { runProcess } = require("./process-runner");
const { capabilities } = require("./foundation");
const { rootCommand } = require("./remote-linux-path");
const { deploymentProbe, validateDeployment, projectDeployment, deploymentCapabilities } = require("./deployment");

const PROBES = Object.freeze({
  os: "LC_ALL=C uname -s",
  architecture: "LC_ALL=C uname -m",
  distribution: "LC_ALL=C cat /etc/os-release",
  tools: "for t in kubectl docker systemctl rc-service psql; do if command -v \"$t\" >/dev/null 2>&1; then printf '%s\\n' \"$t\"; fi; done"
});
const TOOLS = Object.freeze(["kubectl", "docker", "systemctl", "rc-service", "psql"]);
function validateEndpoint(input) {
  const { host, user, keyPath, knownHostsPath } = input || {};
  // Conservative SSH destination grammar; IPv6 literals are deliberately deferred.
  if (typeof host !== "string" || host.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) throw new Error("invalid_host");
  if (typeof user !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(user)) throw new Error("invalid_user");
  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_port");
  for (const file of [keyPath, knownHostsPath]) {
    if (typeof file !== "string" || /[\x00-\x1f\x7f]/.test(file) || !path.isAbsolute(file)) throw new Error("invalid_ssh_file");
    try { if (!fs.statSync(file).isFile()) throw new Error(); fs.accessSync(file, fs.constants.R_OK); }
    catch { throw new Error("unreadable_ssh_file"); }
  }
  return { host, user, port, keyPath, knownHostsPath };
}
function createSshProbeTransport(endpoint, { runner = runProcess, timeoutMs = 5000 } = {}) {
  const target = validateEndpoint(endpoint);
  // OpenSSH -o uses its own parsing even when spawn uses an argv array.
  // Quote the explicit known-hosts path, rejecting its quoting metacharacters.
  if (/["%]/.test(target.knownHostsPath) || target.knownHostsPath.includes("${")) throw new Error("invalid_ssh_file");
  const knownHosts = target.knownHostsPath.replace(/\\/g, "/");
  const args = ["-T", "-F", process.platform === "win32" ? "NUL" : "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile="${knownHosts}"`, "-o", "GlobalKnownHostsFile=none", "-o", "UpdateHostKeys=no", "-o", "ClearAllForwardings=yes", "-o", "ProxyCommand=none", "-o", "ConnectionAttempts=1", "-o", "ConnectTimeout=5", "-p", String(target.port), "-i", target.keyPath, `${target.user}@${target.host}`];
  return Object.freeze({
    async probe(id, root) {
      if (id === "deployment") {
        const probe = deploymentProbe(root.root, root.selector);
        return runner(process.platform === "win32" ? "ssh.exe" : "ssh", [...args, probe.command], { timeoutMs: 10000, maxBytes: 65536, input: probe.input });
      }
      const command = id === "root" ? rootCommand(root) : Object.hasOwn(PROBES, id) ? PROBES[id] : null;
      if (!command) throw new Error("probe_not_allowed");
      return runner(process.platform === "win32" ? "ssh.exe" : "ssh", [...args, command], { timeoutMs, maxBytes: 16384 });
    }
  });
}
const ERROR_CODES = new Set(["timeout", "output_limit", "probe_failed"]);
function boundedResult(result) {
  if (!result || result.ok !== true) return { ok: false, code: ERROR_CODES.has(result?.code) ? result.code : "probe_failed" };
  if (typeof result.stdout !== "string") return { ok: false, code: "probe_failed" };
  if (Buffer.byteLength(result.stdout) > 16384) return { ok: false, code: "output_limit" };
  return { ok: true, stdout: result.stdout.trim() };
}
function createRemoteLinuxProvider({ transport, runtimeRoot, deployment = {} } = {}) {
  if (typeof transport?.probe !== "function") throw new Error("transport_required");
  if (runtimeRoot !== undefined) rootCommand(runtimeRoot);
  if (runtimeRoot !== undefined) validateDeployment(runtimeRoot, deployment);
  return Object.freeze({ id: "remote-linux", classification: "Experimental", async discover() {
    const checks = {};
    for (const id of [...Object.keys(PROBES), ...(runtimeRoot === undefined ? [] : ["root"])]) {
      try { checks[id] = boundedResult(await transport.probe(id, runtimeRoot)); }
      catch { checks[id] = { ok: false, code: "probe_failed" }; }
    }
    const linux = checks.os.ok && checks.os.stdout === "Linux";
    const arch = checks.architecture.ok && ["x86_64", "aarch64"].includes(checks.architecture.stdout) ? checks.architecture.stdout : "unknown";
    const match = checks.distribution.ok ? checks.distribution.stdout.match(/^ID=(?:"([a-z0-9_-]+)"|([a-z0-9_-]+))$/m) : null;
    const distribution = match?.[1] || match?.[2];
    const distributions = ["alpine", "ubuntu", "debian", "fedora", "rocky", "almalinux", "rhel", "arch", "opensuse"];
    const tools = Object.fromEntries(TOOLS.map(tool => [tool, checks.tools.ok ? checks.tools.stdout.split(/\r?\n/).includes(tool) : null]));
    const root = !checks.root ? "not_probed" : !checks.root.ok ? "unknown" : checks.root.stdout === "readable" ? "readable" : checks.root.stdout === "unavailable" ? "unavailable" : "unknown";
    let found = projectDeployment({ errors: ["missing"] });
    if (linux && root === "readable") {
      try {
        const result = await transport.probe("deployment", { root: runtimeRoot, selector: deployment });
        if (result?.ok !== true || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 65536) throw new Error();
        const data = JSON.parse(result.stdout);
        if (data?.schemaVersion !== 1 || typeof data !== "object" || Array.isArray(data)) throw new Error();
        found = projectDeployment(data);
        checks.deployment = { ok: true };
      } catch { checks.deployment = { ok: false, code: "probe_failed" }; found = projectDeployment({ errors: ["probe_failed"] }); }
    }
    return { schemaVersion: 1, provider: "remote-linux", classification: "Experimental", environment: { os: linux ? "linux" : "unknown", architecture: arch, distribution: distributions.includes(distribution) ? distribution : "unknown", tools, runtimeRoot: root }, deployment: found, checks: Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, { ok: value.ok, code: value.ok ? "observed" : value.code }])), capabilities: capabilities({ linux, rootReadable: linux && root === "readable", ...deploymentCapabilities(found) }), limitations: ["application_health_not_probed", "database_not_probed", "no_real_deployment_evidence", "mutations_unavailable"] };
  } });
}
module.exports = { PROBES, TOOLS, rootCommand, validateEndpoint, createSshProbeTransport, createRemoteLinuxProvider };
