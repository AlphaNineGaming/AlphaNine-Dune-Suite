const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeConfig, normalizeCatalogTemplates, normalizeCatalogItems, createCycleId, createMarketAutomator } = require("../lib/market-automator");
const { MARKET_PRICING_PRESETS, normalizePricingConfig, calculateMarketPrice } = require("../lib/market-pricing");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.match(serverSource, /catalog:\s*\(\)\s*=>\s*gearCatalog\(\)/);
assert.match(serverSource, /item\.spawnable\s*!==\s*false/);
assert.match(serverSource, /!isTechKnowledgeItem\(item\)\s*&&\s*!isRecipeSchematicItem\(item\)/);
assert.match(serverSource, /Leave empty to rotate automatically through marketable items in the Suite catalog/);
assert.match(serverSource, /item_price[\s\S]*\$\{command\.price\}/);
assert.match(serverSource, /wear_normalized_price[\s\S]*\$\{command\.price\}/);
assert.match(serverSource, /pricing:\s*command\.pricing/);
assert.match(serverSource, /row\.price/);
assert.match(serverSource, /Dynamic item pricing is now available\. Review the pricing preview and enable it when ready\./);
assert.match(serverSource, /Generate Preview/);
assert.match(serverSource, /Advanced pricing settings/);
assert.match(serverSource, /Optional item price override/);
assert.match(serverSource, /\/api\/market-automator\/catalog-search/);

const normalized = normalizeConfig({
  enabled: true,
  targetNpcListings: 900,
  templates: "Item_A\nItem_B\nItem_A\nnot allowed?"
});
assert.strictEqual(normalized.targetNpcListings, 500);
assert.deepStrictEqual(normalized.templates, ["Item_A", "Item_B"]);
assert.deepStrictEqual(normalizeCatalogTemplates([{ id: "Auto_A" }, "Auto_B", { id: "Auto_A" }, "Auto_Item(1)+", "bad item?"]), ["Auto_A", "Auto_B", "Auto_Item(1)+"]);
assert.deepStrictEqual(normalizeCatalogItems([{ id: "Safe_A", grade: "Rare", price: 999, finalPrice: 888 }]), [{ id: "Safe_A", name: "Safe_A", grade: "Rare", quality: undefined, itemGrade: undefined, tier: undefined, itemTier: undefined, level: undefined, rarity: undefined, itemRarity: undefined, category: undefined, type: undefined }]);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-market-automator-"));
const published = [];
const purchased = [];
const service = createMarketAutomator({
  dataDir,
  inspect: async () => ({ ok: true, botListings: 1 }),
  list: async () => ({ listings: [{ orderId: 7, price: 10, stackSize: 2, isNpcOrder: false }] }),
  publish: async (payload) => { published.push(payload); return { ok: true }; },
  purchase: async (id) => { purchased.push(id); return { ok: true }; },
  catalog: async () => ["Catalog_A"]
});

service.save({
  enabled: false,
  targetNpcListings: 3,
  maxCreatesPerCycle: 2,
  templates: ["Item_A", "Item_B"],
  maxPlayerBuysPerCycle: 1,
  maxPlayerUnitPrice: 20,
  maxPlayerSpendPerCycle: 25,
  stackSize: 1,
  price: 100,
  quality: 0,
  expiryDays: 3
});

(async () => {
  const result = await service.run("all");
  assert.strictEqual(result.listing.created, 2);
  assert.strictEqual(result.buyer.purchased, 1);
  assert.deepStrictEqual(published.map((row) => row.template), ["Item_A", "Item_B"]);
  assert.deepStrictEqual(purchased, [7]);
  assert.ok(service.logs().text.includes("cycle completed"));

  const automaticPublished = [];
  const automaticService = createMarketAutomator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-market-automator-auto-")),
    inspect: async () => ({ ok: true, botListings: 0 }),
    list: async () => ({ listings: [] }),
    publish: async (payload) => { automaticPublished.push(payload); return { ok: true }; },
    purchase: async () => ({ ok: true }),
    catalog: async () => [{ id: "Auto_A" }, { id: "Auto_B" }, { id: "Auto_A" }, { id: "bad item?" }]
  });
  automaticService.save({ targetNpcListings: 3, maxCreatesPerCycle: 3, templates: [] });
  const automaticResult = await automaticService.run("list");
  assert.strictEqual(automaticResult.listing.created, 3);
  assert.strictEqual(automaticResult.listing.templateSource, "automatic-catalog");
  assert.deepStrictEqual(automaticPublished.map((row) => row.template), ["Auto_A", "Auto_B", "Auto_A"]);
  const automaticOverview = await automaticService.overview();
  assert.strictEqual(automaticOverview.status.templateMode, "automatic-catalog");
  assert.strictEqual(automaticOverview.status.availableTemplateCount, 2);
  automaticService.close();

  assert.deepStrictEqual(Object.keys(MARKET_PRICING_PRESETS), ["casual", "vanilla", "hardcore", "economy"]);
  const zeroConfigPreset = normalizePricingConfig({ pricingMode: "dynamic", pricingPreset: "vanilla" });
  assert.strictEqual(zeroConfigPreset.basePrice, 1000);
  assert.ok(Object.keys(zeroConfigPreset.gradeMultipliers).length > 0);
  const presetCommon = calculateMarketPrice({ config: zeroConfigPreset, item: { id: "Preset_Common", grade: "Common", tier: "T1", rarity: "Common" }, battlegroup: "preset", cycleId: "same" });
  const presetEpic = calculateMarketPrice({ config: zeroConfigPreset, item: { id: "Preset_Epic", grade: "Epic", tier: "T5", rarity: "Epic" }, battlegroup: "preset", cycleId: "same" });
  assert.ok(presetEpic.factors.grade > presetCommon.factors.grade);

  const catalogItemsForUx = Array.from({ length: 30 }, (_, index) => ({ id: `Catalog_${String(index).padStart(2, "0")}`, name: `Catalog Item ${index}`, grade: index % 2 ? "Rare" : "Common", tier: index % 3 ? "T3" : "T5", category: index % 2 ? "Weapons" : "Armor" }));
  const uxService = createMarketAutomator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-market-automator-ux-")),
    inspect: async () => ({ ok: true, botListings: 0 }), list: async () => ({ listings: [] }), publish: async () => ({ ok: true }), purchase: async () => ({ ok: true }),
    catalog: async () => catalogItemsForUx, battlegroup: () => "ux-bg"
  });
  const uxPreview = await uxService.pricingPreview({ config: { pricingMode: "dynamic", pricingPreset: "vanilla" }, sample: true, limit: 20, cycleId: "ux-preview" });
  assert.strictEqual(uxPreview.items.length, 20);
  assert.ok(uxPreview.items.every((row) => Number.isSafeInteger(row.pricing.finalPrice)));
  const searchResults = await uxService.catalogSearch({ query: "Item 12", limit: 20 });
  assert.deepStrictEqual(searchResults.items.map((item) => item.id), ["Catalog_12"]);
  uxService.close();

  const expectedDistinctPrices = [
    { template: "Item_A", price: 100 },
    { template: "Item_B", price: 275 },
    { template: "Item_C", price: 900 }
  ];
  const distinctPriceStages = {
    request: [],
    apiPayload: [],
    databaseParameters: [],
    displaySerialization: [],
    audit: []
  };
  const distinctPriceService = createMarketAutomator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-market-automator-distinct-prices-")),
    inspect: async () => ({ ok: true, botListings: 0 }),
    list: async () => ({ listings: [] }),
    publish: async (payload) => {
      const request = { template: payload.template, price: payload.price };
      distinctPriceStages.request.push({ ...request });
      distinctPriceStages.apiPayload.push({ ...request });
      distinctPriceStages.databaseParameters.push({
        template: payload.template,
        itemPrice: payload.price,
        wearNormalizedPrice: payload.price
      });
      distinctPriceStages.displaySerialization.push({ template: payload.template, price: Number(payload.price) });
      distinctPriceStages.audit.push(payload.pricing);
      return { ok: true };
    },
    purchase: async () => ({ ok: true }),
    catalog: async () => []
  });
  const requestedTemplatePrices = Object.fromEntries(expectedDistinctPrices.map((row) => [row.template, row.price]));
  distinctPriceService.save({
    targetNpcListings: 3,
    maxCreatesPerCycle: 3,
    templates: expectedDistinctPrices.map((row) => row.template),
    itemOverrides: requestedTemplatePrices
  });
  const savedDistinctConfig = distinctPriceService.getConfig();
  const savedDistinctPrices = savedDistinctConfig.templates.map((template) => ({
    template,
    price: savedDistinctConfig.itemOverrides[template]
  }));
  const distinctRun = await distinctPriceService.run("list", "test", { cycleId: "distinct-price-regression" });
  distinctPriceStages.planning = distinctRun.listing.planned.map((row) => ({ template: row.template, price: row.price }));
  const distinctPreview = await distinctPriceService.pricingPreview({ config: savedDistinctConfig, cycleId: "distinct-price-regression" });
  distinctPriceService.close();

  const expectedDatabaseParameters = expectedDistinctPrices.map((row) => ({
    template: row.template,
    itemPrice: row.price,
    wearNormalizedPrice: row.price
  }));
  const failures = [];
  for (const [stage, actual, expected] of [
    ["saved configuration", savedDistinctPrices, expectedDistinctPrices],
    ["cycle planning", distinctPriceStages.planning, expectedDistinctPrices],
    ["generated listing request", distinctPriceStages.request, expectedDistinctPrices],
    ["API payload", distinctPriceStages.apiPayload, expectedDistinctPrices],
    ["database parameters", distinctPriceStages.databaseParameters, expectedDatabaseParameters],
    ["display serialization", distinctPriceStages.displaySerialization, expectedDistinctPrices]
  ]) {
    try { assert.deepStrictEqual(actual, expected); }
    catch { failures.push(`${stage}: ${JSON.stringify(actual)}`); }
  }
  assert.deepStrictEqual(failures, [], `Distinct per-template prices were lost:\n${failures.join("\n")}`);
  assert.deepStrictEqual(distinctPreview.items.map((row) => ({ template: row.id, price: row.pricing.finalPrice })), expectedDistinctPrices);
  assert.deepStrictEqual(distinctPriceStages.audit.map((row) => row.finalPrice), [100, 275, 900]);
  assert.ok(distinctPriceStages.audit.every((row) => row.seed.cycleId === "distinct-price-regression"));

  const dynamicConfig = {
    pricingMode: "dynamic",
    basePrice: 100000,
    minimumPrice: 1,
    maximumPrice: 999999999,
    roundingIncrement: 1,
    itemVariationPercent: 15,
    cycleVariationPercent: 0
  };
  const dynamicA = calculateMarketPrice({ config: dynamicConfig, item: { id: "Dynamic_A", grade: "Rare" }, battlegroup: "bg", cycleId: "cycle-1" });
  const dynamicB = calculateMarketPrice({ config: dynamicConfig, item: { id: "Dynamic_B", grade: "Rare" }, battlegroup: "bg", cycleId: "cycle-1" });
  assert.notStrictEqual(dynamicA.factors.item, dynamicB.factors.item);
  assert.notStrictEqual(dynamicA.finalPrice, dynamicB.finalPrice);

  const lowMetadata = calculateMarketPrice({
    config: { ...dynamicConfig, itemVariationPercent: 0, gradeMultipliers: { Common: 1, Epic: 2 }, tierMultipliers: { T1: 1, T5: 3 } },
    item: { id: "Metadata_Low", grade: "Common", tier: "T1" }, battlegroup: "bg", cycleId: "same"
  });
  const highMetadata = calculateMarketPrice({
    config: { ...dynamicConfig, itemVariationPercent: 0, gradeMultipliers: { Common: 1, Epic: 2 }, tierMultipliers: { T1: 1, T5: 3 } },
    item: { id: "Metadata_High", grade: "Epic", tier: "T5" }, battlegroup: "bg", cycleId: "same"
  });
  assert.ok(highMetadata.finalPrice > lowMetadata.finalPrice);

  const manualExact = calculateMarketPrice({
    config: { ...dynamicConfig, minimumPrice: 500, roundingIncrement: 100, itemOverrides: { Manual_Item: 275 } },
    item: { id: "Manual_Item", grade: "Epic", tier: "T6", rarity: "Legendary" }, battlegroup: "bg", cycleId: "manual"
  });
  assert.strictEqual(manualExact.finalPrice, 275);
  assert.strictEqual(manualExact.baseSource, "manual-item-override");

  const repeatOne = calculateMarketPrice({ config: { ...dynamicConfig, cycleVariationPercent: 5 }, item: { id: "Repeat_Item", grade: "Rare" }, battlegroup: "bg", cycleId: "repeat" });
  const repeatTwo = calculateMarketPrice({ config: { ...dynamicConfig, cycleVariationPercent: 5 }, item: { id: "Repeat_Item", grade: "Rare" }, battlegroup: "bg", cycleId: "repeat" });
  assert.deepStrictEqual(repeatOne, repeatTwo);
  const nextCycle = calculateMarketPrice({ config: { ...dynamicConfig, itemVariationPercent: 0, cycleVariationPercent: 5 }, item: { id: "Repeat_Item", grade: "Rare" }, battlegroup: "bg", cycleId: "next" });
  const priorCycle = calculateMarketPrice({ config: { ...dynamicConfig, itemVariationPercent: 0, cycleVariationPercent: 5 }, item: { id: "Repeat_Item", grade: "Rare" }, battlegroup: "bg", cycleId: "prior" });
  assert.notStrictEqual(nextCycle.factors.cycle, priorCycle.factors.cycle);
  assert.ok(nextCycle.factors.cycle >= 0.95 && nextCycle.factors.cycle <= 1.05);
  assert.ok(priorCycle.factors.cycle >= 0.95 && priorCycle.factors.cycle <= 1.05);

  const neutralMetadata = calculateMarketPrice({ config: { ...dynamicConfig, itemVariationPercent: 0 }, item: { id: "Unknown_Metadata" }, battlegroup: "bg", cycleId: "neutral" });
  assert.strictEqual(neutralMetadata.metadata.grade, "Unknown");
  assert.strictEqual(neutralMetadata.factors.grade, 1);
  assert.strictEqual(neutralMetadata.factors.tier, 1);
  assert.strictEqual(neutralMetadata.factors.rarity, 1);

  const rounded = calculateMarketPrice({ config: { ...dynamicConfig, basePrice: 123, itemVariationPercent: 0, roundingIncrement: 25, minimumPrice: 100, maximumPrice: 1000 }, item: { id: "Rounded" } });
  const minimum = calculateMarketPrice({ config: { ...dynamicConfig, basePrice: 1, itemVariationPercent: 0, roundingIncrement: 25, minimumPrice: 100, maximumPrice: 1000 }, item: { id: "Minimum" } });
  const maximum = calculateMarketPrice({ config: { ...dynamicConfig, basePrice: 5000, itemVariationPercent: 0, roundingIncrement: 25, minimumPrice: 100, maximumPrice: 1000 }, item: { id: "Maximum" } });
  assert.strictEqual(rounded.finalPrice, 125);
  assert.strictEqual(minimum.finalPrice, 100);
  assert.strictEqual(maximum.finalPrice, 1000);
  assert.strictEqual(calculateMarketPrice({ config: { pricingMode: "fixed", basePrice: 1000, roundingIncrement: 25 }, item: { id: "Fixed" } }).finalPrice, 1000);
  const invalidInputs = calculateMarketPrice({
    config: { pricingMode: "dynamic", basePrice: Number.NaN, minimumPrice: -10, maximumPrice: Number.POSITIVE_INFINITY, roundingIncrement: 2.5, gradeMultipliers: { Rare: Number.POSITIVE_INFINITY } },
    item: { id: "Invalid_Item", grade: "Rare" }, battlegroup: "bg", cycleId: "invalid"
  });
  assert.ok(Number.isSafeInteger(invalidInputs.finalPrice));
  assert.ok(invalidInputs.finalPrice > 0);
  assert.strictEqual(invalidInputs.factors.grade, 1);
  for (const invalidOverride of [0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 1000000000]) {
    assert.throws(() => normalizePricingConfig({ itemOverrides: { Invalid_Item: invalidOverride } }), /Manual market price/);
  }
  assert.throws(() => normalizePricingConfig({ minimumPrice: 5000, maximumPrice: 1000 }), /Minimum market price cannot exceed maximum market price/);
  const definedCycleId = createCycleId(new Date("2026-07-21T12:34:56.789Z"), 7);
  assert.strictEqual(definedCycleId, "2026-07-21T12:34:56.789Z:7");

  const migrated = normalizePricingConfig({ price: 1000 });
  assert.strictEqual(migrated.pricingMode, "fixed");
  assert.strictEqual(migrated.basePrice, 1000);
  assert.strictEqual(migrated.dynamicPricingNeedsReview, true);
  async function verifyLegacyMigration(enabled) {
    const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), `alphanine-market-automator-migration-${enabled ? "enabled" : "disabled"}-`));
    fs.writeFileSync(path.join(migrationDir, "market-automator.json"), JSON.stringify({ enabled, price: 1000, targetNpcListings: 1, maxCreatesPerCycle: 1, templates: ["Legacy_Item"] }));
    const submitted = [];
    const migrationService = createMarketAutomator({
      dataDir: migrationDir,
      inspect: async () => ({ ok: true, botListings: 0 }),
      list: async () => ({ listings: [] }),
      publish: async (payload) => { submitted.push(payload); return { ok: true }; },
      purchase: async () => ({ ok: true }),
      catalog: async () => [],
      battlegroup: () => "migration-bg"
    });
    const migratedOnDisk = JSON.parse(fs.readFileSync(path.join(migrationDir, "market-automator.json"), "utf8"));
    assert.strictEqual(migratedOnDisk.enabled, enabled);
    assert.strictEqual(migratedOnDisk.pricingMode, "fixed");
    assert.strictEqual(migratedOnDisk.basePrice, 1000);
    assert.strictEqual(migratedOnDisk.dynamicPricingNeedsReview, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(migratedOnDisk, "price"));
    if (enabled) {
      const fixedResult = await migrationService.run("list", "test");
      assert.match(fixedResult.cycleId, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:\d+$/);
      assert.deepStrictEqual(submitted.map((row) => row.price), [1000]);
      assert.strictEqual(submitted[0].pricing.pricingMode, "fixed");
    }
    const dynamicCandidate = { ...migrationService.getConfig(), pricingMode: "dynamic" };
    assert.throws(() => migrationService.save(dynamicCandidate), /Review the dynamic pricing preview/);
    const preview = await migrationService.pricingPreview({ config: dynamicCandidate });
    assert.match(preview.cycleId, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:\d+$/);
    assert.ok(preview.dynamicPricingPreviewToken);
    const savedDynamic = migrationService.save({ ...dynamicCandidate, dynamicPricingPreviewToken: preview.dynamicPricingPreviewToken });
    assert.strictEqual(savedDynamic.pricingMode, "dynamic");
    assert.strictEqual(savedDynamic.dynamicPricingNeedsReview, false);
    migrationService.close();
  }
  await verifyLegacyMigration(true);
  await verifyLegacyMigration(false);

  const existingListing = { orderId: 500, template: "Existing_Item", price: 1000 };
  let listingReadCalled = false;
  const preservationService = createMarketAutomator({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-market-automator-existing-")),
    inspect: async () => ({ ok: true, botListings: 1 }),
    list: async () => { listingReadCalled = true; return { listings: [existingListing] }; },
    publish: async () => ({ ok: true }),
    purchase: async () => ({ ok: true }),
    catalog: async () => [{ id: "New_Item", grade: "Rare" }],
    battlegroup: () => "preservation-bg"
  });
  preservationService.save({ targetNpcListings: 2, maxCreatesPerCycle: 1, templates: ["New_Item"], pricingMode: "dynamic", basePrice: 1000 });
  await preservationService.run("list", "test", { cycleId: "preservation" });
  assert.strictEqual(listingReadCalled, false);
  assert.deepStrictEqual(existingListing, { orderId: 500, template: "Existing_Item", price: 1000 });
  preservationService.close();

  service.close();
  console.log("market automator tests passed");
})().catch((error) => {
  service.close();
  console.error(error);
  process.exitCode = 1;
});
