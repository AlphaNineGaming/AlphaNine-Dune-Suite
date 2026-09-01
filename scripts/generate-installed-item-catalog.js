"use strict";

const path = require("path");
const { generateInstalledGameItemCatalog } = require("../lib/installed-game-item-catalog");

function argument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

const root = path.resolve(__dirname, "..");
const outputPath = path.resolve(argument("output") || path.join(root, "data", "dune-installed-items-catalog.json"));
const document = generateInstalledGameItemCatalog({
  appDir: root,
  paksDir: argument("paks-dir"),
  repakExe: argument("repak"),
  buildId: argument("build-id"),
  outputPath
});

console.log(JSON.stringify({
  ok: true,
  source: document.source,
  gameBuildId: document.gameBuildId,
  tables: document.tables.length,
  items: document.totalItems,
  schematics: document.items.filter((item) => item.category === "Schematics").length,
  outputPath
}, null, 2));
