"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CONFIG_SCHEMA_VERSION = 1;
const VM_MARKET_BOT_DIR = "/home/dune/.dune/alphanine-market-bot";
const VM_MARKET_BOT_BINARY = `${VM_MARKET_BOT_DIR}/alphanine-market-bot`;
const VM_MARKET_BOT_CONFIG = `${VM_MARKET_BOT_DIR}/config.json`;
const VM_MARKET_BOT_STATE = `${VM_MARKET_BOT_DIR}/state.json`;
const VM_MARKET_BOT_SERVICE = "/etc/init.d/alphanine-market-bot";
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
    activated: false,
    economyStyle: "Expensive",
    intervalMinutes: 30,
    expiryDays: 3,
    safety: {
      maxCreatesPerCycle: 25,
      maxMarketValuePerCycle: 25000000
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
    paused: bool(input.paused, base.paused),
    activated: bool(input.activated, base.activated),
    economyStyle,
    intervalMinutes: integer(input.intervalMinutes, base.intervalMinutes, 1, 1440, "Restock interval"),
    expiryDays: integer(input.expiryDays, base.expiryDays, 1, 14, "Listing expiration"),
    safety: {
      maxCreatesPerCycle: integer(input.safety?.maxCreatesPerCycle, base.safety.maxCreatesPerCycle, 1, 250, "Maximum creations per cycle"),
      maxMarketValuePerCycle: integer(input.safety?.maxMarketValuePerCycle, base.safety.maxMarketValuePerCycle, 1, Number.MAX_SAFE_INTEGER, "Maximum market value per cycle")
    },
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

function buildItemPolicies(catalog, configInput) {
  const config = normalizeConfig(configInput);
  const factor = STYLE_FACTORS[config.economyStyle] || 1;
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
    rows.push({
      id: item.id,
      name: item.name,
      category: item.category,
      tier: item.tier,
      enabled: override.enabled !== false,
      unitPrice: override.unitPrice || roundPrice(basePrice * tierFactor(item.tier) * gradeFactor(item.grade) * factor),
      stackSize: override.stackSize || knownStack || defaults.stack || 1,
      targetListings: override.targetListings ?? 1,
      sources: {
        unitPrice: override.unitPrice ? "exact override" : catalogPrice ? "catalog price" : defaults.price ? "category pricebook" : "minimum fallback",
        stackSize: override.stackSize ? "exact override" : knownStack ? "catalog maximum" : defaults.stack ? "category default" : "minimum fallback"
      }
    });
  }
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function runtimeConfig(config, target, catalog, appVersion) {
  const normalized = normalizeConfig(config);
  return {
    schemaVersion: 1,
    runtimeVersion: String(appVersion || "development"),
    enabled: normalized.enabled,
    paused: normalized.paused,
    activated: normalized.activated,
    battlegroup: String(target.name || "").trim(),
    namespace: String(target.namespace || "").trim(),
    dbPod: String(target.dbPod || "").trim(),
    dbService: String(target.dbSvc || target.dbService || "").trim(),
    exchangeName: String(normalized.exchangeName || "").trim(),
    economyStyle: normalized.economyStyle,
    intervalMinutes: normalized.intervalMinutes,
    expiryDays: normalized.expiryDays,
    safety: normalized.safety,
    items: buildItemPolicies(catalog, normalized),
    generatedBy: `AlphaNine Dune Suite ${appVersion || "development"}`,
    generatedAt: new Date().toISOString()
  };
}

function activationFingerprint(runtime) {
  const stable = {
    schemaVersion: runtime.schemaVersion,
    battlegroup: runtime.battlegroup,
    namespace: runtime.namespace,
    dbPod: runtime.dbPod,
    dbService: runtime.dbService,
    economyStyle: runtime.economyStyle,
    intervalMinutes: runtime.intervalMinutes,
    expiryDays: runtime.expiryDays,
    safety: runtime.safety,
    items: runtime.items
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
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
    `sudo -n install -o dune -g dune -m 0750 /tmp/alphanine-market-bot ${shellQuote(VM_MARKET_BOT_BINARY)} && rm -f /tmp/alphanine-market-bot`,
    `printf %s ${shellQuote(configPayload)} | base64 -d > /tmp/alphanine-market-bot-config.json && sudo -n install -o dune -g dune -m 0640 /tmp/alphanine-market-bot-config.json ${shellQuote(VM_MARKET_BOT_CONFIG)} && rm -f /tmp/alphanine-market-bot-config.json`,
    `printf %s ${shellQuote(servicePayload)} | base64 -d > /tmp/alphanine-market-bot-openrc && sudo -n install -o root -g root -m 0755 /tmp/alphanine-market-bot-openrc ${shellQuote(VM_MARKET_BOT_SERVICE)} && rm -f /tmp/alphanine-market-bot-openrc`,
    `${shellQuote(VM_MARKET_BOT_BINARY)} self-test`,
    `${shellQuote(VM_MARKET_BOT_BINARY)} migrate`,
    "sudo -n rc-update add alphanine-market-bot default >/dev/null 2>&1 || true",
    "sudo -n rc-service alphanine-market-bot start >/dev/null",
    `${shellQuote(VM_MARKET_BOT_BINARY)} status`
  ].join("\n");
}

function buildStatusCommand() {
  const missing = base64(JSON.stringify({ ok: true, installed: false, status: "Not Installed" }));
  return `if [ -x ${shellQuote(VM_MARKET_BOT_BINARY)} ] && [ -s ${shellQuote(VM_MARKET_BOT_CONFIG)} ]; then ${shellQuote(VM_MARKET_BOT_BINARY)} status; else printf %s ${shellQuote(missing)} | base64 -d; fi`;
}

function buildActionCommand(action, options = {}) {
  if (!new Set(["preview", "restock", "pause", "resume", "self-test"]).has(action)) throw new Error("Unknown Market Bot action.");
  const cycleId = String(options.cycleId || "").trim();
  const suffix = cycleId && new Set(["preview", "restock"]).has(action) ? ` --cycle-id ${shellQuote(cycleId)}` : "";
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
  VM_MARKET_BOT_DIR,
  VM_MARKET_BOT_BINARY,
  VM_MARKET_BOT_CONFIG,
  VM_MARKET_BOT_STATE,
  VM_MARKET_BOT_SERVICE,
  ECONOMY_STYLES,
  CATEGORY_DEFAULTS,
  defaultMarketBotConfig,
  normalizeConfig,
  legacyMigration,
  createMarketBotStore,
  buildItemPolicies,
  runtimeConfig,
  activationFingerprint,
  buildInstallCommand,
  buildStatusCommand,
  buildActionCommand,
  parseJsonOutput,
  csvForPreview,
  openRcSource
};
