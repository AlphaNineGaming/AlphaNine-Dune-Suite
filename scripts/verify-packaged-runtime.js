const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");

const root = path.join(__dirname, "..");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDir = process.env.ALPHANINE_BUILD_OUTPUT_DIR || path.join(root, "installer-output");
const archive = path.join(outputDir, "win-unpacked", "resources", "app.asar");

if (!fs.existsSync(archive)) throw new Error(`Packaged application archive was not found: ${archive}`);

const packaged = new Set(asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, "")));
const requiredRuntimeFiles = [
  "server.js",
  "assets/coordinate-system.js",
  "assets/market-bot/linux-amd64/alphanine-market-bot",
  "lib/market-bot.js",
  "lib/market-bot-verification.js",
  "lib/market-bot-evidence.js",
  "lib/market-bot-authoritative-evidence.js",
  "lib/market-bot-migration-safety.js",
  "lib/migration-preflight.js",
  "lib/market-bot-reconciliation.js",
  "lib/market-bot-offline-reconciliation.js",
  "lib/migration-maintenance.js",
  "lib/migration-offline-mode.js",
  "lib/migration-ui-safety.js",
  "lib/migration-startup-suppressed-routes.js",
  "lib/profile-binding.js",
  "lib/startup-policy.js",
  "lib/migration-package.js",
  "lib/server-migration.js",
  "lib/server-migration-export.js",
  "lib/server-migration-import.js",
  "lib/migration-destination-worker.js",
  "lib/migration-worker-plan.js",
  "lib/migration-worker-transport.js",
  "lib/migration-empty-market.js",
  "lib/migration-destination-market.js",
  "lib/maintenance-bootstrap.js",
  "lib/maintenance-transport.js",
  "lib/stdin-process.js",
  "lib/ssh-sql-stdin.js",
  "market-bot/main.go",
  "lib/player-directory.js",
  "lib/server-update.js",
  "lib/server-health.js",
  "lib/vm-scheduler.js",
  "lib/battlegroup-control.js",
  "lib/teleport-request-mode.js",
  "lib/experimental-resource-areas.js",
  "lib/give-item-durability.js",
  "lib/dungeon-difficulty.js",
  "lib/installed-game-dungeon-catalog.js",
  "data/dune-resource-spawn-locations.json",
  "electron/main.js",
  "scripts/test-live-map-resources.js",
  "scripts/test-market-bot-verification.js",
  "scripts/test-market-bot-authoritative-evidence.js",
  "scripts/test-market-bot-reconciliation.js",
  "scripts/test-market-bot-offline-reconciliation.js",
  "scripts/test-ssh-sql-stdin.js",
  "scripts/generate-experimental-resource-areas.js",
  "scripts/test-experimental-resource-areas.js",
  "scripts/test-landsraad-tiers.js",
  "scripts/test-server-update-monitor.js",
  "scripts/test-server-health.js",
  "scripts/test-vm-scheduler.js",
  "scripts/test-give-item-durability.js",
  "scripts/test-dungeon-difficulty.js",
  "scripts/test-installed-game-dungeon-catalog.js",
  `RELEASE_NOTES_${rootPackage.version}.md`
];
const missing = requiredRuntimeFiles.filter((entry) => !packaged.has(entry));

if (missing.length) {
  throw new Error(`Packaged application is missing required runtime files: ${missing.join(", ")}`);
}

for (const entry of packaged) {
  if (/^(?:assets\/migration-worker|migration-worker|scripts\/.*migration.*\.js|scripts\/test-maintenance.*\.js|scripts\/test-battlegroup-control-paths\.js)(?:\/|$)/i.test(entry)) {
    throw new Error(`Packaged application still contains a removed Server Migration artifact: ${entry}`);
  }
  if (/experimental-resource-areas\/|\.source-top-(?:max|min)-y\.png$/i.test(entry)) {
    throw new Error(`Packaged application contains a generated resource-area cache artifact: ${entry}`);
  }
  if (/\.(?:pak|uasset|uexp)$/i.test(entry)) {
    throw new Error(`Packaged application contains a raw Funcom package asset: ${entry}`);
  }
}

const packagedServer = asar.extractFile(archive, "server.js").toString("utf8");
const packagedDesktop = asar.extractFile(archive, "electron/main.js").toString("utf8");
const packagedMarketBotModule = asar.extractFile(archive, "lib/market-bot.js").toString("utf8");
const packagedMarketBotVerification = asar.extractFile(archive, "lib/market-bot-verification.js").toString("utf8");
const packagedMarketBotEvidence = asar.extractFile(archive, "lib/market-bot-evidence.js").toString("utf8");
const packagedMarketBotAuthoritativeEvidence = asar.extractFile(archive, "lib/market-bot-authoritative-evidence.js").toString("utf8");
const packagedMarketBotMigrationSafety = asar.extractFile(archive, "lib/market-bot-migration-safety.js").toString("utf8");
const packagedMarketBotReconciliation = asar.extractFile(archive, "lib/market-bot-reconciliation.js").toString("utf8");
const packagedOfflineMarketBotReconciliation = asar.extractFile(archive, "lib/market-bot-offline-reconciliation.js").toString("utf8");
const packagedMigrationMaintenance = asar.extractFile(archive, "lib/migration-maintenance.js").toString("utf8");
const packagedMigrationOffline = asar.extractFile(archive, "lib/migration-offline-mode.js").toString("utf8");
const packagedStartupPolicy = asar.extractFile(archive, "lib/startup-policy.js").toString("utf8");
const packagedStartupSuppressedRoutes = asar.extractFile(archive, "lib/migration-startup-suppressed-routes.js").toString("utf8");
const packagedMigrationExport = asar.extractFile(archive, "lib/server-migration-export.js").toString("utf8");
const packagedMigrationImport = asar.extractFile(archive, "lib/server-migration-import.js").toString("utf8");
const packagedMigrationCore = asar.extractFile(archive, "lib/server-migration.js").toString("utf8");
const packagedMaintenanceBootstrap = asar.extractFile(archive, "lib/maintenance-bootstrap.js").toString("utf8");
const packagedMaintenanceTransport = asar.extractFile(archive, "lib/maintenance-transport.js").toString("utf8");
const packagedStdinProcess = asar.extractFile(archive, "lib/stdin-process.js").toString("utf8");
const packagedSqlStdin = asar.extractFile(archive, "lib/ssh-sql-stdin.js").toString("utf8");
const packagedPlayerDirectory = asar.extractFile(archive, "lib/player-directory.js").toString("utf8");
const packagedServerUpdate = asar.extractFile(archive, "lib/server-update.js").toString("utf8");
const packagedServerHealth = asar.extractFile(archive, "lib/server-health.js").toString("utf8");
const packagedBattlegroupControl = asar.extractFile(archive, "lib/battlegroup-control.js").toString("utf8");
const packagedExperimentalResources = asar.extractFile(archive, "lib/experimental-resource-areas.js").toString("utf8");
const packagedDungeonDifficulty = asar.extractFile(archive, "lib/dungeon-difficulty.js").toString("utf8");
if (!packagedDungeonDifficulty.includes("record_dungeon_completion") || !packagedDungeonDifficulty.includes("snapshotFingerprint")) {
  throw new Error("Packaged experimental dungeon difficulty module is incomplete.");
}
const packagedDungeonCatalog = asar.extractFile(archive, "lib/installed-game-dungeon-catalog.js").toString("utf8");
if (!packagedDungeonCatalog.includes("Dungeons.pak") || !packagedDungeonCatalog.includes("DungeonDataAsset")) {
  throw new Error("Packaged installed-game dungeon scanner is incomplete.");
}
if (/https?:\/\//i.test(packagedExperimentalResources)) {
  throw new Error("Packaged Experimental Resource Areas code contains an external URL.");
}
const packagedResourceDataset = JSON.parse(asar.extractFile(archive, "data/dune-resource-spawn-locations.json").toString("utf8"));
if (!Array.isArray(packagedResourceDataset.locations) || packagedResourceDataset.locations.length !== 117) {
  throw new Error("Packaged Live Map resource dataset does not contain exactly 117 locations.");
}
const packagedResourceCounts = packagedResourceDataset.locations.reduce((counts, row) => {
  counts[row.name] = (counts[row.name] || 0) + 1;
  return counts;
}, {});
if (packagedResourceCounts["Small Spice"] !== 87 || packagedResourceCounts["Flour Sand"] !== 30) {
  throw new Error("Packaged Live Map resource dataset does not contain 87 Small Spice and 30 Flour Sand locations.");
}
if (!packagedServer.includes("loadSharedPlayerDirectory") || !packagedServer.includes("adminPlayerDirectory")) {
  throw new Error("Packaged server is missing the stabilized shared player-directory integration.");
}
if (!packagedServer.includes("prepareMarketBot") || !packagedServer.includes("ensureMarketBotInstalled")) {
  throw new Error("Packaged server is missing the persistent Market Bot integration.");
}
if (!packagedMarketBotModule.includes("alphanine_market_bot_listings") && !packagedMarketBotModule.includes("VM_MARKET_BOT_BINARY")) {
  throw new Error("Packaged Market Bot installer module is incomplete.");
}
if (!packagedBattlegroupControl.includes("battlegroup_control_stale_intent")
  || !packagedBattlegroupControl.includes("oldResourceVersion")
  || !packagedBattlegroupControl.includes("minimumGeneration")) {
  throw new Error("Packaged battlegroup control runtime is missing durable attribution or stale-intent protection.");
}
if (!packagedSqlStdin.includes("runSqlOverSshStdin") || /toString\(["']base64["']\)/.test(packagedSqlStdin)) {
  throw new Error("Packaged diagnostic SQL transport is not bounded SSH stdin streaming.");
}
if (!packagedMarketBotVerification.includes("evaluateAuthoritativeQuiescence") || !packagedMarketBotVerification.includes("fulfilled-payment")) {
  throw new Error("Packaged Market Bot pause/drain or protected-order verification is incomplete.");
}
if (!packagedMarketBotEvidence.includes("parseDatabaseEnvelope") || !packagedMarketBotEvidence.includes("market_bot_evidence_non_json_prefix")) {
  throw new Error("Packaged Market Bot strict migration-evidence parser is incomplete.");
}
if (!packagedMarketBotAuthoritativeEvidence.includes("buildAuthoritativeMarketBotEvidence")
  || !packagedMarketBotAuthoritativeEvidence.includes("market_bot_authoritative_configuration_drift")
  || !packagedServer.includes("collectAuthoritativeMarketBotEvidence")) {
  throw new Error("Packaged authoritative Market Bot runtime-evidence flow is incomplete.");
}
const packagedExportJob = packagedServer.slice(packagedServer.indexOf("async function runMigrationExportJob"), packagedServer.indexOf("function startMigrationExport"));
if (!packagedMarketBotMigrationSafety.includes("validateStoppedServices")
  || /collectMigrationMarketBotSafety|revalidateMigrationMarketBotSafety|migrationSafety|historicalIncompleteMarker|catalogFingerprint|runtimeBinarySha256|Quiescent/.test(packagedExportJob)
  || !packagedExportJob.includes("sourceMarket: after.sourceMarket")
  || !packagedServer.includes("buildDestinationMarketCleanupSql")) {
  throw new Error("Packaged migration is missing read-only source evidence or destination-only transactional market cleanup.");
}
if (!packagedMarketBotReconciliation.includes("runPauseReconciliation") || !packagedMarketBotReconciliation.includes("RECONCILE PAUSED MARKET BOT STATE") || !packagedServer.includes("reconcile-market-bot-pause")) {
  throw new Error("Packaged Market Bot Pause Reconciliation workflow or bootstrap-only endpoint is incomplete.");
}
if (!packagedOfflineMarketBotReconciliation.includes("runOfflineMarketBotReconciliation")
  || !packagedOfflineMarketBotReconciliation.includes("RECONCILE LOCAL MARKET BOT EVIDENCE")
  || !packagedServer.includes("reconcile-market-bot-evidence")
  || !packagedServer.includes("collectIndependentWriterSamples")) {
  throw new Error("Packaged Offline Mode local Market Bot evidence repair or independent writer sampling is incomplete.");
}
if (!packagedMigrationMaintenance.includes("captureCheckpoint") || !packagedMigrationMaintenance.includes("sideEffectFree") || !packagedMigrationMaintenance.includes("Game Server Held Offline")) {
  throw new Error("Packaged Migration Maintenance guard is incomplete.");
}
if (!packagedServer.includes("const SERVER_MIGRATION_ENABLED = false;")
  || /data-view=["']server-migration["']|<section id=["']server-migration["']/.test(packagedServer)
  || packagedDesktop.includes('ipcMain.handle("choose-server-migration-')
  || packagedDesktop.includes("offlineStartup.active")) {
  throw new Error("Packaged runtime still exposes the removed Server Migration feature.");
}
if (!packagedStartupPolicy.includes("migration-startup-suppressed") || !packagedServer.includes("SUITE_STARTUP_POLICY.allowAuxiliaryListeners")
  || !packagedServer.includes("SUITE_STARTUP_POLICY.allowManager") || !packagedDesktop.includes("DESKTOP_STARTUP_POLICY.allowDesktopReceiver")) {
  throw new Error("Packaged migration startup-suppression policy is incomplete or initialized too late.");
}
if (!packagedStartupSuppressedRoutes.includes('"/api/server-migration/import-preflight"')
  || !packagedStartupSuppressedRoutes.includes('"/api/server-migration/import"')
  || !packagedServer.includes("startupSuppressedRouteDecision")) {
  throw new Error("Packaged startup-suppressed migration route policy is missing protected import preflight/import support.");
}
if (!packagedMigrationImport.includes("runServerMigrationImport") || !packagedMigrationImport.includes("automatic-rollback") || !packagedMigrationImport.includes("destination-market-cleanup") || !packagedServer.includes("buildDestinationMarketCleanupSql") || packagedServer.includes("MIGRATION_MARKET_BOT_DUMP_FLAGS")) {
  throw new Error("Packaged Server Migration v1 import/rollback workflow is incomplete.");
}
if (!packagedMigrationCore.includes("classifyStructuredMigrationOfflineSample")
  || !packagedMigrationCore.includes("assertStableStructuredMigrationOfflineSamples")
  || !packagedServer.includes("collectMigrationStructuredOfflineEvidence")
  || !packagedServer.includes("kubectl get pods,deployments,statefulsets")) {
  throw new Error("Packaged Server Migration runtime is missing strict two-sample Kubernetes JSON offline classification.");
}
if (!packagedMigrationExport.includes("inspectClosedArchive") || !packagedMigrationExport.includes("verifyPackagedComponents")
  || !packagedServer.includes("inspectSeekableArchive") || !packagedServer.includes('[\"--file=/dev/null\"]')) {
  throw new Error("Packaged Server Migration export is missing closed-file archive verification or package-component binding.");
}
if (!packagedMaintenanceBootstrap.includes("runMaintenanceBootstrap") || !packagedServer.includes("--maintenance-bootstrap") || !packagedServer.includes("maintenance_bootstrap")) {
  throw new Error("Packaged Maintenance Bootstrap isolation or transition coordinator is incomplete.");
}
if (!packagedMaintenanceBootstrap.includes("runMaintenanceBootstrapRecovery") || !packagedMaintenanceTransport.includes("buildMaintenanceTransport")
  || !packagedMaintenanceTransport.includes("payload.tar") || !packagedStdinProcess.includes("inputComplete")) {
  throw new Error("Packaged runtime is missing bounded maintenance guard transport or exact recovery continuation.");
}
if (!packagedDesktop.includes("DESKTOP_STARTUP_POLICY.allowDesktopReceiver") || !packagedDesktop.includes("await startReceiverIfNeeded()")) {
  throw new Error("Packaged desktop runtime is missing normal Receiver startup.");
}
if (!packagedPlayerDirectory.includes("createPlayerDirectory") || !packagedPlayerDirectory.includes("parsePlayerSelector")) {
  throw new Error("Packaged player-directory module is incomplete.");
}
if (!packagedServer.includes("detectedTiers.length === LANDSRAAD_TIER_COUNT") || !packagedServer.includes("Exactly five distinct thresholds")) {
  throw new Error("Packaged Landsraad exact-five protection is incomplete.");
}
if (!packagedServerUpdate.includes("SERVER_UPDATE_TIMEOUTS") || !packagedServerUpdate.includes("createServerUpdateCheckCoordinator")) {
  throw new Error("Packaged Server Updater timeout policy or failure-aware status coordinator is incomplete.");
}
if (!packagedServer.includes("runServerUpdateLifecycle") || !packagedServer.includes("serverUpdateDiagnosticText")) {
  throw new Error("Packaged Server Updater cleanup or structured failure diagnostics are incomplete.");
}
if (!packagedServer.includes('"/api/server-health"') || !packagedServer.includes('id="server-health"') || !packagedServer.includes("serverHealthScanInFlight")) {
  throw new Error("Packaged application is missing the Server Health API, page, or overlap guard.");
}
if (!packagedServerHealth.includes("buildServerHealthReport") || !packagedServerHealth.includes("CrashLoopBackOff") || !packagedServerHealth.includes("FailedScheduling")) {
  throw new Error("Packaged Server Health parser is incomplete.");
}

console.log(`Packaged runtime files verified in ${archive}`);
