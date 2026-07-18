const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {
  createBlueprintService,
  importName,
  normalizeBlueprint,
  requireId,
  sanitizeBlueprintName
} = require("../lib/blueprints");
const { createZipArchive } = require("../lib/zip-archive");

function testNormalization() {
  assert.equal(sanitizeBlueprintName(" My_Base.v2 "), "My Base v2");
  assert.equal(importName({ instances: [{ building_type: "Foundation" }] }, ""), "Foundation");
  assert.equal(importName({ instances: [{ building_type: "Foundation" }] }, "Hawks_Base.json"), "Hawks Base");
  assert.equal(requireId("42"), 42);
  assert.throws(() => requireId("0"), /positive whole number/);

  const normalized = normalizeBlueprint({
    name: "Base",
    instances: [{ instance_id: 0, building_type: "Atreides_Outpost_Foundation", x: 1, y: 2, z: 3, rotation: 90 }],
    placeables: [{ placeable_id: 0, building_type: "Lamp", x: 4, y: 5, z: 6 }],
    pentashields: [{ placeable_id: 0, scale: [1, 2, 3] }]
  });
  assert.equal(normalized.instances[0].id, 1);
  assert.equal(normalized.instances[0].stability, true);
  assert.equal(normalized.placeables[0].id, 1);
  assert.equal(normalized.pentashields[0].placeableId, 1);
  assert.throws(() => normalizeBlueprint({ instances: "bad", placeables: [] }), /instances must be an array/);
  assert.throws(() => normalizeBlueprint({ instances: [] }), /no instances/i);
  assert.throws(() => normalizeBlueprint({ placeables: [{ building_type: "", x: 0, y: 0, z: 0 }] }), /building_type/);
}

async function testServiceSqlFlow() {
  const queries = [];
  const audits = [];
  const outputs = [
    JSON.stringify(["Base"]),
    JSON.stringify({ status: "inserted", blueprintId: 18, itemId: 90, playerName: "Paul", online: false, pieces: 1, placeables: 0, pentashields: 0 })
  ];
  const service = createBlueprintService({
    query: async (sql) => { queries.push(sql); return outputs.shift(); },
    audit: (action, payload) => audits.push({ action, payload })
  });
  const result = await service.importBlueprint("123", {
    name: "Base",
    instances: [{ building_type: "Wall", x: 0, y: 1, z: 2, rotation: 3 }]
  }, "base.json");
  assert.equal(result.blueprintName, "Base (2)");
  assert.equal(result.blueprintId, 18);
  assert.match(queries[1], /BuildingBlueprint_CopyDevice/);
  assert.match(queries[1], /Base \(2\)/);
  assert.match(queries[1], /!!bbp#/);
  assert.match(queries[1], /\[0:3\]=\{/);
  assert.equal(audits[0].action, "blueprints.import");
}

async function testNativeSolidoOwnershipFallback() {
  let sql = "";
  const service = createBlueprintService({ query: async (value) => { sql = value; return "[]"; } });
  assert.deepEqual(await service.list("2"), []);
  assert.match(sql, /left join dune\.inventories inv on inv\.id = i\.inventory_id/);
  assert.match(sql, /coalesce\(bb\.player_id, inv\.actor_id\)/);
}

async function testNativeTransformArrayBounds() {
  let sql = "";
  const service = createBlueprintService({ query: async (value) => { sql = value; return JSON.stringify({ name: "Native", instances: [], placeables: [], pentashields: [] }); } });
  await service.exportBlueprint(2);
  assert.match(sql, /transform\[array_lower\(bi\.transform,1\)\]/);
  assert.match(sql, /transform\[array_lower\(bp\.transform,1\)\+5\]/);
}

function testZip() {
  const zip = createZipArchive([{ name: "base.json", content: "{}\n" }], new Date("2026-01-01T00:00:00Z"));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.ok(zip.includes(Buffer.from("base.json")));
}

function testInlineUiSyntax() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const marker = source.indexOf("const WEB_PORTAL_URLS=");
  const start = source.lastIndexOf("<script>", marker);
  const end = source.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "Suite inline script should be discoverable");
  const script = source.slice(start + "<script>".length, end)
    .replace("${JSON.stringify(portalUrls)}", "[]")
    .replace("${JSON.stringify(HYDRATION_TOOLTIP)}", JSON.stringify("Hydration"))
    .replaceAll("${APP_VERSION}", "1.0.55");
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /function openBlueprints\(/);
  assert.match(script, /function importBlueprintFiles\(/);
  assert.match(script, /function openBlueprintViewer\(/);
  assert.match(script, /function renderBlueprintViewerExact3d\(/);
  assert.match(script, /function blueprintExactYawCorrection\(/);
  assert.match(script, /Atreides_Outpost_Wall_Inclined_Wide_Left"\)return -37\.5/);
  assert.match(script, /Atreides_Outpost_Wall_Inclined_Wide_Right"\)return 37\.5/);
  assert.match(script, /Number\(yaw\|\|0\)\+blueprintExactYawCorrection\(type,yaw,row\)/);
  assert.match(script, /function blueprintApplyStairTopologyCorrections\(/);
  assert.match(script, /!currentUpper&&oppositeUpper/);
  assert.match(script, /row\.autoYawCorrection=180/);
  assert.match(script, /alphanine-blueprint-rotations:v2:/);
  assert.match(script, /function blueprintChangeSelectedRotation\(/);
  assert.match(script, /function blueprintResetSelectedRotation\(/);
  assert.match(script, /PointerEventTypes\.POINTERPICK/);
  assert.match(script, /localStorage\.setItem\(blueprintViewer\.overrideStorageKey/);
  assert.match(script, /event\.key==="r"\|\|event\.key==="R"/);
  assert.match(script, /function attachBlueprintCameraControls\(/);
  assert.match(script, /function blueprintSceneDisposed\(/);
  assert.match(script, /if\(!blueprintSceneDisposed\(blueprintViewer\.scene\)\)blueprintViewer\.scene\.render\(\)/);
  assert.doesNotMatch(script, /baseScale=root\.scaling\.clone\(\)/);
  assert.match(script, /blueprintApplyExactScale\(root,row\)/);
  assert.match(script, /node\.scaling\.set\(x,y,z\)/);
  assert.match(script, /root\.rotationQuaternion=baseQuaternion/);
  assert.match(script, /root\.addRotation\(BABYLON\.Tools\.ToRadians\(-row\.pitch\)/);
  assert.doesNotMatch(script, /wrapper\.addRotation\(BABYLON\.Tools\.ToRadians\(-row\.pitch\)/);
  assert.match(script, /camera\.beta=Math\.PI\*\.38/);
  assert.match(script, /camera\.attachControl\(canvas,true\)/);
  assert.match(script, /camera\.inputs\.attached\.pointers\.buttons=\[0,1,2\]/);
  assert.match(script, /camera\.panningMouseButton=2/);
  assert.match(script, /addEventListener\("dblclick",reset\)/);
  assert.match(script, /addEventListener\("wheel",containWheel,\{passive:false\}\)/);
  assert.match(script, /containedEvents=\["pointerdown","pointermove","pointerup","pointercancel","click","auxclick"\]/);
  assert.match(script, /function previewSelectedBlueprintFile\(/);
  assert.match(script, /function showBlueprintViewerData\(/);
  assert.match(source, /id="blueprintViewerCanvas"/);
  assert.doesNotMatch(source, />Rotate Left<|>Rotate Right<|>Tilt Up<|>Tilt Down<|>Zoom In<|>Zoom Out</);
}

async function main() {
  testNormalization();
  await testServiceSqlFlow();
  await testNativeSolidoOwnershipFallback();
  await testNativeTransformArrayBounds();
  testZip();
  testInlineUiSyntax();
  console.log("Blueprint feature tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
