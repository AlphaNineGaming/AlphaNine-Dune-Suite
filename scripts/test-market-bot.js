"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
  defaultMarketBotConfig,
  normalizeConfig,
  legacyMigration,
  createMarketBotStore,
  buildItemPolicies,
  marketCategoryMaskSeed,
  runtimeConfig,
  activationFingerprint,
  buildInstallCommand,
  buildActionCommand,
  parseJsonOutput,
  csvForPreview,
  openRcSource
} = require("../lib/market-bot");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const goSource = fs.readFileSync(path.join(__dirname, "..", "market-bot", "main.go"), "utf8");

const catalog = [
  { id: "Item_A", name: "Basic Material", category: "Items", tier: "T1", maxStack: 20 },
  { id: "Item_B", name: "Rare Knife", category: "Weapons", tier: "T4", grade: "Rare" },
  { id: "Item_C", name: "Unknown Thing", category: "Unknown", tier: "" }
];
const testCategorySeed = {
  item_a: { mask: 65536, depth: 2 },
  item_b: { mask: 131328, depth: 3 }
};

{
  const config = defaultMarketBotConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.paused, true);
  assert.equal(config.activated, false);
  assert.equal(config.economyStyle, "Expensive");
  assert.equal(config.listingCategory, "");
  const policies = buildItemPolicies(catalog, config, testCategorySeed);
  assert.equal(policies.length, 3);
  assert.equal(policies[0].targetListings, 1);
  assert.equal(policies.find((row) => row.id === "Item_A").stackSize, 20, "catalog stack maximum must win");
  assert.equal(policies.find((row) => row.id === "Item_C").unitPrice, 1000, "unknown category must use a conservative market baseline");
  assert.deepEqual(
    [policies.find((row) => row.id === "Item_A").categoryMask, policies.find((row) => row.id === "Item_A").categoryDepth],
    [65536, 2],
    "verified category metadata must be attached case-insensitively"
  );
  assert.equal(policies.find((row) => row.id === "Item_C").categoryMask, 0, "unknown category metadata must fail closed");
}

{
  const expensive = buildItemPolicies(catalog, normalizeConfig({ economyStyle: "Expensive" }));
  const affordable = buildItemPolicies(catalog, normalizeConfig({ economyStyle: "Affordable" }));
  assert(affordable.find((row) => row.id === "Item_B").unitPrice < expensive.find((row) => row.id === "Item_B").unitPrice);
}

{
  const policies = buildItemPolicies(catalog, normalizeConfig({ listingCategory: "Weapons" }), testCategorySeed);
  assert.equal(policies.find((row) => row.id === "Item_B").enabled, true);
  assert.equal(policies.find((row) => row.id === "Item_A").enabled, false);
  assert.equal(policies.find((row) => row.id === "Item_C").enabled, false);
}

{
  const seed = marketCategoryMaskSeed();
  assert(Object.keys(seed).length > 1000, "bundled category seed is unexpectedly incomplete");
  assert(seed.social_atre_casual03_shoes?.mask > 0, "Arrakeen garment metadata is missing");
  assert(seed.radiation_suit?.depth > 0, "known suit metadata is missing");
}

{
  const migrated = legacyMigration({
    version: 2,
    enabled: true,
    pricingMode: "fixed",
    basePrice: 75,
    stackSize: 4,
    templates: ["Item_A"],
    itemOverrides: { Item_B: 900 }
  });
  assert.equal(migrated.migration.detected, true);
  assert.equal(migrated.migration.snapshot.enabled, true);
  assert.equal(migrated.overrides.Item_A.unitPrice, 75);
  assert.equal(migrated.overrides.Item_A.stackSize, 4);
  assert.equal(migrated.overrides.Item_B.unitPrice, 900);
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-market-bot-store-"));
  try {
    fs.writeFileSync(path.join(scratch, "market-automator.json"), JSON.stringify({
      version: 1,
      enabled: true,
      templates: [{ template: "Item_A", price: 55 }]
    }));
    const store = createMarketBotStore({ dataDir: scratch });
    const config = store.load();
    assert.equal(config.activated, false, "legacy migration must never auto-activate");
    assert.equal(config.overrides.Item_A.unitPrice, 55);
    store.save(config);
    store.disableLegacy(config);
    const legacy = JSON.parse(fs.readFileSync(path.join(scratch, "market-automator.json"), "utf8"));
    assert.equal(legacy.enabled, false, "new bot activation must disable legacy");
    const restored = store.restoreLegacy(config);
    assert.equal(restored.enabled, false, "rollback must restore legacy disabled for review");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const config = normalizeConfig({
    economyStyle: "Balanced",
    overrides: { Item_A: { enabled: false, unitPrice: 123, stackSize: 7, targetListings: 3 } }
  });
  const target = { name: "abc", namespace: "funcom-seabass-abc", dbPod: "db-0", dbSvc: "db" };
  const runtime = runtimeConfig(config, target, catalog, "1.2.3");
  const item = runtime.items.find((row) => row.id === "Item_A");
  assert.equal(item.enabled, false);
  assert.equal(item.unitPrice, 123);
  assert.equal(item.stackSize, 7);
  assert.equal(item.targetListings, 3);
  assert.equal(runtime.items.length, catalog.length, "runtime plan must never truncate the catalog");
  assert.equal(activationFingerprint(runtime), activationFingerprint({ ...runtime, generatedAt: "later" }), "fingerprint must ignore volatile timestamps");
}

{
  const fakeBinary = Buffer.alloc(20000, 7);
  const command = buildInstallCommand({
    config: {
      schemaVersion: 1,
      battlegroup: "abc",
      namespace: "funcom-seabass-abc",
      dbPod: "db-0",
      dbService: "db",
      items: []
    },
    binary: fakeBinary,
    appVersion: "test"
  });
  const payload = command.match(/printf %s '([^']+)' \| base64 -d \| gzip -d > \/tmp\/alphanine-market-bot/)?.[1];
  assert(payload, "installer must embed the Linux binary payload");
  assert.deepEqual(zlib.gunzipSync(Buffer.from(payload, "base64")), fakeBinary);
  assert(command.includes("rc-update add alphanine-market-bot default"));
  assert(command.includes("' migrate"));
  assert(command.includes('readlink -f "/proc/$market_bot_pid/exe"'), "installer must verify the recorded PID before stopping it");
  assert(command.includes("alphanine-market-bot (deleted)"), "installer must recognize the managed executable after an interrupted in-place upgrade");
  assert(command.includes("timeout -k 2 12 rc-service alphanine-market-bot stop"), "installer stop must be bounded");
  assert(command.includes('market_bot_kill_tree "$market_bot_pid"'), "installer must recover a hung prior Market Bot process tree");
  assert(!command.includes("pkill -f"), "installer must not use an unscoped process-name kill");
  assert(openRcSource().includes('command_args="daemon"'));
}

{
  const action = buildActionCommand("preview", { cycleId: "preview-123" });
  assert(action.includes("preview"));
  assert(action.includes("preview-123"));
  assert(buildActionCommand("clean").includes("'clean'"));
  assert.throws(() => buildActionCommand("remove-player-listing"));
  assert.deepEqual(parseJsonOutput("diagnostic\n{\"ok\":true}\n"), { ok: true });
}

{
  const csv = csvForPreview({
    categories: [{ category: "Items", items: 1, activeListings: 0, targetListings: 1, deficit: 1, createNow: 1, plannedValue: 20 }],
    items: [{
      id: "Item_A", name: "A, Item", category: "Items", unitPrice: 10, stackSize: 2,
      targetListings: 1, activeListings: 0, deficit: 1, createNow: 1, plannedValue: 20
    }]
  });
  assert(csv.includes('"A, Item"'));
  assert(csv.includes('"Planned Value"'));
  assert(csv.includes('"Category","Items","Active Listings"'));
}

{
  assert(serverSource.includes('"/api/market-bot/prepare"'), "staged activation API is missing");
  assert(serverSource.includes("Legacy Market Automator is locked while persistent Market Bot is activated."), "legacy/new concurrency guard is missing");
  assert(serverSource.includes("delegated-to-market-bot"), "unsafe Suite-side cleanup was not disabled");
  assert(serverSource.includes("Legacy automated buying is disabled because Market Bot never modifies player listings."), "player-listing buyer path is not disabled");
  assert(serverSource.includes("if (status.installed && status.updateRequired) return installMarketBot(config);"), "installed paused Market Bots must receive versioned migrations during Suite startup");
  assert(serverSource.includes("Legacy arbitrary listing removal is disabled."), "arbitrary listing removal path is not disabled");
  assert(serverSource.includes('id="market" class="view"') && serverSource.includes("Persistent Market Bot"), "primary Market Bot UI is missing");
  assert(serverSource.includes("Category-verified catalog items") && serverSource.includes("Skipped (category metadata unavailable)"), "Market Bot UI must distinguish visible from skipped catalog items");
  assert(serverSource.includes('id="marketBotListingCategory"') && serverSource.includes('"/api/market-bot/category"'), "persistent listing category control is missing");
  assert(serverSource.includes("Clean Bot Market") && serverSource.includes('"/api/market-bot/clean"'), "tracked-only Market Bot cleanup control is missing");
  assert(serverSource.includes('id="legacy-market" class="view hidden"'), "legacy market UI is not isolated");
  assert(goSource.includes("pg_try_advisory_xact_lock"), "database lock is missing");
  assert(goSource.includes("public.alphanine_market_bot_listings"), "strict ownership table is missing");
  assert(goSource.includes("class='Duke' and owner_account_id is null"), "Market Bot must use a native clean Duke actor");
  assert(goSource.includes("set owner_id=(select id from selected_duke)"), "tracked legacy Market Bot orders must migrate to the native actor");
  assert(goSource.includes("not exists(select 1 from prior_cycle)"), "cycle idempotency gate is missing");
  assert(goSource.includes("extract(epoch from clock_timestamp())"), "database-clock fallback is missing");
  assert(goSource.includes("Player listings are never changed."), "planner safety warning is missing");
  assert(goSource.includes("p.category_mask,p.category_depth"), "listing inserts must use verified category metadata");
  assert(goSource.includes("o.category_mask>0 and o.category_depth>0"), "invisible listings must not count as active");
  assert(goSource.includes("o.category_mask<=0 or o.category_depth<=0"), "owned invisible listings must be repaired");
  assert(goSource.includes("partition by lower(e.category)") && goSource.includes("order by e.category_sequence,lower(e.category)"), "restock allocation must interleave deficient categories");
  assert(!goSource.includes("row_number() over(order by lower(e.category),lower(e.display_name)"), "alphabetical category starvation ordering must not return");
  assert(goSource.includes("'playerListingsChanged',0") && goSource.includes("join bot_actor b on b.id=o.owner_id"), "cleanup must report and enforce tracked bot ownership");
  assert(goSource.includes("dune.dune_exchange_accesspoints"), "access point must resolve from a live foreign-key row");
  assert(!goSource.includes("),1)::bigint access_point_id"), "Market Bot must not invent access point id 1");
  assert(!/p\.template_id,1\.0,1\.0,0,0,p\.unit_price/.test(goSource), "Market Bot must not create zero-mask listings");
  assert(serverSource.includes("Restart-VM -Force"), "VM restart must be non-interactive");
  assert(!/delete from dune\.[^\n]+\n[\s\S]{0,300}is_npc_order=false/i.test(goSource), "Market Bot contains a player-listing delete path");
}

console.log("Persistent Market Bot config, migration, pricebook, installer, and CSV tests passed.");
