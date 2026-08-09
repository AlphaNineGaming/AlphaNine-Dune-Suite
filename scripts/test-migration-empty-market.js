"use strict";

const assert = require("assert/strict");
const {
  CONFIRMATION,
  DIAGNOSTIC_KEYS,
  aggregateFixtureClassifications,
  buildCleanupSql,
  buildPortableEvidenceSql,
  buildPreviewSql,
  migrationMarketIsEmpty,
  runEmptyMarket,
  validatePreview,
  verifyPostCleanup
} = require("../lib/migration-empty-market");

const emptyDigest = "a".repeat(64);
function preview(overrides = {}) {
  const counts = {
    botListings: "775", playerListings: "0", legacyNpcListings: "40", unknownNpcListings: "0", pendingSettlements: "0",
    completedHistory: "1", invalidRelationships: "0", activeTracking: "775", totalTracking: "1675", retiredTracking: "900",
    ...(overrides.counts || {})
  };
  const digests = {
    botListings: "b".repeat(64), playerListings: emptyDigest, legacyNpcListings: "c".repeat(64), unknownNpcListings: emptyDigest,
    pendingSettlements: emptyDigest, completedHistory: "d".repeat(64), protectedUnselected: "e".repeat(64), selected: "f".repeat(64),
    ...(overrides.digests || {})
  };
  const diagnostics = {
    ...Object.fromEntries(DIAGNOSTIC_KEYS.map((key) => [key, "0"])),
    ...(overrides.diagnostics || {})
  };
  diagnostics.totalInvalid = counts.invalidRelationships;
  return { version: 2, counts, digests, diagnostics };
}

function safety() {
  return {
    offlineMode: { active: true, failClosed: false },
    battlegroup: { stopped: true, controllersSuspended: true, runningGameWorkloads: "0" },
    marketBot: { state: "Service stopped", authoritative: true, serviceInstalled: true, runtimeInstalled: true, pidPresent: false, matchingProcesses: "0", supervisorProcesses: "0", defaultRunlevelRegistered: false, restartPathActive: false },
    database: { postgresqlHealthy: true, unexpectedWriters: "0", openTransactions: "0" },
    conflictingOperations: false
  };
}

function stoppedInfrastructure() {
  return { state: "Service stopped", authoritative: true, serviceInstalled: true, runtimeInstalled: true, pidPresent: false, matchingProcesses: "0", supervisorProcesses: "0", defaultRunlevelRegistered: false, restartPathActive: false };
}

function absentInfrastructure() {
  return { state: "Service absent", authoritative: true, serviceInstalled: false, runtimeInstalled: false, pidPresent: false, matchingProcesses: "0", supervisorProcesses: "0", defaultRunlevelRegistered: false, restartPathActive: false };
}

function backup() {
  return {
    verified: true, usableForRestore: true, archiveReadVerified: true, completeDune: true,
    size: "9007199254740993", sha256: "1".repeat(64),
    alphaTables: ["alphanine_market_bot_audit", "alphanine_market_bot_cycle_evidence", "alphanine_market_bot_cycles", "alphanine_market_bot_listings"]
  };
}

function testSqlBoundaries() {
  const previewSql = buildPreviewSql({ deleteBotListings: true, deletePlayerListings: true, deleteLegacyNpcListings: true });
  for (const required of [
    "public.alphanine_market_bot_listings", "dune.dune_exchange_orders", "dune.dune_exchange_sell_orders",
    "dune.dune_exchange_fulfilled_orders", "dune.items", "dune.dune_exchanges", "dune.inventories",
    "dune.dune_exchange_accesspoints", "dune.dune_exchange_users", "dune.player_state", "dune.accounts", "owner_account_record_id=owner_account_id",
    "inventory_id=exchange_inventory_id", "item_template_id=template_id", "item_order_references=1",
    "expected_bot_owner", "AlphaNineMarket", "exchange_user_count=1", "has_player_state_link=false",
    "completed-history", "pending-settlement", "legacy-npc", "other-npc", "diagnostics", "::text"
  ]) assert(previewSql.includes(required), `preview SQL is missing ${required}`);
  assert.match(previewSql, /t\.order_id=o\.id[\s\S]*t\.item_id=o\.item_id[\s\S]*t\.template_id=o\.template_id/, "bot ownership must match the exact tracked order, item, and template");
  assert.doesNotMatch(previewSql, /inventory_id IS NULL/, "listed items must be proven in Exchange custody, not incorrectly required to be detached");
  assert.doesNotMatch(previewSql, /clock_timestamp|current_timestamp|\bnow\s*\(|ctid|xmin|pg_stat|reltuples|relpages/i, "preview digests must be stable and persisted-only");

  const all = { deleteBotListings: true, deletePlayerListings: true, deleteLegacyNpcListings: true };
  const before = validatePreview(preview(), all);
  const sql = buildCleanupSql(all, before);
  assert.match(sql, /^BEGIN;/);
  for (const locked of ["dune.dune_exchange_orders", "dune.dune_exchange_sell_orders", "dune.dune_exchange_fulfilled_orders", "dune.dune_exchanges", "dune.dune_exchange_accesspoints", "dune.inventories", "dune.items", "dune.actors", "dune.accounts", "public.alphanine_market_bot_listings", "public.alphanine_market_bot_audit"]) {
    assert(sql.includes(locked), `cleanup lock boundary is missing ${locked}`);
  }
  assert.match(sql, /IN SHARE ROW EXCLUSIVE MODE/);
  assert(sql.indexOf("LOCK TABLE") < sql.indexOf("CREATE TEMP TABLE a9_empty_market_targets"));
  assert(sql.indexOf("selected_digest") < sql.indexOf("DELETE FROM dune.dune_exchange_sell_orders"));
  assert.match(sql, /DELETE FROM dune\.dune_exchange_sell_orders/);
  assert.match(sql, /DELETE FROM dune\.dune_exchange_orders/);
  assert.match(sql, /DELETE FROM dune\.items i[\s\S]*i\.inventory_id=t\.inventory_id/);
  assert.match(sql, /UPDATE public\.alphanine_market_bot_listings m SET retired_at=clock_timestamp\(\)/);
  assert.doesNotMatch(sql, /DELETE FROM (?:dune\.)?(?:accounts|actors|inventories|building|vehicles|player_|guild|dune_exchange_fulfilled_orders)/i);
  assert.match(sql, /a9_empty_market_history_baseline[\s\S]*a9_empty_market_write_result[\s\S]*a9_verify[\s\S]*classification='active'[\s\S]*classification='pending-settlement'[\s\S]*classification='invalid'[\s\S]*fulfilled-history assertion failed[\s\S]*COMMIT;/);
  assert.match(sql, /expectedSelected=%s actualOrders=%s actualSellRows=%s actualCustodyItems=%s expectedRetired=%s actualRetired=%s residualBot=%s residualPlayer=%s residualLegacy=%s residualUnknown=%s active=%s pending=%s invalid=%s expectedHistoryCount=%s actualHistoryCount=%s expectedHistoryDigest=%s actualHistoryDigest=%s/);
  assert(sql.indexOf("a9_verify") < sql.lastIndexOf("COMMIT;"), "zero-market and fulfilled-history verification must run before commit");
  assert(sql.indexOf("a9_empty_market_history_baseline") < sql.indexOf("DELETE FROM dune.dune_exchange_sell_orders"), "fulfilled history must be baselined with the same portable canonicalizer before deletion");
  assert(sql.indexOf("fulfilled-history assertion failed") < sql.indexOf("SELECT jsonb_build_object('committed',true"), "write evidence must be returned only after every in-transaction assertion passes");
  assert(sql.trim().endsWith("COMMIT;"));

  const portableSql = buildPortableEvidenceSql();
  assert.match(portableSql, /dune\.dune_exchange_fulfilled_orders/);
  assert.match(portableSql, /inventory_id=exchange_inventory_id/);
  assert.doesNotMatch(portableSql, /inventory_id IS NULL/);
  assert.match(portableSql, /'activeListings'/);
  assert.match(portableSql, /'pendingSettlements'/);
  assert.match(portableSql, /'invalidRelationships'/);
  assert.doesNotMatch(portableSql, /public\.alphanine_market_bot_/i, "destination verification must not require Market Bot tables");
  assert.doesNotMatch(portableSql, /DELETE|UPDATE|INSERT|clock_timestamp|current_timestamp|\bnow\s*\(/i, "destination evidence must be stable and read-only");
}

function productionSellFixture(kind, index) {
  const orderId = String(9007199254741000n + BigInt(index));
  const itemId = String(9107199254741000n + BigInt(index));
  const exchangeId = "501";
  const inventoryId = "601";
  const accessPointId = "701";
  const templateId = `template_${index % 29}`;
  const npc = kind === "bot" || kind === "legacy";
  const expectedBotOwnerId = "801";
  const ownerId = kind === "bot" ? expectedBotOwnerId : String(10000 + index);
  return {
    order: { id: orderId, itemId, templateId, exchangeId, accessPointId, isNpcOrder: npc, ownerId },
    sell: { orderId },
    item: { id: itemId, inventoryId, templateId },
    exchange: { id: exchangeId, inventoryId },
    inventory: { id: inventoryId, exchangeId },
    accessPoint: { id: accessPointId, exchangeId },
    owner: kind === "bot"
      ? { id: expectedBotOwnerId, class: "Duke", ownerAccountId: null, accountExists: false, exchangeUserCount: "1", ownerIdIsAccount: false, playerOwnershipLink: false }
      : kind === "legacy"
        ? { id: ownerId, class: "AlphaNineMarket", ownerAccountId: null, accountExists: false, exchangeUserCount: "1", ownerIdIsAccount: false, playerOwnershipLink: false }
        : { id: ownerId, class: "Player", ownerAccountId: String(20000 + index), accountExists: true, exchangeUserCount: "1", ownerIdIsAccount: false, playerOwnershipLink: true },
    expectedBotOwnerId,
    tracking: kind === "bot" ? [{ orderId, itemId, templateId, active: true }] : [],
    fulfillments: [],
    itemOrderReferences: "1"
  };
}

function completedPaymentFixture() {
  return {
    order: { id: "9999999999999999", itemId: null, templateId: "payment", exchangeId: "501", accessPointId: "701", isNpcOrder: false, ownerId: "901" },
    sell: null, item: null, exchange: null, inventory: null, accessPoint: null,
    owner: { id: "901", class: "Player", ownerAccountId: "902", accountExists: true },
    expectedBotOwnerId: "801", tracking: [], itemOrderReferences: "0",
    fulfillments: [{ completionType: 2, originalOrderId: "9999999999999998", sourceOrderId: null }]
  };
}

function testProductionShapedClassifier() {
  const records = [];
  for (let index = 0; index < 775; index++) records.push(productionSellFixture("bot", index));
  for (let index = 0; index < 40; index++) records.push(productionSellFixture("legacy", 1000 + index));
  records.push(completedPaymentFixture());
  const result = aggregateFixtureClassifications(records);
  assert.deepEqual(result.counts, {
    bot: 775, player: 0, "legacy-npc": 40, "other-npc": 0, "pending-settlement": 0, "completed-history": 1, invalid: 0
  });
  assert.equal(result.diagnostics.totalInvalid, 0);
  assert.equal(Object.values(result.diagnostics).reduce((sum, value) => sum + value, 0), 0);

  const rolledBackProductionShape = [];
  for (let index = 0; index < 775; index++) rolledBackProductionShape.push(productionSellFixture("bot", index));
  rolledBackProductionShape.push(completedPaymentFixture());
  assert.deepEqual(aggregateFixtureClassifications(rolledBackProductionShape).counts, {
    bot: 775, player: 0, "legacy-npc": 0, "other-npc": 0, "pending-settlement": 0, "completed-history": 1, invalid: 0
  }, "the exact rolled-back production shape must remain a valid cleanup boundary");
  const rolledBackPreview = preview({
    counts: { legacyNpcListings: "0" },
    digests: { legacyNpcListings: emptyDigest }
  });
  const rolledBackSql = buildCleanupSql({ deleteBotListings: true, deletePlayerListings: false, deleteLegacyNpcListings: false }, rolledBackPreview);
  assert(rolledBackSql.includes("expected_selected := '775'"));
  assert(rolledBackSql.includes("expected_retired := '775'"));
  assert(!rolledBackSql.includes(`actual_history_digest <> '${rolledBackPreview.digests.completedHistory}'`), "portable fulfilled history must not be compared with the differently canonicalized ownership preview digest");

  const custodyMismatch = productionSellFixture("player", 2001);
  custodyMismatch.item = { ...custodyMismatch.item, inventoryId: "different-inventory" };
  const dangling = productionSellFixture("player", 2002);
  dangling.item = null;
  const templateMismatch = productionSellFixture("bot", 2003);
  templateMismatch.item = { ...templateMismatch.item, templateId: "wrong-template" };
  const trackedPlayer = productionSellFixture("player", 2004);
  trackedPlayer.tracking = [{ orderId: trackedPlayer.order.id, itemId: trackedPlayer.order.itemId, templateId: trackedPlayer.order.templateId, active: false }];
  const wrongBotOwner = productionSellFixture("bot", 2005);
  wrongBotOwner.owner = { id: "not-the-runtime-owner", class: "Duke", ownerAccountId: null, accountExists: false };
  const ambiguousReference = productionSellFixture("player", 2006);
  ambiguousReference.itemOrderReferences = "2";
  const fulfillmentConflict = productionSellFixture("player", 2007);
  fulfillmentConflict.fulfillments = [{ completionType: 1, originalOrderId: "1", sourceOrderId: null }];
  const invalid = aggregateFixtureClassifications([
    custodyMismatch, dangling, templateMismatch, trackedPlayer, wrongBotOwner, ambiguousReference, fulfillmentConflict
  ]);
  assert.equal(invalid.counts.invalid, 7);
  for (const reason of ["exchangeCustodyMismatch", "missingItem", "itemTemplateMismatch", "playerTrackingHistory", "botOwnerMismatch", "itemReferenceAmbiguous", "fulfillmentConflict"]) {
    assert(invalid.diagnostics[reason] > 0, `expected sanitized ${reason} diagnostic`);
  }

  const unknownNpc = productionSellFixture("bot", 2008);
  unknownNpc.tracking = [];
  unknownNpc.owner = { id: "another-npc", class: "Trader", ownerAccountId: null, accountExists: false };
  const unknown = aggregateFixtureClassifications([unknownNpc]);
  assert.equal(unknown.counts["other-npc"], 1, "untracked NPC listings remain separately visible and fail closed");

  const legacyBoundaryFailures = [
    ["wrong actor type", (row) => { row.owner.class = "Trader"; }],
    ["missing Exchange-user registration", (row) => { row.owner.exchangeUserCount = "0"; }],
    ["ambiguous Exchange-user registration", (row) => { row.owner.exchangeUserCount = "2"; }],
    ["account identity", (row) => { row.owner.ownerIdIsAccount = true; }],
    ["player-state/controller/pawn identity", (row) => { row.owner.playerOwnershipLink = true; }],
    ["direct player account", (row) => { row.owner.ownerAccountId = "42"; }],
    ["historical Market Bot tracking", (row) => { row.tracking = [{ orderId: row.order.id, itemId: row.order.itemId, templateId: row.order.templateId, active: false }]; }],
    ["duplicate sell rows", (row) => { row.sellRowCount = "2"; }],
    ["item attachment", (row) => { row.item.id = "different-item"; }],
    ["inventory custody", (row) => { row.inventory.id = "different-inventory"; }],
    ["Exchange relationship", (row) => { row.exchange.id = "different-exchange"; }],
    ["access point", (row) => { row.accessPoint.exchangeId = "different-exchange"; }],
    ["ambiguous item reference", (row) => { row.itemOrderReferences = "2"; }],
    ["template mismatch", (row) => { row.item.templateId = "different-template"; }],
    ["fulfillment reference", (row) => { row.fulfillments = [{ completionType: 4, originalOrderId: row.order.id }]; }]
  ];
  legacyBoundaryFailures.forEach(([label, alter], index) => {
    const row = productionSellFixture("legacy", 3000 + index);
    alter(row);
    const classified = aggregateFixtureClassifications([row]);
    assert.equal(classified.counts["legacy-npc"], 0, `${label} must remain outside the Legacy/Suite NPC deletion boundary`);
    assert.equal(classified.counts["other-npc"] + classified.counts.invalid, 1, `${label} must fail closed as unknown or invalid`);
  });
}

function testFailClosedPreview() {
  const all = { deleteBotListings: true, deletePlayerListings: true, deleteLegacyNpcListings: true };
  assert.throws(() => validatePreview(preview({ counts: { unknownNpcListings: "1" } }), all), /Unknown or untracked NPC/);
  assert.throws(() => validatePreview(preview({ counts: { pendingSettlements: "1" } }), all), /Pending Exchange settlements/);
  assert.throws(() => validatePreview(preview({ counts: { invalidRelationships: "1" } }), all), /Invalid, dangling, or hybrid/);
  assert.equal(validatePreview(preview({ counts: { botListings: "9007199254740993" } }), all).selectedCount, "9007199254741033", "counts beyond Number.MAX_SAFE_INTEGER must remain exact");
  assert.equal(migrationMarketIsEmpty({ counts: { botListings: "0", playerListings: "0", legacyNpcListings: "0", unknownNpcListings: "0", pendingSettlements: "0", invalidRelationships: "0" } }), true);
  assert.equal(migrationMarketIsEmpty({ counts: { botListings: "0", playerListings: "0", legacyNpcListings: "1", unknownNpcListings: "0", pendingSettlements: "0", invalidRelationships: "0" } }), false);
}

function testPostVerification() {
  const selection = { deleteBotListings: true, deletePlayerListings: true, deleteLegacyNpcListings: true };
  const before = validatePreview(preview(), selection);
  const after = preview({
    counts: { botListings: "0", playerListings: "0", legacyNpcListings: "0", activeTracking: "0", retiredTracking: "1675" },
    digests: { botListings: emptyDigest, playerListings: emptyDigest, legacyNpcListings: emptyDigest, selected: emptyDigest }
  });
  const write = { deletedOrders: "815", deletedSellRows: "815", deletedItems: "815", deletedBotListings: "775", deletedPlayerListings: "0", deletedLegacyNpcListings: "40", retiredTracking: "775" };
  const verified = verifyPostCleanup(before, after, selection, write);
  assert.equal(verified.removed, "815");
  assert.deepEqual(verified.removedByCategory, { botListings: "775", playerListings: "0", legacyNpcListings: "40" });
  assert.throws(() => verifyPostCleanup(before, { ...after, digests: { ...after.digests, completedHistory: "0".repeat(64) } }, selection, write), /history changed/);
  assert.throws(() => verifyPostCleanup(before, after, selection, { ...write, deletedOrders: "814" }), /exact selected/);
}

async function testWorkflowSuccessAndRollback() {
  const selection = { deleteBotListings: true, deletePlayerListings: true, deleteLegacyNpcListings: true };
  const beforeRaw = preview();
  const afterRaw = preview({
    counts: { botListings: "0", playerListings: "0", legacyNpcListings: "0", activeTracking: "0", retiredTracking: "1675" },
    digests: { botListings: emptyDigest, playerListings: emptyDigest, legacyNpcListings: emptyDigest, selected: emptyDigest, protectedUnselected: emptyDigest }
  });
  const events = [];
  let stopCalls = 0;
  const result = await runEmptyMarket({
    selection, confirmText: CONFIRMATION, acknowledged: true,
    stopMarketBot: async () => { stopCalls += 1; return stoppedInfrastructure(); }, verifyMarketBotStopped: async () => stoppedInfrastructure(),
    preflight: async () => safety(), preview: async () => beforeRaw,
    createBackup: async () => backup(), verifyBackup: async (value) => value,
    execute: async () => ({ committed: true, deletedOrders: "815", deletedSellRows: "815", deletedItems: "815", deletedBotListings: "775", deletedPlayerListings: "0", deletedLegacyNpcListings: "40", retiredTracking: "775" }),
    postVerify: async () => afterRaw,
    uninstallMarketBot: async () => absentInfrastructure(), verifyMarketBotAbsent: async () => absentInfrastructure(),
    restoreBackup: async () => { throw new Error("not expected"); },
    verifyRestore: async () => ({ matchesBefore: true }), checkpoint: async (name) => events.push(name)
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.removedByCategory, { botListings: "775", playerListings: "0", legacyNpcListings: "40" });
  assert.equal(result.marketBotInfrastructureRemoved, true);
  assert.equal(stopCalls, 0, "an authoritative already-stopped preflight must skip the redundant OpenRC stop command");
  assert.deepEqual(events, ["preflight", "rollback-backup", "immediately-before-write", "post-verification", "remove-market-bot-infrastructure", "complete"]);

  let restored = 0;
  await assert.rejects(() => runEmptyMarket({
    selection, confirmText: CONFIRMATION, acknowledged: true,
    stopMarketBot: async () => stoppedInfrastructure(), verifyMarketBotStopped: async () => stoppedInfrastructure(),
    preflight: async () => safety(), preview: async () => beforeRaw,
    createBackup: async () => backup(), verifyBackup: async (value) => value,
    execute: async () => ({ committed: true, deletedOrders: "815", deletedSellRows: "815", deletedItems: "815", deletedBotListings: "775", deletedPlayerListings: "0", deletedLegacyNpcListings: "40", retiredTracking: "775" }),
    postVerify: async () => ({ ...afterRaw, digests: { ...afterRaw.digests, completedHistory: "9".repeat(64) } }),
    uninstallMarketBot: async () => absentInfrastructure(), verifyMarketBotAbsent: async () => absentInfrastructure(),
    restoreBackup: async () => { restored += 1; }, verifyRestore: async () => ({ matchesBefore: true }), checkpoint: async () => {}
  }), (error) => error.code === "empty_market_rolled_back");
  assert.equal(restored, 1, "post-commit verification failure must restore exactly once");
}

async function testBackupAndConfirmationPrecedeWrite() {
  let writes = 0;
  await assert.rejects(() => runEmptyMarket({ selection: { deleteBotListings: false, deletePlayerListings: false, deleteLegacyNpcListings: false }, confirmText: CONFIRMATION, acknowledged: true }), /Select Delete Market Bot Listings/);
  await assert.rejects(() => runEmptyMarket({ selection: { deleteBotListings: true, deletePlayerListings: false, deleteLegacyNpcListings: false }, confirmText: "wrong", acknowledged: true }), /EMPTY MARKET FOR MIGRATION/);
  await assert.rejects(() => runEmptyMarket({
    selection: { deleteBotListings: true, deletePlayerListings: false, deleteLegacyNpcListings: false }, confirmText: CONFIRMATION, acknowledged: true,
    stopMarketBot: async () => stoppedInfrastructure(), verifyMarketBotStopped: async () => stoppedInfrastructure(),
    preflight: async () => safety(), preview: async () => preview(),
    createBackup: async () => ({ ...backup(), archiveReadVerified: false }), verifyBackup: async (value) => value,
    execute: async () => { writes += 1; }, postVerify: async () => preview(),
    uninstallMarketBot: async () => absentInfrastructure(), verifyMarketBotAbsent: async () => absentInfrastructure(),
    restoreBackup: async () => {}, verifyRestore: async () => ({ matchesBefore: true }), checkpoint: async () => {}
  }), /not independently verified/);
  assert.equal(writes, 0);
}

async function main() {
  testSqlBoundaries();
  testProductionShapedClassifier();
  testFailClosedPreview();
  testPostVerification();
  await testWorkflowSuccessAndRollback();
  await testBackupAndConfirmationPrecedeWrite();
  console.log("Migration Empty Market classification, transactional deletion, backup, and rollback tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
