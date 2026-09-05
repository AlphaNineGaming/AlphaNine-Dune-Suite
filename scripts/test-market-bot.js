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
  repairTargetMatches,
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

assert.equal(repairTargetMatches(
  { battlegroup: "sh-bc-test" },
  { name: "sh-bc-test", namespace: "funcom-seabass-sh-bc-test", dbPod: "db-0", dbSvc: "db-svc" }
), true, "repair target matching must accept the public remote config, which intentionally omits namespace");
assert.equal(repairTargetMatches(
  { battlegroup: "sh-bc-other" },
  { name: "sh-bc-test", namespace: "funcom-seabass-sh-bc-test", dbPod: "db-0", dbSvc: "db-svc" }
), false, "repair target matching must reject a different battlegroup");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.match(serverSource, /remoteFailure = parseMarketBotJson\(result\.stdout\)[\s\S]*remoteFailure\?\.ok === false/, "failed status probes must surface the bot's structured validation error instead of the raw SSH command");
const marketBotImport = serverSource.match(/const \{([\s\S]*?)\} = require\("\.\/lib\/market-bot"\);/)?.[1] || "";
assert(marketBotImport.includes("VM_MARKET_BOT_PAUSE_MARKER") && marketBotImport.includes("VM_MARKET_BOT_CYCLE_LEASE"), "repair boundary constants must be imported into the server runtime");
const goSource = fs.readFileSync(path.join(__dirname, "..", "market-bot", "main.go"), "utf8");
assert(goSource.includes(`exec.CommandContext(passwordContext, "timeout", "-k", "5", "20", "sudo", "-n", "kubectl"`), "database credential lookup must apply timeout outside the scoped sudo kubectl command");
assert(goSource.includes(`exec.CommandContext(plannerContext, "timeout", args...)`), "database planner timeout must wrap scoped sudo kubectl instead of running timeout as root");
assert(!goSource.includes(`exec.CommandContext(passwordContext, "sudo", "-n", "timeout"`), "Market Bot must not request passwordless sudo access to the timeout wrapper");
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
  assert.equal(config.exchangeName, "");
  assert.equal(config.economyStyle, "Expensive");
  assert.equal(config.listingCategory, "");
  assert.equal(config.playerBuying.enabled, false, "player buying must be opt-in");
  assert.equal(config.playerBuying.chancePercent, 50);
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
    exchangeName: "Arrakeen_EX",
    economyStyle: "Balanced",
    overrides: { Item_A: { enabled: false, unitPrice: 123, stackSize: 7, targetListings: 3 } }
  });
  const target = { name: "abc", namespace: "funcom-seabass-abc", dbPod: "db-0", dbSvc: "db" };
  const runtime = runtimeConfig(config, target, catalog, "1.2.3");
  const item = runtime.items.find((row) => row.id === "Item_A");
  assert.equal(runtime.exchangeName, "Arrakeen_EX", "the selected Exchange must survive normalization into the VM runtime config");
  assert.equal(item.enabled, false);
  assert.equal(item.unitPrice, 123);
  assert.equal(item.stackSize, 7);
  assert.equal(item.targetListings, 3);
  assert.equal(runtime.items.length, catalog.length, "runtime plan must never truncate the catalog");
  assert(!runtime.items.some((row) => Object.prototype.hasOwnProperty.call(row, "sources")), "runtime policy must exclude Suite-only pricing provenance");
  assert.match(runtime.configFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(activationFingerprint(runtime), activationFingerprint({ ...runtime, generatedAt: "later" }), "fingerprint must ignore volatile timestamps");
  assert.equal(
    activationFingerprint(runtime),
    activationFingerprint({ ...runtime, items: runtime.items.map((item) => ({ ...item, sources: { unitPrice: "Suite-only metadata" } })) }),
    "fingerprint must include only fields decoded by the Go runtime"
  );
}

{
  const runtime = {
    schemaVersion: 3,
    enabled: false,
    activated: false,
    battlegroup: "abc",
    namespace: "funcom-seabass-abc",
    dbPod: "db-0",
    dbService: "db",
    economyStyle: "Expensive",
    listingCategory: "",
    intervalMinutes: 30,
    expiryDays: 3,
    safety: { maxCreatesPerCycle: 25, maxMarketValuePerCycle: 25000000 },
    playerBuying: { enabled: false, chancePercent: 10, maxPurchasesPerCycle: 1, maxUnitPrice: 100000, maxSpendPerCycle: 100000 },
    items: [{
      id: "Item_1",
      name: "Salt & Pepper <Special>",
      category: "Items",
      tier: "Tier 1",
      enabled: true,
      unitPrice: 100,
      stackSize: 1,
      targetListings: 1,
      categoryMask: 1,
      categoryDepth: 1
    }]
  };
  assert.equal(activationFingerprint(runtime), "db5c3a29ec2127b194b491ee5f1aa858e7d33b487e0273544a4e91d2a9b1c783", "Suite fingerprint serialization must match Go encoding/json");
}

{
  const enabled = normalizeConfig({ playerBuying: { enabled: true, chancePercent: 35, maxPurchasesPerCycle: 4, maxUnitPrice: 25000, maxSpendPerCycle: 60000 } });
  assert.deepEqual(enabled.playerBuying, { enabled: true, chancePercent: 35, maxPurchasesPerCycle: 4, maxUnitPrice: 25000, maxSpendPerCycle: 60000 });
  assert.throws(() => normalizeConfig({ playerBuying: { chancePercent: 0 } }), /chance/);
  assert.throws(() => normalizeConfig({ playerBuying: { maxPurchasesPerCycle: 21 } }), /purchases/);
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
    schemaVersion: 3,
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
  assert(serverSource.includes("Legacy automated buying is disabled"), "unsafe Suite-side legacy buyer path is not disabled");
  assert(serverSource.includes('id="marketBotPlayerBuyingEnabled"') && serverSource.includes('"/api/market-bot/player-buying"'), "persistent bounded player buyer controls are missing");
  assert(serverSource.includes("if (status.installed && status.updateRequired) return installMarketBot(config);"), "installed paused Market Bots must receive versioned migrations during Suite startup");
  assert(serverSource.includes("Legacy arbitrary listing removal is disabled."), "arbitrary listing removal path is not disabled");
  assert(serverSource.includes('id="market" class="view"') && serverSource.includes("Persistent Market Bot"), "primary Market Bot UI is missing");
  assert(serverSource.includes("Category-verified catalog items") && serverSource.includes("Skipped (category metadata unavailable)"), "Market Bot UI must distinguish visible from skipped catalog items");
  assert(serverSource.includes('id="marketBotListingCategory"') && serverSource.includes('"/api/market-bot/category"'), "persistent listing category control is missing");
  assert(serverSource.includes('id="marketBotExchange"') && serverSource.includes('"/api/market-bot/exchanges"') && serverSource.includes('"/api/market-bot/exchange"'), "live Exchange selection and persistence controls are missing");
  assert(serverSource.includes("await setMarketBotPaused(true, { strictEvidence: true })") && serverSource.includes("existingListingsMoved: false"), "Exchange changes must pause safely and explicitly leave existing listings in place");
  const guidedExchangeWorkflow = serverSource.slice(serverSource.indexOf("async function updateMarketBotExchange"), serverSource.indexOf("async function restockMarketBot"));
  assert.match(guidedExchangeWorkflow, /before\.updateRequired[\s\S]*repairMarketBotRuntime\(\{ confirmed: true \}\)[\s\S]*setMarketBotPaused\(true, \{ strictEvidence: true \}\)[\s\S]*buildMarketBotActionCommand\("preview"[\s\S]*setMarketBotPaused\(false, \{ strictEvidence: true \}\)/, "guided Exchange switching must repair, pause, verify, and resume in one protected workflow");
  assert(serverSource.includes('id="marketBotExchangeChoices"') && serverSource.includes("chooseMarketBotExchange(this.dataset.exchange)") && serverSource.includes("Switch &amp; Run Selected Exchange"), "Arrakeen and HarkoVillage must expose a one-confirmation guided choice");
  assert(serverSource.includes("Arrakeen · start map first"), "unavailable Arrakeen must give one clear prerequisite instead of exposing a failing action");
  assert(serverSource.includes('operationRegistry.begin("market-bot:exchange"') && serverSource.includes('started: true, operation: startMarketBotExchangeSwitch(body)') && serverSource.includes("}, 202)"), "guided Exchange switching must run as a persistent background operation");
  assert(serverSource.includes('id="marketBotExchangeProgress"') && serverSource.includes('id="marketBotExchangeProgressFill"') && serverSource.includes('id="marketBotExchangeProgressLog"'), "Exchange switching must expose visible stage, percentage, and live log progress");
  assert(serverSource.includes('pollMarketBotExchangeOperation(data.operation.id)') && serverSource.includes('row.key==="market-bot:exchange"'), "Exchange progress must poll live operations and recover after refreshing the Market Bot view");
  for (const stage of ["Validating Exchange", "Repairing Market Bot", "Pausing and Draining", "Market Bot Quiescent", "Saving Exchange", "Verifying Market Preview", "Resuming Market Bot", "Exchange Ready"]) {
    assert(serverSource.includes(`report("${stage}"`), `guided Exchange progress is missing the ${stage} stage`);
  }
  assert(serverSource.includes("setMarketBotExchangeBusy(true)") && serverSource.includes('data-map-offline disabled'), "Exchange controls must stay locked while the Suite is busy without enabling an offline Arrakeen choice");
  assert(serverSource.includes("marketBotActivationPreviewFingerprint") && serverSource.includes('exchangeName: String(runtime.exchangeName || "")'), "activation confirmation must be bound to the selected Exchange");
  assert(serverSource.includes('id="marketBotRepairButton"') && serverSource.includes('"/api/market-bot/repair-runtime"'), "normal Market Bot UI must expose safe runtime repair");
  assert(serverSource.includes("if (!before.pauseProtocolCompatible)") && serverSource.includes("marketBotRepairBoundary(minimumGeneration, remoteFingerprint)"), "runtime repair must use only the compatible legacy pause protocol and an independent pause boundary");
  assert(serverSource.includes("VM_MARKET_BOT_PAUSE_MARKER") && serverSource.includes("VM_MARKET_BOT_CYCLE_LEASE") && serverSource.includes("pg_try_advisory_xact_lock"), "runtime repair must verify the pause marker, cycle lease, and Market Bot-specific database lock");
  assert(serverSource.includes("if (!repaired.quiescent || repaired.updateRequired || !repaired.generationMatch)"), "runtime repair must finish current, matching-generation, and Quiescent");
  assert(serverSource.includes("resumed: false"), "runtime repair must never resume the bot automatically");
  assert(/if \(paused !== true && !status\.quiescent\)[\s\S]{0,1400}status\.generationMatch === true[\s\S]{0,1400}marketBotRepairBoundary\(pauseGeneration, remoteFingerprint\)/.test(serverSource), "resume must independently prove the exact current pause boundary when a status refresh temporarily loses Quiescent");
  assert(serverSource.includes("Market Bot cannot resume because a fresh authoritative pause boundary could not be proven"), "resume must remain fail-closed when fresh pause evidence cannot be proved");
  assert(serverSource.includes("Market Bot is resumed and will retry automatically."), "a live resumed status must replace a stale resume rejection in the UI");
  assert(serverSource.includes('catalogSelection !== "preserve-remote"') && serverSource.includes("buildPinnedMarketBotCatalogPolicy(runtimeEvidence.config.items)"), "bootstrap reconciliation must require explicit remote-catalog preservation");
  assert(serverSource.includes("publishPinnedPausedMarketBotPolicy(before") && serverSource.includes("BigInt(generation) - 1n"), "bootstrap reconciliation must atomically publish a staged paused policy before the final Pause generation");
  assert(serverSource.includes('sshCommand("bash -s", 45000') && serverSource.includes("inputPath: publisherPath"), "large pinned policies must be streamed over SSH stdin rather than placed on the process command line");
  assert(serverSource.includes("configSha256Before") && serverSource.includes("configSha256After") && serverSource.includes("configBase64"), "remote policy evidence must bind one binary-safe capture between stable file hashes");
  assert(/const firstWriterText = await migrationSql\(target, ACTIVE_WRITERS_SQL\);\r?\n\s*const firstSampleResult = await migrationSql/.test(serverSource), "writer sampling must finish before the Suite opens its own semantic evidence session");
  assert(serverSource.includes("Clean Bot Market") && serverSource.includes('"/api/market-bot/clean"'), "tracked-only Market Bot cleanup control is missing");
  const cleanWorkflow = serverSource.slice(serverSource.indexOf("async function cleanMarketBot(input = {})"), serverSource.indexOf("async function updateMarketBotPlayerBuying"));
  assert.doesNotMatch(cleanWorkflow, /maintenanceCheckpoint|verifyMaintenanceCheckpointRemote|Migration Maintenance/, "normal Market Bot cleanup must not depend on the removed Migration Maintenance workflow");
  assert.match(cleanWorkflow, /marketBotStatus\(\{ strictEvidence: true \}\)[\s\S]*setMarketBotPaused\(true, \{ strictEvidence: true \}\)[\s\S]*status\.quiescent[\s\S]*status\.generationMatch[\s\S]*current\.paused !== true[\s\S]*buildMarketBotActionCommand\("clean"\)/, "Clean Bot must automatically pause when needed and prove authoritative Quiescent before deleting tracked listings");
  assert(serverSource.includes("if(cleanButton)cleanButton.disabled=!active;"), "Clean Bot must remain clickable while an activated running bot is available for automatic pause");
  assert(serverSource.includes('id="marketBotUninstallButton"') && serverSource.includes('"/api/market-bot/uninstall"'), "safe Market Bot uninstall control is missing");
  assert(/async function uninstallMarketBot\(input = \{\}\)[\s\S]*setMarketBotPaused\(true[\s\S]*buildMarketBotMigrationStopCommand\(\)[\s\S]*buildMarketBotMigrationUninstallCommand[\s\S]*requireAbsent: true[\s\S]*marketBotStore\.save/.test(serverSource), "Market Bot uninstall must prove Quiescent, stop, remove with rollback, prove absence, and only then deactivate local state");
  assert(!serverSource.includes("cleanMarketBot({ confirmed: true, maintenanceCheckpoint:"), "uninstall cleanup must not pass the removed Migration Maintenance checkpoint");
  assert(serverSource.includes("market_bot_paused_for_uninstall") && serverSource.includes("A compatible older runtime acknowledged the authoritative uninstall drain without being replaced."), "safe uninstall must drain a compatible older runtime without requiring a replacement build");
  assert(serverSource.includes("Choose what happens to active listings strictly tracked as Market Bot-owned") && serverSource.includes('body:JSON.stringify({confirmed:true,removeBotListings})'), "Market Bot uninstall must require an explicit keep-or-remove listing choice");
  assert(serverSource.includes('id="legacy-market" class="view hidden"'), "legacy market UI is not isolated");
  assert(goSource.includes("pg_try_advisory_xact_lock"), "database lock is missing");
  assert(!/func runtimeQuiescenceSQL[\s\S]*?pg_stat_activity[\s\S]*?func cleanupSQL/.test(goSource), "runtime quiescence must not be blocked by unrelated player/database writers");
  assert(goSource.includes("public.alphanine_market_bot_listings"), "strict ownership table is missing");
  assert(goSource.includes("class='Duke' and owner_account_id is null"), "Market Bot must use a native clean Duke actor");
  assert(goSource.includes("set owner_id=(select id from selected_duke)"), "tracked legacy Market Bot orders must migrate to the native actor");
  assert(goSource.includes("not exists(select 1 from prior_cycle)"), "cycle idempotency gate is missing");
  assert(goSource.includes("from dune.farm_variables"), "authoritative universe-clock source is missing");
  assert(!goSource.includes("down_time_accumulation"), "universe clock must not add the persisted downtime again");
  assert(goSource.includes("'farm-variables'"), "universe-clock diagnostics are missing");
  assert(!goSource.includes("inferred_now between d.database_now"), "game time must not be compared with Unix epoch time");
  assert(!goSource.includes("extract(epoch from clock_timestamp())"), "unavailable game time must not fall back to Unix time");
  assert(goSource.includes("else 'unavailable'"), "unavailable server-clock diagnostics are missing");
  assert(goSource.includes("Only verified player-owned active sell listings are eligible for opt-in random purchases."), "player buyer safety warning is missing");
  assert(goSource.includes("999999999,1.0,1.0,p.item_price,0,0,false"), "seller payout must use a non-expiring claim and per-unit item price");
  assert(!goSource.includes("p.item_price*p.stack_size,0,0,false"), "seller payout must not store total cost as a per-unit price");
  assert(goSource.includes("where id=(select id from bot_exchange_user)"), "player purchases must require the dedicated bot Exchange user debit path");
  assert(goSource.includes("p.category_mask,p.category_depth"), "listing inserts must use verified category metadata");
  assert(goSource.includes("o.category_mask>0 and o.category_depth>0"), "invisible listings must not count as active");
  assert(goSource.includes("o.category_mask<=0 or o.category_depth<=0"), "owned invisible listings must be repaired");
  assert(goSource.includes("partition by lower(e.category)") && goSource.includes("order by e.category_sequence,lower(e.category)"), "restock allocation must interleave deficient categories");
  assert(!goSource.includes("row_number() over(order by lower(e.category),lower(e.display_name)"), "alphabetical category starvation ordering must not return");
  assert(goSource.includes("'playerListingsChanged',0") && goSource.includes("join bot_actor b on b.id=o.owner_id"), "cleanup must report and enforce tracked bot ownership");
  assert(goSource.includes("dune.dune_exchange_accesspoints"), "access point must resolve from a live foreign-key row");
  assert(goSource.includes('exchange_name = " + sqlText(cfg.ExchangeName)'), "the VM bot must target the exact selected Exchange name");
  assert(!goSource.includes("),1)::bigint access_point_id"), "Market Bot must not invent access point id 1");
  assert(!/p\.template_id,1\.0,1\.0,0,0,p\.unit_price/.test(goSource), "Market Bot must not create zero-mask listings");
  assert(serverSource.includes("Restart-VM -Force"), "VM restart must be non-interactive");
  assert(goSource.includes("player_buying_enabled and (random()*100)<player_buy_chance"), "player listing purchases must remain behind the explicit random buyer gate");
}

console.log("Persistent Market Bot config, migration, pricebook, installer, and CSV tests passed.");
