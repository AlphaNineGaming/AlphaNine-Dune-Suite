"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const port = 19120 + Math.floor(Math.random() * 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-schematic-catalog-"));
const child = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(port), ALPHANINE_HTTPS_PORT: String(port + 500), ALPHANINE_DATA_DIR: dataDir, ALPHANINE_SKIP_MANAGER: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitForCatalog() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/gear-codex/items?q=Elohim-Class`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Catalog endpoint did not start. ${stderr}`);
}

(async () => {
  try {
    const data = await waitForCatalog();
    const schematic = (data.items || []).find((item) => item.id === "Unique_MiscEquipment_FullSuspensorBelt_Durability_Schematic");
    assert(schematic, "Elohim-Class Suspensor Belt schematic is missing from the shared Suite catalog.");
    assert.strictEqual(schematic.name, "Elohim-Class Suspensor Belt");
    assert.strictEqual(schematic.category, "Schematics");
    assert.strictEqual(schematic.subtype, "Unique Schematic");
    assert.strictEqual(schematic.tier, "Tier 6");
    assert.strictEqual(schematic.spawnable, true);
    assert(data.report?.marketBotCatalogSchematics > 0, "Market Bot schematic merge was not reported.");
    console.log("Market Bot schematics are merged into the shared Item Catalog and Give Item source.");
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
