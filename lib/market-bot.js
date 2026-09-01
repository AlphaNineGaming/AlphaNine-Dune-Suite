"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { PAUSE_STATES, normalizeGeneration } = require("./market-bot-verification");

const CONFIG_SCHEMA_VERSION = 3;
const CATALOG_POLICY_VERSION = 1;
const VM_MARKET_BOT_DIR = "/home/dune/.dune/alphanine-market-bot";
const VM_MARKET_BOT_BINARY = `${VM_MARKET_BOT_DIR}/alphanine-market-bot`;
const VM_MARKET_BOT_CONFIG = `${VM_MARKET_BOT_DIR}/config.json`;
const VM_MARKET_BOT_STATE = `${VM_MARKET_BOT_DIR}/state.json`;
const VM_MARKET_BOT_PAUSE_MARKER = `${VM_MARKET_BOT_DIR}/pause-requested`;
const VM_MARKET_BOT_CYCLE_LEASE = `${VM_MARKET_BOT_DIR}/cycle-running`;
const VM_MARKET_BOT_SERVICE = "/etc/init.d/alphanine-market-bot";
const MARKET_CATEGORY_MASK_SEED_PATH = path.join(__dirname, "..", "data", "market-bot-category-mask-seed.json");
const ECONOMY_STYLES = Object.freeze(["Affordable", "Balanced", "Expensive"]);
const STYLE_FACTORS = Object.freeze({ Affordable: 0.5, Balanced: 0.75, Expensive: 1 });
const CATEGORY_DEFAULTS = Object.freeze({
  Armor: { price: 5000, stack: 1 },
  Atreides: { price: 6000, stack: 1 },
  Harkonnen: { price: 6000, stack: 1 },
  Smuggler: { price: 6000, stack: 1 },
  Choam: { price: 6000, stack: 1 },
  Choam2: { price: 6000, stack: 1 },
  Watershippers: { price: 6000, stack: 1 },
  Garment: { price: 5000, stack: 1 },
  Clothes: { price: 3000, stack: 1 },
  Weapons: { price: 8000, stack: 1 },
  Rangedweapons: { price: 8000, stack: 1 },
  Meleeweapons: { price: 7000, stack: 1 },
  Vehicles: { price: 15000, stack: 1 },
  Vehicle: { price: 15000, stack: 1 },
  Utility: { price: 2500, stack: 1 },
  Augment: { price: 6000, stack: 1 },
  Decorations: { price: 750, stack: 1 },
  Customization: { price: 1500, stack: 1 },
  Customizations: { price: 1500, stack: 1 },
  Buildables: { price: 1500, stack: 1 },
  Construction: { price: 1500, stack: 1 },
  "Construction Sets": { price: 2500, stack: 1 },
  Consumables: { price: 1000, stack: 10 },
  Extrasets: { price: 1500, stack: 1 },
  Fabricators: { price: 5000, stack: 1 },
  Refineries: { price: 6000, stack: 1 },
  Schematics: { price: 12000, stack: 1 },
  "Server discovered": { price: 2500, stack: 1 },
  Storage: { price: 3000, stack: 1 },
  Utilities: { price: 2500, stack: 1 },
  Items: { price: 1000, stack: 10 },
  Misc: { price: 1000, stack: 1 },
  Other: { price: 1000, stack: 1 }
});

function bool(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function integer(value, fallback, min, max, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) throw new Error(`${label} must be from ${min} to ${max}.`);
  return parsed;
}

function atomicJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")); }
  catch { return fallback; }
}

function safeCatalogItem(item = {}) {
  const id = String(item.id || "").trim();
  if (!id || id.length > 240 || /[\r\n\t]/.test(id)) return null;
  return {
    id,
    name: String(item.name || id).trim() || id,
    category: String(item.category || "Other").trim() || "Other",
    tier: String(item.tier || item.itemTier || "").trim(),
    grade: String(item.grade || item.rarity || "").trim(),
    maxStack: positiveInteger(item.maxStack)
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeCategoryMaskSeed(input = {}) {
  const result = {};
  for (const [id, value] of Object.entries(input || {})) {
    const key = String(id || "").trim().toLowerCase();
    const mask = Number(value?.mask);
    const depth = Number(value?.depth);
    if (!key || !Number.isInteger(mask) || mask <= 0 || !Number.isInteger(depth) || depth < 1 || depth > 4) continue;
    result[key] = { mask, depth };
  }
  return result;
}

let bundledCategoryMaskSeed;
function marketCategoryMaskSeed() {
  if (!bundledCategoryMaskSeed) {
    bundledCategoryMaskSeed = normalizeCategoryMaskSeed(readJson(MARKET_CATEGORY_MASK_SEED_PATH, {}));
  }
  return bundledCategoryMaskSeed;
}

function categoryDefaults(category) {
  return CATEGORY_DEFAULTS[category] || CATEGORY_DEFAULTS.Other;
}

function tierFactor(tier) {
  const match = String(tier || "").match(/([1-6])/);
  return match ? [1, 1, 1.25, 1.6, 2.1, 2.8, 3.7][Number(match[1])] : 1;
}

function gradeFactor(grade) {
  const value = String(grade || "").toLowerCase();
  if (/unique|legend/.test(value)) return 2;
  if (/epic|rare/.test(value)) return 1.5;
  if (/uncommon/.test(value)) return 1.2;
  return 1;
}

function roundPrice(value) {
  const number = Math.max(1, Math.round(Number(value) || 1));
  const step = number >= 10000 ? 100 : number >= 1000 ? 50 : number >= 100 ? 10 : 1;
  return Math.max(1, Math.round(number / step) * step);
}

function defaultMarketBotConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: false,
    paused: true,
    pauseState: PAUSE_STATES.UNKNOWN,
    configGeneration: "0",
    pauseGeneration: "0",
    runtimeFingerprint: "",
    activated: false,
    exchangeName: "",
    economyStyle: "Expensive",
    listingCategory: "",
    intervalMinutes: 30,
    expiryDays: 3,
    safety: {
      maxCreatesPerCycle: 25,
      maxMarketValuePerCycle: 25000000
    },
    playerBuying: {
      enabled: false,
      chancePercent: 50,
      maxPurchasesPerCycle: 1,
      maxUnitPrice: 100000,
      maxSpendPerCycle: 100000
    },
    catalogPolicy: {
      mode: "dynamic",
      version: CATALOG_POLICY_VERSION,
      itemCount: "0",
      fingerprint: "",
      items: []
    },
    overrides: {},
    legacyMigration: {
      detected: false,
      sourceVersion: 0,
      snapshot: null,
      convertedAt: "",
      activatedAt: "",
      activationFingerprint: "",
      legacyDisabledAt: ""
    },
    updatedAt: ""
  };
}

const PINNED_ITEM_KEYS = Object.freeze([
  "id", "name", "category", "tier", "enabled", "unitPrice", "stackSize",
  "targetListings", "categoryMask", "categoryDepth"
]);

function boundedInteger(value, min, max, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an exact integer from ${min} to ${max}.`);
  }
  return value;
}

function normalizePinnedCatalogItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100000) {
    throw new Error("A pinned Market Bot catalog must contain from 1 to 100000 item policies.");
  }
  const seen = new Set();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Pinned catalog item ${index + 1} is malformed.`);
    const unknown = Object.keys(raw).filter((key) => !PINNED_ITEM_KEYS.includes(key));
    if (unknown.length) throw new Error(`Pinned catalog item ${index + 1} contains unknown fields.`);
    for (const key of PINNED_ITEM_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) throw new Error(`Pinned catalog item ${index + 1} is missing ${key}.`);
    }
    const id = String(raw.id || "").trim();
    if (!id || id.length > 240 || /[\r\n\t]/.test(id)) throw new Error(`Pinned catalog item ${index + 1} has an invalid template identifier.`);
    const key = id.toLowerCase();
    if (seen.has(key)) throw new Error("Pinned Market Bot catalog contains a duplicate template identifier.");
    seen.add(key);
    const text = (value, label, max = 1000) => {
      if (typeof value !== "string" || value.length > max || /[\r\n\t]/.test(value)) throw new Error(`Pinned catalog ${label} is malformed.`);
      return value;
    };
    if (typeof raw.enabled !== "boolean") throw new Error(`Pinned catalog item ${index + 1} has a malformed enabled value.`);
    return {
      id,
      name: text(raw.name, "name"),
      category: text(raw.category, "category"),
      tier: text(raw.tier, "tier"),
      enabled: raw.enabled,
      unitPrice: boundedInteger(raw.unitPrice, 1, 999999999, "Pinned unit price"),
      stackSize: boundedInteger(raw.stackSize, 1, 50000, "Pinned stack size"),
      targetListings: boundedInteger(raw.targetListings, 0, 100, "Pinned target listing count"),
      categoryMask: boundedInteger(raw.categoryMask, 0, Number.MAX_SAFE_INTEGER, "Pinned category mask"),
      categoryDepth: boundedInteger(raw.categoryDepth, 0, 4, "Pinned category depth")
    };
  });
}

function catalogPolicyFingerprint(items) {
  return crypto.createHash("sha256").update(JSON.stringify({ version: CATALOG_POLICY_VERSION, items }), "utf8").digest("hex");
}

function pinnedCatalogPolicy(itemsInput) {
  const items = normalizePinnedCatalogItems(itemsInput);
  return {
    mode: "pinned",
    version: CATALOG_POLICY_VERSION,
    itemCount: String(items.length),
    fingerprint: catalogPolicyFingerprint(items),
    items
  };
}

function normalizeCatalogPolicy(input) {
  if (input === undefined || input === null || input.mode === "dynamic") return defaultMarketBotConfig().catalogPolicy;
  if (!input || typeof input !== "object" || Array.isArray(input) || input.mode !== "pinned" || input.version !== CATALOG_POLICY_VERSION) {
    throw new Error("Market Bot catalog policy is malformed or unsupported.");
  }
  const policy = pinnedCatalogPolicy(input.items);
  if (String(input.itemCount || "") !== policy.itemCount || String(input.fingerprint || "") !== policy.fingerprint) {
    throw new Error("Pinned Market Bot catalog count or fingerprint does not match its item policies.");
  }
  return policy;
}

function normalizeOverride(value = {}) {
  const result = {};
  if (value.enabled !== undefined) result.enabled = bool(value.enabled, true);
  if (positiveInteger(value.unitPrice || value.price)) result.unitPrice = integer(value.unitPrice || value.price, 1, 1, 999999999, "Unit price");
  if (positiveInteger(value.stackSize)) result.stackSize = integer(value.stackSize, 1, 1, 50000, "Stack size");
  if (value.targetListings !== undefined || value.targetCount !== undefined) {
    result.targetListings = integer(value.targetListings ?? value.targetCount, 1, 0, 100, "Target listing count");
  }
  return result;
}

function normalizeConfig(input = {}) {
  const base = defaultMarketBotConfig();
  const legacyState = Number(input.schemaVersion || 0) < 2;
  const paused = bool(input.paused, base.paused);
  const allowedPauseStates = new Set(Object.values(PAUSE_STATES));
  const requestedPauseState = allowedPauseStates.has(input.pauseState) ? input.pauseState : PAUSE_STATES.UNKNOWN;
  const economyStyle = ECONOMY_STYLES.includes(input.economyStyle) ? input.economyStyle : base.economyStyle;
  const overrides = {};
  for (const [id, value] of Object.entries(input.overrides || {})) {
    const cleanId = String(id || "").trim();
    if (!cleanId || cleanId.length > 240 || /[\r\n\t]/.test(cleanId)) continue;
    overrides[cleanId] = normalizeOverride(value);
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: bool(input.enabled, base.enabled),
    paused,
    pauseState: legacyState && paused ? PAUSE_STATES.UNKNOWN : requestedPauseState,
    configGeneration: normalizeGeneration(input.configGeneration, "0"),
    pauseGeneration: normalizeGeneration(input.pauseGeneration, "0"),
    runtimeFingerprint: /^[a-f0-9]{64}$/.test(String(input.runtimeFingerprint || "")) ? String(input.runtimeFingerprint) : "",
    activated: bool(input.activated, base.activated),
    exchangeName: String(input.exchangeName || "").trim().slice(0, 160),
    economyStyle,
    listingCategory: String(input.listingCategory || "").trim().slice(0, 80),
    intervalMinutes: integer(input.intervalMinutes, base.intervalMinutes, 1, 1440, "Restock interval"),
    expiryDays: integer(input.expiryDays, base.expiryDays, 1, 14, "Listing expiration"),
    safety: {
      maxCreatesPerCycle: integer(input.safety?.maxCreatesPerCycle, base.safety.maxCreatesPerCycle, 1, 250, "Maximum creations per cycle"),
      maxMarketValuePerCycle: integer(input.safety?.maxMarketValuePerCycle, base.safety.maxMarketValuePerCycle, 1, Number.MAX_SAFE_INTEGER, "Maximum market value per cycle")
    },
    playerBuying: {
      enabled: bool(input.playerBuying?.enabled, base.playerBuying.enabled),
      chancePercent: integer(input.playerBuying?.chancePercent, base.playerBuying.chancePercent, 1, 100, "Player purchase chance"),
      maxPurchasesPerCycle: integer(input.playerBuying?.maxPurchasesPerCycle, base.playerBuying.maxPurchasesPerCycle, 1, 20, "Maximum player purchases per cycle"),
      maxUnitPrice: integer(input.playerBuying?.maxUnitPrice, base.playerBuying.maxUnitPrice, 1, 999999999, "Maximum player listing unit price"),
      maxSpendPerCycle: integer(input.playerBuying?.maxSpendPerCycle, base.playerBuying.maxSpendPerCycle, 1, Number.MAX_SAFE_INTEGER, "Maximum player listing spend per cycle")
    },
    catalogPolicy: normalizeCatalogPolicy(input.catalogPolicy),
    overrides,
    legacyMigration: {
      ...base.legacyMigration,
      ...(input.legacyMigration && typeof input.legacyMigration === "object" ? input.legacyMigration : {})
    },
    updatedAt: String(input.updatedAt || "")
  };
}

function legacyMigration(legacy = null) {
  const migration = defaultMarketBotConfig().legacyMigration;
  if (!legacy || typeof legacy !== "object") return { migration, overrides: {} };
  const overrides = {};
  for (const template of Array.isArray(legacy.templates) ? legacy.templates : []) {
    const id = String(typeof template === "string" ? template : (template?.template || template?.id || "")).trim();
    if (!id) continue;
    overrides[id] = normalizeOverride({
      enabled: typeof template === "object" ? template.enabled !== false : true,
      unitPrice: typeof template === "object"
        ? template.price
        : String(legacy.pricingMode || "").toLowerCase() === "fixed"
          ? (legacy.basePrice || legacy.price)
          : undefined,
      stackSize: typeof template === "object" ? template.stackSize : legacy.stackSize,
      targetListings: typeof template === "object" ? (template.targetListings ?? template.targetCount) : undefined
    });
  }
  for (const [id, price] of Object.entries(legacy.pricing?.itemPriceOverrides || legacy.itemPriceOverrides || legacy.itemOverrides || {})) {
    overrides[id] = { ...(overrides[id] || {}), unitPrice: integer(price, 1, 1, 999999999, "Legacy item price") };
  }
  return {
    overrides,
    migration: {
      ...migration,
      detected: true,
      sourceVersion: Number(legacy.version || 1) || 1,
      snapshot: legacy,
      convertedAt: new Date().toISOString()
    }
  };
}

function createMarketBotStore(options = {}) {
  const configPath = path.resolve(options.configPath || path.join(options.dataDir || ".", "market-bot.json"));
  const legacyPath = path.resolve(options.legacyPath || path.join(options.dataDir || ".", "market-automator.json"));
  function load() {
    const existing = readJson(configPath);
    if (existing) return normalizeConfig(existing);
    const migrated = legacyMigration(readJson(legacyPath));
    return normalizeConfig({ ...defaultMarketBotConfig(), overrides: migrated.overrides, legacyMigration: migrated.migration });
  }
  function save(input) {
    const config = normalizeConfig({ ...input, updatedAt: new Date().toISOString() });
    atomicJson(configPath, config);
    return config;
  }
  function disableLegacy(config) {
    const legacy = readJson(legacyPath);
    if (!legacy || typeof legacy !== "object") return null;
    const next = { ...legacy, enabled: false, disabledByMarketBotAt: new Date().toISOString() };
    atomicJson(legacyPath, next);
    config.legacyMigration.legacyDisabledAt = next.disabledByMarketBotAt;
    return next;
  }
  function restoreLegacy(config) {
    const snapshot = config.legacyMigration?.snapshot;
    if (!snapshot || typeof snapshot !== "object") throw new Error("No preserved Legacy Market Automator configuration is available.");
    atomicJson(legacyPath, { ...snapshot, enabled: false, restoredFromMarketBotAt: new Date().toISOString() });
    return readJson(legacyPath);
  }
  return { configPath, legacyPath, load, save, disableLegacy, restoreLegacy };
}

function buildItemPolicies(catalog, configInput, categoryMaskSeedInput = null) {
  const config = normalizeConfig(configInput);
  const factor = STYLE_FACTORS[config.economyStyle] || 1;
  const categoryMaskSeed = categoryMaskSeedInput === null
    ? marketCategoryMaskSeed()
    : normalizeCategoryMaskSeed(categoryMaskSeedInput);
  const rows = [];
  const seen = new Set();
  for (const raw of catalog || []) {
    const item = safeCatalogItem(raw);
    if (!item || seen.has(item.id.toLowerCase())) continue;
    seen.add(item.id.toLowerCase());
    const defaults = categoryDefaults(item.category);
    const override = config.overrides[item.id] || {};
    const catalogPrice = positiveInteger(raw.unitPrice || raw.catalogPrice || raw.price);
    const knownStack = item.maxStack || positiveInteger(raw.stackLimit || raw.max_stack);
    const basePrice = catalogPrice || defaults.price || 1;
    const rawMask = positiveInteger(raw.categoryMask || raw.category_mask);
    const rawDepth = positiveInteger(raw.categoryDepth || raw.category_depth);
    const seededCategory = categoryMaskSeed[item.id.toLowerCase()] || {};
    const categoryMask = rawMask && rawDepth >= 1 && rawDepth <= 4 ? rawMask : positiveInteger(seededCategory.mask);
    const categoryDepth = categoryMask
      ? (rawMask && rawDepth >= 1 && rawDepth <= 4 ? rawDepth : positiveInteger(seededCategory.depth))
      : 0;
    rows.push({
      id: item.id,
      name: item.name,
      category: item.category,
      tier: item.tier,
      enabled: override.enabled !== false && (!config.listingCategory || item.category === config.listingCategory),
      unitPrice: override.unitPrice || roundPrice(basePrice * tierFactor(item.tier) * gradeFactor(item.grade) * factor),
      stackSize: override.stackSize || knownStack || defaults.stack || 1,
      targetListings: override.targetListings ?? 1,
      categoryMask,
      categoryDepth,
      sources: {
        unitPrice: override.unitPrice ? "exact override" : catalogPrice ? "catalog price" : defaults.price ? "category pricebook" : "minimum fallback",
        stackSize: override.stackSize ? "exact override" : knownStack ? "catalog maximum" : defaults.stack ? "category default" : "minimum fallback",
        category: rawMask && rawDepth ? "catalog metadata" : categoryMask ? "verified category seed" : "unavailable"
      }
    });
  }
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function runtimeConfig(config, target, catalog, appVersion) {
  const normalized = normalizeConfig(config);
  const runtime = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    runtimeVersion: String(appVersion || "development"),
    enabled: normalized.enabled,
    paused: normalized.paused,
    pauseState: normalized.pauseState,
    configGeneration: normalized.configGeneration,
    pauseGeneration: normalized.pauseGeneration,
    activated: normalized.activated,
    battlegroup: String(target.name || "").trim(),
    namespace: String(target.namespace || "").trim(),
    dbPod: String(target.dbPod || "").trim(),
    dbService: String(target.dbSvc || target.dbService || "").trim(),
    exchangeName: String(normalized.exchangeName || "").trim(),
    economyStyle: normalized.economyStyle,
    listingCategory: normalized.listingCategory,
    intervalMinutes: normalized.intervalMinutes,
    expiryDays: normalized.expiryDays,
    safety: normalized.safety,
    playerBuying: normalized.playerBuying,
    items: normalized.catalogPolicy.mode === "pinned"
      ? normalized.catalogPolicy.items.map(runtimeItemPolicy)
      : buildItemPolicies(catalog, normalized).map(runtimeItemPolicy),
    generatedBy: `AlphaNine Dune Suite ${appVersion || "development"}`,
    generatedAt: new Date().toISOString()
  };
  runtime.configFingerprint = activationFingerprint(runtime);
  return runtime;
}

function runtimeItemPolicy(item = {}) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    tier: item.tier,
    enabled: item.enabled,
    unitPrice: item.unitPrice,
    stackSize: item.stackSize,
    targetListings: item.targetListings,
    categoryMask: item.categoryMask,
    categoryDepth: item.categoryDepth
  };
}

function goCanonicalJson(value) {
  const escaped = Object.freeze({ "&": "\\u0026", "<": "\\u003c", ">": "\\u003e", "\u2028": "\\u2028", "\u2029": "\\u2029" });
  return JSON.stringify(value).replace(/[&<>\u2028\u2029]/g, (character) => escaped[character]);
}

function activationFingerprint(runtime) {
  const stable = {
    schemaVersion: runtime.schemaVersion,
    enabled: runtime.enabled,
    activated: runtime.activated,
    battlegroup: runtime.battlegroup,
    namespace: runtime.namespace,
    dbPod: runtime.dbPod,
    dbService: runtime.dbService,
    economyStyle: runtime.economyStyle,
    listingCategory: runtime.listingCategory,
    intervalMinutes: runtime.intervalMinutes,
    expiryDays: runtime.expiryDays,
    safety: runtime.safety,
    playerBuying: runtime.playerBuying,
    items: runtime.items.map(runtimeItemPolicy)
  };
  // Go's encoding/json escapes HTML-sensitive characters and U+2028/U+2029.
  // Use its exact wire representation because the VM runtime independently
  // recalculates this digest before accepting a configuration.
  return crypto.createHash("sha256").update(goCanonicalJson(stable)).digest("hex");
}

function repairTargetMatches(remoteConfig = {}, target = {}) {
  const remoteBattlegroup = String(remoteConfig.battlegroup || "").trim();
  return Boolean(remoteBattlegroup
    && remoteBattlegroup === String(target.name || "").trim()
    && String(target.namespace || "").trim()
    && String(target.dbPod || "").trim()
    && String(target.dbSvc || "").trim());
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function gzipBase64(value) {
  return zlib.gzipSync(Buffer.isBuffer(value) ? value : Buffer.from(String(value)), { level: 9 }).toString("base64");
}

function base64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function openRcSource() {
  return `#!/sbin/openrc-run
name="AlphaNine Market Bot"
description="Persistent AlphaNine Dune Suite market target-stock reconciler"
command="${VM_MARKET_BOT_BINARY}"
command_args="daemon"
command_user="dune:dune"
directory="${VM_MARKET_BOT_DIR}"
pidfile="/run/alphanine-market-bot.pid"
command_background="yes"
output_log="${VM_MARKET_BOT_DIR}/service.log"
error_log="${VM_MARKET_BOT_DIR}/service.log"
respawn_delay=5
respawn_max=0
depend() {
  need net
  after k3s
}
`;
}

function buildInstallCommand({ config, binary, appVersion }) {
  if (!Buffer.isBuffer(binary) || binary.length < 10000) throw new Error("Bundled Linux/amd64 Market Bot binary is missing or invalid.");
  const binaryPayload = gzipBase64(binary);
  const configPayload = base64(`${JSON.stringify(config, null, 2)}\n`);
  const servicePayload = base64(openRcSource());
  return [
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `printf '%s\\n' ${shellQuote(`[market-bot-install] AlphaNine Dune Suite ${appVersion || "development"}`)}`,
    "command -v kubectl >/dev/null && command -v sudo >/dev/null && command -v rc-service >/dev/null",
    `sudo -n install -d -o dune -g dune -m 0750 ${shellQuote(VM_MARKET_BOT_DIR)}`,
    `printf %s ${shellQuote(binaryPayload)} | base64 -d | gzip -d > /tmp/alphanine-market-bot && chmod 0750 /tmp/alphanine-market-bot && /tmp/alphanine-market-bot --version >/dev/null 2>&1 || true`,
    `market_bot_kill_tree() { for child in $(pgrep -P "$1" 2>/dev/null || true); do market_bot_kill_tree "$child"; done; sudo -n kill -KILL "$1" 2>/dev/null || true; }`,
    `if [ -s /run/alphanine-market-bot.pid ]; then market_bot_pid=$(sudo -n cat /run/alphanine-market-bot.pid 2>/dev/null || true); case "$market_bot_pid" in ''|*[!0-9]*) printf '%s\\n' 'Invalid Market Bot PID file; refusing an unscoped stop.' >&2; exit 1;; esac; market_bot_exe=$(sudo -n readlink -f "/proc/$market_bot_pid/exe" 2>/dev/null || true); if [ "$market_bot_exe" != ${shellQuote(VM_MARKET_BOT_BINARY)} ] && [ "$market_bot_exe" != ${shellQuote(`${VM_MARKET_BOT_BINARY} (deleted)`)} ]; then printf '%s\\n' 'Market Bot PID does not identify the managed binary; refusing an unscoped stop.' >&2; exit 1; fi; if ! sudo -n timeout -k 2 12 rc-service alphanine-market-bot stop >/dev/null 2>&1; then market_bot_kill_tree "$market_bot_pid"; sudo -n rm -f /run/alphanine-market-bot.pid; sudo -n rc-service alphanine-market-bot zap >/dev/null 2>&1 || true; fi; fi`,
    `printf %s ${shellQuote(configPayload)} | base64 -d > /tmp/alphanine-market-bot-config.json && sudo -n install -o dune -g dune -m 0640 /tmp/alphanine-market-bot-config.json ${shellQuote(VM_MARKET_BOT_CONFIG)} && rm -f /tmp/alphanine-market-bot-config.json`,
    `sudo -n install -o dune -g dune -m 0750 /tmp/alphanine-market-bot ${shellQuote(VM_MARKET_BOT_BINARY)} && rm -f /tmp/alphanine-market-bot`,
    `printf %s ${shellQuote(servicePayload)} | base64 -d > /tmp/alphanine-market-bot-openrc && sudo -n install -o root -g root -m 0755 /tmp/alphanine-market-bot-openrc ${shellQuote(VM_MARKET_BOT_SERVICE)} && rm -f /tmp/alphanine-market-bot-openrc`,
    `${shellQuote(VM_MARKET_BOT_BINARY)} self-test`,
    `${shellQuote(VM_MARKET_BOT_BINARY)} migrate`,
    "sudo -n rc-update add alphanine-market-bot default >/dev/null 2>&1 || true",
    "sudo -n rc-service alphanine-market-bot start >/dev/null",
    `${shellQuote(VM_MARKET_BOT_BINARY)} status`
  ].join("\n");
}

function buildPausedRuntimeDeploymentCommand({ binary, expectedPreviousSha256, expectedPreviousSize, rollbackToken }) {
  if (!Buffer.isBuffer(binary) || binary.length < 10000) throw new Error("Bundled Linux/amd64 Market Bot binary is missing or invalid.");
  const previousSha256 = String(expectedPreviousSha256 || "").trim().toLowerCase();
  const previousSize = String(expectedPreviousSize || "").trim();
  const token = String(rollbackToken || "").trim();
  if (!/^[a-f0-9]{64}$/.test(previousSha256) || !/^[1-9]\d*$/.test(previousSize)) throw new Error("Exact previous Market Bot binary identity is required.");
  if (!/^[a-f0-9-]{16,64}$/.test(token)) throw new Error("A safe rollback token is required.");
  const binaryPayload = gzipBase64(binary);
  const nextSha256 = crypto.createHash("sha256").update(binary).digest("hex");
  const nextSize = String(binary.length);
  const nextPath = `${VM_MARKET_BOT_BINARY}.next-${token}`;
  const rollbackPath = `${VM_MARKET_BOT_BINARY}.rollback-${token}`;
  const success = base64(JSON.stringify({ ok: true, status: "deployed", previousSize, previousSha256, nextSize, nextSha256, rollbackToken: token }));
  return [
    "set -eu",
    "umask 077",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `binary=${shellQuote(VM_MARKET_BOT_BINARY)}`,
    `next=${shellQuote(nextPath)}`,
    `rollback=${shellQuote(rollbackPath)}`,
    "published=false",
    "service_stopped=false",
    "cleanup_paused_deploy() { rc=$?; sudo -n rm -f \"$next\" /tmp/alphanine-market-bot-paused-deploy; if [ \"$rc\" -ne 0 ]; then if [ \"$published\" = true ] && sudo -n test -f \"$rollback\"; then sudo -n timeout -k 2 12 rc-service alphanine-market-bot stop >/dev/null 2>&1 || true; sudo -n mv -f \"$rollback\" \"$binary\"; sudo -n chown dune:dune \"$binary\"; sudo -n chmod 0750 \"$binary\"; sudo -n rc-service alphanine-market-bot start >/dev/null 2>&1 || true; elif [ \"$service_stopped\" = true ]; then sudo -n rc-service alphanine-market-bot start >/dev/null 2>&1 || true; fi; fi; exit \"$rc\"; }",
    "trap cleanup_paused_deploy EXIT HUP INT TERM",
    `test -f ${shellQuote(VM_MARKET_BOT_PAUSE_MARKER)} && test ! -e ${shellQuote(VM_MARKET_BOT_CYCLE_LEASE)}`,
    `test \"$(sudo -n wc -c < \"$binary\" | tr -d ' ')\" = ${shellQuote(previousSize)}`,
    `test \"$(sudo -n sha256sum \"$binary\" | awk '{print $1}')\" = ${shellQuote(previousSha256)}`,
    `test ! -e ${shellQuote(rollbackPath)} && test ! -e ${shellQuote(nextPath)}`,
    `printf %s ${shellQuote(binaryPayload)} | base64 -d | gzip -d > /tmp/alphanine-market-bot-paused-deploy`,
    `test \"$(wc -c < /tmp/alphanine-market-bot-paused-deploy | tr -d ' ')\" = ${shellQuote(nextSize)}`,
    `test \"$(sha256sum /tmp/alphanine-market-bot-paused-deploy | awk '{print $1}')\" = ${shellQuote(nextSha256)}`,
    "chmod 0700 /tmp/alphanine-market-bot-paused-deploy",
    `ALPHANINE_MARKET_BOT_DIR=${shellQuote(VM_MARKET_BOT_DIR)} /tmp/alphanine-market-bot-paused-deploy self-test >/dev/null`,
    "sudo -n install -o dune -g dune -m 0700 \"$binary\" \"$rollback\"",
    "sudo -n install -o dune -g dune -m 0750 /tmp/alphanine-market-bot-paused-deploy \"$next\"",
    `test \"$(sudo -n wc -c < \"$next\" | tr -d ' ')\" = ${shellQuote(nextSize)}`,
    `test \"$(sudo -n sha256sum \"$next\" | awk '{print $1}')\" = ${shellQuote(nextSha256)}`,
    `test -f ${shellQuote(VM_MARKET_BOT_PAUSE_MARKER)} && test ! -e ${shellQuote(VM_MARKET_BOT_CYCLE_LEASE)}`,
    "sudo -n timeout -k 2 12 rc-service alphanine-market-bot stop >/dev/null",
    "service_stopped=true",
    "sudo -n mv -f \"$next\" \"$binary\"",
    "published=true",
    "sudo -n sync",
    `test \"$(sudo -n wc -c < \"$binary\" | tr -d ' ')\" = ${shellQuote(nextSize)}`,
    `test \"$(sudo -n sha256sum \"$binary\" | awk '{print $1}')\" = ${shellQuote(nextSha256)}`,
    `test -f ${shellQuote(VM_MARKET_BOT_PAUSE_MARKER)} && test ! -e ${shellQuote(VM_MARKET_BOT_CYCLE_LEASE)}`,
    "sudo -n rc-service alphanine-market-bot start >/dev/null",
    "service_stopped=false",
    `printf %s ${shellQuote(success)} | base64 -d`,
    "trap - EXIT HUP INT TERM",
    "sudo -n rm -f /tmp/alphanine-market-bot-paused-deploy"
  ].join("\n");
}

function buildPausedRuntimeRollbackCleanupCommand({ rollbackToken, expectedPreviousSha256, expectedPreviousSize, expectedCurrentSha256, expectedCurrentSize }) {
  const token = String(rollbackToken || "").trim();
  const rollbackPath = `${VM_MARKET_BOT_BINARY}.rollback-${token}`;
  for (const digest of [expectedPreviousSha256, expectedCurrentSha256]) if (!/^[a-f0-9]{64}$/.test(String(digest || ""))) throw new Error("Exact runtime digests are required.");
  for (const size of [expectedPreviousSize, expectedCurrentSize]) if (!/^[1-9]\d*$/.test(String(size || ""))) throw new Error("Exact runtime sizes are required.");
  if (!/^[a-f0-9-]{16,64}$/.test(token)) throw new Error("A safe rollback token is required.");
  return [
    "set -eu", "umask 077",
    `test \"$(sudo -n wc -c < ${shellQuote(VM_MARKET_BOT_BINARY)} | tr -d ' ')\" = ${shellQuote(expectedCurrentSize)}`,
    `test \"$(sudo -n sha256sum ${shellQuote(VM_MARKET_BOT_BINARY)} | awk '{print $1}')\" = ${shellQuote(expectedCurrentSha256)}`,
    `test \"$(sudo -n wc -c < ${shellQuote(rollbackPath)} | tr -d ' ')\" = ${shellQuote(expectedPreviousSize)}`,
    `test \"$(sudo -n sha256sum ${shellQuote(rollbackPath)} | awk '{print $1}')\" = ${shellQuote(expectedPreviousSha256)}`,
    `sudo -n rm -f ${shellQuote(rollbackPath)}`,
    `test ! -e ${shellQuote(rollbackPath)}`,
    `printf '%s\\n' '{"ok":true,"rollbackRemoved":true}'`
  ].join("\n");
}

function buildPausedRuntimeRollbackRestoreCommand({ rollbackToken, expectedPreviousSha256, expectedPreviousSize, expectedCurrentSha256, expectedCurrentSize }) {
  const token = String(rollbackToken || "").trim();
  const rollbackPath = `${VM_MARKET_BOT_BINARY}.rollback-${token}`;
  for (const digest of [expectedPreviousSha256, expectedCurrentSha256]) if (!/^[a-f0-9]{64}$/.test(String(digest || ""))) throw new Error("Exact runtime digests are required.");
  for (const size of [expectedPreviousSize, expectedCurrentSize]) if (!/^[1-9]\d*$/.test(String(size || ""))) throw new Error("Exact runtime sizes are required.");
  if (!/^[a-f0-9-]{16,64}$/.test(token)) throw new Error("A safe rollback token is required.");
  return [
    "set -eu", "umask 077",
    `test \"$(sudo -n wc -c < ${shellQuote(VM_MARKET_BOT_BINARY)} | tr -d ' ')\" = ${shellQuote(expectedCurrentSize)}`,
    `test \"$(sudo -n sha256sum ${shellQuote(VM_MARKET_BOT_BINARY)} | awk '{print $1}')\" = ${shellQuote(expectedCurrentSha256)}`,
    `test \"$(sudo -n wc -c < ${shellQuote(rollbackPath)} | tr -d ' ')\" = ${shellQuote(expectedPreviousSize)}`,
    `test \"$(sudo -n sha256sum ${shellQuote(rollbackPath)} | awk '{print $1}')\" = ${shellQuote(expectedPreviousSha256)}`,
    "sudo -n timeout -k 2 12 rc-service alphanine-market-bot stop >/dev/null",
    `sudo -n mv -f ${shellQuote(rollbackPath)} ${shellQuote(VM_MARKET_BOT_BINARY)}`,
    `sudo -n chown dune:dune ${shellQuote(VM_MARKET_BOT_BINARY)}`,
    `sudo -n chmod 0750 ${shellQuote(VM_MARKET_BOT_BINARY)}`,
    "sudo -n sync",
    `test \"$(sudo -n wc -c < ${shellQuote(VM_MARKET_BOT_BINARY)} | tr -d ' ')\" = ${shellQuote(expectedPreviousSize)}`,
    `test \"$(sudo -n sha256sum ${shellQuote(VM_MARKET_BOT_BINARY)} | awk '{print $1}')\" = ${shellQuote(expectedPreviousSha256)}`,
    "sudo -n rc-service alphanine-market-bot start >/dev/null",
    `printf '%s\\n' '{"ok":true,"rollbackRestored":true}'`
  ].join("\n");
}

function buildPausedConfigPublishCommand({ config, expectedCurrentSha256 }) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Paused Market Bot configuration is required.");
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION || config.paused !== true || config.pauseState !== PAUSE_STATES.REQUESTED) {
    throw new Error("Only a schema-current Pause requested Market Bot configuration may be published.");
  }
  const generation = normalizeGeneration(config.configGeneration, "");
  if (!generation || generation !== normalizeGeneration(config.pauseGeneration, "")) throw new Error("Paused configuration generations must match exactly.");
  if (activationFingerprint(config) !== config.configFingerprint) throw new Error("Paused configuration fingerprint does not match its canonical policy.");
  const priorSha256 = String(expectedCurrentSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(priorSha256)) throw new Error("The exact current remote configuration digest is required.");
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configPayload = base64(configText);
  const expectedPublishedSha256 = crypto.createHash("sha256").update(configText, "utf8").digest("hex");
  const successPayload = base64(JSON.stringify({ ok: true, status: "Paused configuration published" }));
  return [
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "umask 077",
    `test -x ${shellQuote(VM_MARKET_BOT_BINARY)} && test -s ${shellQuote(VM_MARKET_BOT_CONFIG)}`,
    `test -f ${shellQuote(VM_MARKET_BOT_PAUSE_MARKER)} && test ! -e ${shellQuote(VM_MARKET_BOT_CYCLE_LEASE)}`,
    `current_config_sha=$(sudo -n sha256sum ${shellQuote(VM_MARKET_BOT_CONFIG)} | awk '{print $1}')`,
    `test "$current_config_sha" = ${shellQuote(priorSha256)}`,
    "staging_dir=$(mktemp -d /tmp/alphanine-market-bot-policy.XXXXXX)",
    `remote_next=${shellQuote(`${VM_MARKET_BOT_CONFIG}.next-`)}$$`,
    "cleanup_policy_stage() { rm -f \"$staging_dir/config.json\"; rmdir \"$staging_dir\" 2>/dev/null || true; sudo -n rm -f \"$remote_next\"; }",
    "trap cleanup_policy_stage EXIT HUP INT TERM",
    `printf %s ${shellQuote(configPayload)} | base64 -d > "$staging_dir/config.json"`,
    `test "$(sha256sum "$staging_dir/config.json" | awk '{print $1}')" = ${shellQuote(expectedPublishedSha256)}`,
    `ALPHANINE_MARKET_BOT_DIR="$staging_dir" ${shellQuote(VM_MARKET_BOT_BINARY)} self-test >/dev/null`,
    `test -f ${shellQuote(VM_MARKET_BOT_PAUSE_MARKER)} && test ! -e ${shellQuote(VM_MARKET_BOT_CYCLE_LEASE)}`,
    `test "$(sudo -n sha256sum ${shellQuote(VM_MARKET_BOT_CONFIG)} | awk '{print $1}')" = ${shellQuote(priorSha256)}`,
    "sudo -n install -o dune -g dune -m 0640 \"$staging_dir/config.json\" \"$remote_next\"",
    `sudo -n mv -f "$remote_next" ${shellQuote(VM_MARKET_BOT_CONFIG)}`,
    `test "$(sudo -n sha256sum ${shellQuote(VM_MARKET_BOT_CONFIG)} | awk '{print $1}')" = ${shellQuote(expectedPublishedSha256)}`,
    "sync",
    `printf %s ${shellQuote(successPayload)} | base64 -d`
  ].join("\n");
}

function buildStatusCommand() {
  const missing = base64(JSON.stringify({ ok: true, installed: false, status: "Not Installed" }));
  return `if [ -x ${shellQuote(VM_MARKET_BOT_BINARY)} ] && [ -s ${shellQuote(VM_MARKET_BOT_CONFIG)} ]; then ${shellQuote(VM_MARKET_BOT_BINARY)} status; else printf %s ${shellQuote(missing)} | base64 -d; fi`;
}

function buildMigrationStoppedEvidenceCommand() {
  return [
    "set -u",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `service_installed=false; if sudo -n test -e ${shellQuote(VM_MARKET_BOT_SERVICE)}; then service_installed=true; fi`,
    `runtime_installed=false; if sudo -n test -e ${shellQuote(VM_MARKET_BOT_BINARY)}; then runtime_installed=true; fi`,
    "service_manager=none",
    "service_state=unknown",
    "service_authoritative=false",
    "service_status_code=not-installed",
    "if [ \"$service_installed\" = false ]; then service_state=absent; service_authoritative=true; elif command -v rc-service >/dev/null 2>&1; then service_manager=openrc; service_output=$(sudo -n rc-service alphanine-market-bot status 2>&1); service_status_code=$?; case \"$service_output\" in *stopped*) if [ \"$service_status_code\" -ne 0 ]; then service_state=stopped; service_authoritative=true; fi;; *started*|*running*) service_state=started;; esac; else service_manager=unknown; fi",
    "pid_file_present=false",
    "if sudo -n test -e /run/alphanine-market-bot.pid; then pid_file_present=true; fi",
    "default_runlevel_registered=false",
    "if sudo -n test -e /etc/runlevels/default/alphanine-market-bot; then default_runlevel_registered=true; fi",
    "matching_process_count=0",
    `for process_dir in /proc/[0-9]*; do process_exe=$(sudo -n readlink -f \"$process_dir/exe\" 2>/dev/null || true); if [ \"$process_exe\" = ${shellQuote(VM_MARKET_BOT_BINARY)} ] || [ \"$process_exe\" = ${shellQuote(`${VM_MARKET_BOT_BINARY} (deleted)`)} ]; then matching_process_count=$((matching_process_count+1)); fi; done`,
    "supervisor_process_count=0",
    `for process_dir in /proc/[0-9]*; do process_name=$(sudo -n cat \"$process_dir/comm\" 2>/dev/null || true); case \"$process_name\" in supervise-daemon|s6-supervise|runsv) process_args=$(sudo -n tr '\\000' ' ' < \"$process_dir/cmdline\" 2>/dev/null || true); case \"$process_args\" in *alphanine-market-bot*|*${VM_MARKET_BOT_BINARY}*) supervisor_process_count=$((supervisor_process_count+1));; esac;; esac; done`,
    "restart_path_active=false",
    "if [ \"$service_state\" = started ] || [ \"$service_state\" = unknown ] || [ \"$matching_process_count\" -ne 0 ] || [ \"$supervisor_process_count\" -ne 0 ] || [ \"$default_runlevel_registered\" = true ]; then restart_path_active=true; fi",
    "printf '{\"version\":3,\"serviceManager\":\"%s\",\"serviceState\":\"%s\",\"serviceInstalled\":%s,\"runtimeInstalled\":%s,\"serviceAuthoritative\":%s,\"statusExit\":\"%s\",\"pidFilePresent\":%s,\"matchingProcessCount\":\"%s\",\"supervisorProcessCount\":\"%s\",\"defaultRunlevelRegistered\":%s,\"restartPathActive\":%s}\\n' \"$service_manager\" \"$service_state\" \"$service_installed\" \"$runtime_installed\" \"$service_authoritative\" \"$service_status_code\" \"$pid_file_present\" \"$matching_process_count\" \"$supervisor_process_count\" \"$default_runlevel_registered\" \"$restart_path_active\""
  ].join("\n");
}

function buildMigrationStopCommand() {
  return [
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `if sudo -n test -e ${shellQuote(VM_MARKET_BOT_SERVICE)}; then command -v rc-service >/dev/null 2>&1; sudo -n rc-service alphanine-market-bot stop >/dev/null; fi`,
    buildMigrationStoppedEvidenceCommand()
  ].join("\n");
}

function buildMigrationUninstallCommand(options = {}) {
  const token = String(options.token || "").trim().toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(token)) throw new Error("A restrictive Market Bot migration-removal token is required.");
  const serviceStaging = `${VM_MARKET_BOT_SERVICE}.migration-remove-${token}`;
  const runtimeStaging = `${VM_MARKET_BOT_DIR}.migration-remove-${token}`;
  return [
    "set -eu",
    "umask 077",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `service=${shellQuote(VM_MARKET_BOT_SERVICE)}`,
    `runtime=${shellQuote(VM_MARKET_BOT_DIR)}`,
    `service_staging=${shellQuote(serviceStaging)}`,
    `runtime_staging=${shellQuote(runtimeStaging)}`,
    "test ! -e \"$service_staging\" && test ! -e \"$runtime_staging\"",
    "if test -e \"$service\"; then service_status=0; service_output=$(sudo -n rc-service alphanine-market-bot status 2>&1) || service_status=$?; case \"$service_output\" in *stopped*) test \"$service_status\" -ne 0;; *) printf '%s\\n' 'Market Bot service is not stopped.' >&2; exit 1;; esac; fi",
    "test ! -e /run/alphanine-market-bot.pid",
    `for process_dir in /proc/[0-9]*; do process_exe=$(sudo -n readlink -f \"$process_dir/exe\" 2>/dev/null || true); test \"$process_exe\" != ${shellQuote(VM_MARKET_BOT_BINARY)} && test \"$process_exe\" != ${shellQuote(`${VM_MARKET_BOT_BINARY} (deleted)`)}; done`,
    "had_runlevel=false; if sudo -n test -e /etc/runlevels/default/alphanine-market-bot; then had_runlevel=true; fi",
    "restore_market_bot() { rc=$?; if [ \"$rc\" -ne 0 ]; then if sudo -n test -e \"$runtime_staging\" && ! sudo -n test -e \"$runtime\"; then sudo -n mv \"$runtime_staging\" \"$runtime\"; fi; if sudo -n test -e \"$service_staging\" && ! sudo -n test -e \"$service\"; then sudo -n mv \"$service_staging\" \"$service\"; fi; if [ \"$had_runlevel\" = true ] && sudo -n test -e \"$service\"; then sudo -n rc-update add alphanine-market-bot default >/dev/null 2>&1 || true; fi; fi; exit \"$rc\"; }",
    "trap restore_market_bot EXIT HUP INT TERM",
    "if [ \"$had_runlevel\" = true ]; then sudo -n rc-update del alphanine-market-bot default >/dev/null; fi",
    "if sudo -n test -e \"$service\"; then sudo -n mv \"$service\" \"$service_staging\"; fi",
    "if sudo -n test -e \"$runtime\"; then sudo -n mv \"$runtime\" \"$runtime_staging\"; fi",
    "test ! -e \"$service\" && test ! -e \"$runtime\" && test ! -e /run/alphanine-market-bot.pid",
    `infrastructure_evidence=$(${buildMigrationStoppedEvidenceCommand()})`,
    "case \"$infrastructure_evidence\" in *'\"version\":3'*'\"serviceState\":\"absent\"'*'\"serviceInstalled\":false'*'\"runtimeInstalled\":false'*'\"matchingProcessCount\":\"0\"'*'\"supervisorProcessCount\":\"0\"'*'\"defaultRunlevelRegistered\":false'*) ;; *) printf '%s\\n' 'Market Bot removal evidence was not authoritative.' >&2; exit 1;; esac",
    "sudo -n rm -rf -- \"$service_staging\" \"$runtime_staging\"",
    "test ! -e \"$service_staging\" && test ! -e \"$runtime_staging\"",
    "trap - EXIT HUP INT TERM",
    "printf '%s\\n' \"$infrastructure_evidence\""
  ].join("\n");
}

function buildActionCommand(action, options = {}) {
  if (!new Set(["preview", "restock", "pause", "resume", "clean", "self-test"]).has(action)) throw new Error("Unknown Market Bot action.");
  const cycleId = String(options.cycleId || "").trim();
  const generation = normalizeGeneration(options.generation, "");
  if (new Set(["pause", "resume"]).has(action) && !generation) throw new Error("A pause/config generation is required.");
  const suffix = cycleId && new Set(["preview", "restock"]).has(action)
    ? ` --cycle-id ${shellQuote(cycleId)}`
    : generation ? ` --generation ${shellQuote(generation)}` : "";
  return `test -x ${shellQuote(VM_MARKET_BOT_BINARY)} && ${shellQuote(VM_MARKET_BOT_BINARY)} ${shellQuote(action)}${suffix}`;
}

function parseJsonOutput(output) {
  const lines = String(output || "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw new Error(`Market Bot returned invalid output: ${String(output || "").slice(-1000)}`);
}

function csvForPreview(result = {}) {
  const rows = Array.isArray(result.items) ? result.items : [];
  const categories = Array.isArray(result.categories) ? result.categories : [];
  const quote = (value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
  const header = ["Item ID", "Name", "Category", "Unit Price", "Stack Size", "Target Listings", "Active Listings", "Deficit", "Create Now", "Planned Value"];
  const body = rows.map((item) => [
    item.id, item.name, item.category, item.unitPrice, item.stackSize, item.targetListings,
    item.activeListings, item.deficit, item.createNow, item.plannedValue
  ].map(quote).join(","));
  const categoryHeader = ["Category", "Items", "Active Listings", "Target Listings", "Deficit", "Create Now", "Planned Value"];
  const categoryBody = categories.map((row) => [
    row.category, row.items, row.activeListings, row.targetListings, row.deficit, row.createNow, row.plannedValue
  ].map(quote).join(","));
  return [
    header.map(quote).join(","),
    ...body,
    "",
    categoryHeader.map(quote).join(","),
    ...categoryBody
  ].join("\r\n") + "\r\n";
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  CATALOG_POLICY_VERSION,
  VM_MARKET_BOT_DIR,
  VM_MARKET_BOT_BINARY,
  VM_MARKET_BOT_CONFIG,
  VM_MARKET_BOT_STATE,
  VM_MARKET_BOT_PAUSE_MARKER,
  VM_MARKET_BOT_CYCLE_LEASE,
  VM_MARKET_BOT_SERVICE,
  MARKET_CATEGORY_MASK_SEED_PATH,
  ECONOMY_STYLES,
  CATEGORY_DEFAULTS,
  normalizeCategoryMaskSeed,
  marketCategoryMaskSeed,
  defaultMarketBotConfig,
  normalizeConfig,
  normalizePinnedCatalogItems,
  catalogPolicyFingerprint,
  pinnedCatalogPolicy,
  legacyMigration,
  createMarketBotStore,
  buildItemPolicies,
  runtimeConfig,
  activationFingerprint,
  repairTargetMatches,
  buildInstallCommand,
  buildPausedRuntimeDeploymentCommand,
  buildPausedRuntimeRollbackCleanupCommand,
  buildPausedRuntimeRollbackRestoreCommand,
  buildPausedConfigPublishCommand,
  buildStatusCommand,
  buildMigrationStoppedEvidenceCommand,
  buildMigrationStopCommand,
  buildMigrationUninstallCommand,
  buildActionCommand,
  parseJsonOutput,
  csvForPreview,
  openRcSource
};
