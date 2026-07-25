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
  "lib/teleport-request-mode.js",
  "electron/main.js",
  "scripts/test-landsraad-tiers.js",
  "scripts/test-server-update-monitor.js",
  `RELEASE_NOTES_${rootPackage.version}.md`
];
const missing = requiredRuntimeFiles.filter((entry) => !packaged.has(entry));

if (missing.length) {
  throw new Error(`Packaged application is missing required runtime files: ${missing.join(", ")}`);
}

const packagedServer = asar.extractFile(archive, "server.js").toString("utf8");
const packagedMarketBotModule = asar.extractFile(archive, "lib/market-bot.js").toString("utf8");
const packagedPlayerDirectory = asar.extractFile(archive, "lib/player-directory.js").toString("utf8");
const packagedServerUpdate = asar.extractFile(archive, "lib/server-update.js").toString("utf8");
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

console.log(`Packaged runtime files verified in ${archive}`);
