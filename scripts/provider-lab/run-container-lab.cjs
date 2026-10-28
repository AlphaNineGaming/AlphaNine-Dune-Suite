"use strict";
// Opt-in, real disposable Linux/SSH/PostgreSQL integration; never starts the Suite.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createRemoteLinuxProvider, createSshProbeTransport } = require("../../lib/providers/remote-linux");
const { createRemoteDatabase } = require("../../lib/providers/remote-database");
const { sanitizeReport } = require("../../lib/providers/report");
const { runProcess } = require("../../lib/providers/process-runner");
const suite = path.resolve(__dirname, "../.."), output = path.join(suite, "work/provider-container-lab");
fs.mkdirSync(output, { recursive: true });
const resultFile = path.join(output, "results.json"), results = [], runId = "a9-provider-" + crypto.randomBytes(6).toString("hex");
let container, imageId;
function command(binary, args, options = {}) { return execFileSync(binary, args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...options }).trim(); }
function docker(args, options) { return command("docker", args, options); }
async function check(name, work) { await work(); results.push({ name, passed: true }); console.log("PASS " + name); }
async function main() {
  try { docker(["version", "--format", "{{.Server.Version}}"]); command("ssh", ["-V"], { stdio: ["ignore", "pipe", "ignore"] }); }
  catch { fs.writeFileSync(resultFile, JSON.stringify({ status: "not_executed", reason: "Docker daemon and OpenSSH client required", results }, null, 2)); process.exitCode = 2; return; }
  const base = process.env.A9_PROVIDER_LAB_BASE;
  if (!/^debian:bookworm-slim@sha256:[a-f0-9]{64}$/.test(base || "")) throw new Error("Set A9_PROVIDER_LAB_BASE to an explicitly selected Debian bookworm-slim digest; tags alone are refused.");
  const dir = path.join(output, runId); fs.mkdirSync(dir);
  const key = path.join(dir, "client"), other = path.join(dir, "wrong-client"), trust = path.join(dir, "known_hosts"), badTrust = path.join(dir, "wrong_known_hosts"), ca = path.join(dir, "ca.crt");
  for (const name of [key, other]) command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", name]);
  try {
    docker(["build", "--file", path.join(__dirname, "Dockerfile.linux"), "--build-arg", "BASE_IMAGE=" + base, "--iidfile", path.join(dir, "image-id"), "-t", runId, __dirname], { timeout: 600000, stdio: "inherit" });
    imageId = fs.readFileSync(path.join(dir, "image-id"), "utf8").trim();
    container = docker(["run", "--detach", "--name", runId, "--label", "org.alphanine.provider-lab.run=" + runId, "--mount", `type=bind,source=${key}.pub,target=/run/lab/client.pub,readonly`, "-p", "127.0.0.1::22", "-p", "127.0.0.1::5432", imageId]);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { docker(["exec", container, "test", "-f", "/run/lab-ready"]); ready = true; break; } catch {} await new Promise(resolve => setTimeout(resolve, 500)); }
    assert(ready, "Fixture services did not become ready");
    const port = Number(docker(["port", container, "22/tcp"]).split(":").at(-1)), pgPort = Number(docker(["port", container, "5432/tcp"]).split(":").at(-1));
    assert(Number.isInteger(port) && Number.isInteger(pgPort));
    // Trust comes from this newly created container, never keyscan/untrusted TOFU.
    const hostKey = docker(["exec", container, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"]).split(" ").slice(0, 2).join(" ");
    fs.writeFileSync(trust, `[127.0.0.1]:${port} ${hostKey}\n`);
    fs.writeFileSync(badTrust, `[127.0.0.1]:${port} ${fs.readFileSync(other + ".pub", "utf8").split(" ").slice(0, 2).join(" ")}\n`);
    fs.writeFileSync(ca, docker(["exec", container, "cat", "/srv/lab-pg/server.crt"]) + "\n");
    const endpoint = { host: "127.0.0.1", user: "diagnostic", port, keyPath: key, knownHostsPath: trust };
    const transport = createSshProbeTransport(endpoint);
    await check("real Linux SSH identity and scoped synthetic ELF process", async () => {
      const report = sanitizeReport(await createRemoteLinuxProvider({ transport, runtimeRoot: "/srv/dune" }).discover());
      assert.equal(report.deployment.layout, "native-v1"); assert.equal(report.deployment.runtime.state, "running"); assert(report.deployment.identityEstablished); assert.equal(report.classification, "Experimental");
      assert(!JSON.stringify(report).includes("canary")); assert.equal(report.capabilities["runtime.stop"].available, false);
      fs.writeFileSync(path.join(dir, "sanitized-report.json"), JSON.stringify(report, null, 2));
    });
    await check("real SSH wrong authentication and mismatched host trust fail closed", async () => {
      for (const overrides of [{ keyPath: other }, { knownHostsPath: badTrust }]) assert.equal((await createSshProbeTransport({ ...endpoint, ...overrides }).probe("os")).ok, false);
    });
    await check("Linux Unix-socket container discovery using a synthetic GET-only engine protocol", async () => {
      const report = sanitizeReport(await createRemoteLinuxProvider({ transport, runtimeRoot: "/srv/dune", deployment: { kind: "docker", socket: "/srv/lab/docker.sock", container: "a".repeat(12) } }).discover());
      assert.equal(report.deployment.runtime.kind, "docker"); assert.equal(report.deployment.runtime.health, "healthy"); assert(report.deployment.identityEstablished); assert(!JSON.stringify(report).includes("canary"));
    });
    await check("missing permissions and unsupported layouts cannot enable runtime reads", async () => {
      for (const root of ["/srv/denied", "/srv/unknown"]) { const report = await createRemoteLinuxProvider({ transport, runtimeRoot: root }).discover(); assert.equal(report.capabilities["server.status"].available, false); }
    });
    const dbConfig = { remoteDatabaseEnabled: true, remoteDatabaseHost: "127.0.0.1", remoteDatabasePort: pgPort, remoteDatabaseName: "dune", remoteDatabaseUser: "reader", remoteDatabasePassword: "fixture-reader-password", remoteDatabaseCaPath: ca }, database = createRemoteDatabase();
    await check("real PostgreSQL TLS, role/schema validation and synthetic player read", async () => { const result = await database.inspect(dbConfig, { players: true }); assert.equal(result.schemaValidated, true); assert.equal(result.players[0].name, "Synthetic player"); });
    await check("real PostgreSQL authentication, write privilege and unknown schema failures", async () => {
      for (const overrides of [{ remoteDatabasePassword: "wrong" }, { remoteDatabaseCaPath: "" }, { remoteDatabaseUser: "writer", remoteDatabasePassword: "fixture-writer-password" }]) assert.equal((await database.inspect({ ...dbConfig, ...overrides }, { players: true })).authenticated, false);
      const unsupported = await database.inspect({ ...dbConfig, remoteDatabaseName: "unknown" }, { players: true }); assert.equal(unsupported.authenticated, true); assert.equal(unsupported.schemaValidated, false); assert.equal(unsupported.players, undefined);
    });
    await check("real SSH timeout and interrupted connection discard partial output", async () => {
      const args = ["-F", process.platform === "win32" ? "NUL" : "/dev/null", "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "UserKnownHostsFile=" + trust, "-i", key, "-p", String(port), "--", "diagnostic@127.0.0.1", "sleep 60"];
      assert.equal((await runProcess("ssh", args, { timeoutMs: 250 })).ok, false);
      const interrupted = runProcess("ssh", args, { timeoutMs: 5000 }); await new Promise(resolve => setTimeout(resolve, 400)); docker(["stop", "--time", "0", container]); assert.equal((await interrupted).ok, false);
      assert.equal((await database.inspect(dbConfig)).authenticated, false);
    });
    fs.writeFileSync(resultFile, JSON.stringify({ status: "passed", evidence: "synthetic disposable Linux/SSH/PostgreSQL; NOT real Dune compatibility", base, imageId, aptSnapshot: "20250901T000000Z", results, untested: ["real Funcom payload", "real Docker API", "real systemd daemon", "real Kubernetes cluster", "production permissions", "real game schema"] }, null, 2));
  } catch (error) { fs.writeFileSync(resultFile, JSON.stringify({ status: "failed", imageId, results, failure: error.message }, null, 2)); process.exitCode = 1; }
  finally {
    if (container) {
      // Verify exact run ownership before removing anything, including on failure.
      const owner = docker(["inspect", "--format", '{{index .Config.Labels "org.alphanine.provider-lab.run"}}', container]);
      if (owner === runId) docker(["rm", "--force", container]);
    }
    // Images and local keys remain confined to this lab; no broad prune/delete.
  }
}
main().catch(error => { fs.writeFileSync(resultFile, JSON.stringify({ status: "not_executed", reason: error.message, results }, null, 2)); process.exitCode = 2; });
