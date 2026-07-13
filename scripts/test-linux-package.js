const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { version } = require("../package.json");

const root = path.join(__dirname, "..");
const artifact = path.join(root, "dist", "linux", `AlphaNine-Dune-Suite-${version}-linux-x64.tar.gz`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-linux-package-"));
const port = 19410;
const httpsPort = 19411;
assert.ok(fs.existsSync(artifact), `Linux artifact does not exist: ${artifact}`);
const extracted = spawnSync("tar", ["-xzf", artifact, "-C", temporary], { stdio: "inherit" });
assert.strictEqual(extracted.status, 0, "Linux artifact extraction failed.");
const packageDir = path.join(temporary, `alphanine-dune-suite-${version}-linux-x64`);
assert.ok(fs.existsSync(path.join(packageDir, "server.js")));
assert.ok(fs.existsSync(path.join(packageDir, "node_modules", "selfsigned")));
assert.ok(fs.existsSync(path.join(packageDir, "linux", "alphanine-dune-suite.service")));

function request(protocol, requestPath) {
  const client = protocol === "https" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get({ hostname: "127.0.0.1", port: protocol === "https" ? httpsPort : port, path: requestPath, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

const dataDir = path.join(temporary, "data");
let childOutput = "";
const child = spawn(process.execPath, ["server.js"], {
  cwd: packageDir,
  env: { ...process.env, PORT: String(port), ALPHANINE_HTTPS_PORT: String(httpsPort), ALPHANINE_DATA_DIR: dataDir, ALPHANINE_SKIP_MANAGER: "1", ALPHANINE_PLATFORM_OVERRIDE: "linux" },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
child.stderr.on("data", (chunk) => { childOutput += String(chunk); });

(async () => {
  try {
    const deadline = Date.now() + 20000;
    let status;
    while (Date.now() < deadline) {
      try { status = await request("http", "/api/remote-access/status"); if (status.status === 200) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.strictEqual(status?.status, 200, `Packaged local HTTP portal did not start.\n${childOutput}`);
    assert.match(status.body, /"configured":false/);
    const unauthenticated = await request("https", "/");
    assert.strictEqual(unauthenticated.status, 302);
    assert.strictEqual(unauthenticated.headers.location, "/login");
    const password = spawnSync(process.execPath, [path.join(packageDir, "scripts", "set-remote-password.js"), "--username", "admin"], {
      env: { ...process.env, ALPHANINE_DATA_DIR: dataDir, ALPHANINE_ADMIN_PASSWORD: "packaged-linux-test-42" },
      encoding: "utf8"
    });
    assert.strictEqual(password.status, 0, password.stderr);
    assert.match(password.stdout, /configured successfully/);
    console.log("Packaged Linux artifact startup, HTTPS redirect, and password CLI checks passed.");
  } finally {
    child.kill();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
