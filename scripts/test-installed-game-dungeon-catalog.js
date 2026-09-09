"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  DUNGEONS_MOUNT_POINT,
  readableDungeonName,
  parseDungeonAssetEntries,
  correlateDatabaseId
} = require("../lib/installed-game-dungeon-catalog");

assert.equal(DUNGEONS_MOUNT_POINT, "../../../DuneSandbox/Content/Dune/Dungeons/");
assert.equal(readableDungeonName("DA_Dgn_024_Darkness"), "24 · Darkness");
assert.equal(readableDungeonName("DA_Dgn_Pit"), "The Old Quarry (Pit)");

const entries = parseDungeonAssetEntries([
  "DuneSandbox/Content/Dune/Dungeons/Collection/DA_Dgn_024_Darkness.uasset",
  "DuneSandbox/Content/Dune/Dungeons/Collection/DA_Dgn_024_Darkness.uexp",
  "DuneSandbox/Content/Dune/Dungeons/Collection/DA_Dgn_Demo_Basic123.uasset",
  "DuneSandbox/Content/Dune/Dungeons/Collection/DA_Dgn_Pit.uasset",
  "DuneSandbox/Content/Dune/Dungeons/Bosses/DA_Dgn_NotACollection.uasset"
].join("\n"));
assert.deepStrictEqual(entries.map((row) => row.id), ["DA_Dgn_024_Darkness", "DA_Dgn_Pit"]);

const asset = { id: "DA_Dgn_024_Darkness", assetPath: "/Game/Dune/Dungeons/Collection/DA_Dgn_024_Darkness" };
assert.deepStrictEqual(correlateDatabaseId(asset, []), {
  databaseId: "DA_Dgn_024_Darkness",
  validation: "game-asset",
  databaseVerified: false
});
assert.deepStrictEqual(correlateDatabaseId(asset, [{ dungeon_id: "/Game/Dune/Dungeons/Collection/DA_Dgn_024_Darkness.DA_Dgn_024_Darkness" }]), {
  databaseId: "/Game/Dune/Dungeons/Collection/DA_Dgn_024_Darkness.DA_Dgn_024_Darkness",
  validation: "database-exact",
  databaseVerified: true
});
assert.equal(correlateDatabaseId(asset, [{ dungeon_id: "custom/prefix/DA_Dgn_024_Darkness" }]).validation, "database-correlated");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
for (const category of ["progression", "skills", "house-scrip", "dungeons"]) {
  assert.match(server, new RegExp(`data-progression-category=["']${category}["']`), `Progression category button ${category} is missing.`);
  assert.match(server, new RegExp(`data-progression-category-panel=["']${category}["']`), `Progression category panel ${category} is missing.`);
}
assert.match(server, /function selectProgressionCategory\(value\)/, "Progression category switching is not wired.");
assert.match(server, /Installed Game Dungeon IDs[\s\S]*?scanInstalledGameDungeonIds\(\)/, "Installed-game dungeon scanner UI is missing.");
assert.match(server, /\/api\/progression\/dungeon-difficulty\/scan-installed-game/, "Installed-game dungeon scanner route is missing.");
assert.match(server, /scanInstalledGameDungeons\(\{[\s\S]*?knownDungeons/, "Dungeon asset scanning must correlate IDs with server history.");

console.log("Installed-game dungeon catalog regression checks passed.");
