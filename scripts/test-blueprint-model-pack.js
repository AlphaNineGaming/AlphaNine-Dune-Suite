const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBlueprintModelPack, normalizePieceKey } = require("../lib/blueprint-model-pack");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-blueprint-models-"));
const source = path.join(root, "source");
const dataDir = path.join(root, "data");
const emptyBundledDir = path.join(root, "empty-bundled");
fs.mkdirSync(emptyBundledDir, { recursive: true });
fs.mkdirSync(path.join(source, "Dune", "Meshes"), { recursive: true });
fs.writeFileSync(path.join(source, "Dune", "Meshes", "SM_Env_PB_Atre_Outpost_Wall_02.glb"), Buffer.from("test-glb"));
fs.writeFileSync(path.join(source, "blueprint-model-pack.json"), JSON.stringify({
  name: "Test Models",
  models: {
    Atreides_Outpost_Wall_02: "Dune/Meshes/SM_Env_PB_Atre_Outpost_Wall_02.glb"
  }
}));

try {
  assert.strictEqual(normalizePieceKey("Atreides_Outpost_Wall_02"), "atreoutpostwall02");
  const pack = createBlueprintModelPack({ dataDir, bundledDir: emptyBundledDir });
  assert.strictEqual(pack.status().installed, false);
  const imported = pack.importFromDirectory(source);
  assert.strictEqual(imported.installed, true);
  assert.strictEqual(imported.modelCount, 1);
  const resolved = pack.resolveTypes(["Atreides_Outpost_Wall_02", "Missing_Floor"]);
  assert.strictEqual(resolved.matchedCount, 1);
  assert.match(resolved.models.Atreides_Outpost_Wall_02, /\.glb$/i);
  assert.ok(pack.resolveFile("Dune/Meshes/SM_Env_PB_Atre_Outpost_Wall_02.glb"));
  assert.strictEqual(pack.resolveFile("../config.json"), null);
  assert.throws(() => pack.importFromDirectory(path.join(root, "missing")), /valid model-pack folder/i);
  const bundled = createBlueprintModelPack({ dataDir: path.join(root, "bundled-data") });
  const bundledStatus = bundled.status();
  assert.strictEqual(bundledStatus.exactBundled, true);
  assert.strictEqual(bundledStatus.modelCount, 542);
  assert.strictEqual(bundledStatus.mappingCount, 555);
  assert.strictEqual(bundled.resolveTypes(["Atreides_Outpost_Wall_02"]).matchedCount, 1);
  assert.strictEqual(bundled.resolveTypes([
    "Generator_Placeable",
    "SpiceSilo_Placeable",
    "Choam_PentashieldSurfaceHorizontal_Placeable",
    "Choam_PentashieldSurfaceVertical_Placeable"
  ]).matchedCount, 4);
  console.log("Blueprint offline model-pack tests passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
