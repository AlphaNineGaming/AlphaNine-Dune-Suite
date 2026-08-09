"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const {
  buildDestinationMarketCleanupSql,
  emptyDestinationMarketEvidence,
  validateDestinationCleanupResult,
  validateSourceMarketEvidence
} = require("../lib/migration-destination-market");
const { buildPortableEvidenceSql } = require("../lib/migration-empty-market");

const digest = (character) => character.repeat(64);
const source = {
  counts: { activeListings: "815", pendingSettlements: "0", invalidRelationships: "0", completedHistory: "1" },
  digests: { activeListings: digest("1"), pendingSettlements: digest("2"), invalidRelationships: digest("2"), completedHistory: digest("3") }
};

function testPortableClassifierContract() {
  const sql = buildPortableEvidenceSql();
  assert.match(sql, /sell_row_count=1/);
  assert.match(sql, /item_order_references=1/);
  assert.match(sql, /inventory_id=exchange_inventory_id/);
  assert.match(sql, /catalog_access_point_id=access_point_id/);
  assert.match(sql, /owner_actor_id=owner_id/);
  assert.match(sql, /is_npc_order=true AND owner_account_id IS NULL/);
  assert.match(sql, /is_npc_order=false AND owner_account_id IS NOT NULL AND owner_account_record_id=owner_account_id/);
  assert.match(sql, /completed_history/);
  assert.match(sql, /orphan-sell/);
  assert.match(sql, /orphan-fulfillment/);
  assert.match(sql, /orphan-custody-item/);
  assert.doesNotMatch(sql, /public\.alphanine_market_bot_/i, "Portable classification must not depend on Market Bot infrastructure.");
}

function testCleanupTransactionContract() {
  const sql = buildDestinationMarketCleanupSql(source);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /LOCK TABLE[\s\S]+IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /classification='active'/);
  assert.match(sql, /DELETE FROM dune\.dune_exchange_sell_orders/);
  assert.match(sql, /DELETE FROM dune\.dune_exchange_orders/);
  assert.match(sql, /DELETE FROM dune\.items/);
  assert.match(sql, /i\.inventory_id=t\.inventory_id/);
  assert.match(sql, /classification IN \('active','pending-settlement','invalid'\)/);
  assert.match(sql, /Completed or fulfilled payment history changed/);
  assert.match(sql, /Restored market evidence differs from the verified package/);
  assert.match(sql, /COMMIT;$/);
  assert.doesNotMatch(sql, /public\.|alphanine_market_bot|rc-service|runtime fingerprint/i);
}

function testEvidenceAndResultValidation() {
  assert.deepEqual(validateSourceMarketEvidence(source), source);
  assert.throws(() => validateSourceMarketEvidence({ ...source, counts: { ...source.counts, activeListings: 815 } }), /decimal string/);
  assert.throws(() => validateSourceMarketEvidence({ ...source, extra: true }), /unknown or missing/);
  assert.throws(() => validateSourceMarketEvidence({ ...source, digests: { ...source.digests, activeListings: "bad" } }), /SHA-256/);
  const huge = { ...source, counts: { ...source.counts, activeListings: "9007199254740993" } };
  assert.equal(validateSourceMarketEvidence(huge).counts.activeListings, "9007199254740993");
  assert.match(buildDestinationMarketCleanupSql(huge), /9007199254740993/);
  const result = { committed: true, deletedListings: "815", deletedSellRows: "815", deletedItems: "815", completedHistory: "1", completedHistoryDigest: digest("3") };
  assert.equal(validateDestinationCleanupResult(result, source).deletedListings, "815");
  assert.throws(() => validateDestinationCleanupResult({ ...result, deletedItems: "814" }, source), /exact active listing boundary/);
  assert.throws(() => validateDestinationCleanupResult({ ...result, completedHistoryDigest: digest("4") }, source), /fulfilled payment history/);
  const emptyDigest = crypto.createHash("sha256").update("[]").digest("hex");
  assert.deepEqual(emptyDestinationMarketEvidence(source), {
    counts: { activeListings: "0", pendingSettlements: "0", invalidRelationships: "0", completedHistory: "1" },
    digests: { activeListings: emptyDigest, pendingSettlements: emptyDigest, invalidRelationships: emptyDigest, completedHistory: digest("3") }
  });
}

testPortableClassifierContract();
testCleanupTransactionContract();
testEvidenceAndResultValidation();
console.log("Destination-only portable market classification, exact transactional cleanup, completed-history preservation, bigint, and fail-closed validation tests passed.");
