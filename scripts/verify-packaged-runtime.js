const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");

const root = path.join(__dirname, "..");
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
  "lib/teleport-request-mode.js",
  "electron/main.js"
];
const missing = requiredRuntimeFiles.filter((entry) => !packaged.has(entry));

if (missing.length) {
  throw new Error(`Packaged application is missing required runtime files: ${missing.join(", ")}`);
}

const packagedServer = asar.extractFile(archive, "server.js").toString("utf8");
const packagedMarketBotModule = asar.extractFile(archive, "lib/market-bot.js").toString("utf8");
const packagedPlayerDirectory = asar.extractFile(archive, "lib/player-directory.js").toString("utf8");
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

console.log(`Packaged runtime files verified in ${archive}`);
