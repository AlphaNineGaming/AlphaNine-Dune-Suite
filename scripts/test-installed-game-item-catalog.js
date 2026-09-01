"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  BASE_ITEM_TABLES,
  extractDataTableRowNames,
  displayNameForRow
} = require("../lib/installed-game-item-catalog");

const root = path.resolve(__dirname, "..");
const catalogPath = path.join(root, "data", "dune-installed-items-catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");

// Minimal Unreal name-map/export fixture for the exact DataTable row marker used by the scanner.
const originalPackageNames = require("../lib/experimental-resource-areas").packageNames;
assert.equal(typeof originalPackageNames, "function");
const fakeNames = ["Unused", "None", "First_Item", "Second_Item"];
const fakeExport = Buffer.alloc(48);
for (const [offset, index] of [[0, 2], [24, 3]]) {
  fakeExport.writeInt32LE(1, offset);
  fakeExport.writeInt32LE(1, offset + 8);
  fakeExport.writeInt32LE(index, offset + 16);
}
// Test the row parser with a tiny package-name fixture by replacing only its package parser input.
const itemModulePath = require.resolve("../lib/installed-game-item-catalog");
const resourceModule = require("../lib/experimental-resource-areas");
const savedPackageNames = resourceModule.packageNames;
resourceModule.packageNames = () => fakeNames;
delete require.cache[itemModulePath];
const fixtureModule = require("../lib/installed-game-item-catalog");
assert.deepEqual(fixtureModule.extractDataTableRowNames(Buffer.alloc(0), fakeExport), ["First_Item", "Second_Item"]);
resourceModule.packageNames = savedPackageNames;
delete require.cache[itemModulePath];

assert.equal(catalog.source, "installed-game-data");
assert.equal(catalog.tables.length, BASE_ITEM_TABLES.length);
assert.equal(catalog.totalItems, catalog.items.length);
assert.ok(catalog.items.length >= 3500, `Expected at least 3,500 installed-game items, found ${catalog.items.length}.`);
const unique = new Set(catalog.items.map((item) => item.id.toLowerCase()));
assert.equal(unique.size, catalog.items.length, "Installed-game catalog contains duplicate template identifiers.");
assert.equal(new Set(catalog.tables.map((table) => table.category.toLowerCase())).size, catalog.tables.length, "Installed-game tables contain duplicate category menus.");
const schematics = catalog.items.filter((item) => item.category === "Schematics");
assert.ok(schematics.length >= 1200, `Expected at least 1,200 installed-game schematics, found ${schematics.length}.`);
assert.ok(!catalog.items.some((item) => /^(?:Default__)?BP_.*_C$/i.test(item.id)), "Blueprint class names were mistaken for item rows.");
const cobra = catalog.items.find((item) => item.id.toLowerCase() === "b1c4_unique_smg2_schematic");
assert.ok(cobra, "Spitting Cobra schematic is missing from the installed-game table.");
assert.equal(cobra.name, "Spitting Cobra Schematic");
assert.equal(cobra.sourceTable, "DT_BaseItems_Schematics");
assert.equal(displayNameForRow(cobra.id, "Schematics", new Map([["b1c4_unique_smg2", "Spitting Cobra"]])), "Spitting Cobra Schematic");
assert.ok(serverSource.includes('onclick="scanInstalledGameItems()"'), "Item Database is missing the installed-game scan button.");
assert.ok(serverSource.includes('url.pathname === "/api/items/catalog/scan-installed-game"'), "Installed-game scan endpoint is missing.");

console.log(JSON.stringify({
  ok: true,
  source: catalog.source,
  gameBuildId: catalog.gameBuildId,
  tables: catalog.tables.length,
  items: catalog.items.length,
  schematics: schematics.length,
  spittingCobra: cobra.id
}, null, 2));
