const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { createInternetTunnel, findOnPath } = require("../lib/internet-tunnel");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-tunnel-test-"));
const executable = path.join(temporary, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
fs.writeFileSync(executable, "test");
const previous = process.env.ALPHANINE_CLOUDFLARED_PATH;
process.env.ALPHANINE_CLOUDFLARED_PATH = executable;
const calls = [];

function fakeSpawn(binary, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("exit", 0, null); };
  calls.push({ binary, args, options, child });
  return child;
}

try {
  const tunnel = createInternetTunnel({ dataDir: temporary, originUrl: "http://127.0.0.1:18813", spawnProcess: fakeSpawn, signatureVerifier: () => ({ ok: true, status: "Valid", signer: "Cloudflare, Inc." }) });
  assert.strictEqual(tunnel.status().installed, true);
  tunnel.start("quick");
  assert.deepStrictEqual(calls[0].args, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:18813"]);
  calls[0].child.stderr.write("Your quick Tunnel has been created! Visit https://kind-dune.trycloudflare.com\n");
  assert.strictEqual(tunnel.status().publicUrl, "https://kind-dune.trycloudflare.com");
  assert.strictEqual(tunnel.status().running, true);
  assert.strictEqual(tunnel.status().signatureVerified, true);
  tunnel.touch();
  assert.strictEqual(tunnel.enforceIdleTimeout(Date.now() + 61 * 60 * 1000), true);
  assert.match(tunnel.status().lastError, /without remote activity/);
  tunnel.stop();
  assert.strictEqual(tunnel.status().running, false);

  tunnel.start("named", "a-secure-cloudflare-token-value", "https://suite.example.com/");
  assert.deepStrictEqual(calls[1].args, ["tunnel", "--no-autoupdate", "run", "--token", "a-secure-cloudflare-token-value"]);
  assert.strictEqual(tunnel.status().publicUrl, "https://suite.example.com");
  assert.ok(!JSON.stringify(tunnel.status()).includes("a-secure-cloudflare-token-value"));
  tunnel.stop();

  assert.strictEqual(findOnPath("missing-cloudflared", temporary), "");
  console.log("Internet tunnel command, URL discovery, token handling, and lifecycle checks passed.");
} finally {
  if (previous === undefined) delete process.env.ALPHANINE_CLOUDFLARED_PATH;
  else process.env.ALPHANINE_CLOUDFLARED_PATH = previous;
  fs.rmSync(temporary, { recursive: true, force: true });
}
