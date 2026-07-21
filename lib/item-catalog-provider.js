"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_:.()+\/-]{2,240}$/;
const GENERIC_ICON_PATHS = Object.freeze({
  armor: "/gear-codex/assets/item-icons/generic-armor.svg",
  schematic: "/gear-codex/assets/item-icons/generic-schematic.svg",
  tool: "/gear-codex/assets/item-icons/generic-tool.svg",
  vehicle: "/gear-codex/assets/item-icons/generic-vehicle.svg",
  other: "/gear-codex/assets/item-icons/generic-other.svg"
});

function isValidTemplateId(value) {
  return TEMPLATE_ID_PATTERN.test(String(value || "").trim());
}

function readableTemplateName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Unknown Item";
  return raw
    .replace(/^.*[/:]/, "")
    .replace(/[_.+-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || raw;
}

function genericIconForItem(item = {}) {
  const text = [item.category, item.type, item.subtype, item.id].filter(Boolean).join(" ").toLowerCase();
  if (/schematic|blueprint|recipe|patent/.test(text)) return GENERIC_ICON_PATHS.schematic;
  if (/armor|garment|wearable|helmet|glove|boot|stillsuit/.test(text)) return GENERIC_ICON_PATHS.armor;
  if (/vehicle|buggy|sandbike|ornithopter|crawler/.test(text)) return GENERIC_ICON_PATHS.vehicle;
  if (/tool|weapon|rifle|pistol|sword|knife|scanner|cutter/.test(text)) return GENERIC_ICON_PATHS.tool;
  return GENERIC_ICON_PATHS.other;
}

function localIconForItem(item = {}) {
  const localPath = String(item.imageLocalPath || "").trim();
  if (localPath) return `/gear-images/${encodeURIComponent(path.basename(localPath))}`;
  const icon = String(item.icon || "").trim();
  if (icon.startsWith("/") && !icon.startsWith("//")) return icon;
  if (/^assets\/item-icons\//i.test(icon)) return `/gear-codex/${icon}`;
  return genericIconForItem(item);
}

function itemTags(item = {}) {
  const raw = item.tags;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw && Array.isArray(raw.value)) return raw.value.map(String).filter(Boolean);
  return [];
}

function managerCatalogItem(item = {}) {
  const tags = itemTags(item);
  const constructionSet = tags.some((tag) => /^Items\.Consumables\.BuildableSets$/i.test(tag));
  const schematic = /schematic|blueprint/i.test(String(item.id || "")) || tags.some((tag) => /^Items\.Schematics\./i.test(tag));
  const lootTier = tags.find((tag) => /^LootTier\./i.test(tag));
  const normalized = normalizeItem({
    ...item,
    category: constructionSet ? "Construction Sets" : (schematic ? "Schematics" : item.category),
    type: constructionSet ? "Buildable Set" : item.type,
    subtype: constructionSet ? "Buildable Set" : (schematic ? "Schematic Item" : item.subtype),
    tier: item.tier || (lootTier ? lootTier.replace(/^LootTier\./i, "") : ""),
    detail: item.detail || tags.join(" / "),
    _classificationOverride: constructionSet || schematic
  }, "bundled-manager");
  return normalized;
}

function normalizeItem(item = {}, source = "bundled") {
  const id = String(item.id || item.templateId || item.template_id || "").trim();
  if (!isValidTemplateId(id)) return null;
  const name = String(item.name || item.displayName || readableTemplateName(id)).trim() || readableTemplateName(id);
  return {
    ...item,
    id,
    name,
    category: String(item.category || "").trim(),
    type: String(item.type || item.subtype || "").trim(),
    subtype: String(item.subtype || item.type || "").trim(),
    detail: String(item.detail || item.description || "").trim(),
    description: String(item.description || "").trim(),
    tier: String(item.tier || "").trim(),
    rarity: String(item.rarity || "").trim(),
    grade: String(item.grade || item.rarity || "Unknown").trim() || "Unknown",
    maxStack: item.maxStack == null ? "" : String(item.maxStack),
    imageLocalPath: String(item.imageLocalPath || "").trim(),
    icon: localIconForItem(item),
    source,
    hasDisplayName: item.hasDisplayName !== false && name !== id,
    spawnable: item.spawnable !== false
  };
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8").replace(/^\uFEFF/, ""));
}

function itemsFromDocument(document) {
  if (Array.isArray(document)) return document;
  return Array.isArray(document?.items) ? document.items : [];
}

function catalogIntegrity(pathname, { required = false, imageDir = "" } = {}) {
  const result = { path: pathname, present: fs.existsSync(pathname), valid: false, items: [], errors: [], warnings: [], sha256: "", imageReferences: 0, missingImages: 0, duplicateIdentifiers: 0 };
  if (!result.present) {
    if (required) result.errors.push("Catalog file is missing.");
    return result;
  }
  try {
    const bytes = fs.readFileSync(pathname);
    result.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    const rows = itemsFromDocument(document);
    if (!rows.length) throw new Error("Catalog contains no item records.");
    const ids = new Set();
    for (const row of rows) {
      const item = normalizeItem(row, "bundled");
      if (!item) {
        result.errors.push(`Invalid template identifier: ${String(row?.id || "(missing)")}`);
        continue;
      }
      const key = item.id.toLowerCase();
      if (ids.has(key)) {
        result.duplicateIdentifiers += 1;
        result.warnings.push(`Duplicate template identifier preserved and merged at runtime: ${item.id}`);
      }
      else ids.add(key);
      if (item.imageLocalPath) {
        result.imageReferences += 1;
        if (imageDir && !fs.existsSync(path.join(imageDir, path.basename(item.imageLocalPath)))) {
          result.missingImages += 1;
          item.icon = genericIconForItem(item);
        }
      }
      result.items.push(item);
    }
    result.valid = result.items.length > 0 && !result.errors.length;
  } catch (error) {
    result.errors.push(error.message);
  }
  return result;
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function mergeLowerPriority(existing, lowerPriority) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(lowerPriority || {})) {
    if (!hasValue(merged[key]) && hasValue(value)) merged[key] = value;
  }
  merged.id = existing.id;
  merged.source = existing.source;
  if (lowerPriority?._classificationOverride) {
    for (const key of ["category", "type", "subtype"]) {
      if (hasValue(lowerPriority[key])) merged[key] = lowerPriority[key];
    }
  }
  merged.icon = localIconForItem(merged);
  return merged;
}

function mergeByPriority(groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      const key = String(item.id || "").toLowerCase();
      if (!key) continue;
      if (!byId.has(key)) byId.set(key, item);
      else byId.set(key, mergeLowerPriority(byId.get(key), item));
    }
  }
  return [...byId.values()];
}

function readOptionalItems(pathname, source, normalizer = (item) => normalizeItem(item, source)) {
  if (!pathname || !fs.existsSync(pathname)) return { items: [], error: "", present: false };
  try {
    const document = readJson(pathname);
    return { items: itemsFromDocument(document).map(normalizer).filter(Boolean), error: "", present: true };
  } catch (error) {
    return { items: [], error: error.message, present: true };
  }
}

function learnedItem(record = {}) {
  const id = String(record.id || record.templateId || record.template_id || "").trim();
  if (!isValidTemplateId(id)) return null;
  return normalizeItem({
    id,
    name: readableTemplateName(id),
    category: "Server discovered",
    type: "Server discovered",
    subtype: String(record.discoverySource || record.source || "Server discovered"),
    detail: `Template identifier discovered through a read-only server query (${String(record.discoverySource || record.source || "server")}).`,
    grade: "Unknown",
    tier: "",
    maxStack: "",
    icon: GENERIC_ICON_PATHS.other,
    hasDisplayName: true,
    spawnable: true,
    discoveredAt: record.discoveredAt || new Date().toISOString(),
    discoverySource: String(record.discoverySource || record.source || "server")
  }, "server-discovered");
}

function rawFallback(value) {
  const id = String(value || "").trim();
  if (!isValidTemplateId(id)) return null;
  return normalizeItem({
    id,
    name: readableTemplateName(id),
    category: "Raw identifier",
    type: "Raw identifier",
    subtype: "Manual exact ID",
    detail: "Exact template identifier entered manually. Catalog metadata is unavailable.",
    grade: "Unknown",
    icon: GENERIC_ICON_PATHS.other,
    hasDisplayName: true,
    spawnable: true
  }, "raw-id");
}

function createItemCatalogProvider(options = {}) {
  const bundledCatalogPath = path.resolve(options.bundledCatalogPath || "");
  const bundledImageDir = path.resolve(options.bundledImageDir || path.dirname(bundledCatalogPath));
  const managerCatalogPath = options.managerCatalogPath ? path.resolve(options.managerCatalogPath) : "";
  const learnedCatalogPath = path.resolve(options.learnedCatalogPath || path.join(path.dirname(bundledCatalogPath), "server-discovered-items.json"));
  const legacyCachePath = options.legacyCachePath ? path.resolve(options.legacyCachePath) : "";
  let lastSnapshot = null;

  function snapshot({ refresh = false } = {}) {
    if (lastSnapshot && !refresh) return lastSnapshot;
    const bundled = catalogIntegrity(bundledCatalogPath, { required: true, imageDir: bundledImageDir });
    if (!bundled.valid) throw new Error(`Bundled item catalog failed integrity validation: ${bundled.errors.join("; ")}`);
    const manager = readOptionalItems(managerCatalogPath, "bundled-manager", managerCatalogItem);
    const learned = readOptionalItems(learnedCatalogPath, "server-discovered");
    const legacy = readOptionalItems(legacyCachePath, "legacy-local-cache");
    const items = mergeByPriority([bundled.items, manager.items, learned.items, legacy.items]);
    lastSnapshot = {
      ok: true,
      items,
      generatedAt: new Date().toISOString(),
      report: {
        sourcePriority: ["bundled", "locally-stored-server-discovered", "live-read-only-discovery", "raw-id-fallback"],
        bundledCatalogPath,
        bundledCatalogItems: bundled.items.length,
        bundledCatalogSha256: bundled.sha256,
        bundledImageReferences: bundled.imageReferences,
        bundledMissingImages: bundled.missingImages,
        bundledDuplicateIdentifiers: bundled.duplicateIdentifiers,
        bundledCatalogWarnings: bundled.warnings,
        managerCatalogPath,
        managerCatalogItems: manager.items.length,
        managerCatalogConstructionSets: manager.items.filter((item) => item.category === "Construction Sets").length,
        managerCatalogSchematics: manager.items.filter((item) => item.category === "Schematics").length,
        managerCatalogError: manager.error,
        learnedCatalogPath,
        learnedItems: learned.items.length,
        learnedCatalogError: learned.error,
        legacyCachePath,
        legacyCachePresent: legacy.present,
        legacyCacheItems: legacy.items.length,
        legacyCacheError: legacy.error,
        recoveredFromBundled: !legacy.present || Boolean(legacy.error),
        totalItemsFound: items.length
      }
    };
    return lastSnapshot;
  }

  function learn(records = []) {
    const knownIds = new Set(snapshot().items.map((item) => item.id.toLowerCase()));
    const current = readOptionalItems(learnedCatalogPath, "server-discovered");
    const byId = new Map(current.items.map((item) => [item.id.toLowerCase(), item]));
    let added = 0;
    for (const record of records) {
      const item = learnedItem(record);
      if (!item || knownIds.has(item.id.toLowerCase()) || byId.has(item.id.toLowerCase())) continue;
      byId.set(item.id.toLowerCase(), item);
      added += 1;
    }
    if (added) {
      fs.mkdirSync(path.dirname(learnedCatalogPath), { recursive: true });
      const document = { version: 1, updatedAt: new Date().toISOString(), items: [...byId.values()] };
      const temporary = `${learnedCatalogPath}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, learnedCatalogPath);
      lastSnapshot = null;
    }
    return { added, total: byId.size, path: learnedCatalogPath };
  }

  function resolve(value) {
    const id = String(value || "").trim();
    if (!isValidTemplateId(id)) return null;
    return snapshot().items.find((item) => item.id.toLowerCase() === id.toLowerCase()) || rawFallback(id);
  }

  return { snapshot, learn, resolve, validate: () => snapshot({ refresh: true }).report };
}

module.exports = {
  TEMPLATE_ID_PATTERN,
  GENERIC_ICON_PATHS,
  isValidTemplateId,
  readableTemplateName,
  genericIconForItem,
  localIconForItem,
  managerCatalogItem,
  normalizeItem,
  catalogIntegrity,
  mergeByPriority,
  learnedItem,
  rawFallback,
  createItemCatalogProvider
};
