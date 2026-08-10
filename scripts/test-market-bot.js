"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { EXPECTED: OFFLINE_RECONCILIATION_EXPECTED } = require("../lib/market-bot-offline-reconciliation");
const {
  defaultMarketBotConfig,
  normalizeConfig,
  legacyMigration,
  createMarketBotStore,
  buildItemPolicies,
  pinnedCatalogPolicy,
  catalogPolicyFingerprint,
  marketCategoryMaskSeed,
  runtimeConfig,
  activationFingerprint,
  buildInstallCommand,
  buildPausedRuntimeDeploymentCommand,
  buildPausedRuntimeRollbackCleanupCommand,
  buildPausedRuntimeRollbackRestoreCommand,
  buildPausedConfigPublishCommand,
  buildMigrationStoppedEvidenceCommand,
  buildMigrationStopCommand,
  buildMigrationUninstallCommand,
  buildActionCommand,
  parseJsonOutput,
  csvForPreview,
  openRcSource
} = require("../lib/market-bot");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const goSource = fs.readFileSync(path.join(__dirname, "..", "market-bot", "main.go"), "utf8");
const runtimeBinary = fs.readFileSync(path.join(__dirname, "..", "assets", "market-bot", "linux-amd64", "alphanine-market-bot"));
assert.equal(
  crypto.createHash("sha256").update(runtimeBinary).digest("hex"),
  OFFLINE_RECONCILIATION_EXPECTED.runtimeBinarySha256,
  "bundled optional Market Bot runtime does not match its deliberate asset identity"
);

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
  assert.equal(config.pauseState, "Unknown");
  assert.equal(config.configGeneration, "0");
  assert.equal(config.pauseGeneration, "0");
  assert.equal(config.runtimeFingerprint, "");
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
  assert.match(runtime.configFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(activationFingerprint(runtime), activationFingerprint({ ...runtime, generatedAt: "later" }), "fingerprint must ignore volatile timestamps");
}

{
  const command = buildMigrationStoppedEvidenceCommand();
  assert(command.includes("rc-service alphanine-market-bot status"), "migration stopped-service evidence must inspect the real OpenRC service");
  assert(command.includes("/proc/[0-9]*") && command.includes('readlink -f "$process_dir/exe"') && command.includes("matching_process_count"), "migration stopped-service evidence must detect hidden matching processes independently of the PID file");
  assert(command.includes("supervise-daemon") && command.includes("restart_path_active"), "migration stopped-service evidence must detect supervisors and active restart paths");
  assert(command.includes('"version":3') && command.includes("service_installed") && command.includes("runtime_installed"), "migration infrastructure evidence must classify stopped and absent installations without policy metadata");
  assert(command.includes("/etc/runlevels/default/alphanine-market-bot") && command.includes("default_runlevel_registered"), "migration infrastructure evidence must reject a default-runlevel restart path");
  assert(!/pause_marker|cycle_lease|boot_identity|generation|fingerprint|catalog/i.test(command), "migration infrastructure evidence must not require Market Bot runtime policy");
  assert(!/rc-service alphanine-market-bot (?:start|stop|restart)|rc-update|kill|pkill/.test(command), "migration stopped-service evidence must remain read-only and never control the service");
  const stop = buildMigrationStopCommand();
  assert(stop.includes("rc-service alphanine-market-bot stop") && !/kill|pkill/.test(stop), "migration stop must use the normal OpenRC operation without force killing");
  const uninstall = buildMigrationUninstallCommand({ token: "1234567890abcdef1234567890abcdef" });
  assert(uninstall.includes("rc-update del alphanine-market-bot default"), "migration removal must unregister the OpenRC service");
  assert(uninstall.indexOf("rc-service alphanine-market-bot status") < uninstall.indexOf("rc-update del"), "service stopped proof must precede removal");
  assert(uninstall.includes("migration-remove-1234567890abcdef1234567890abcdef") && uninstall.includes("restore_market_bot"), "migration removal must stage restrictive rollback paths and restore them on failure");
}

{
  const binary = Buffer.alloc(20000, 9);
  const deploy = buildPausedRuntimeDeploymentCommand({
    binary,
    expectedPreviousSha256: "a".repeat(64),
    expectedPreviousSize: "19000",
    rollbackToken: "12345678-1234-1234-1234-123456789abc"
  });
  assert(deploy.includes("cleanup_paused_deploy") && deploy.includes("rollback-12345678"), "paused deployment must retain and automatically restore a restrictive rollback binary");
  assert(deploy.includes('mv -f "$next" "$binary"'), "paused deployment must publish atomically");
  assert(deploy.includes("sha256sum") && deploy.includes("wc -c"), "paused deployment must verify old, staged, and installed identities");
  assert(deploy.indexOf('install -o dune -g dune -m 0700 "$binary" "$rollback"') < deploy.indexOf('mv -f "$next" "$binary"'), "rollback must exist before publication");
  assert(deploy.includes("test -f '/home/dune/.dune/alphanine-market-bot/pause-requested'") && deploy.includes("test ! -e '/home/dune/.dune/alphanine-market-bot/cycle-running'"), "paused deployment must enforce pause and lease boundaries");
  const cleanup = buildPausedRuntimeRollbackCleanupCommand({ rollbackToken: "12345678-1234-1234-1234-123456789abc", expectedPreviousSha256: "a".repeat(64), expectedPreviousSize: "19000", expectedCurrentSha256: "b".repeat(64), expectedCurrentSize: "20000" });
  assert(cleanup.indexOf("sha256sum") < cleanup.indexOf("rm -f"), "rollback cleanup must verify both binaries before removal");
  const restore = buildPausedRuntimeRollbackRestoreCommand({ rollbackToken: "12345678-1234-1234-1234-123456789abc", expectedPreviousSha256: "a".repeat(64), expectedPreviousSize: "19000", expectedCurrentSha256: "b".repeat(64), expectedCurrentSize: "20000" });
  assert(restore.includes("rc-service alphanine-market-bot stop") && restore.includes("rc-service alphanine-market-bot start"), "rollback restore must bound service replacement");
  assert(restore.indexOf("sha256sum") < restore.indexOf("mv -f"), "rollback restore must verify exact identities before publication");
}

{
  const source = buildItemPolicies(catalog, normalizeConfig({ economyStyle: "Expensive" }), testCategorySeed)
    .map(({ sources, ...item }) => item);
  const policy = pinnedCatalogPolicy(source);
  assert.equal(policy.mode, "pinned");
  assert.equal(policy.itemCount, "3");
  assert.equal(policy.fingerprint, catalogPolicyFingerprint(source));
  const normalized = normalizeConfig({ catalogPolicy: policy });
  const target = { name: "abc", namespace: "funcom-seabass-abc", dbPod: "db-0", dbSvc: "db" };
  const runtime = runtimeConfig(normalized, target, [{ id: "new-local-item", name: "New", category: "Items" }], "1.2.3");
  assert.deepEqual(runtime.items, source, "a pinned remote policy must remain independent of the changing local catalog");
  assert.throws(() => normalizeConfig({ catalogPolicy: { ...policy, itemCount: "4" } }), /count or fingerprint/);
  assert.throws(() => pinnedCatalogPolicy([...source, { ...source[0] }]), /duplicate/);
  assert.throws(() => pinnedCatalogPolicy([{ ...source[0], unknown: true }]), /unknown fields/);
  assert.throws(() => pinnedCatalogPolicy([{ ...source[0], unitPrice: Number.MAX_SAFE_INTEGER + 1 }]), /exact integer/);
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
  const policy = pinnedCatalogPolicy(buildItemPolicies(catalog, normalizeConfig({}), testCategorySeed).map(({ sources, ...item }) => item));
  const target = { name: "abc", namespace: "funcom-seabass-abc", dbPod: "db-0", dbSvc: "db" };
  const config = runtimeConfig(normalizeConfig({
    schemaVersion: 2,
    enabled: true,
    activated: true,
    paused: true,
    pauseState: "Pause requested",
    configGeneration: "9007199254740994",
    pauseGeneration: "9007199254740994",
    catalogPolicy: policy
  }), target, [], "1.2.3");
  const command = buildPausedConfigPublishCommand({ config, expectedCurrentSha256: "a".repeat(64) });
  assert(command.includes("pause-requested") && command.includes("cycle-running"), "policy publication must require the durable pause boundary");
  assert(command.includes("sha256sum") && command.includes("remote_next=") && command.includes('mv -f "$remote_next"'), "policy publication must bind the old identity and publish atomically");
  assert(command.includes("ALPHANINE_MARKET_BOT_DIR=\"$staging_dir\""), "staged policy must pass the matching runtime self-test");
  assert(!command.includes("rc-service") && !/alphanine-market-bot' (?:migrate|resume|clean)(?:\s|$)/.test(command), "policy publication must not control services or data");
  assert.throws(() => buildPausedConfigPublishCommand({ config: { ...config, paused: false }, expectedCurrentSha256: "a".repeat(64) }), /Only a schema-current/);
  assert.throws(() => buildPausedConfigPublishCommand({ config, expectedCurrentSha256: "bad" }), /exact current remote/);
}

{
  const action = buildActionCommand("preview", { cycleId: "preview-123" });
  assert(action.includes("preview"));
  assert(action.includes("preview-123"));
  assert(buildActionCommand("clean").includes("'clean'"));
  assert(buildActionCommand("pause", { generation: "900719925474099312345" }).includes("900719925474099312345"));
  assert.throws(() => buildActionCommand("pause"), /generation/);
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
  assert(serverSource.includes('catalogSelection !== "preserve-remote"') && serverSource.includes("buildPinnedMarketBotCatalogPolicy(runtimeEvidence.config.items)"), "bootstrap reconciliation must require explicit remote-catalog preservation");
  assert(serverSource.includes("publishPinnedPausedMarketBotPolicy(before") && serverSource.includes("BigInt(generation) - 1n"), "bootstrap reconciliation must atomically publish a staged paused policy before the final Pause generation");
  assert(serverSource.includes('sshCommand("bash -s", 45000') && serverSource.includes("inputPath: publisherPath"), "large pinned policies must be streamed over SSH stdin rather than placed on the process command line");
  assert(serverSource.includes("configSha256Before") && serverSource.includes("configSha256After") && serverSource.includes("configBase64"), "remote policy evidence must bind one binary-safe capture between stable file hashes");
  assert(/const firstWriterText = await migrationSql\(target, ACTIVE_WRITERS_SQL\);\r?\n\s*const firstSampleResult = await migrationSql/.test(serverSource), "writer sampling must finish before the Suite opens its own semantic evidence session");
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
