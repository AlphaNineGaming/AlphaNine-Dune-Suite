const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_PRICING_CONFIG, MARKET_PRICING_PRESETS, normalizePricingConfig, calculateMarketPrice } = require("./market-pricing");

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  targetNpcListings: 40,
  maxCreatesPerCycle: 5,
  listingIntervalMinutes: 30,
  buyerIntervalMinutes: 20,
  maxPlayerBuysPerCycle: 0,
  maxPlayerUnitPrice: 0,
  maxPlayerSpendPerCycle: 0,
  stackSize: 1,
  quality: 0,
  expiryDays: 3,
  templates: [],
  ...DEFAULT_PRICING_CONFIG
});

function integer(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeTemplates(value) {
  const rows = Array.isArray(value) ? value : String(value || "").split(/[\r\n,]+/);
  return [...new Set(rows.map((row) => String(row || "").trim()).filter((row) => /^[A-Za-z0-9_:.()+-]{2,240}$/.test(row)))].slice(0, 100);
}

function normalizeCatalogTemplates(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((row) => String(row && typeof row === "object" ? row.id : row || "").trim())
    .filter((row) => /^[A-Za-z0-9_:.()+-]{2,240}$/.test(row)))];
}

function normalizeCatalogItems(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const row of value) {
    const source = row && typeof row === "object" ? row : { id: row };
    const id = String(source.id || source.template || source.templateId || "").trim();
    if (!/^[A-Za-z0-9_:.()+-]{2,240}$/.test(id) || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: String(source.name || id),
      grade: source.grade,
      quality: source.quality,
      itemGrade: source.itemGrade,
      tier: source.tier,
      itemTier: source.itemTier,
      level: source.level,
      rarity: source.rarity,
      itemRarity: source.itemRarity,
      category: source.category,
      type: source.type
    });
  }
  return [...byId.values()];
}

function normalizeConfig(value = {}) {
  return {
    enabled: value.enabled === true,
    targetNpcListings: integer(value.targetNpcListings, DEFAULT_CONFIG.targetNpcListings, 0, 500),
    maxCreatesPerCycle: integer(value.maxCreatesPerCycle, DEFAULT_CONFIG.maxCreatesPerCycle, 0, 25),
    listingIntervalMinutes: integer(value.listingIntervalMinutes, DEFAULT_CONFIG.listingIntervalMinutes, 1, 1440),
    buyerIntervalMinutes: integer(value.buyerIntervalMinutes, DEFAULT_CONFIG.buyerIntervalMinutes, 1, 1440),
    maxPlayerBuysPerCycle: integer(value.maxPlayerBuysPerCycle, DEFAULT_CONFIG.maxPlayerBuysPerCycle, 0, 20),
    maxPlayerUnitPrice: integer(value.maxPlayerUnitPrice, DEFAULT_CONFIG.maxPlayerUnitPrice, 0, 999999999),
    maxPlayerSpendPerCycle: integer(value.maxPlayerSpendPerCycle, DEFAULT_CONFIG.maxPlayerSpendPerCycle, 0, 999999999),
    stackSize: integer(value.stackSize, DEFAULT_CONFIG.stackSize, 1, 50000),
    quality: integer(value.quality, DEFAULT_CONFIG.quality, 0, 5),
    expiryDays: [1, 3, 7, 14].includes(Number(value.expiryDays)) ? Number(value.expiryDays) : DEFAULT_CONFIG.expiryDays,
    templates: normalizeTemplates(value.templates),
    ...normalizePricingConfig(value)
  };
}

function createCycleId(value = Date.now(), sequence = 1) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Market pricing cycle time is invalid.");
  return `${date.toISOString()}:${integer(sequence, 1, 1, Number.MAX_SAFE_INTEGER)}`;
}

function pricingConfigFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeConfig(value)), "utf8").digest("hex");
}

function createMarketAutomator(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.cwd());
  const configPath = path.join(dataDir, "market-automator.json");
  const logPath = path.join(dataDir, "market-automator.log");
  const inspect = options.inspect;
  const list = options.list;
  const publish = options.publish;
  const purchase = options.purchase;
  const catalog = options.catalog;
  const battlegroup = typeof options.battlegroup === "function" ? options.battlegroup : () => "";
  if (![inspect, list, publish, purchase, catalog].every((entry) => typeof entry === "function")) {
    throw new Error("Market automator requires inspect, list, publish, purchase, and catalog callbacks.");
  }

  fs.mkdirSync(dataDir, { recursive: true });
  let config = { ...DEFAULT_CONFIG };
  let cursor = 0;
  let running = false;
  let startedAt = Date.now();
  let lastListingCycleAt = 0;
  let lastBuyerCycleAt = 0;
  let counters = { cycles: 0, created: 0, purchased: 0, errors: 0 };
  const pricingPreviewApprovals = new Map();

  function log(level, message, detail = "") {
    const line = `${new Date().toISOString()} ${String(level).toUpperCase()} ${message}${detail ? ` | ${detail}` : ""}`;
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
    return line;
  }

  function load() {
    try {
      if (fs.existsSync(configPath)) {
        const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
        config = normalizeConfig(stored);
        if (JSON.stringify(stored) !== JSON.stringify(config)) writeConfig(config);
      }
    } catch (error) {
      counters.errors += 1;
      log("error", "Configuration load failed", error.message);
    }
    return config;
  }

  function writeConfig(next) {
    const temporary = `${configPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, configPath);
  }

  function save(next) {
    const candidate = normalizeConfig(next);
    if (config.dynamicPricingNeedsReview === true) {
      if (candidate.pricingMode === "dynamic") {
        const token = String(next?.dynamicPricingPreviewToken || "");
        const expectedFingerprint = pricingPreviewApprovals.get(token);
        if (!token || expectedFingerprint !== pricingConfigFingerprint(candidate)) {
          throw new Error("Review the dynamic pricing preview before enabling Dynamic pricing.");
        }
        candidate.dynamicPricingNeedsReview = false;
        pricingPreviewApprovals.delete(token);
      } else {
        candidate.dynamicPricingNeedsReview = true;
      }
    }
    config = candidate;
    writeConfig(config);
    log("info", "Configuration saved", config.enabled ? "automation enabled" : "automation disabled");
    return config;
  }

  function nextTemplates(count, availableTemplates) {
    const selected = [];
    const templates = config.templates.length ? config.templates : availableTemplates;
    if (!templates.length) return selected;
    for (let index = 0; index < count; index += 1) {
      selected.push(templates[cursor % templates.length]);
      cursor = (cursor + 1) % templates.length;
    }
    return selected;
  }

  async function catalogItems() {
    return normalizeCatalogItems(await catalog());
  }

  async function listingCycle({ cycleId } = {}) {
    if (config.pricingMode === "dynamic" && config.dynamicPricingNeedsReview) {
      throw new Error("Dynamic item pricing must be reviewed and saved before running a listing cycle.");
    }
    if (config.minimumPrice > config.maximumPrice) throw new Error("Minimum market price cannot exceed maximum market price.");
    const market = await inspect();
    if (!market.ok) throw new Error(`Market schema is not ready: ${(market.missingTables || []).join(", ") || market.error || "unknown reason"}`);
    const current = Number(market.botListings || 0);
    const deficit = Math.max(0, config.targetNpcListings - current);
    const createCount = Math.min(deficit, config.maxCreatesPerCycle);
    if (!createCount) return { ok: true, kind: "list", current, target: config.targetNpcListings, created: 0 };
    let items = [];
    try { items = await catalogItems(); }
    catch (error) {
      if (!config.templates.length) throw error;
    }
    const automaticTemplates = config.templates.length ? [] : items.map((item) => item.id);
    const templates = nextTemplates(createCount, automaticTemplates);
    if (!templates.length) throw new Error("No marketable item templates are available in the local Suite catalog.");
    const templateSource = config.templates.length ? "configured" : "automatic-catalog";
    const results = [];
    const planned = [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const battlegroupId = String(await battlegroup() || "").trim() || "unknown-battlegroup";
    for (const template of templates) {
      const pricing = calculateMarketPrice({ config, item: byId.get(template) || { id: template }, template, battlegroup: battlegroupId, cycleId });
      const request = {
        confirmed: true,
        template,
        stackSize: config.stackSize,
        price: pricing.finalPrice,
        quality: config.quality,
        listingCount: 1,
        expiryDays: config.expiryDays,
        pricing
      };
      planned.push({ template, price: pricing.finalPrice, pricing });
      results.push(await publish(request));
    }
    counters.created += results.length;
    log("info", "Listing cycle completed", `${results.length} created; ${current} existed`);
    return { ok: true, kind: "list", current, target: config.targetNpcListings, created: results.length, templates, templateSource, cycleId, battlegroup: battlegroupId, planned };
  }

  async function buyerCycle() {
    if (!config.maxPlayerBuysPerCycle || !config.maxPlayerUnitPrice || !config.maxPlayerSpendPerCycle) {
      return { ok: true, kind: "buy", purchased: 0, skipped: "Buyer limits are disabled." };
    }
    const market = await list({ limit: 250 });
    const candidates = (market.listings || [])
      .filter((row) => !row.isNpcOrder && Number(row.price) > 0 && Number(row.price) <= config.maxPlayerUnitPrice)
      .sort((left, right) => Number(left.price) - Number(right.price) || Number(left.orderId) - Number(right.orderId));
    const results = [];
    let spent = 0;
    for (const row of candidates) {
      const total = Number(row.price) * Math.max(1, Number(row.stackSize || 1));
      if (results.length >= config.maxPlayerBuysPerCycle || spent + total > config.maxPlayerSpendPerCycle) break;
      results.push(await purchase(row.orderId));
      spent += total;
    }
    counters.purchased += results.length;
    log("info", "Buyer cycle completed", `${results.length} purchased; ${spent} Solari committed`);
    return { ok: true, kind: "buy", purchased: results.length, spent };
  }

  async function run(kind = "all", source = "manual", runOptions = {}) {
    if (running) throw new Error("A market automation cycle is already running.");
    if (!["list", "buy", "all"].includes(kind)) throw new Error("Unsupported market automation cycle.");
    running = true;
    counters.cycles += 1;
    const started = new Date();
    const startedAt = started.toISOString();
    const cycleId = String(runOptions.cycleId || createCycleId(started, counters.cycles));
    const result = { ok: true, kind, source, cycleId, startedAt };
    try {
      if (kind === "list" || kind === "all") {
        result.listing = await listingCycle({ cycleId });
        lastListingCycleAt = Date.now();
      }
      if (kind === "buy" || kind === "all") {
        result.buyer = await buyerCycle();
        lastBuyerCycleAt = Date.now();
      }
      result.completedAt = new Date().toISOString();
      return result;
    } catch (error) {
      counters.errors += 1;
      log("error", `${kind} cycle failed`, error.message);
      throw error;
    } finally {
      running = false;
    }
  }

  async function overview() {
    let market;
    try { market = await inspect(); }
    catch (error) { market = { ok: false, error: error.message, botListings: 0 }; }
    let automaticTemplateCount = 0;
    let catalogError = "";
    if (!config.templates.length) {
      try { automaticTemplateCount = (await catalogItems()).length; }
      catch (error) { catalogError = error.message; }
    }
    return {
      ok: true,
      service: "AlphaNine Market Automator",
      architecture: "suite-native",
      config,
      pricingPresets: MARKET_PRICING_PRESETS,
      status: {
        running,
        enabled: config.enabled,
        npcListings: Number(market.botListings || 0),
        marketReady: market.ok === true,
        marketError: market.ok ? "" : (market.error || (market.missingTables || []).join(", ")),
        templateMode: config.templates.length ? "configured" : "automatic-catalog",
        availableTemplateCount: config.templates.length || automaticTemplateCount,
        catalogError,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        lastListingCycleAt: lastListingCycleAt ? new Date(lastListingCycleAt).toISOString() : "",
        lastBuyerCycleAt: lastBuyerCycleAt ? new Date(lastBuyerCycleAt).toISOString() : "",
        counters: { ...counters }
      }
    };
  }

  async function pricingPreview(options = {}) {
    const previewConfig = normalizeConfig(options.config || config);
    const rows = await catalogItems();
    const search = String(options.search || "").trim().toLowerCase();
    const limit = integer(options.limit, 20, 1, 250);
    const cycleId = String(options.cycleId || createCycleId(new Date(), counters.cycles + 1));
    const battlegroupId = String(await battlegroup() || "").trim() || "unknown-battlegroup";
    const configuredIds = previewConfig.templates.length ? new Set(previewConfig.templates) : null;
    let selected = rows.filter((item) => {
      if (configuredIds && !configuredIds.has(item.id)) return false;
      if (!search) return true;
      return [item.id, item.name, item.grade, item.tier, item.rarity, item.category].some((value) => String(value || "").toLowerCase().includes(search));
    });
    if (options.sample === true && selected.length > limit) {
      const lastIndex = selected.length - 1;
      selected = Array.from({ length: limit }, (_, index) => selected[Math.floor((index * lastIndex) / Math.max(1, limit - 1))]);
    } else {
      selected = selected.slice(0, limit);
    }
    const byId = new Map(selected.map((item) => [item.id, item]));
    if (configuredIds) {
      for (const id of configuredIds) if (!byId.has(id) && (!search || id.toLowerCase().includes(search))) byId.set(id, { id, name: id });
    }
    const items = [...byId.values()].slice(0, limit).map((item) => ({
      id: item.id,
      name: item.name || item.id,
      pricing: calculateMarketPrice({ config: previewConfig, item, template: item.id, battlegroup: battlegroupId, cycleId })
    }));
    let dynamicPricingPreviewToken = "";
    if (previewConfig.pricingMode === "dynamic") {
      dynamicPricingPreviewToken = crypto.randomBytes(24).toString("hex");
      pricingPreviewApprovals.set(dynamicPricingPreviewToken, pricingConfigFingerprint(previewConfig));
      while (pricingPreviewApprovals.size > 20) pricingPreviewApprovals.delete(pricingPreviewApprovals.keys().next().value);
    }
    return { ok: true, cycleId, battlegroup: battlegroupId, config: previewConfig, dynamicPricingPreviewToken, items };
  }

  async function catalogSearch(options = {}) {
    const query = String(options.query || "").trim().toLowerCase();
    const limit = integer(options.limit, 20, 1, 50);
    const items = (await catalogItems()).filter((item) => !query || [item.id, item.name, item.grade, item.tier, item.rarity, item.category]
      .some((value) => String(value || "").toLowerCase().includes(query))).slice(0, limit);
    return { ok: true, items };
  }

  function logs(limit = 160) {
    if (!fs.existsSync(logPath)) return { ok: true, lines: [], text: "No market automation activity yet." };
    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-integer(limit, 160, 1, 1000));
    return { ok: true, lines, text: lines.join("\n") };
  }

  async function scheduledCheck() {
    if (!config.enabled || running) return;
    const now = Date.now();
    const listingDue = now - lastListingCycleAt >= config.listingIntervalMinutes * 60000;
    const buyerDue = now - lastBuyerCycleAt >= config.buyerIntervalMinutes * 60000;
    if (!listingDue && !buyerDue) return;
    const kind = listingDue && buyerDue ? "all" : (listingDue ? "list" : "buy");
    await run(kind, "scheduler").catch(() => {});
  }

  load();
  const timer = setInterval(scheduledCheck, 30000);
  if (typeof timer.unref === "function") timer.unref();
  return {
    overview,
    getConfig: () => JSON.parse(JSON.stringify(config)),
    save,
    run,
    pricingPreview,
    catalogSearch,
    logs,
    close: () => clearInterval(timer)
  };
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, normalizeCatalogTemplates, normalizeCatalogItems, createCycleId, createMarketAutomator };
