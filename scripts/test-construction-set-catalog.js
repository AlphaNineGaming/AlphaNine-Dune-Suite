"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const port = 19320 + Math.floor(Math.random() * 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-construction-sets-"));
const child = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(port + 500),
    ALPHANINE_DATA_DIR: dataDir,
    ALPHANINE_SKIP_MANAGER: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitFor(pathName) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathName}`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Catalog endpoint did not start. ${stderr}`);
}

(async () => {
  try {
    const [giveCatalog, itemDatabaseCatalog] = await Promise.all([
      waitFor("/api/give-items?category=Construction%20Sets"),
      waitFor("/api/item-database/items?category=Construction%20Sets")
    ]);
    const expectedIds = [
      "Atre_BasicLighting_Patent",
      "Atre_BedroomSet_Patent",
      "Atre_DiningRoomSet_Patent",
      "Atre_OfficeSet_Patent",
      "AtreidesSet",
      "Hark_BasicLighting_Patent",
      "Hark_BedroomSet_Patent",
      "Hark_DiningRoomSet_Patent",
      "Hark_OfficeSet_Patent",
      "HarkonnenSet"
    ];
    for (const catalog of [giveCatalog, itemDatabaseCatalog]) {
      assert.strictEqual(catalog.items.length, expectedIds.length);
      assert.deepStrictEqual(catalog.items.map((item) => item.id).sort(), [...expectedIds].sort());
      assert(catalog.items.every((item) => item.category === "Construction Sets"));
      assert(catalog.items.every((item) => item.subtype === "Buildable Set"));
      assert(catalog.items.every((item) => item.spawnable === true));
      assert.strictEqual(catalog.report?.managerCatalogConstructionSets, expectedIds.length);
    }
    console.log("Construction sets are available in Give Item and Item Database.");
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
