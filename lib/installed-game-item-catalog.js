"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  findPaksDirectory,
  findRepakExecutable,
  findInstalledBuildId,
  compatiblePakCopy,
  verifyOfflineDecompressor,
  packageNames,
  repakGet
} = require("./experimental-resource-areas");
const { isValidTemplateId, readableTemplateName, GENERIC_ICON_PATHS } = require("./item-catalog-provider");

const SYSTEMS_MOUNT_POINT = "../../../DuneSandbox/Content/Dune/Systems/";
const SYSTEMS_ASSET_ROOT = "DuneSandbox/Content/Dune/Systems/Items/BaseItems";
const BASE_ITEM_TABLES = Object.freeze([
  ["Augments", "Augments"],
  ["BuildingBlueprints", "Building Blueprints"],
  ["BuildingSets", "Construction Sets"],
  ["Clothing", "Clothing"],
  ["Consumables", "Consumables"],
  ["Contracts", "Contracts"],
  ["Customizations", "Customizations"],
  ["Emotes", "Emotes"],
  ["FactionReputation", "Faction Reputation"],
  ["Gadgets", "Gadgets"],
  ["ItemMods", "Item Mods"],
  ["MiscEquipment", "Miscellaneous Equipment"],
  ["Placeables", "Placeables"],
  ["ReferenceItem", "Reference Items"],
  ["Resources", "Resources"],
  ["Schematics", "Schematics"],
  ["Sinkcharts", "Sinkcharts"],
  ["SolidFuels", "Solid Fuels"],
  ["Vehicles", "Vehicles"],
  ["Weapons", "Weapons"]
]);

function extractDataTableRowNames(asset, exportData) {
  const names = packageNames(asset);
  const noneIndex = names.indexOf("None");
  if (noneIndex < 0) throw new Error("Data table name map does not contain the Unreal None marker.");
  const rowPrefix = Buffer.alloc(16);
  rowPrefix.writeInt32LE(noneIndex, 0);
  rowPrefix.writeInt32LE(noneIndex, 8);
  const rows = [];
  const seen = new Set();
  for (let offset = exportData.indexOf(rowPrefix); offset >= 0 && offset + 24 <= exportData.length; offset = exportData.indexOf(rowPrefix, offset + 1)) {
    const nameIndex = exportData.readInt32LE(offset + 16);
    const nameNumber = exportData.readInt32LE(offset + 20);
    const value = names[nameIndex];
    if (nameNumber !== 0 || !isValidTemplateId(value)) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(value);
    }
  }
  return rows;
}

function itemsFromDocument(document) {
  if (Array.isArray(document)) return document;
  return Array.isArray(document?.items) ? document.items : [];
}

function readKnownItemNames(paths = []) {
  const names = new Map();
  for (const pathname of paths) {
    if (!pathname || !fs.existsSync(pathname)) continue;
    const document = JSON.parse(fs.readFileSync(pathname, "utf8").replace(/^\uFEFF/, ""));
    for (const item of itemsFromDocument(document)) {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      if (isValidTemplateId(id) && name && name.toLowerCase() !== id.toLowerCase() && !names.has(id.toLowerCase())) names.set(id.toLowerCase(), name);
    }
  }
  return names;
}

function schematicBaseCandidates(id) {
  const candidates = [
    id.replace(/_Schematic$/i, ""),
    id.replace(/Schematic$/i, ""),
    id.replace(/^Schematic_/i, ""),
    id.replace(/Blueprint$/i, "")
  ];
  return [...new Set(candidates.map((value) => value.replace(/^D_/, "")).concat(candidates))];
}

function displayNameForRow(id, category, knownNames) {
  const exact = knownNames.get(id.toLowerCase());
  if (exact) return exact;
  if (category === "Schematics") {
    for (const candidate of schematicBaseCandidates(id)) {
      const baseName = knownNames.get(candidate.toLowerCase());
      if (baseName) return /schematic|blueprint/i.test(baseName) ? baseName : `${baseName} Schematic`;
    }
    const readable = readableTemplateName(id.replace(/^D_/, "").replace(/_?Schematic$/i, ""));
    return /schematic|blueprint/i.test(readable) ? readable : `${readable} Schematic`;
  }
  return readableTemplateName(id.replace(/^D_/, ""));
}

function itemForRow(id, tableName, category, knownNames) {
  const schematic = category === "Schematics";
  const constructionSet = category === "Construction Sets";
  const type = schematic ? "Schematic Item" : (constructionSet ? "Buildable Set" : "");
  return {
    id,
    name: displayNameForRow(id, category, knownNames),
    category,
    type,
    subtype: type,
    detail: `Discovered from the installed game table ${tableName}.`,
    grade: "Unknown",
    rarity: "",
    tier: "",
    maxStack: "",
    icon: schematic ? GENERIC_ICON_PATHS.schematic : "",
    hasDisplayName: true,
    spawnable: true,
    sourceTable: tableName
  };
}

function writeCatalog(outputPath, document) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolved);
  return resolved;
}

function generateInstalledGameItemCatalog(options = {}) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, ".."));
  const paksDir = findPaksDirectory(options.paksDir);
  const systemsPak = path.join(paksDir, "Systems.pak");
  if (!fs.existsSync(systemsPak)) throw new Error(`Systems.pak was not found in the installed game: ${systemsPak}`);
  const repakExe = findRepakExecutable(options.repakExe, appDir);
  verifyOfflineDecompressor(repakExe);
  const knownNames = readKnownItemNames(options.knownCatalogPaths || [
    path.join(appDir, "data", "dune-items-catalog.json"),
    path.join(appDir, "manager", "dune-item-catalog.json")
  ]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-installed-items-"));
  const compatiblePak = path.join(temporaryRoot, "Systems.pak");
  const byId = new Map();
  const tables = [];
  try {
    compatiblePakCopy(systemsPak, compatiblePak, SYSTEMS_MOUNT_POINT);
    for (const [suffix, category] of BASE_ITEM_TABLES) {
      const tableName = `DT_BaseItems_${suffix}`;
      const assetBase = `${SYSTEMS_ASSET_ROOT}/${tableName}`;
      const rows = extractDataTableRowNames(
        repakGet(repakExe, compatiblePak, `${assetBase}.uasset`),
        repakGet(repakExe, compatiblePak, `${assetBase}.uexp`)
      );
      tables.push({ name: tableName, category, rows: rows.length });
      for (const id of rows) {
        const key = id.toLowerCase();
        if (!byId.has(key)) byId.set(key, itemForRow(id, tableName, category, knownNames));
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  const items = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  const document = {
    version: 1,
    source: "installed-game-data",
    generatedAt: new Date().toISOString(),
    gameBuildId: findInstalledBuildId(paksDir, options.buildId),
    sourcePak: "Systems.pak",
    sourcePolicy: "Template identifiers are read from the installed game. No game assets are retained; existing Suite labels may be reused for presentation.",
    totalItems: items.length,
    tables,
    items
  };
  if (options.outputPath) writeCatalog(options.outputPath, document);
  return document;
}

module.exports = {
  BASE_ITEM_TABLES,
  SYSTEMS_MOUNT_POINT,
  SYSTEMS_ASSET_ROOT,
  extractDataTableRowNames,
  readKnownItemNames,
  displayNameForRow,
  generateInstalledGameItemCatalog,
  writeCatalog
};
