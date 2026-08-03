const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ExperimentalResourceAreas = require("../lib/experimental-resource-areas");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expected = ["Bauxite", "Magnetite", "Azurite", "Dolomite", "Erythrite", "Jasmium", "Basalt", "Cistanche", "Primrose Field", "Saguaro"];

assert.deepStrictEqual(ExperimentalResourceAreas.RESOURCES.map(resource => resource.name), expected);
assert.equal(new Set(ExperimentalResourceAreas.RESOURCES.map(resource => resource.key)).size, 10);
assert.deepStrictEqual(ExperimentalResourceAreas.ORIENTATIONS, [{ key: "source-top-max-y", label: "Source top = world maximum Y" }]);
assert.deepStrictEqual(ExperimentalResourceAreas.DISTRIBUTION_BOUNDS, { minX: -457200, maxX: 355600, minY: -457200, maxY: 355600, sizeCm: 812800, centreX: -50800, centreY: -50800 });
assert.deepStrictEqual(ExperimentalResourceAreas.HAGGA_BASIN_RASTER_BOUNDS, { minX: -456752.21, maxX: 354547.46, minY: -450630.14, maxY: 353821.95 });
assert.equal(ExperimentalResourceAreas._test.CACHE_SCHEMA_VERSION, 3);
assert.equal(ExperimentalResourceAreas._test.DISPLAY_GAMMA, 0.5);
assert.equal(ExperimentalResourceAreas._test.displayAlphaForIntensity(0), 0);
assert.equal(ExperimentalResourceAreas._test.displayAlphaForIntensity(1), 16);
assert.equal(ExperimentalResourceAreas._test.displayAlphaForIntensity(64), 128);
assert.equal(ExperimentalResourceAreas._test.displayAlphaForIntensity(255), 255);
assert(ExperimentalResourceAreas.HAGGA_BASIN_RASTER_BOUNDS.minX >= ExperimentalResourceAreas.DISTRIBUTION_BOUNDS.minX);
assert(ExperimentalResourceAreas.HAGGA_BASIN_RASTER_BOUNDS.maxX <= ExperimentalResourceAreas.DISTRIBUTION_BOUNDS.maxX);
assert(ExperimentalResourceAreas.HAGGA_BASIN_RASTER_BOUNDS.minY >= ExperimentalResourceAreas.DISTRIBUTION_BOUNDS.minY);
assert(ExperimentalResourceAreas.HAGGA_BASIN_RASTER_BOUNDS.maxY <= ExperimentalResourceAreas.DISTRIBUTION_BOUNDS.maxY);
for (const unresolved of ["Stone", "Fiber", "Fuel", "Scrap", "Rogue", "T6ResourceA", "T6ResourceB"]) assert.equal(expected.includes(unresolved), false, `${unresolved} must remain excluded.`);

const pixels = Buffer.alloc(1024 * 1024);
for (let row = 0; row < 1024; row += 1) pixels.fill(Math.round(row / 1023 * 255), row * 1024, (row + 1) * 1024);
const heatmap = { width: 1024, height: 1024, pixels };
const topMax = ExperimentalResourceAreas._test.resampleToRaster(heatmap, "#112233");
const topAlpha = 3;
const bottomAlpha = ((1024 - 1) * 1024 * 4) + 3;
assert(topMax[topAlpha] < topMax[bottomAlpha], "Maximum-Y alignment does not map the displayed top edge to the source image top.");
assert.deepStrictEqual(Array.from(topMax.subarray(0, 3)), [0x11, 0x22, 0x33]);
assert(topMax[((256 * 1024) * 4) + 3] > pixels[256 * 1024], "The display transfer must make low nonzero heatmap intensity visible at the default opacity.");
const png = ExperimentalResourceAreas._test.encodeRgbaPng(1024, 1024, topMax);
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-resource-area-test-"));
try {
  const identity = { buildId: "24335045", pakSha256: "a".repeat(64), pakPath: "Tools.pak", paksDir: "Paks" };
  identity.cacheKey = ExperimentalResourceAreas._test.cacheKeyForIdentity(identity);
  assert.equal(identity.cacheKey, `build-24335045-tools-${"a".repeat(64)}`);
  const activeCache = ExperimentalResourceAreas._test.cacheDirectory(temp, identity.cacheKey);
  fs.mkdirSync(activeCache, { recursive: true });
  fs.writeFileSync(path.join(activeCache, "metadata.json"), JSON.stringify({ schemaVersion: ExperimentalResourceAreas._test.CACHE_SCHEMA_VERSION, cacheKey: identity.cacheKey, generatedAt: "test", source: { gameBuildId: identity.buildId, pakSha256: identity.pakSha256 }, calibration: { intensityLabel: "Heatmap intensity" }, resources: ExperimentalResourceAreas.RESOURCES }));
  for (const resource of ExperimentalResourceAreas.RESOURCES) for (const orientation of ExperimentalResourceAreas.ORIENTATIONS) fs.writeFileSync(path.join(activeCache, `${resource.key}.${orientation.key}.png`), png);
  const status = ExperimentalResourceAreas.status(temp, { identity });
  assert.equal(status.available, true);
  assert.equal(status.needsGeneration, false);
  assert.equal(status.missing.length, 0);
  assert(ExperimentalResourceAreas.overlayFile(temp, "bauxite", "source-top-max-y", identity.cacheKey).endsWith("bauxite.source-top-max-y.png"));
  assert.equal(ExperimentalResourceAreas.overlayFile(temp, "stone", "source-top-max-y", identity.cacheKey), "");

  const upgradedBuild = { ...identity, buildId: "24335046", cacheKey: "" };
  upgradedBuild.cacheKey = ExperimentalResourceAreas._test.cacheKeyForIdentity(upgradedBuild);
  assert.equal(ExperimentalResourceAreas.status(temp, { identity: upgradedBuild }).needsGeneration, true, "A new installed game build must miss the previous cache.");
  const upgradedPak = { ...identity, pakSha256: "b".repeat(64), cacheKey: "" };
  upgradedPak.cacheKey = ExperimentalResourceAreas._test.cacheKeyForIdentity(upgradedPak);
  assert.equal(ExperimentalResourceAreas.status(temp, { identity: upgradedPak }).needsGeneration, true, "A changed Tools.pak hash must miss the previous cache.");

  fs.writeFileSync(path.join(temp, "obsolete.source-top-min-y.png"), png);
  ExperimentalResourceAreas._test.removeAlternateOrientationArtifacts(temp);
  assert.equal(fs.existsSync(path.join(temp, "obsolete.source-top-min-y.png")), false, "Minimum-Y artifacts must be removed.");

  const steamapps = path.join(temp, "steamapps");
  const paks = path.join(steamapps, "common", "DuneAwakening", "DuneSandbox", "Content", "Paks");
  fs.mkdirSync(paks, { recursive: true });
  fs.writeFileSync(path.join(steamapps, `appmanifest_${ExperimentalResourceAreas._test.DUNE_STEAM_APP_ID}.acf`), '"AppState"\n{\n  "buildid" "7654321"\n}\n');
  const fakePak = Buffer.alloc(300);
  fakePak.writeUInt32LE(0x5a6f12e1, fakePak.length - 204);
  fakePak.writeInt32LE(11, fakePak.length - 200);
  fs.writeFileSync(path.join(paks, "Tools.pak"), fakePak);
  assert.equal(ExperimentalResourceAreas._test.resolvePaksDirectory(paks), paks, "A direct Content/Paks selection must resolve.");
  assert.equal(ExperimentalResourceAreas._test.resolvePaksDirectory(path.join(steamapps, "common", "DuneAwakening")), paks, "A selected Dune game root must resolve to Content/Paks.");
  assert.equal(ExperimentalResourceAreas._test.resolvePaksDirectory(temp), paks, "A selected Steam library root must resolve to Content/Paks.");
  const discovered = ExperimentalResourceAreas._test.sourceIdentity({ paksDir: paks });
  assert.equal(discovered.buildId, "7654321");
  assert.match(discovered.cacheKey, /^build-7654321-tools-[a-f0-9]{64}$/);

  const unsupportedPak = path.join(temp, "unsupported.pak");
  fs.writeFileSync(unsupportedPak, Buffer.alloc(300));
  assert.throws(() => ExperimentalResourceAreas._test.validateSupportedPak(unsupportedPak), /not the supported Dune build format/);
  const unavailable = ExperimentalResourceAreas.status(path.join(temp, "missing-cache"), { paksDir: path.join(temp, "missing-paks") });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.needsGeneration, false);
  assert.match(unavailable.source.error, /Tools\.pak was not found/i);

  const writableCache = path.join(temp, "app-data", "resource-areas");
  assert.equal(ExperimentalResourceAreas._test.prepareWritableCacheRoot(writableCache), writableCache);
  assert.equal(fs.existsSync(writableCache), true, "The cache must be created in a writable application-data location.");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

if (packageJson.scripts) {
  assert.equal(packageJson.scripts["test:experimental-resource-areas"], "node scripts/test-experimental-resource-areas.js");
  assert.equal(packageJson.scripts["test:experimental-resource-areas-ui"], "node scripts/test-experimental-resource-areas-ui.js");
  assert.equal(packageJson.scripts["generate:resource-areas"], "node scripts/generate-experimental-resource-areas.js");
}
assert.match(serverSource, /Experimental Resource Areas/);
assert.match(serverSource, /Procedural distribution data only—not exact resource nodes or guaranteed spawns/);
assert.match(serverSource, /Heatmap intensity/);
assert.match(serverSource, /id="liveLayerExperimentalResources" type="checkbox" onchange=/);
assert.doesNotMatch(serverSource, /id="liveLayerExperimentalResources" type="checkbox" checked/, "Experimental overlays must remain disabled by default.");
assert.match(serverSource, /source-top-max-y/);
assert.doesNotMatch(serverSource, /source-top-min-y/);
assert.doesNotMatch(serverSource, /liveExperimentalResourceOrientation/);
assert.match(serverSource, /liveExperimentalResourceOpacity/);
assert.match(serverSource, /id="liveExperimentalResourceOpacity"[^>]+value="45"/);
assert.match(serverSource, /data-experimental-resource/);
assert.match(serverSource, /filter\(resource=>selected\.has\(resource\.key\)\)/);
assert.match(serverSource, /showAllExperimentalResourceAreas/);
assert.match(serverSource, /hideAllExperimentalResourceAreas/);
assert.doesNotMatch(serverSource, /Temporary Orientation Diagnostic|liveExperimentalDiagnostic|resource-areas\/diagnostic/);
assert.match(serverSource, /IgwLevelBounds/);
assert.match(serverSource, /Icehunter was consulted only as independent evidence|independently cross-checked against Icehunter/);
assert.match(ExperimentalResourceAreas.PROVENANCE.nonIncorporation, /No Icehunter project code, resource markers, CDN files, map tiles, icons, heatmap PNGs/);
assert.match(serverSource, /interactive:false,className:"live-map-resource-area-overlay"/);
assert.match(serverSource, /EXPERIMENTAL_RESOURCE_AREA_CACHE_DIR/);
assert.match(serverSource, /cacheKey/);
assert.match(serverSource, /needsGeneration/);
assert.match(serverSource, /Preparing resource areasâ€¦|Preparing resource areas…/);
assert.match(serverSource, /Resource areas ready\./);
assert.match(serverSource, /No resource types selected\./);
assert.match(serverSource, /Select Game Folder/);
assert.match(serverSource, /image-load-success/);
assert.match(serverSource, /image-load-failure/);
assert.match(serverSource, /render-complete/);
assert.match(serverSource, /empty-selection-populated/);
assert.match(serverSource, /liveExperimentalResourceErrorActions/);
if (packageJson.build) {
  const packageFiles = JSON.stringify(packageJson.build.files || []);
  const asarUnpack = JSON.stringify(packageJson.build.asarUnpack || []);
  assert.match(packageFiles, /!data\/experimental-resource-areas\/\*\*/i, "The local overlay cache needs an explicit package exclusion.");
  assert.match(packageFiles, /!\*\*\/\*\.source-top-max-y\.png/i, "Derived Maximum-Y images need an explicit package exclusion.");
  assert.match(packageFiles, /tools\/repak\/\*\*/i, "The compatible local extraction helper must be packaged.");
  assert.match(asarUnpack, /tools\/repak\/\*\*/i, "The extraction helper must live outside the read-only ASAR.");
}
assert.doesNotMatch(JSON.stringify(ExperimentalResourceAreas.RESOURCES), /stone|fiber|fuel|scrap|rogue|t6resource/i);
const resourceModuleSource = fs.readFileSync(path.join(root, "lib", "experimental-resource-areas.js"), "utf8");
assert.doesNotMatch(resourceModuleSource, /https?:\/\/|Red-Blink/i, "Resource areas must not depend on third-party URLs or Red-Blink.");
assert.doesNotMatch(resourceModuleSource, /catch\s*\([^)]*\)\s*\{\s*\}/, "Resource-area backend errors must not be swallowed by empty catch blocks.");
assert.match(resourceModuleSource, /app\.asar\.unpacked/, "The packaged generator must resolve its writable/executable helper outside app.asar.");
assert.match(serverSource, /path\.join\(DATA_DIR,\s*"experimental-resource-areas"\)/, "Generated overlays must use the writable Suite data directory.");
const bundledRepak = path.join(root, "tools", "repak", "repak.exe");
assert(fs.existsSync(bundledRepak), "The packaged repak helper is missing from the source tree.");
const repakVersion = require("child_process").spawnSync(bundledRepak, ["--version"], { encoding: "utf8", windowsHide: true });
assert.equal(repakVersion.status, 0, `The packaged repak helper cannot run: ${repakVersion.stderr || repakVersion.stdout}`);
assert.match(repakVersion.stdout || repakVersion.stderr, /0\.2\.3/);
const offlineDecompressor = path.join(root, "tools", "repak", "oo2core_9_win64.dll");
assert(fs.existsSync(offlineDecompressor), "The packaged offline decompressor is missing.");
assert.equal(fs.readFileSync(offlineDecompressor).subarray(0, 2).toString("ascii"), "MZ", "The offline decompressor is not a Windows DLL.");
const offlineHash = require("crypto").createHash("sha256").update(fs.readFileSync(offlineDecompressor)).digest("hex");
assert.equal(offlineHash, ExperimentalResourceAreas._test.OPEN_SOURCE_DECOMPRESSOR_SHA256, "The offline decompressor hash is not the approved open-source build.");
assert.notEqual(offlineHash, "6f5d41a7892ea6b2db420f2458dad2f84a63901c9a93ce9497337b16c195f457", "The proprietary downloader-provided Oodle DLL must never be packaged.");
assert.equal(ExperimentalResourceAreas._test.verifyOfflineDecompressor(bundledRepak), offlineDecompressor);
for (const sourceFile of ["COPYING", "BUILD.md", "alphanine-oodle-abi-shim.cpp", "kraken.cpp", "bitknit.cpp", "lzna.cpp", "ooz.h", "ooz_private.h"]) {
  assert(fs.existsSync(path.join(root, "tools", "repak", "ooz-source", sourceFile)), `Corresponding open-source decompressor source is missing: ${sourceFile}`);
}

const overlayFunctionStart = serverSource.indexOf("function renderExperimentalResourceAreas(");
const overlayFunctionEnd = serverSource.indexOf("function toggleExperimentalResourceAreas(", overlayFunctionStart);
const overlayFunction = serverSource.slice(overlayFunctionStart, overlayFunctionEnd);
assert.doesNotMatch(overlayFunction, /teleport|liveMapSelectedEntity|selectLiveCoordinates/i, "Experimental overlays entered the teleport or entity-selection path.");
assert.match(overlayFunction, /L\.imageOverlay/);

console.log("Experimental resource-area mappings, Maximum-Y calibration, build/hash cache invalidation, clean-install failure handling, upgrade behavior, UI safety, and package exclusion tests passed.");
