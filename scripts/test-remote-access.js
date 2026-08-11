const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { totpCode } = require("../lib/remote-access");

const root = path.join(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-remote-test-"));
const port = 18810 + Math.floor(Math.random() * 500);
const httpsPort = port + 1;
const internetPort = port + 3;
const output = [];

function request(protocol, requestPath, options = {}) {
  const client = protocol === "https" ? https : http;
  const body = options.body ? JSON.stringify(options.body) : "";
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: "127.0.0.1",
      port: options.port || (protocol === "https" ? httpsPort : port),
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
    ALPHANINE_INTERNET_ORIGIN_PORT: String(internetPort),
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
    assert.strictEqual(status.json.lanWebPortalEnabled, false);
    assert.strictEqual(status.json.localOnly, true);
    assert.strictEqual(status.json.listenHost, "127.0.0.1");
    assert.deepStrictEqual(status.json.urls, [`https://127.0.0.1:${httpsPort}`]);
    assert.ok(status.json.certificateFingerprint);
    const localHome = await request("http", "/");
    assert.match(localHome.text, /Phone \/ LAN Access/);
    assert.match(localHome.text, /Disable Private LAN Access/);
    assert.match(localHome.text, /Local only — no firewall permission needed/);
    const unsafeEnable = await request("http", "/api/remote-access/lan", { method: "POST", body: { enabled: true } });
    assert.strictEqual(unsafeEnable.status, 400);
    assert.match(unsafeEnable.json.error, /password before enabling/i);

    const redirect = await request("https", "/");
    assert.strictEqual(redirect.status, 302);
    assert.strictEqual(redirect.headers.location, "/login");
    const denied = await request("https", "/api/status");
    assert.strictEqual(denied.status, 401);
    const tunnelRedirect = await request("http", "/", { port: internetPort });
    assert.strictEqual(tunnelRedirect.status, 302);
    assert.strictEqual(tunnelRedirect.headers.location, "/login");
    const tunnelDenied = await request("http", "/api/status", { port: internetPort });
    assert.strictEqual(tunnelDenied.status, 401);

    const configured = await request("http", "/api/remote-access/password", {
      method: "POST",
      body: { username: "admin", password: "local-test-password-42" }
    });
    assert.strictEqual(configured.status, 200);
    const enabledLan = await request("http", "/api/remote-access/lan", { method: "POST", body: { enabled: true } });
    assert.strictEqual(enabledLan.status, 200);
    assert.strictEqual(enabledLan.json.lanWebPortalEnabled, true);
    assert.strictEqual(enabledLan.json.localOnly, false);
    assert.strictEqual(enabledLan.json.listenHost, "0.0.0.0");
    assert.match(enabledLan.json.firewallGuidance, /Private networks only/);
    const disabledLan = await request("http", "/api/remote-access/lan", { method: "POST", body: { enabled: false } });
    assert.strictEqual(disabledLan.status, 200);
    assert.strictEqual(disabledLan.json.lanWebPortalEnabled, false);
    assert.strictEqual(disabledLan.json.localOnly, true);
    assert.strictEqual(disabledLan.json.listenHost, "127.0.0.1");

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
    const remoteMenuPolicy = home.text.match(/function remoteAllowedViews\(role\)\{[^\r\n]+\}/)?.[0];
    assert.ok(remoteMenuPolicy, "Remote menu policy was not rendered.");
    const allowedViews = (role) => vm.runInNewContext(`${remoteMenuPolicy};remoteAllowedViews(${JSON.stringify(role)})`);
    assert.deepStrictEqual(Array.from(allowedViews("viewer")), ["dashboard", "players", "live-map", "progression", "landsraad", "item-database"]);
    assert.deepStrictEqual(Array.from(allowedViews("operator")), ["dashboard", "players", "live-map", "progression", "landsraad", "item-database", "server", "scheduler"]);
    assert.strictEqual(allowedViews("owner"), null, "Owner must have no remote menu allowlist restriction.");
    assert.deepStrictEqual(Array.from(allowedViews("invalid-role")), ["dashboard"], "Unknown roles must fail closed to Dashboard only.");
    const remoteSession = await request("https", "/api/auth/session", { headers: { Cookie: cookieHeader } });
    assert.strictEqual(remoteSession.json.role, "viewer");
    const viewerStatus = await request("https", "/api/status", { headers: { Cookie: cookieHeader } });
    assert.strictEqual(viewerStatus.status, 200);
    const viewerWriteBlocked = await request("https", "/api/action/not-a-real-action", { method: "POST", headers: { Cookie: cookieHeader, "X-CSRF-Token": csrf } });
    assert.strictEqual(viewerWriteBlocked.status, 403);
    assert.match(home.text, /AlphaNine Dune Suite/);
    const blockedPost = await request("https", "/api/auth/logout", { method: "POST", headers: { Cookie: cookieHeader } });
    assert.strictEqual(blockedPost.status, 403);
    const remoteSetupBlocked = await request("https", "/api/remote-access/status", { headers: { Cookie: cookieHeader } });
    assert.strictEqual(remoteSetupBlocked.status, 403);
    const remoteLanSetupBlocked = await request("https", "/api/remote-access/lan", { method: "POST", headers: { Cookie: cookieHeader, "X-CSRF-Token": csrf }, body: { enabled: true } });
    assert.strictEqual(remoteLanSetupBlocked.status, 403);
    const tunnelHome = await request("http", "/", { port: internetPort, headers: { Cookie: cookieHeader } });
    assert.strictEqual(tunnelHome.status, 200);
    const tunnelSetupBlocked = await request("http", "/api/internet-access/status", { port: internetPort, headers: { Cookie: cookieHeader } });
    assert.strictEqual(tunnelSetupBlocked.status, 403);
    const logout = await request("https", "/api/auth/logout", { method: "POST", headers: { Cookie: cookieHeader, "X-CSRF-Token": csrf } });
    assert.strictEqual(logout.status, 200);

    const ownerRole = await request("http", "/api/remote-access/role", { method: "POST", body: { role: "owner" } });
    assert.strictEqual(ownerRole.status, 200);
    assert.strictEqual(ownerRole.json.role, "owner");
    const beginTotp = await request("http", "/api/remote-access/totp/begin", { method: "POST" });
    assert.strictEqual(beginTotp.status, 200);
    assert.match(beginTotp.json.secret, /^[A-Z2-7]+$/);
    const confirmTotp = await request("http", "/api/remote-access/totp/confirm", { method: "POST", body: { code: totpCode(beginTotp.json.secret) } });
    assert.strictEqual(confirmTotp.status, 200);
    const missingTotp = await request("https", "/api/auth/login", { method: "POST", body: { username: "admin", password: "local-test-password-42" } });
    assert.strictEqual(missingTotp.status, 401);
    const ownerLogin = await request("https", "/api/auth/login", { method: "POST", body: { username: "admin", password: "local-test-password-42", totp: totpCode(beginTotp.json.secret) } });
    assert.strictEqual(ownerLogin.status, 200);
    const ownerCookies = ownerLogin.headers["set-cookie"].map((cookie) => cookie.split(";")[0]).join("; ");
    const ownerLocalConfigBlocked = await request("https", "/api/config", { headers: { Cookie: ownerCookies } });
    assert.strictEqual(ownerLocalConfigBlocked.status, 403);

    console.log("Remote roles, viewer policy, owner 2FA, HTTPS/tunnel login, local-only setup, secure cookies, and CSRF checks passed.");
  } finally {
    child.kill();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
