"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { assertRenderedInlineJavaScript } = require("../lib/rendered-script-check");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function scriptsFromExactHtml(html) {
  return [...String(html).matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]) && !/\btype=["']application\/json["']/i.test(match[1]))
    .map((match) => match[2])
    .filter((script) => script.trim());
}

async function fetchRenderedPage(flag) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-rendered-migration-page-"));
  const dataDir = path.join(scratch, "profile");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), `${JSON.stringify({ setupComplete: true, vmName: "dune-awakening-migration-test" }, null, 2)}\n`);
  const port = await freePort();
  const args = [path.join(root, "server.js"), flag];
  if (flag === "--migration-startup-suppressed") args.push("--profile-dir", dataDir);
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, PORT: String(port), ALPHANINE_HTTPS_PORT: String(await freePort()), ALPHANINE_DATA_DIR: dataDir, ALPHANINE_DISABLE_SERVER_ITEM_DISCOVERY: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Rendered-page runtime exited before binding: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
        if (response.ok) return { html: await response.text(), cacheControl: response.headers.get("cache-control") || "" };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Rendered-page runtime did not bind: ${stderr}`);
  } finally {
    child.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function elementStub(id) {
  return { id, disabled: false, value: "", textContent: "", checked: false, className: "", style: {}, addEventListener() {}, focus() {}, removeAttribute(name) { delete this[name]; } };
}

async function verifyStartupBehavior(script) {
  const ids = ["status", "selected-profile", "offline-status", "runtime-identity", "vm-ip-status", "vm-ip-confirm", "vm-ip-rebind", "confirm", "enter", "evidence-preflight", "evidence-confirm", "evidence-reconcile", "destination", "preflight", "export", "import-package", "import-choose", "import-preflight", "import-confirm", "import", "progress"];
  const elements = Object.fromEntries(ids.map((id) => [id, elementStub(id)]));
  const requests = [];
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchStub = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    requests.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
    if (url === "/api/migration-offline") return response({ ok: true, active: true, failClosed: false, generation: "1", digest: "a".repeat(64) });
    if (url === "/api/migration-runtime-identity") return response({ ok: true, verified: true, sourceBuildFingerprint: "b".repeat(64), packageFormatVersion: "4", exportTransportVersion: "pod-native-direct-pgpass-v3", progressApiVersion: "migration-progress-v1" });
    if (url === "/api/server-migration/profile") return response({ ok: true, selectedProfile: { source: "command-line", profileName: "AlphaNineMigrationTestProfile", vmName: "dune-awakening-migration-test", digest: "e".repeat(64) } });
    if (url === "/api/server-migration/vm-ip-reconciliation" && method === "GET") return response({ ok: true, changed: false, tcpAndPinnedHostKeyVerified: true, vmIdentityFingerprint: "d".repeat(64) });
    if (url === "/api/server-migration/active-job") return response({ ok: true, active: false, type: "", job: null });
    if (url === "/api/server-migration/preflight" && method === "POST") return response({ ok: true, jobId: "preflight-1", type: "preflight", status: "running", stage: "Request received", live: { state: "working", elapsedMs: 0, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Request received" } } }, 202);
    if (String(url).startsWith("/api/server-migration/preflight-status/")) return response({ ok: true, jobId: "preflight-1", type: "preflight", status: "success", stage: "Preflight verified", result: { ready: true, conditions: [] }, live: { state: "verified", elapsedMs: 10, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Preflight verified" } } });
    if (url === "/api/server-migration/import-preflight" && method === "POST") return response({ ok: true, jobId: "import-preflight-1", type: "import-preflight", status: "running", stage: "Request received", live: { state: "working", elapsedMs: 0, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Request received" } } }, 202);
    if (String(url).startsWith("/api/server-migration/import-preflight-status/")) return response({ ok: true, jobId: "import-preflight-1", type: "import-preflight", status: "success", stage: "Preflight verified", result: { ready: true, approvalDigest: "c".repeat(64), conditions: [{ ok: true, message: "Destination is exact-compatible and stopped." }] }, live: { state: "verified", elapsedMs: 10, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Preflight verified" } } });
    if (url === "/api/server-migration/import" && method === "POST") return response({ ok: true, jobId: "import-1", type: "import", status: "running", stage: "inspecting-package", live: { state: "working", elapsedMs: 0, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Inspecting package" } } }, 202);
    if (String(url).startsWith("/api/server-migration/import-status/")) return response({ ok: true, jobId: "import-1", type: "import", status: "success", stage: "complete", result: { ok: true }, live: { state: "verified", elapsedMs: 10, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Verified" } } });
    return response({ ok: false, error: "Unexpected test request." }, 500);
  };
  const documentStub = { getElementById: (id) => elements[id] || null };
  const windowStub = { addEventListener() {} };
  const context = vm.createContext({ console, document: documentStub, window: windowStub, globalThis: null, fetch: fetchStub, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, String, Number, Boolean, Math, Promise, Error, encodeURIComponent });
  context.globalThis = context;
  new vm.Script(script, { filename: "migration-startup-suppressed-rendered.js" }).runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(elements["offline-status"].textContent, /Generation 1.*Healthy/, "Offline Mode did not finish loading from the rendered page.");
  assert.match(elements["runtime-identity"].textContent, /Verified runtime/, "Runtime identity did not finish loading from the rendered page.");
  assert.match(elements["vm-ip-status"].textContent, /address is current/i, "Pinned migration VM address identity did not finish loading from the rendered page.");
  elements.destination.value = "isolated-test.a9migration";
  elements.preflight.disabled = false;
  const first = elements.preflight.onclick();
  const second = elements.preflight.onclick();
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.filter((row) => row.method === "POST" && row.url === "/api/server-migration/preflight").length, 1, "One preflight click sequence sent more than one request.");
  elements["import-package"].value = "verified.a9migration";
  context.invalidateImportPreflight();
  assert.equal(elements["import-preflight"].disabled, false, "Healthy Offline Mode with a selected package must enable import preflight.");
  const importPreflightFirst = elements["import-preflight"].onclick();
  const importPreflightSecond = elements["import-preflight"].onclick();
  await Promise.all([importPreflightFirst, importPreflightSecond]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.filter((row) => row.method === "POST" && row.url === "/api/server-migration/import-preflight").length, 1, "One import-preflight click sequence sent more than one request.");
  elements["import-confirm"].value = "IMPORT SERVER MIGRATION PACKAGE";
  context.updateControls();
  assert.equal(elements.import.disabled, false, "Verified ready:true import preflight and exact confirmation must enable protected import.");
  const importFirst = elements.import.onclick();
  const importSecond = elements.import.onclick();
  await Promise.all([importFirst, importSecond]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.filter((row) => row.method === "POST" && row.url === "/api/server-migration/import").length, 1, "One import click sequence sent more than one protected import request.");
  assert.equal(requests.find((row) => row.method === "POST" && row.url === "/api/server-migration/import").body.preflightApprovalDigest, "c".repeat(64), "Protected import did not bind itself to the approved package/destination checkpoint.");
  context.renderJob({
    jobId: "terminal-preflight", status: "failed", stage: "Preflight failed", error: "Command exited with code 255.",
    failure: { gate: "Collecting database evidence", commandPurpose: "Read-only PostgreSQL migration evidence query", exitCode: 255, timedOut: false, category: "connection_failure", stderr: "ssh: connection refused" },
    live: { state: "failed", elapsedMs: 12406, lastActivityAt: new Date().toISOString(), activity: { mode: "indeterminate", substep: "Sampling PostgreSQL health" } }
  });
  assert.match(elements.status.textContent, /Failed gate: Collecting database evidence/);
  assert.match(elements.status.textContent, /SSH exit code: 255/);
  assert.match(elements.status.textContent, /Timed out: no/);
  assert.match(elements.status.textContent, /Sanitized stderr: ssh: connection refused/);
}

(async () => {
  assert.throws(
    () => assertRenderedInlineJavaScript("deliberately-invalid", "<script>const broken='first line\nsecond line';</script>"),
    /rendered invalid inline JavaScript/,
    "The startup compiler guard accepted a rendered literal newline inside a quoted string."
  );
  const startup = await fetchRenderedPage("--migration-startup-suppressed");
  const full = await fetchRenderedPage("--side-effect-free");
  for (const [name, page] of [["startup-suppressed", startup], ["full", full]]) {
    assert.match(page.cacheControl, /no-store/i, `${name} migration page is cacheable.`);
    const scripts = scriptsFromExactHtml(page.html);
    assert(scripts.length > 0, `${name} page rendered no inline scripts.`);
    scripts.forEach((script, index) => new vm.Script(script, { filename: `${name}-inline-${index + 1}.js` }));
  }
  await verifyStartupBehavior(scriptsFromExactHtml(startup.html)[0]);
  const guardIndex = serverSource.indexOf("assertMigrationRenderedPagesCompile();");
  const bindIndex = serverSource.indexOf("const server = http.createServer");
  assert(guardIndex >= 0 && bindIndex > guardIndex, "Rendered-script startup self-check does not run before the migration listener is created.");
  console.log("Exact rendered startup-suppressed/full-page parsing, startup loading, and single preflight dispatch tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
