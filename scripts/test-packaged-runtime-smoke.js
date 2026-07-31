"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");
const asar = require("@electron/asar");

const root = path.join(__dirname, "..");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDir = process.env.ALPHANINE_BUILD_OUTPUT_DIR || path.join(root, "installer-output");
const archive = path.join(outputDir, "win-unpacked", "resources", "app.asar");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-packaged-smoke-"));
const extracted = path.join(scratch, "app");
const dataDir = path.join(scratch, "data");
const port = 19080 + Math.floor(Math.random() * 400);
const httpsPort = port + 500;

if (!fs.existsSync(archive)) throw new Error(`Packaged archive was not found: ${archive}`);
asar.extractAll(archive, extracted);
const packagedServerSource = fs.readFileSync(path.join(extracted, "server.js"), "utf8");
const packagedDesktopSource = fs.readFileSync(path.join(extracted, "electron", "main.js"), "utf8");
const packagedCleanerTestPath = path.join(extracted, "scripts", "test-base-cleanup-override.js");
const packagedLandsraadTestPath = path.join(extracted, "scripts", "test-landsraad-tiers.js");
const packagedServerUpdateTestPath = path.join(extracted, "scripts", "test-server-update-monitor.js");
const packagedServerHealthTestPath = path.join(extracted, "scripts", "test-server-health.js");
const packagedStorageDepositTestPath = path.join(extracted, "scripts", "test-storage-deposits.js");
const packagedReleaseNotesPath = path.join(extracted, `RELEASE_NOTES_${rootPackage.version}.md`);
assert(fs.existsSync(packagedCleanerTestPath), "Packaged app is missing the Server Cleaner regression test.");
assert(fs.existsSync(packagedLandsraadTestPath), "Packaged app is missing the Landsraad exact-five regression test.");
assert(fs.existsSync(packagedServerUpdateTestPath), "Packaged app is missing the Server Updater regression test.");
assert(fs.existsSync(packagedServerHealthTestPath), "Packaged app is missing the Server Health regression test.");
assert(fs.existsSync(packagedStorageDepositTestPath), "Packaged app is missing the storage-deposit reliability regression test.");
assert(fs.existsSync(packagedReleaseNotesPath), `Packaged app is missing release notes for ${rootPackage.version}.`);
assert(
  packagedServerSource.includes('const actorId = requireSqlBigint(payload.actorId, "actor_id", 0n)'),
  "Packaged Server Cleaner is missing bigint-safe backend validation."
);
assert(
  packagedServerSource.includes('const actorId=String(row.actorId||"").trim()'),
  "Packaged Server Cleaner UI does not preserve scanned actor IDs as strings."
);
assert(
  !packagedServerSource.includes("const actorId=Number(row.actorId)||0"),
  "Packaged Server Cleaner still coerces actor IDs through Number."
);
const packagedCleanerTest = spawnSync(process.execPath, [packagedCleanerTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedCleanerTest.status,
  0,
  `Packaged Server Cleaner regression failed.\n${packagedCleanerTest.stdout || ""}\n${packagedCleanerTest.stderr || ""}`
);
const packagedLandsraadTest = spawnSync(process.execPath, [packagedLandsraadTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedLandsraadTest.status,
  0,
  `Packaged Landsraad regression failed.\n${packagedLandsraadTest.stdout || ""}\n${packagedLandsraadTest.stderr || ""}`
);
const packagedServerUpdateTest = spawnSync(process.execPath, [packagedServerUpdateTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedServerUpdateTest.status,
  0,
  `Packaged Server Updater regression failed.\n${packagedServerUpdateTest.stdout || ""}\n${packagedServerUpdateTest.stderr || ""}`
);
const packagedServerHealthTest = spawnSync(process.execPath, [packagedServerHealthTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedServerHealthTest.status,
  0,
  `Packaged Server Health regression failed.\n${packagedServerHealthTest.stdout || ""}\n${packagedServerHealthTest.stderr || ""}`
);
const packagedStorageDepositTest = spawnSync(process.execPath, [packagedStorageDepositTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedStorageDepositTest.status,
  0,
  `Packaged storage-deposit regression failed.\n${packagedStorageDepositTest.stdout || ""}\n${packagedStorageDepositTest.stderr || ""}`
);
assert(
  packagedServerSource.includes("detectedTiers.length === LANDSRAAD_TIER_COUNT"),
  "Packaged Landsraad inspection is missing the exact-five fail-closed invariant."
);
assert(
  packagedServerSource.includes("runServerUpdateLifecycle") && packagedServerSource.includes("serverUpdateDiagnosticText"),
  "Packaged Server Updater is missing lifecycle cleanup or structured failure diagnostics."
);
assert(
  packagedServerSource.includes("query: (sql, timeout) => dbQueryStreamed(sql, timeout)"),
  "Packaged blueprint imports are not using streamed SQL."
);
const packagedVmScheduler = require(path.join(extracted, "lib", "vm-scheduler.js"));
const packagedSchedulerInstall = packagedVmScheduler.buildInstallCommand({
  config: packagedVmScheduler.defaultSchedulerConfig("abc"),
  scriptSource: "#!/bin/bash\r\nlog_line() {\r\n  printf ok\r\n}\r\n",
  appVersion: "packaged-smoke"
});
const packagedSchedulerPayload = packagedSchedulerInstall.match(/printf %s '([^']+)' \| base64 -d \| gzip -d > \/tmp\/alphanine-scheduler\.sh/)?.[1];
assert(packagedSchedulerPayload, "Packaged scheduler installer payload was not found.");
const packagedSchedulerRuntime = zlib.gunzipSync(Buffer.from(packagedSchedulerPayload, "base64")).toString("utf8");
assert.equal(packagedSchedulerRuntime.includes("\r"), false, "Packaged scheduler payload still contains Windows CRLF line endings.");
const packagedMarketBot = require(path.join(extracted, "lib", "market-bot.js"));
const packagedMarketBotBinaryPath = path.join(extracted, "assets", "market-bot", "linux-amd64", "alphanine-market-bot");
assert(fs.existsSync(packagedMarketBotBinaryPath), "Packaged Linux/amd64 Market Bot binary is missing.");
const packagedMarketBotBinary = fs.readFileSync(packagedMarketBotBinaryPath);
assert.equal(packagedMarketBotBinary.subarray(0, 4).toString("hex"), "7f454c46", "Packaged Market Bot is not an ELF binary.");
assert.equal(packagedMarketBotBinary[4], 2, "Packaged Market Bot is not ELF64.");
assert.equal(packagedMarketBotBinary.readUInt16LE(18), 62, "Packaged Market Bot is not amd64.");
const packagedMarketBotInstall = packagedMarketBot.buildInstallCommand({
  config: {
    schemaVersion: 1,
    battlegroup: "abc",
    namespace: "funcom-seabass-abc",
    dbPod: "database-0",
    dbService: "database",
    items: []
  },
  binary: packagedMarketBotBinary,
  appVersion: "packaged-smoke"
});
assert(packagedMarketBotInstall.includes("rc-update add alphanine-market-bot default"), "Packaged Market Bot does not register its OpenRC service.");
assert(packagedMarketBotInstall.includes("' migrate"), "Packaged Market Bot installer does not initialize strict ownership metadata.");
assert(packagedMarketBotInstall.includes("timeout -k 2 12 rc-service alphanine-market-bot stop"), "Packaged Market Bot installer cannot recover a hung prior daemon.");
assert(packagedMarketBotInstall.includes('readlink -f "/proc/$market_bot_pid/exe"'), "Packaged Market Bot installer does not verify the recorded service PID.");
assert(packagedServerSource.includes('"/api/market-bot/prepare"'), "Packaged UI/API is missing staged Market Bot activation.");
assert(
  packagedServerSource.includes("Player listings and untracked NPC listings will not be touched.") &&
    packagedServerSource.includes('"/api/market-bot/clean"'),
  "Packaged Market Bot tracked-only cleanup safety warning is missing."
);
assert(
  /loadEnvironment\(\);\s*await startReceiverIfNeeded\(\);\s*await startServer\(\);/.test(packagedDesktopSource),
  "Packaged desktop boot does not start the receiver before the Suite backend."
);
assert(
  packagedServerSource.includes("dune.adjust_player_virtual_currency_balance(${controllerId}::bigint, ${HOUSE_SCRIP_CURRENCY_ID}::smallint, ${amount}::bigint)"),
  "Packaged server is missing the schema-compatible House Scrip function call."
);
assert(
  packagedServerSource.includes("font-size:clamp(14px,1.5vw,20px)"),
  "Packaged UI is missing the responsive House Scrip balance sizing."
);

for (const relative of [
  "assets/vendor/babylon.js",
  "assets/vendor/BABYLONJS-LICENSE.md",
  "assets/blueprint-piece-catalog.json",
  "lib/blueprint-piece-catalog.js",
  "lib/blueprint-viewer-transform.js",
  "scripts/test-procedural-blueprint-viewer.js",
  "scripts/test-blueprint-piece-catalog.js",
  "scripts/fixtures/blueprint-viewer-rotations.json"
]) {
  assert(!fs.existsSync(path.join(extracted, relative)), `Packaged app still contains removed blueprint visualization content: ${relative}`);
}

const child = spawn(process.execPath, [path.join(extracted, "server.js")], {
  cwd: extracted,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(httpsPort),
    ALPHANINE_DATA_DIR: dataDir,
    ALPHANINE_SKIP_MANAGER: "1",
    ALPHANINE_SKIP_STARTUP_SERVICES: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitForUi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited with ${child.exitCode}.\n${stdout}\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.text();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Packaged Suite UI did not become reachable.\n${stdout}\n${stderr}`);
}

(async () => {
  try {
    const html = await waitForUi();
    assert(html.includes("loadSharedPlayerDirectory"), "Packaged UI is missing the shared player directory.");
    assert(html.includes("keeping the last confirmed directory"), "Packaged UI is missing stale player preservation.");
    assert(html.includes("Player Building Blueprints"), "Packaged UI is missing blueprint management.");
    assert(html.includes("Export Selected"), "Packaged UI is missing selected-blueprint export.");
    assert(html.includes("Export All"), "Packaged UI is missing all-blueprint ZIP export.");
    assert(!/blueprintViewer|BABYLON|blueprintProcedural|blueprint-piece-catalog|blueprint-viewer-transform/.test(html), "Packaged UI still contains blueprint visualization code.");
    assert(!html.includes('data-blueprint-action="view"'), "Packaged UI still contains a blueprint View action.");
    assert(html.includes("Grant Selected Ranks"), "Packaged UI is missing granular skill rank grants.");
    assert(html.includes("House Scrip is virtual currency"), "Packaged UI is missing the House Scrip grant panel.");
    const packagedVersion = JSON.parse(fs.readFileSync(path.join(extracted, "package.json"), "utf8")).version;
    assert.equal(packagedVersion, rootPackage.version, "Packaged version does not match the release source.");
    assert(html.includes("Exactly five distinct thresholds"), "Packaged Landsraad UI is missing the exact-five policy.");
    assert(/id="landsraadTierPreviewButton"[^>]*disabled/.test(html), "Packaged Landsraad preview is not fail-closed by default.");
    assert(html.includes("Nested server-management timeout:"), "Packaged Server Updater UI is missing nested timeout diagnostics.");
    assert(html.includes('getJson("/api/server-update/check"+(force?"?force=1":""),{timeoutMs:120000})'), "Packaged Server Updater UI deadline is not longer than bounded backend work.");
    assert(html.includes('id="server-health"'), "Packaged UI is missing the Server Health page.");
    assert(html.includes("Refresh Health"), "Packaged UI is missing manual Server Health refresh.");
    assert(html.includes('getJson("/api/server-health",{timeoutMs:65000})'), "Packaged Server Health scan is missing its bounded UI deadline.");
    assert(html.includes("Protected Battlegroup Refresh"), "Packaged Give Item UI is missing protected storage refresh.");
    assert(html.includes('getJson("/api/admin/storage-deposits/recheck"'), "Packaged UI is missing storage receipt rechecks.");
    assert(packagedServerSource.includes("Storage deposit failed transactional slot and quantity verification"), "Packaged backend is missing transactional storage verification.");
    console.log(`Packaged Suite smoke test passed on isolated port ${port}; version ${packagedVersion}.`);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
