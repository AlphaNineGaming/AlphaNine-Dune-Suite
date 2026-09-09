"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  findPaksDirectory,
  findRepakExecutable,
  findInstalledBuildId,
  compatiblePakCopy,
  verifyOfflineDecompressor,
  packageNames,
  repakGet
} = require("./experimental-resource-areas");

const DUNGEONS_PAK = "Dungeons.pak";
const DUNGEONS_MOUNT_POINT = "../../../DuneSandbox/Content/Dune/Dungeons/";
const DUNGEON_COLLECTION_ROOT = "DuneSandbox/Content/Dune/Dungeons/Collection";
const DUNGEON_ASSET_PATTERN = /^DA_Dgn_[A-Za-z0-9_]+$/;

function readableDungeonName(assetId) {
  const suffix = String(assetId || "").replace(/^DA_Dgn_/, "");
  if (/^Pit$/i.test(suffix)) return "The Old Quarry (Pit)";
  const text = suffix
    .replace(/^0+(?=\d)/, "")
    .replace(/_/g, " · ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return text || assetId;
}

function parseDungeonAssetEntries(output) {
  const byId = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const normalized = line.trim().replace(/\\/g, "/");
    const prefix = `${DUNGEON_COLLECTION_ROOT}/`;
    if (!normalized.startsWith(prefix) || !normalized.toLowerCase().endsWith(".uasset")) continue;
    const id = path.posix.basename(normalized, ".uasset");
    if (!DUNGEON_ASSET_PATTERN.test(id) || /(?:demo|test|gym)/i.test(id)) continue;
    if (!byId.has(id.toLowerCase())) byId.set(id.toLowerCase(), { id, entry: normalized });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function databaseLeaf(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  return normalized.split("/").pop().split(".").pop().replace(/_C$/i, "");
}

function correlateDatabaseId(asset, knownDungeons = []) {
  const assetId = String(asset.id || "");
  const assetPath = String(asset.assetPath || "");
  const exact = knownDungeons.find((row) => {
    const value = String(row?.dungeon_id || "").trim();
    return value === assetId || value === assetPath || value === `${assetPath}.${assetId}`;
  });
  if (exact) return { databaseId: String(exact.dungeon_id), validation: "database-exact", databaseVerified: true };
  const correlated = knownDungeons.find((row) => databaseLeaf(row?.dungeon_id).toLowerCase() === assetId.toLowerCase());
  if (correlated) return { databaseId: String(correlated.dungeon_id), validation: "database-correlated", databaseVerified: true };
  return { databaseId: assetId, validation: "game-asset", databaseVerified: false };
}

function listPakEntries(repakExe, pakPath) {
  const result = spawnSync(repakExe, ["list", pakPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Could not list ${DUNGEONS_PAK}: ${String(result.stderr || result.stdout || `repak exited ${result.status}`).trim()}`);
  return String(result.stdout || "");
}

function installedBuildId(paksDir, preferred = "") {
  try { return findInstalledBuildId(paksDir, preferred); }
  catch { return "unknown"; }
}

function scanInstalledGameDungeons(options = {}) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, ".."));
  const paksDir = findPaksDirectory(options.paksDir);
  const sourcePak = path.join(paksDir, DUNGEONS_PAK);
  if (!fs.existsSync(sourcePak)) throw new Error(`${DUNGEONS_PAK} was not found in the installed game: ${sourcePak}`);
  const repakExe = findRepakExecutable(options.repakExe, appDir);
  verifyOfflineDecompressor(repakExe);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-dungeon-scan-"));
  const compatiblePak = path.join(temporaryRoot, DUNGEONS_PAK);
  try {
    compatiblePakCopy(sourcePak, compatiblePak, DUNGEONS_MOUNT_POINT);
    const entries = parseDungeonAssetEntries(listPakEntries(repakExe, compatiblePak));
    const dungeons = entries.map(({ id, entry }) => {
      const packageMap = packageNames(repakGet(repakExe, compatiblePak, entry));
      const assetPath = `/Game/Dune/Dungeons/Collection/${id}`;
      const verifiedDungeonAsset = packageMap.includes("DungeonDataAsset") && packageMap.includes(id) && packageMap.includes(assetPath);
      if (!verifiedDungeonAsset) return null;
      return {
        id,
        name: readableDungeonName(id),
        assetPath,
        sourceEntry: entry,
        sourceClass: "DungeonDataAsset",
        ...correlateDatabaseId({ id, assetPath }, options.knownDungeons || [])
      };
    }).filter(Boolean);
    if (!dungeons.length) throw new Error("No production DungeonDataAsset entries were found in the installed Dungeons.pak.");
    return {
      ok: true,
      experimental: true,
      gameBuildId: installedBuildId(paksDir, options.buildId),
      sourcePak,
      sourceMountPoint: DUNGEONS_MOUNT_POINT,
      scannedAt: new Date().toISOString(),
      totalDungeons: dungeons.length,
      databaseVerified: dungeons.filter((row) => row.databaseVerified).length,
      dungeons,
      warning: "Unverified rows use the exact DungeonDataAsset name from the installed game. They can be tested without a first completion, but remain experimental until a real database record confirms the identifier."
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

module.exports = {
  DUNGEONS_PAK,
  DUNGEONS_MOUNT_POINT,
  DUNGEON_COLLECTION_ROOT,
  readableDungeonName,
  parseDungeonAssetEntries,
  correlateDatabaseId,
  scanInstalledGameDungeons
};
