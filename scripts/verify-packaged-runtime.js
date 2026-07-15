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
  "lib/player-directory.js",
  "lib/teleport-request-mode.js",
  "electron/main.js"
];
const missing = requiredRuntimeFiles.filter((entry) => !packaged.has(entry));

if (missing.length) {
  throw new Error(`Packaged application is missing required runtime files: ${missing.join(", ")}`);
}

const packagedServer = asar.extractFile(archive, "server.js").toString("utf8");
const packagedPlayerDirectory = asar.extractFile(archive, "lib/player-directory.js").toString("utf8");
if (!packagedServer.includes("loadSharedPlayerDirectory") || !packagedServer.includes("adminPlayerDirectory")) {
  throw new Error("Packaged server is missing the stabilized shared player-directory integration.");
}
if (!packagedPlayerDirectory.includes("createPlayerDirectory") || !packagedPlayerDirectory.includes("parsePlayerSelector")) {
  throw new Error("Packaged player-directory module is incomplete.");
}

console.log(`Packaged runtime files verified in ${archive}`);
