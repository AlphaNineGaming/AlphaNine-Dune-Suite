const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-remote-test-"));
const port = 18810 + Math.floor(Math.random() * 500);
const httpsPort = port + 1;
const output = [];

function request(protocol, requestPath, options = {}) {
  const client = protocol === "https" ? https : http;
  const body = options.body ? JSON.stringify(options.body) : "";
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: "127.0.0.1",
      port: protocol === "https" ? httpsPort : port,
      path: requestPath,
      method: options.method || "GET",
      rejectUnauthorized: protocol !== "https" ? undefined : false,
      headers: {
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await request("http", "/api/remote-access/status");
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Suite did not start.\n${output.join("")}`);
}

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    APPDATA: path.join(temporary, "appdata"),
    LOCALAPPDATA: path.join(temporary, "localappdata"),
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(httpsPort),
    ALPHANINE_SKIP_MANAGER: "1",
    ALPHANINE_PLATFORM_OVERRIDE: process.env.ALPHANINE_PLATFORM_OVERRIDE || "",
    ALPHANINE_REMOTE_ACCESS_DIR: path.join(temporary, "remote-access"),
    ALPHANINE_DATA_DIR: path.join(temporary, "suite-data"),
    ALPHANINE_CONFIG_PATH: path.join(temporary, "config.json")
  },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

(async () => {
  try {
    await waitUntilReady();
    const status = await request("http", "/api/remote-access/status");
    assert.strictEqual(status.json.configured, false);
    assert.ok(status.json.urls.some((url) => url === `https://127.0.0.1:${httpsPort}`));
    assert.ok(status.json.certificateFingerprint);

    const redirect = await request("https", "/");
    assert.strictEqual(redirect.status, 302);
    assert.strictEqual(redirect.headers.location, "/login");
    const denied = await request("https", "/api/status");
    assert.strictEqual(denied.status, 401);

    const configured = await request("http", "/api/remote-access/password", {
      method: "POST",
      body: { username: "admin", password: "local-test-password-42" }
    });
    assert.strictEqual(configured.status, 200);

    const badLogin = await request("https", "/api/auth/login", {
      method: "POST",
      body: { username: "admin", password: "wrong-password" }
    });
    assert.strictEqual(badLogin.status, 401);
    const login = await request("https", "/api/auth/login", {
      method: "POST",
      body: { username: "admin", password: "local-test-password-42" }
    });
    assert.strictEqual(login.status, 200);
    const cookies = login.headers["set-cookie"];
    assert.ok(Array.isArray(cookies) && cookies.some((cookie) => /HttpOnly; Secure; SameSite=Strict/.test(cookie)));
    const cookieHeader = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
    const csrfCookie = cookies.find((cookie) => cookie.startsWith("alphanine_csrf="));
    const csrf = decodeURIComponent(csrfCookie.split(";")[0].split("=")[1]);

    const home = await request("https", "/", { headers: { Cookie: cookieHeader } });
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /AlphaNine Dune Suite/);
    const blockedPost = await request("https", "/api/auth/logout", { method: "POST", headers: { Cookie: cookieHeader } });
    assert.strictEqual(blockedPost.status, 403);
    const remoteSetupBlocked = await request("https", "/api/remote-access/status", { headers: { Cookie: cookieHeader } });
    assert.strictEqual(remoteSetupBlocked.status, 403);
    const logout = await request("https", "/api/auth/logout", { method: "POST", headers: { Cookie: cookieHeader, "X-CSRF-Token": csrf } });
    assert.strictEqual(logout.status, 200);

    console.log("Remote access HTTPS, login, local-only setup, secure cookies, and CSRF checks passed.");
  } finally {
    child.kill();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
