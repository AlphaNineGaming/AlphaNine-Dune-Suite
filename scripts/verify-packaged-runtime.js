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
  "market-bot/main.go",
  "lib/player-directory.js",
  "lib/server-update.js",
  "lib/server-health.js",
  "lib/teleport-request-mode.js",
  "lib/experimental-resource-areas.js",
  "data/dune-resource-spawn-locations.json",
  "electron/main.js",
  "scripts/test-live-map-resources.js",
  "scripts/generate-experimental-resource-areas.js",
  "scripts/test-experimental-resource-areas.js",
  "scripts/test-landsraad-tiers.js",
  "scripts/test-server-update-monitor.js",
  "scripts/test-server-health.js",
  `RELEASE_NOTES_${rootPackage.version}.md`
];
const missing = requiredRuntimeFiles.filter((entry) => !packaged.has(entry));

if (missing.length) {
  throw new Error(`Packaged application is missing required runtime files: ${missing.join(", ")}`);
}

for (const entry of packaged) {
  if (/experimental-resource-areas\/|\.source-top-(?:max|min)-y\.png$/i.test(entry)) {
    throw new Error(`Packaged application contains a generated resource-area cache artifact: ${entry}`);
  }
  if (/\.(?:pak|uasset|uexp)$/i.test(entry)) {
    throw new Error(`Packaged application contains a raw Funcom package asset: ${entry}`);
  }
}

const packagedServer = asar.extractFile(archive, "server.js").toString("utf8");
const packagedMarketBotModule = asar.extractFile(archive, "lib/market-bot.js").toString("utf8");
const packagedPlayerDirectory = asar.extractFile(archive, "lib/player-directory.js").toString("utf8");
const packagedServerUpdate = asar.extractFile(archive, "lib/server-update.js").toString("utf8");
const packagedServerHealth = asar.extractFile(archive, "lib/server-health.js").toString("utf8");
const packagedExperimentalResources = asar.extractFile(archive, "lib/experimental-resource-areas.js").toString("utf8");
if (/https?:\/\/|Red-Blink/i.test(packagedExperimentalResources)) {
  throw new Error("Packaged Experimental Resource Areas code contains an external URL or Red-Blink reference.");
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
