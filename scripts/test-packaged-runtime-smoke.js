"use strict";

const assert = require("assert");
const crypto = require("crypto");
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
const packagedMarketBotMigrationSafetySource = fs.readFileSync(path.join(extracted, "lib", "market-bot-migration-safety.js"), "utf8");
const packagedMigrationUiSafetySource = fs.readFileSync(path.join(extracted, "lib", "migration-ui-safety.js"), "utf8");
const packagedDesktopSource = fs.readFileSync(path.join(extracted, "electron", "main.js"), "utf8");
const packagedCleanerTestPath = path.join(extracted, "scripts", "test-base-cleanup-override.js");
const packagedLandsraadTestPath = path.join(extracted, "scripts", "test-landsraad-tiers.js");
const packagedServerUpdateTestPath = path.join(extracted, "scripts", "test-server-update-monitor.js");
const packagedServerHealthTestPath = path.join(extracted, "scripts", "test-server-health.js");
const packagedBattlegroupControlTestPath = path.join(extracted, "scripts", "test-battlegroup-control.js");
const packagedStorageDepositTestPath = path.join(extracted, "scripts", "test-storage-deposits.js");
const packagedGiveItemDurabilityTestPath = path.join(extracted, "scripts", "test-give-item-durability.js");
const packagedMarketBotVerificationTestPath = path.join(extracted, "scripts", "test-market-bot-verification.js");
const packagedMarketBotAuthoritativeEvidenceTestPath = path.join(extracted, "scripts", "test-market-bot-authoritative-evidence.js");
const packagedMarketBotReconciliationTestPath = path.join(extracted, "scripts", "test-market-bot-reconciliation.js");
const packagedOfflineMarketBotReconciliationTestPath = path.join(extracted, "scripts", "test-market-bot-offline-reconciliation.js");
const packagedSqlStdinTestPath = path.join(extracted, "scripts", "test-ssh-sql-stdin.js");
const packagedRemoteAccessTestPath = path.join(extracted, "scripts", "test-remote-access.js");
const packagedUpdateIntegrityTestPath = path.join(extracted, "scripts", "test-update-integrity.js");
const packagedLiveMapResourcesTestPath = path.join(extracted, "scripts", "test-live-map-resources.js");
const packagedLiveMapResourcesDataPath = path.join(extracted, "data", "dune-resource-spawn-locations.json");
const packagedExperimentalResourcesTestPath = path.join(extracted, "scripts", "test-experimental-resource-areas.js");
const packagedExperimentalResourcesUiTestPath = path.join(extracted, "scripts", "test-experimental-resource-areas-ui.js");
const packagedExperimentalResourcesModulePath = path.join(extracted, "lib", "experimental-resource-areas.js");
const packagedRepakDir = path.join(outputDir, "win-unpacked", "resources", "app.asar.unpacked", "tools", "repak");
const packagedReleaseNotesPath = path.join(extracted, `RELEASE_NOTES_${rootPackage.version}.md`);
assert(fs.existsSync(packagedCleanerTestPath), "Packaged app is missing the Server Cleaner regression test.");
assert(fs.existsSync(packagedLandsraadTestPath), "Packaged app is missing the Landsraad exact-five regression test.");
assert(fs.existsSync(packagedServerUpdateTestPath), "Packaged app is missing the Server Updater regression test.");
assert(fs.existsSync(packagedServerHealthTestPath), "Packaged app is missing the Server Health regression test.");
assert(fs.existsSync(packagedBattlegroupControlTestPath), "Packaged app is missing the battlegroup generation/attribution regression test.");
assert(fs.existsSync(packagedStorageDepositTestPath), "Packaged app is missing the storage-deposit reliability regression test.");
assert(fs.existsSync(packagedGiveItemDurabilityTestPath), "Packaged app is missing the Give Item durability regression test.");
assert(fs.existsSync(packagedMarketBotVerificationTestPath), "Packaged app is missing the Market Bot pause/drain regression test.");
assert(fs.existsSync(packagedMarketBotAuthoritativeEvidenceTestPath), "Packaged app is missing the authoritative Market Bot evidence regression test.");
assert(fs.existsSync(packagedMarketBotReconciliationTestPath), "Packaged app is missing the Market Bot pause reconciliation regression test.");
assert(fs.existsSync(packagedOfflineMarketBotReconciliationTestPath), "Packaged app is missing the Offline Mode Market Bot evidence reconciliation regression test.");
assert(fs.existsSync(packagedSqlStdinTestPath), "Packaged app is missing the diagnostic SSH-stdin SQL regression test.");
assert(fs.existsSync(packagedRemoteAccessTestPath), "Packaged app is missing the remote-access regression test.");
assert(fs.existsSync(packagedUpdateIntegrityTestPath), "Packaged app is missing the self-update integrity regression test.");
assert(fs.existsSync(packagedLiveMapResourcesTestPath), "Packaged app is missing the Live Map resource regression test.");
assert(fs.existsSync(packagedLiveMapResourcesDataPath), "Packaged app is missing the known resource spawn dataset.");
assert(fs.existsSync(packagedExperimentalResourcesTestPath), "Packaged app is missing the Experimental Resource Areas regression test.");
assert(fs.existsSync(packagedExperimentalResourcesUiTestPath), "Packaged app is missing the Experimental Resource Areas UI regression test.");
assert(fs.existsSync(packagedExperimentalResourcesModulePath), "Packaged app is missing the local Experimental Resource Areas generator.");
for (const filename of ["repak.exe", "LICENSE-MIT", "LICENSE-APACHE", "README.md", "oo2core_9_win64.dll", "ooz-source/COPYING", "ooz-source/BUILD.md"]) assert(fs.existsSync(path.join(packagedRepakDir, filename)), `Packaged app is missing the unpacked repak ${filename}.`);
const packagedDecompressorHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(packagedRepakDir, "oo2core_9_win64.dll"))).digest("hex");
assert.equal(packagedDecompressorHash, "5ac5e474887a110bcee8ec454df99c2f0133102cd54f74bb309868fdd7253db3", "Packaged app is missing the approved open-source offline decompressor.");
assert.notEqual(packagedDecompressorHash, "6f5d41a7892ea6b2db420f2458dad2f84a63901c9a93ce9497337b16c195f457", "Packaged app contains the proprietary downloader-provided Oodle DLL.");
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
const packagedMarketBotReconciliationTest = spawnSync(process.execPath, [packagedMarketBotReconciliationTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedMarketBotReconciliationTest.status,
  0,
  `Packaged Market Bot Pause Reconciliation regression failed.\n${packagedMarketBotReconciliationTest.stdout || ""}\n${packagedMarketBotReconciliationTest.stderr || ""}`
);
const packagedMarketBotAuthoritativeEvidenceTest = spawnSync(process.execPath, [packagedMarketBotAuthoritativeEvidenceTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedMarketBotAuthoritativeEvidenceTest.status,
  0,
  `Packaged authoritative Market Bot evidence regression failed.\n${packagedMarketBotAuthoritativeEvidenceTest.stdout || ""}\n${packagedMarketBotAuthoritativeEvidenceTest.stderr || ""}`
);
const packagedOfflineMarketBotReconciliationTest = spawnSync(process.execPath, [packagedOfflineMarketBotReconciliationTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedOfflineMarketBotReconciliationTest.status,
  0,
  `Packaged Offline Mode Market Bot evidence reconciliation regression failed.\n${packagedOfflineMarketBotReconciliationTest.stdout || ""}\n${packagedOfflineMarketBotReconciliationTest.stderr || ""}`
);
const packagedSqlStdinTest = spawnSync(process.execPath, [packagedSqlStdinTestPath], { cwd: extracted, encoding: "utf8", windowsHide: true });
assert.equal(packagedSqlStdinTest.status, 0, `Packaged diagnostic SSH-stdin SQL regression failed.\n${packagedSqlStdinTest.stdout || ""}\n${packagedSqlStdinTest.stderr || ""}`);
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
for (const testPath of [packagedBattlegroupControlTestPath]) {
  const result = spawnSync(process.execPath, [testPath], { cwd: extracted, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `Packaged battlegroup control regression failed.\n${result.stdout || ""}\n${result.stderr || ""}`);
}
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
const packagedGiveItemDurabilityTest = spawnSync(process.execPath, [packagedGiveItemDurabilityTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedGiveItemDurabilityTest.status,
  0,
  `Packaged Give Item durability regression failed.\n${packagedGiveItemDurabilityTest.stdout || ""}\n${packagedGiveItemDurabilityTest.stderr || ""}`
);
const packagedRemoteAccessTest = spawnSync(process.execPath, [packagedRemoteAccessTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedRemoteAccessTest.status,
  0,
  `Packaged remote-access regression failed.\n${packagedRemoteAccessTest.stdout || ""}\n${packagedRemoteAccessTest.stderr || ""}`
);
const packagedUpdateIntegrityTest = spawnSync(process.execPath, [packagedUpdateIntegrityTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedUpdateIntegrityTest.status,
  0,
  `Packaged self-update integrity regression failed.\n${packagedUpdateIntegrityTest.stdout || ""}\n${packagedUpdateIntegrityTest.stderr || ""}`
);
const packagedLiveMapResourcesTest = spawnSync(process.execPath, [packagedLiveMapResourcesTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedLiveMapResourcesTest.status,
  0,
  `Packaged Live Map resource regression failed.\n${packagedLiveMapResourcesTest.stdout || ""}\n${packagedLiveMapResourcesTest.stderr || ""}`
);
const packagedExperimentalResourcesTest = spawnSync(process.execPath, [packagedExperimentalResourcesTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedExperimentalResourcesTest.status,
  0,
  `Packaged Experimental Resource Areas regression failed.\n${packagedExperimentalResourcesTest.stdout || ""}\n${packagedExperimentalResourcesTest.stderr || ""}`
);
const packagedExperimentalResourcesUiTest = spawnSync(process.execPath, [packagedExperimentalResourcesUiTestPath], {
  cwd: extracted,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  packagedExperimentalResourcesUiTest.status,
  0,
  `Packaged Experimental Resource Areas UI regression failed.\n${packagedExperimentalResourcesUiTest.stdout || ""}\n${packagedExperimentalResourcesUiTest.stderr || ""}`
);
const packagedExperimentalResourcesModule = fs.readFileSync(packagedExperimentalResourcesModulePath, "utf8");
assert(!/https?:\/\//i.test(packagedExperimentalResourcesModule), "Packaged Experimental Resource Areas code contains an external URL.");
assert(packagedExperimentalResourcesModule.includes("app.asar.unpacked"), "Packaged Resource Areas generator cannot locate its extraction helper outside app.asar.");
const packagedEntries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
for (const entry of packagedEntries) {
  assert(!/^(?:assets\/migration-worker|migration-worker|scripts\/.*migration.*\.js|scripts\/test-maintenance.*\.js|scripts\/test-battlegroup-control-paths\.js)(?:\/|$)/i.test(entry), `Packaged app still contains a removed Server Migration artifact: ${entry}`);
  assert(!/experimental-resource-areas\/|\.source-top-(?:max|min)-y\.png$/i.test(entry), `Packaged app contains a generated resource-area cache artifact: ${entry}`);
  assert(!/\.(?:pak|uasset|uexp)$/i.test(entry), `Packaged app contains a raw Funcom package asset: ${entry}`);
}
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
const packagedSchedulerStatus = packagedVmScheduler.buildStatusCommand();
assert(packagedSchedulerStatus.includes("elif sudo -n test ! -e '/etc/crontabs/dune'"), "Packaged scheduler status does not distinguish a positively absent cron file.");
assert(packagedSchedulerStatus.includes("then begin_count=0; end_count=0; path_refs=0"), "Packaged scheduler status does not assign exact zero counts for an absent cron file.");
assert(!packagedSchedulerStatus.includes("grep -Fxc '# BEGIN ALPHANINE DUNE SCHEDULER' '/etc/crontabs/dune' 2>/dev/null || true"), "Packaged scheduler status still erases cron inspection failures.");
assert(packagedSchedulerStatus.includes("kubectl get cronjobs -A -o json") && packagedSchedulerStatus.includes("rc-update show -v") && packagedSchedulerStatus.includes("/etc/cron.d /etc/periodic"), "Packaged scheduler status is missing alternate restart-surface checks.");
assert(packagedSchedulerStatus.includes("sudo -n kubectl get cronjobs") && !packagedSchedulerStatus.includes("command -v kubectl"), "Packaged scheduler status does not use the privileged Kubernetes evidence path independently of the SSH user's PATH.");
assert(packagedSchedulerStatus.includes("ps -eo pid=,comm=,args=") && packagedSchedulerStatus.includes("$field == scheduler") && !packagedSchedulerStatus.includes("for (index="), "Packaged scheduler status does not use BusyBox-compatible exact process-argument boundaries.");
assert.equal(packagedVmScheduler.countSchedulerProcessArguments([{ argv: ["bash", "-c", packagedSchedulerStatus] }]), "0", "Packaged scheduler status counts its own shell transport as a helper process.");
assert.equal(packagedVmScheduler.classifyStatusInventory({
  evidenceValid: true,
  filesystemEvidenceValid: true,
  cronEvidenceValid: true,
  alternateCronEvidenceValid: true,
  kubernetesEvidenceValid: true,
  processEvidenceValid: true,
  openRcEvidenceValid: true,
  cronFileState: "absent",
  directoryExists: false,
  scriptExists: false,
  configExists: false,
  beginCount: "0",
  endCount: "0",
  pathRefs: "0",
  alternateCronRefs: "0",
  kubernetesCronJobRefs: "0",
  helperProcessRefs: "0",
  openRcRestartRefs: "0",
  genericCrondRunning: true
}).schedulerMode, "absent", "Packaged scheduler status incorrectly treats generic crond as an AlphaNine schedule.");
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
const packagedMarketBotVerification = require(path.join(extracted, "lib", "market-bot-verification.js"));
const packagedMarketBotMigrationSafety = require(path.join(extracted, "lib", "market-bot-migration-safety.js"));
const packagedMarketBotBinaryPath = path.join(extracted, "assets", "market-bot", "linux-amd64", "alphanine-market-bot");
assert(fs.existsSync(packagedMarketBotBinaryPath), "Packaged Linux/amd64 Market Bot binary is missing.");
const packagedMarketBotBinary = fs.readFileSync(packagedMarketBotBinaryPath);
const packagedExpected = require(path.join(extracted, "lib", "market-bot-offline-reconciliation.js")).EXPECTED;
assert.equal(crypto.createHash("sha256").update(packagedMarketBotBinary).digest("hex"), packagedExpected.runtimeBinarySha256, "Packaged optional Market Bot runtime does not match its bundled asset identity.");
assert.equal(packagedMarketBotBinary.subarray(0, 4).toString("hex"), "7f454c46", "Packaged Market Bot is not an ELF binary.");
assert.equal(packagedMarketBotBinary[4], 2, "Packaged Market Bot is not ELF64.");
assert.equal(packagedMarketBotBinary.readUInt16LE(18), 62, "Packaged Market Bot is not amd64.");
assert.equal(typeof packagedMarketBotVerification.evaluateAuthoritativeQuiescence, "function", "Packaged Market Bot quiescence verifier is missing.");
assert.equal(typeof packagedMarketBotMigrationSafety.validateStoppedServices, "function", "Packaged Market Bot stopped-or-absent infrastructure verifier is missing.");
const packagedExportJob = packagedServerSource.slice(packagedServerSource.indexOf("async function runMigrationExportJob"), packagedServerSource.indexOf("function startMigrationExport"));
assert(!/collectMigrationMarketBotSafety|revalidateMigrationMarketBotSafety|migrationSafety|historicalIncompleteMarker|catalogFingerprint|runtimeBinarySha256|Quiescent/.test(packagedExportJob) && packagedExportJob.includes("sourceMarket: after.sourceMarket"), "Packaged source export is not read-only or still depends on non-portable Market Bot infrastructure.");
assert(packagedServerSource.includes("const SERVER_MIGRATION_ENABLED = false;"), "Packaged server does not disable Server Migration.");
assert(!/data-view=\"server-migration\"|<section id=\"server-migration\"|id=\"migrationMaintenanceBanner\"|id=\"migrationOfflineBanner\"/.test(packagedServerSource), "Packaged server still renders a Server Migration UI surface.");
assert(!packagedDesktopSource.includes('ipcMain.handle("choose-server-migration-') && !packagedDesktopSource.includes("offlineStartup.active"), "Packaged desktop still exposes Server Migration dialogs or startup holds.");
assert(packagedServerSource.includes("buildDestinationMarketCleanupSql") && packagedServerSource.includes("cleanupDestinationMarket"), "Packaged import is missing transactional destination market cleanup.");
assert(!/supportedExportMarketBotExpected|marketBotExpected/.test(packagedServerSource.slice(packagedServerSource.indexOf("async function migrationExportPreflight"), packagedServerSource.indexOf("async function migrationDumpToFile"))), "Packaged export preflight still reconstructs Market Bot generation, catalog, or runtime policy.");
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
  packagedDesktopSource.includes("DESKTOP_STARTUP_POLICY.allowDesktopEnvironmentMutation") &&
    packagedDesktopSource.includes("DESKTOP_STARTUP_POLICY.allowDesktopReceiver") &&
    packagedDesktopSource.includes("await startReceiverIfNeeded()") &&
    packagedDesktopSource.includes("await startServer()"),
  "Packaged desktop boot must preserve normal Receiver and Suite startup."
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

const child = spawn(process.execPath, [path.join(extracted, "server.js"), "--side-effect-free"], {
  cwd: extracted,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(httpsPort),
    ALPHANINE_DATA_DIR: dataDir,
    ALPHANINE_DUNE_PAKS_DIR: path.join(scratch, "missing-paks"),
    ALPHANINE_SKIP_MANAGER: "1"
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
    assert(!html.includes('data-view="server-migration"') && !html.includes('id="server-migration"'), "Packaged UI still exposes Server Migration.");
    assert(!html.includes('id="migrationMaintenanceBanner"') && !html.includes('id="migrationOfflineBanner"'), "Packaged UI still renders migration startup-hold banners.");
    for (const [migrationPath, method] of [["/api/server-migration/profile", "GET"], ["/api/migration-offline/enter", "POST"], ["/api/migration-maintenance/enter", "POST"]]) {
      const response = await fetch(`http://127.0.0.1:${port}${migrationPath}`, { method });
      const body = await response.json();
      assert.equal(response.status, 404, `Removed Server Migration route remains reachable: ${migrationPath}`);
      assert.equal(body.code, "feature_not_in_build", `Removed Server Migration route returned an unexpected response: ${migrationPath}`);
    }
    const blockedStartResponse = await fetch(`http://127.0.0.1:${port}/api/action/start`, { method: "POST" });
    const blockedStart = await blockedStartResponse.json();
    assert.equal(blockedStartResponse.status, 409, "Side-effect-free packaged runner must block manual server start.");
    assert.equal(blockedStart.code, "side_effect_free", "Side-effect-free runner must return its fail-closed reason.");
    const resourceAreaStatusResponse = await fetch(`http://127.0.0.1:${port}/api/live-map/resource-areas/status`);
    const resourceAreaStatus = await resourceAreaStatusResponse.json();
    assert.equal(resourceAreaStatusResponse.status, 200, "Missing Tools.pak must not crash the packaged status API.");
    assert.equal(resourceAreaStatus.available, false, "A clean install without Tools.pak must not claim overlays are available.");
    assert.match(resourceAreaStatus.source?.error || "", /Tools\.pak was not found/i, "Missing Tools.pak needs a clear packaged-runtime explanation.");
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
    assert(html.includes("Preparing resource areas…"), "Packaged UI is missing the preparing state for Resource Areas.");
    assert(html.includes("Resource areas ready."), "Packaged UI is missing the ready state for Resource Areas.");
    assert(html.includes("No resource types selected."), "Packaged UI is missing the empty selection state for Resource Areas.");
    assert(html.includes("Select Game Folder"), "Packaged UI is missing the Resource Areas game-folder recovery action.");
    assert(html.includes("Protected Battlegroup Refresh"), "Packaged Give Item UI is missing protected storage refresh.");
    assert(html.includes("Give at full durability — 200 / 200"), "Packaged desktop/web Give Item UI is missing the full-durability option.");
    assert(html.includes("Durability not applicable"), "Packaged desktop/web Give Item UI is missing the non-durable state.");
    assert(html.includes('getJson("/api/admin/give-item-receipts/recheck"'), "Packaged UI is missing player-inventory delayed durability rechecks.");
    assert(html.includes('getJson("/api/admin/storage-deposits/recheck"'), "Packaged UI is missing storage receipt rechecks.");
    assert(packagedServerSource.includes("Storage deposit failed transactional slot and quantity verification"), "Packaged backend is missing transactional storage verification.");
    assert(packagedServerSource.includes("Player item grant failed transactional identity, quantity, slot, grade, or durability verification"), "Packaged backend is missing transactional player-inventory durability rollback.");
    console.log(`Packaged Suite smoke test passed on isolated port ${port}; version ${packagedVersion}.`);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
