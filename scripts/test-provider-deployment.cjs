"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateDeployment, deploymentProbe, projectDeployment } = require("../lib/providers/deployment");
const { createSuiteProviders, providerLocalRequest, startupPermissions } = require("../lib/providers/suite-provider");
const { sanitizeReport } = require("../lib/providers/report");
const { runProcess } = require("../lib/providers/process-runner");
const known = { schemaVersion: 1, layout: "native-v1", identityEstablished: true, runtime: { kind: "native", state: "running", bound: true, scope: "process" }, configuration: { userGame: "readable", userEngine: "readable", manifest: "readable", revision: "missing" }, version: { steamBuild: "123456" }, settings: { m_GlobalXPMultiplier: 2 }, processScanComplete: true, gameProcessCount: 1 };
const basics = { os: "Linux", architecture: "x86_64", distribution: "ID=debian", tools: "psql", root: "readable" };
test("selectors reject injection, arbitrary fields and non-normalized paths", () => {
  for (const spec of [null, [], { kind: "exec" }, { kind: "systemd", unit: "x;id.service" }, { kind: "docker", container: "--all" }, { kind: "kubernetes", kubeConfig: "/tmp/k", context: "x", namespace: "../x", pod: "x" }, { kind: "auto", command: "id" }]) assert.throws(() => validateDeployment("/srv/dune", spec));
  assert.throws(() => validateDeployment("/srv/../dune", {}));
  assert.equal(validateDeployment("/srv/dune", { kind: "docker", container: "a".repeat(12) }).socket, "/var/run/docker.sock");
  const probe = deploymentProbe("/srv/a'b", {});
  assert.match(probe.command, /^python3 -B -I - '[A-Za-z0-9+/=]+'$/);
  assert(probe.input.includes("def inspect")); assert(Buffer.byteLength(probe.input) < 65536);
});
test("projection is idempotent and strips secrets, private players and forged claims", () => {
  const canary = "private-secret@example.test";
  const raw = { ...known, paths: canary, settings: { ...known.settings, password: canary }, database: { players: [{ name: canary }] }, runtime: { ...known.runtime, env: canary } };
  const report = sanitizeReport({ deployment: raw, environment: { os: "linux", runtimeRoot: "readable" }, database: { authenticated: true, readOnlyRole: true, schemaValidated: true, schemaProfile: "dune-player-state-v1", players: [canary], password: canary } });
  assert(!JSON.stringify(report).includes(canary)); assert(!JSON.stringify(report).includes("Verified"));
  assert.deepEqual(sanitizeReport(report), report);
  assert.equal(projectDeployment({ ...known, runtime: { ...known.runtime, bound: false } }).identityEstablished, false);
  const unavailable = sanitizeReport({ deployment: raw, environment: { os: "unknown", runtimeRoot: "readable" } });
  assert.equal(unavailable.deployment.classification, "Unsupported"); assert.equal(unavailable.deployment.runtime.bound, false); assert.equal(unavailable.capabilities["configuration.inspect"].available, false);
});
test("fresh evidence gates every read and expires cached reports; unknown identities skip DB", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-deployment-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key"), trust = path.join(dir, "trust"); fs.writeFileSync(key, "fixture"); fs.writeFileSync(trust, "fixture");
  let config = { serverType: "remote-linux", sshHost: "fixture.example", sshUser: "fixture", sshKey: key, sshKnownHostsPath: trust, remoteRuntimeRoot: "/srv/dune" }, evidence = known, tick = 0, dbCalls = 0, probes = 0;
  const providers = createSuiteProviders({ configuration: () => config, now: () => tick, ttlMs: 50, transportFactory: () => ({ async probe(id) { probes++; return { ok: true, stdout: id === "deployment" ? JSON.stringify(evidence) : basics[id] }; } }), database: { async inspect() { dbCalls++; throw new Error("must not run"); } } });
  for (const operation of ["status", "health", "configuration", "version"]) assert.equal((await providers.read(operation)).classification, "Experimental");
  assert(probes >= 24); assert(providers.report()); tick = 51; assert.equal(providers.report(), null);
  evidence = { schemaVersion: 1, layout: "unknown" };
  for (const operation of ["status", "health", "configuration", "version", "players", "database"]) await assert.rejects(providers.read(operation));
  assert.equal(dbCalls, 0);
  await assert.rejects(providers.read("runtime.stop")); await assert.rejects(providers.read("players", { limit: 101 }));
  assert.equal(startupPermissions(null).allowAutomation, false);
});
test("provider endpoints reject DNS rebinding, cross-site and wrong-origin requests", () => {
  const request = { headers: { host: "127.0.0.1:1234" }, socket: { localPort: 1234 } };
  assert(providerLocalRequest(request));
  for (const headers of [{ host: "attacker.test:1234" }, { host: "127.0.0.1:1235" }, { ...request.headers, origin: "http://attacker.test" }, { ...request.headers, "sec-fetch-site": "cross-site" }]) assert.equal(providerLocalRequest({ ...request, headers }), false);
});
test("private player results stay out of cached reports and configuration changes invalidate reads", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-private-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key"), trust = path.join(dir, "trust"); fs.writeFileSync(key, "fixture"); fs.writeFileSync(trust, "fixture");
  let config = { serverType: "remote-linux", sshHost: "fixture.example", sshUser: "fixture", sshKey: key, sshKnownHostsPath: trust, remoteRuntimeRoot: "/srv/dune", remoteDatabaseEnabled: true, remoteDatabaseHost: "db.fixture.example", remoteDatabaseName: "dune", remoteDatabaseUser: "reader", remoteDatabasePassword: "fixture-password" }, changed = false;
  const providers = createSuiteProviders({ configuration: () => config, transportFactory: () => ({ async probe(id) { return { ok: true, stdout: id === "deployment" ? JSON.stringify(known) : basics[id] }; } }), database: { async inspect(input, options) { if (changed) config = { ...config, sshHost: "changed.example" }; return { authenticated: true, readOnlyRole: true, schemaValidated: true, schemaProfile: "dune-player-state-v1", ...(options.players ? { players: [{ id: "1", name: "private-player-canary", status: "1" }] } : {}) }; } } });
  assert.equal((await providers.read("players")).data.players[0].name, "private-player-canary");
  assert(!JSON.stringify(providers.report()).includes("private-player-canary"));
  changed = true; await assert.rejects(providers.read("players"), /deployment_changed/); assert.equal(providers.report(), null);
});
test("remote agent input uses a real bounded local pipe and discards interrupted output", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.on('data',d=>process.stdout.write(d))"], { input: "fixture-stdin" });
  assert.deepEqual(result, { ok: true, stdout: "fixture-stdin" });
  assert.throws(() => runProcess(process.execPath, [], { input: "x".repeat(65537) }));
  const interrupted = await runProcess(process.execPath, ["-e", "process.stdout.write('secret');process.exit(9)"], { input: "fixture" });
  assert.equal(interrupted.ok, false); assert(!JSON.stringify(interrupted).includes("secret"));
});
test("Python parser and discovery fixtures execute without claiming Linux validation", () => {
  const python = process.env.ALPHANINE_TEST_PYTHON;
  assert(python && fs.existsSync(python), "Set ALPHANINE_TEST_PYTHON to an actual Python 3 interpreter; no silent skip");
  const result = spawnSync(python, ["-B", path.join(__dirname, "test-provider-agent.py")], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
