"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { providerId, projectConfig, rollbackProjection, createLegacyHyperVProvider, capabilities, MUTATIONS, requireFeature } = require("../lib/providers/foundation");
const { createRemoteLinuxProvider, createSshProbeTransport, rootCommand, PROBES } = require("../lib/providers/remote-linux");
const { sanitizeReport } = require("../lib/providers/report");
const { runProcess } = require("../lib/providers/process-runner");
const { main } = require("./diagnose-provider");
const fixture = path.join(__dirname, "provider-lab", "fixture-process.js");
const good = { os: "Linux", architecture: "x86_64", distribution: 'ID="alpine"', tools: "kubectl\npsql", root: "readable" };
function transport(values = good) { return { async probe(id) { return { ok: true, stdout: values[id] }; } }; }

test("legacy aliases and missing type preserve selection; unknown explicit providers fail closed", () => {
  for (const serverType of [undefined, "", "local-hyperv", "local-windows", "hyperv", "hyper-v", "local", " HYPERV "]) assert.equal(providerId({ serverType }), "hyperv-legacy");
  assert.equal(providerId({ serverType: "remote-linux" }), "remote-linux");
  for (const serverType of ["proxmox", "docker", "managed", "typo"]) assert.throws(() => providerId({ serverType }), /unsupported_provider/);
  assert.throws(() => providerId([]), /invalid_config/);
});
test("in-memory projection and rollback preserve all legacy keys and never mutate inputs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8");
  const original = JSON.parse(source);
  Object.assign(original, { databasePassword: "private-password", receiverToken: "private-token", unknownFutureField: { preserved: true }, sshKey: "C:\\private\\key" });
  const before = JSON.stringify(original);
  const projected = projectConfig(original);
  const restored = rollbackProjection(projected);
  assert.deepEqual(restored, original); assert.equal(JSON.stringify(original), before);
  restored.unknownFutureField.preserved = false;
  assert.equal(projected.original.unknownFutureField.preserved, true);
  assert.throws(() => rollbackProjection({ ...projected, schemaVersion: 2 }), /invalid_projection/);
  assert.throws(() => rollbackProjection({ ...projected, provider: "remote-linux" }), /invalid_projection/);
  assert.equal(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8"), source);
});
test("legacy read adapter preserves receiver binding, arguments, return identity and errors", async () => {
  const object = { state: "Running" }, error = new Error("legacy-error");
  const readers = {};
  for (const facet of ["vm", "runtime", "database", "filesystem"]) readers[facet] = { marker: facet, inspect(...args) { assert.equal(this.marker, facet); assert.deepEqual(args, ["target", { timeout: 10 }]); return object; } };
  const adapter = createLegacyHyperVProvider(readers);
  for (const facet of Object.keys(readers)) assert.equal(adapter[facet].inspect("target", { timeout: 10 }), object);
  readers.vm.inspect = () => { throw error; };
  assert.throws(() => adapter.vm.inspect(), thrown => thrown === error);
  readers.vm.inspect = () => Promise.reject(error);
  await assert.rejects(adapter.vm.inspect(), thrown => thrown === error);
  assert.throws(() => createLegacyHyperVProvider().vm.inspect(), /not_bound/);
  assert.equal(adapter.vm.start, undefined);
});
test("mutations remain blocked even for forged Verified capabilities", () => {
  for (const feature of MUTATIONS) {
    assert.equal(capabilities({ linux: true, rootReadable: true })[feature].available, false);
    assert.throws(() => requireFeature({ [feature]: { available: true, classification: "Verified" } }, feature), /unavailable/);
  }
  assert.throws(() => requireFeature({}, "missing"), /unavailable/);
  assert.doesNotThrow(() => requireFeature(capabilities({ linux: true }), "diagnostics.read"));
});
test("read probes establish observations but never runtime, DB or provider verification", async () => {
  const provider = createRemoteLinuxProvider({ transport: transport(), runtimeRoot: "/srv/dune" });
  const report = await provider.discover();
  assert.equal(report.environment.os, "linux"); assert.equal(report.environment.runtimeRoot, "readable");
  assert.equal(report.environment.tools.kubectl, true); assert.equal(report.environment.tools.docker, false);
  assert.equal(report.capabilities["runtime.inspect"].available, false);
  assert.equal(report.capabilities["database.inspect"].available, false);
  assert.equal(report.classification, "Experimental"); assert.equal(provider.vm, undefined);
});
test("permission, timeout, exception and malformed responses cannot establish Linux compatibility", async () => {
  for (const response of [{ ok: false, code: "timeout" }, { ok: false, code: "permission_denied", stderr: "private-password" }, { ok: true, stdout: "Linux\nprivate-password" }, { ok: true, stdout: null }, { ok: true, stdout: "x".repeat(20000) }, null]) {
    const report = await createRemoteLinuxProvider({ transport: { async probe() { return response; } } }).discover();
    assert.equal(report.environment.os, "unknown"); assert.equal(report.capabilities["diagnostics.read"].available, false);
    assert(!JSON.stringify(report).includes("private-password"));
  }
  const failed = await createRemoteLinuxProvider({ transport: { async probe() { throw new Error("private-password"); } } }).discover();
  assert.equal(failed.checks.os.code, "probe_failed"); assert(!JSON.stringify(failed).includes("private-password"));
});
test("report allowlist removes malicious fields, raw values and forged capability classifications", async () => {
  const report = await createRemoteLinuxProvider({ transport: transport() }).discover();
  const secret = "secret-canary@private.example";
  Object.assign(report, { endpoint: secret, credentials: { password: secret }, playerIds: [secret], classification: "Verified" });
  Object.assign(report.environment, { hostname: secret, architecture: secret, distribution: secret, runtimeRoot: secret, tools: { ...report.environment.tools, custom: secret } });
  report.checks.os.stderr = secret; report.checks.tools.code = secret;
  report.capabilities = { ...report.capabilities, "database.write": { available: true, classification: "Verified", reason: secret } };
  const exported = sanitizeReport(report), text = JSON.stringify(exported);
  assert(!text.includes(secret)); assert(!text.includes("Verified"));
  assert.equal(exported.classification, "Experimental"); assert.equal(exported.environment.architecture, "unknown");
  assert.equal(exported.capabilities["database.write"].available, false);
  assert.deepEqual(sanitizeReport(exported), exported);
  const rawSecret = await createRemoteLinuxProvider({ transport: transport({ ...good, distribution: `ID="${secret}"`, tools: secret, root: secret }), runtimeRoot: "/srv/dune" }).discover();
  assert(!JSON.stringify(sanitizeReport(rawSecret)).includes(secret));
});
test("SSH transport uses strict trust, fixed probes, no local config, and rejects argument injection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-provider-trust-"));
  try {
    const keyPath = path.join(dir, "key"), knownHostsPath = path.join(dir, "known hosts");
    fs.writeFileSync(keyPath, "fixture"); fs.writeFileSync(knownHostsPath, "fixture");
    const endpoint = { host: "fixture.example", user: "diagnostic", port: 22222, keyPath, knownHostsPath };
    const calls = [];
    const ssh = createSshProbeTransport(endpoint, { runner: async (...args) => { calls.push(args); return { ok: true, stdout: "Linux" }; } });
    await ssh.probe("os"); await ssh.probe("root", "/srv/a'b;$(touch hacked)");
    const args = calls[0][1];
    for (const option of ["StrictHostKeyChecking=yes", "BatchMode=yes", "UpdateHostKeys=no", "ClearAllForwardings=yes", "ProxyCommand=none"]) assert(args.includes(option));
    assert(args.includes("-F")); assert.equal(args.at(-1), PROBES.os);
    assert.match(calls[1][1].at(-1), /'"'"'/);
    await assert.rejects(ssh.probe("rm -rf /"), /not_allowed/);
    for (const host of ["-oProxyCommand=evil", "a;touch x", "a@b", "a\nb"]) assert.throws(() => createSshProbeTransport({ ...endpoint, host }), /invalid_host/);
    for (const user of ["-root", "root;id", "root@else"]) assert.throws(() => createSshProbeTransport({ ...endpoint, user }), /invalid_user/);
    for (const port of [0, 65536, "22"]) assert.throws(() => createSshProbeTransport({ ...endpoint, port }), /invalid_port/);
    assert.throws(() => createSshProbeTransport({ ...endpoint, keyPath: path.join(dir, "missing") }), /unreadable/);
    for (const root of ["relative", "/srv/../etc", "/srv\nsecret"]) assert.throws(() => rootCommand(root), /invalid_runtime_root/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("local subprocess integration executes a full deterministic discovery and report roundtrip", async () => {
  const calls = [];
  const provider = createRemoteLinuxProvider({ runtimeRoot: "/srv/dune", transport: { async probe(id) { calls.push(id); return runProcess(process.execPath, [fixture, "normal", id]); } } });
  const report = sanitizeReport(await provider.discover());
  assert.deepEqual(calls, ["os", "architecture", "distribution", "tools", "root", "deployment"]);
  assert.equal(report.environment.os, "linux"); assert.equal(report.environment.distribution, "alpine");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-provider-report-"));
  try { const file = path.join(dir, "report.json"); fs.writeFileSync(file, JSON.stringify(report), { flag: "wx" }); assert.deepEqual(JSON.parse(fs.readFileSync(file)), report); assert.throws(() => fs.writeFileSync(file, "overwrite", { flag: "wx" }), /EEXIST/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("real local child failure, timeout and output overflow discard partial/error output", async () => {
  for (const [mode, code] of [["fail", "probe_failed"], ["hang", "timeout"], ["overflow", "output_limit"]]) {
    const result = await runProcess(process.execPath, [fixture, mode, "os"], { timeoutMs: mode === "hang" ? 200 : 5000, maxBytes: 16384 });
    assert.deepEqual(result, { ok: false, code }); assert(!JSON.stringify(result).includes("fixture-password"));
  }
  assert.throws(() => runProcess(process.execPath, [], { timeoutMs: 0 }), /invalid_process_limits/);
});
test("standalone CLI refuses unknown provider before any connection or output write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-provider-cli-"));
  try {
    const input = path.join(dir, "endpoint.json"), output = path.join(dir, "report.json");
    fs.writeFileSync(input, JSON.stringify({ serverType: "docker" }));
    await assert.rejects(main(["--endpoint-file", input, output]), /unsupported_provider/);
    assert.equal(fs.existsSync(output), false);
    await assert.rejects(main([]), /usage/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
