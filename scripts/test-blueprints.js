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
  assert.equal(normalized.instances[0].stability, false);
  const explicitStability = normalizeBlueprint({ instances: [{ building_type: "Foundation", x: 0, y: 0, z: 0, provides_stability: true }] });
  assert.equal(explicitStability.instances[0].stability, true);
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
  assert.match(queries[1], /nextval\('dune\.building_blueprints_id_seq'::regclass\)/);
  assert.match(queries[1], /'!!bbp#' \|\| blueprint_key\.id::text/);
  assert.match(queries[1], /\[0:3\]=\{/);
  assert.match(queries[1], /insert into dune\.building_blueprints \(id, item_id, player_id, building_blueprint_map\)/);
  assert.match(queries[1], /select blueprint_key\.id, inserted_item\.id, null::bigint, '' from inserted_item, blueprint_key/);
  assert.doesNotMatch(queries[1], /updated_item as/);
  assert.doesNotMatch(queries[1], /!!bbp#0/);
  assert.doesNotMatch(queries[1], /PlayerBaseBackupId/);
  assert.equal(audits[0].action, "blueprints.import");
}

async function testNativeSolidoOwnershipFallback() {
  const queries = [];
  const service = createBlueprintService({ query: async (value) => { queries.push(value); return "[]"; } });
  assert.deepEqual(await service.list("2"), []);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /update dune\.items i/);
  assert.match(queries[0], /jsonb_set/);
  assert.match(queries[0], /'!!bbp#' \|\| bb\.id::text/);
  assert.match(queries[1], /left join dune\.inventories inv on inv\.id = i\.inventory_id/);
  assert.match(queries[1], /coalesce\(bb\.player_id, inv\.actor_id\)/);
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
  assert.match(
    source,
    /const blueprintService = createBlueprintService\(\{[\s\S]*?query: \(sql, timeout\) => dbQueryStreamed\(sql, timeout\)/,
    "Blueprint database operations must stream SQL over stdin so large imports do not exceed Windows command-line limits."
  );
  const marker = source.indexOf("const WEB_PORTAL_URLS=");
  const start = source.lastIndexOf("<script>", marker);
  const end = source.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "Suite inline script should be discoverable");
  const script = source.slice(start + "<script>".length, end)
    .replace("${JSON.stringify(portalUrls)}", "[]")
    .replace("${JSON.stringify(HYDRATION_TOOLTIP)}", JSON.stringify("Hydration"))
    .replaceAll("${HTTPS_PORT}", "443")
    .replaceAll("${SERVER_UPDATE_TIMEOUTS.uiPollMs}", "30000")
    .replaceAll("${SERVER_UPDATE_TIMEOUTS.uiStartMs}", "30000")
    .replaceAll("${SERVER_UPDATE_TIMEOUTS.uiCheckMs}", "120000")
    .replaceAll("${APP_VERSION}", "1.0.83")
    .replace("${JSON.stringify(SERVER_MANAGEMENT_UI_TIMEOUTS)}", "{}")
    .replaceAll("${SERVER_MANAGEMENT_UI_TIMEOUTS.start}", "960000");
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /function openBlueprints\(/);
  assert.match(script, /function importBlueprintFiles\(/);
  assert.match(script, /function exportBlueprintRows\(/);
  assert.match(script, /function exportSelectedBlueprints\(/);
  assert.match(script, /function exportAllBlueprints\(/);
  assert.match(source, /id="blueprintExportSelected"/);
  assert.match(source, /id="blueprintExportAll"/);
  assert.doesNotMatch(source, /blueprintViewer|BABYLON|blueprintProcedural|blueprint-piece-catalog|blueprint-viewer-transform/);
  assert.doesNotMatch(source, /data-blueprint-action="view"|>View<\/button>|blueprintDeleteSelected|deleteBlueprint/);
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
