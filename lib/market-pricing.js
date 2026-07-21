"use strict";

const crypto = require("crypto");

const MAX_MARKET_PRICE = 999999999;
const MARKET_PRICING_PRESETS = Object.freeze({
  casual: Object.freeze({
    label: "Casual", description: "Gentle variation and modest metadata adjustments.", basePrice: 750, itemVariationPercent: 5, cycleVariationPercent: 2,
    gradeMultipliers: Object.freeze({ Common: 0.98, Uncommon: 1, Rare: 1.05, Epic: 1.1, Legendary: 1.18, Unique: 1.25 }),
    tierMultipliers: Object.freeze({ T1: 0.95, T2: 0.98, T3: 1, T4: 1.05, T5: 1.12, T6: 1.2 }),
    rarityMultipliers: Object.freeze({ Common: 0.98, Uncommon: 1, Rare: 1.03, Epic: 1.07, Legendary: 1.12, Unique: 1.18 })
  }),
  vanilla: Object.freeze({
    label: "Vanilla", description: "Balanced local-catalog pricing for everyday markets.", basePrice: 1000, itemVariationPercent: 15, cycleVariationPercent: 5,
    gradeMultipliers: Object.freeze({ Common: 0.95, Uncommon: 1, Rare: 1.1, Epic: 1.22, Legendary: 1.36, Unique: 1.5 }),
    tierMultipliers: Object.freeze({ T1: 0.9, T2: 0.95, T3: 1, T4: 1.12, T5: 1.28, T6: 1.45 }),
    rarityMultipliers: Object.freeze({ Common: 0.95, Uncommon: 1, Rare: 1.07, Epic: 1.16, Legendary: 1.28, Unique: 1.42 })
  }),
  hardcore: Object.freeze({
    label: "Hardcore", description: "Higher prices with stronger grade, tier, and rarity differences.", basePrice: 1500, itemVariationPercent: 20, cycleVariationPercent: 8,
    gradeMultipliers: Object.freeze({ Common: 0.9, Uncommon: 1, Rare: 1.18, Epic: 1.42, Legendary: 1.72, Unique: 2 }),
    tierMultipliers: Object.freeze({ T1: 0.8, T2: 0.9, T3: 1, T4: 1.25, T5: 1.55, T6: 1.9 }),
    rarityMultipliers: Object.freeze({ Common: 0.9, Uncommon: 1, Rare: 1.12, Epic: 1.3, Legendary: 1.55, Unique: 1.8 })
  }),
  economy: Object.freeze({
    label: "Economy", description: "Lower prices with restrained movement between cycles.", basePrice: 600, itemVariationPercent: 10, cycleVariationPercent: 3,
    gradeMultipliers: Object.freeze({ Common: 0.98, Uncommon: 1, Rare: 1.07, Epic: 1.16, Legendary: 1.28, Unique: 1.4 }),
    tierMultipliers: Object.freeze({ T1: 0.92, T2: 0.96, T3: 1, T4: 1.1, T5: 1.22, T6: 1.35 }),
    rarityMultipliers: Object.freeze({ Common: 0.98, Uncommon: 1, Rare: 1.05, Epic: 1.12, Legendary: 1.22, Unique: 1.32 })
  })
});
const DEFAULT_PRICING_CONFIG = Object.freeze({
  pricingMode: "dynamic",
  pricingPreset: "vanilla",
  basePrice: 1000,
  dynamicPricingNeedsReview: false,
  minimumPrice: 1,
  maximumPrice: MAX_MARKET_PRICE,
  roundingIncrement: 1,
  itemVariationPercent: 15,
  cycleVariationPercent: 5,
  gradeMultipliers: MARKET_PRICING_PRESETS.vanilla.gradeMultipliers,
  tierMultipliers: MARKET_PRICING_PRESETS.vanilla.tierMultipliers,
  rarityMultipliers: MARKET_PRICING_PRESETS.vanilla.rarityMultipliers,
  categoryBasePrices: Object.freeze({}),
  itemOverrides: Object.freeze({})
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function cleanKey(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedLookupKey(value) {
  return cleanKey(value).toLocaleLowerCase("en-US");
}

function normalizeNumberMap(value, { minimum, maximum, integer = false, strictLabel = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = cleanKey(rawKey);
    const number = Number(rawValue);
    if (!key || !Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
      if (strictLabel) throw new Error(`${strictLabel} for ${key || "unknown item"} must be a whole number from ${minimum} to ${maximum}.`);
      continue;
    }
    result[key] = number;
  }
  return result;
}

function normalizePricingConfig(value = {}) {
  const legacyPricing = Object.prototype.hasOwnProperty.call(value, "price")
    && !Object.prototype.hasOwnProperty.call(value, "pricingMode")
    && !Object.prototype.hasOwnProperty.call(value, "basePrice");
  const pricingFields = ["pricingMode", "basePrice", "minimumPrice", "maximumPrice", "roundingIncrement", "itemVariationPercent", "cycleVariationPercent", "gradeMultipliers", "tierMultipliers", "rarityMultipliers", "categoryBasePrices", "itemOverrides", "templatePrices"];
  const requestedPreset = String(value.pricingPreset || "").trim().toLowerCase();
  const pricingPreset = Object.prototype.hasOwnProperty.call(MARKET_PRICING_PRESETS, requestedPreset)
    ? requestedPreset
    : (legacyPricing || pricingFields.some((field) => Object.prototype.hasOwnProperty.call(value, field)) ? "custom" : "vanilla");
  const preset = MARKET_PRICING_PRESETS[pricingPreset] || DEFAULT_PRICING_CONFIG;
  const legacyPrice = integerInRange(value.price, preset.basePrice || DEFAULT_PRICING_CONFIG.basePrice, 1, MAX_MARKET_PRICE);
  const basePrice = integerInRange(value.basePrice, legacyPrice, 1, MAX_MARKET_PRICE);
  const minimumPrice = integerInRange(value.minimumPrice, DEFAULT_PRICING_CONFIG.minimumPrice, 1, MAX_MARKET_PRICE);
  const maximumCandidate = integerInRange(value.maximumPrice, DEFAULT_PRICING_CONFIG.maximumPrice, 1, MAX_MARKET_PRICE);
  if (minimumPrice > maximumCandidate) throw new Error("Minimum market price cannot exceed maximum market price.");
  const pricingMode = legacyPricing ? "fixed" : (["fixed", "dynamic"].includes(String(value.pricingMode || "").toLowerCase())
    ? String(value.pricingMode).toLowerCase()
    : "dynamic");
  return {
    pricingMode,
    pricingPreset,
    basePrice,
    dynamicPricingNeedsReview: legacyPricing || value.dynamicPricingNeedsReview === true,
    minimumPrice,
    maximumPrice: maximumCandidate,
    roundingIncrement: integerInRange(value.roundingIncrement, DEFAULT_PRICING_CONFIG.roundingIncrement, 1, MAX_MARKET_PRICE),
    itemVariationPercent: Math.max(0, Math.min(100, finiteNumber(value.itemVariationPercent, preset.itemVariationPercent ?? DEFAULT_PRICING_CONFIG.itemVariationPercent))),
    cycleVariationPercent: Math.max(0, Math.min(100, finiteNumber(value.cycleVariationPercent, preset.cycleVariationPercent ?? DEFAULT_PRICING_CONFIG.cycleVariationPercent))),
    gradeMultipliers: normalizeNumberMap(value.gradeMultipliers ?? preset.gradeMultipliers, { minimum: 0.01, maximum: 100 }),
    tierMultipliers: normalizeNumberMap(value.tierMultipliers ?? preset.tierMultipliers, { minimum: 0.01, maximum: 100 }),
    rarityMultipliers: normalizeNumberMap(value.rarityMultipliers ?? preset.rarityMultipliers, { minimum: 0.01, maximum: 100 }),
    categoryBasePrices: normalizeNumberMap(value.categoryBasePrices, { minimum: 1, maximum: MAX_MARKET_PRICE, integer: true }),
    itemOverrides: normalizeNumberMap(value.itemOverrides || value.templatePrices, { minimum: 1, maximum: MAX_MARKET_PRICE, integer: true, strictLabel: "Manual market price" })
  };
}

function titleCase(value) {
  return cleanKey(value).toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeGrade(value) {
  const raw = cleanKey(value);
  if (!raw || /^(unknown|n\/a|null|undefined)$/i.test(raw)) return "Unknown";
  if (/^\d+$/.test(raw)) return `Grade ${Number(raw)}`;
  const gradeNumber = raw.match(/^grade\s*(\d+)$/i);
  if (gradeNumber) return `Grade ${Number(gradeNumber[1])}`;
  const canonical = ["common", "uncommon", "rare", "epic", "legendary", "unique", "research", "recipe"];
  return canonical.includes(raw.toLowerCase()) ? titleCase(raw) : raw;
}

function normalizeTier(value) {
  const raw = cleanKey(value);
  if (!raw || /^(unknown|n\/a|null|undefined)$/i.test(raw)) return "Unknown";
  const match = raw.match(/^(?:tier|t)?\s*(\d+)$/i);
  return match ? `T${Number(match[1])}` : raw;
}

function normalizeRarity(value) {
  const raw = cleanKey(value);
  if (!raw || /^(unknown|n\/a|null|undefined)$/i.test(raw)) return "Unknown";
  const canonical = ["common", "uncommon", "rare", "epic", "legendary", "unique"];
  return canonical.includes(raw.toLowerCase()) ? titleCase(raw) : raw;
}

function normalizeCategory(value) {
  const raw = cleanKey(value);
  return raw && !/^(unknown|n\/a|null|undefined)$/i.test(raw) ? raw : "Unknown";
}

function normalizePricingMetadata(item = {}) {
  return {
    grade: normalizeGrade(item.grade ?? item.quality ?? item.itemGrade),
    tier: normalizeTier(item.tier ?? item.itemTier ?? item.level),
    rarity: normalizeRarity(item.rarity ?? item.itemRarity),
    category: normalizeCategory(item.category ?? item.type)
  };
}

function mapValue(map, key) {
  const wanted = normalizedLookupKey(key);
  for (const [candidate, value] of Object.entries(map || {})) {
    if (normalizedLookupKey(candidate) === wanted && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function deterministicUnit(seed) {
  const digest = crypto.createHash("sha256").update(String(seed), "utf8").digest();
  return digest.readUIntBE(0, 6) / 0xffffffffffff;
}

function variationFactor(seed, percent) {
  const boundedPercent = Math.max(0, Math.min(100, finiteNumber(percent, 0)));
  return 1 + ((deterministicUnit(seed) * 2) - 1) * (boundedPercent / 100);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundToTick(value, increment) {
  const tick = Math.max(1, integerInRange(increment, 1, 1, MAX_MARKET_PRICE));
  return Math.round(value / tick) * tick;
}

function calculateMarketPrice({ config = {}, item = {}, template, battlegroup = "", cycleId = "" } = {}) {
  const pricing = normalizePricingConfig(config);
  const itemId = cleanKey(template || item.id || item.template || item.templateId);
  if (!itemId) throw new Error("Market pricing requires a template identifier.");
  const metadata = normalizePricingMetadata(item);
  const manualOverride = mapValue(pricing.itemOverrides, itemId);
  const categoryBase = mapValue(pricing.categoryBasePrices, metadata.category);
  const selectedBase = manualOverride ?? categoryBase ?? pricing.basePrice;
  const baseSource = manualOverride !== undefined ? "manual-item-override" : (categoryBase !== undefined ? "category-base" : "global-base");
  const itemSeed = `${itemId}\u0000${metadata.grade}`;
  const cycleSeed = `${cleanKey(battlegroup) || "unknown-battlegroup"}\u0000${itemId}\u0000${metadata.grade}\u0000${cleanKey(cycleId) || "cycle-0"}`;
  const dynamic = pricing.pricingMode === "dynamic" && manualOverride === undefined;
  const itemFactor = dynamic ? variationFactor(itemSeed, pricing.itemVariationPercent) : 1;
  const cycleFactor = dynamic ? variationFactor(cycleSeed, pricing.cycleVariationPercent) : 1;
  const gradeFactor = dynamic ? (mapValue(pricing.gradeMultipliers, metadata.grade) ?? 1) : 1;
  const tierFactor = dynamic ? (mapValue(pricing.tierMultipliers, metadata.tier) ?? 1) : 1;
  const rarityFactor = dynamic ? (mapValue(pricing.rarityMultipliers, metadata.rarity) ?? 1) : 1;
  const calculatedPrice = selectedBase * itemFactor * gradeFactor * tierFactor * rarityFactor * cycleFactor;
  let finalPrice;
  if (manualOverride !== undefined) {
    finalPrice = Math.round(manualOverride);
  } else if (pricing.pricingMode === "fixed") {
    finalPrice = clamp(Math.round(selectedBase), pricing.minimumPrice, pricing.maximumPrice);
  } else {
    const bounded = clamp(calculatedPrice, pricing.minimumPrice, pricing.maximumPrice);
    finalPrice = clamp(roundToTick(bounded, pricing.roundingIncrement), pricing.minimumPrice, pricing.maximumPrice);
  }
  if (!Number.isSafeInteger(finalPrice) || finalPrice < 1 || finalPrice > MAX_MARKET_PRICE) {
    throw new Error("Calculated market price is not a valid database integer.");
  }
  return {
    template: itemId,
    pricingMode: pricing.pricingMode,
    basePrice: selectedBase,
    globalBasePrice: pricing.basePrice,
    baseSource,
    metadata,
    factors: {
      item: itemFactor,
      grade: gradeFactor,
      tier: tierFactor,
      rarity: rarityFactor,
      cycle: cycleFactor
    },
    variation: {
      itemPercent: pricing.itemVariationPercent,
      cyclePercent: pricing.cycleVariationPercent
    },
    seed: {
      item: itemSeed,
      cycle: cycleSeed,
      battlegroup: cleanKey(battlegroup) || "unknown-battlegroup",
      cycleId: cleanKey(cycleId) || "cycle-0"
    },
    calculatedPrice,
    finalPrice
  };
}

module.exports = {
  MAX_MARKET_PRICE,
  MARKET_PRICING_PRESETS,
  DEFAULT_PRICING_CONFIG,
  normalizePricingConfig,
  normalizePricingMetadata,
  deterministicUnit,
  variationFactor,
  roundToTick,
  calculateMarketPrice
};
