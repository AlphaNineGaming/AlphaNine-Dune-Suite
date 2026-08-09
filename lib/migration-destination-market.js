"use strict";

const { portableClassificationCtes } = require("./migration-empty-market");

const COUNT_KEYS = Object.freeze(["activeListings", "pendingSettlements", "invalidRelationships", "completedHistory"]);
const DIGEST_KEYS = Object.freeze([...COUNT_KEYS]);

class DestinationMarketError extends Error {
  constructor(message, code = "migration_destination_market_failed", details = {}) {
    super(message); this.name = "DestinationMarketError"; this.code = code; this.details = details;
  }
}

function decimal(value, label) {
  if (typeof value !== "string") throw new DestinationMarketError(`${label} must be an exact decimal string.`, "migration_destination_market_evidence");
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new DestinationMarketError(`${label} must be an exact decimal string.`, "migration_destination_market_evidence");
  return BigInt(text).toString(10);
}

function digest(value, label) {
  const text = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new DestinationMarketError(`${label} must be a SHA-256 digest.`, "migration_destination_market_evidence");
  return text;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DestinationMarketError(`${label} is missing.`, "migration_destination_market_evidence");
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new DestinationMarketError(`${label} contains unknown or missing fields.`, "migration_destination_market_evidence");
}

function validateSourceMarketEvidence(value, label = "sourceMarket") {
  exactKeys(value, ["counts", "digests"], label);
  exactKeys(value.counts, COUNT_KEYS, `${label}.counts`);
  exactKeys(value.digests, DIGEST_KEYS, `${label}.digests`);
  return {
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, decimal(value.counts[key], `${label}.${key}`)])),
    digests: Object.fromEntries(DIGEST_KEYS.map((key) => [key, digest(value.digests[key], `${label}.${key}`)]))
  };
}

function quote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function buildDestinationMarketCleanupSql(sourceEvidence) {
  const source = validateSourceMarketEvidence(sourceEvidence);
  return String.raw`BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='10min';
LOCK TABLE dune.dune_exchange_orders,dune.dune_exchange_sell_orders,dune.dune_exchange_fulfilled_orders,
  dune.dune_exchanges,dune.dune_exchange_accesspoints,dune.inventories,dune.items,dune.actors,dune.accounts IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE a9_destination_market_before ON COMMIT DROP AS
WITH ` + portableClassificationCtes() + String.raw`
SELECT evidence_id,order_id,item_id,inventory_id,classification,canonical FROM evidence_rows;
DO $a9$
DECLARE active_count text; pending_count text; invalid_count text; completed_count text;
  active_digest text; pending_digest text; invalid_digest text; completed_digest_value text;
BEGIN
  SELECT count(*) FILTER (WHERE classification='active')::text,
         count(*) FILTER (WHERE classification='pending-settlement')::text,
         count(*) FILTER (WHERE classification='invalid')::text,
         count(*) FILTER (WHERE classification='completed-history')::text,
         encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY evidence_id,canonical) FILTER (WHERE classification='active'),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'),
         encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY evidence_id,canonical) FILTER (WHERE classification='pending-settlement'),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'),
         encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY evidence_id,canonical) FILTER (WHERE classification='invalid'),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'),
         encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY evidence_id,canonical) FILTER (WHERE classification='completed-history'),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex')
  INTO active_count,pending_count,invalid_count,completed_count,active_digest,pending_digest,invalid_digest,completed_digest_value
  FROM a9_destination_market_before;
  IF active_count <> ` + quote(source.counts.activeListings) + ` OR pending_count <> ` + quote(source.counts.pendingSettlements) + `
     OR invalid_count <> ` + quote(source.counts.invalidRelationships) + ` OR completed_count <> ` + quote(source.counts.completedHistory) + `
     OR active_digest <> ` + quote(source.digests.activeListings) + ` OR pending_digest <> ` + quote(source.digests.pendingSettlements) + `
     OR invalid_digest <> ` + quote(source.digests.invalidRelationships) + ` OR completed_digest_value <> ` + quote(source.digests.completedHistory) + String.raw` THEN
    RAISE EXCEPTION 'Restored market evidence differs from the verified package.' USING ERRCODE='40001';
  END IF;
  IF pending_count <> '0' OR invalid_count <> '0' THEN
    RAISE EXCEPTION 'Destination market contains pending, dangling, ambiguous, or hybrid relationships.' USING ERRCODE='23514';
  END IF;
END $a9$;
CREATE TEMP TABLE a9_destination_market_targets ON COMMIT DROP AS
SELECT order_id,item_id,inventory_id FROM a9_destination_market_before WHERE classification='active';
CREATE TEMP TABLE a9_deleted_sell(order_id bigint) ON COMMIT DROP;
WITH deleted AS (
  DELETE FROM dune.dune_exchange_sell_orders s USING a9_destination_market_targets t
  WHERE s.order_id=t.order_id RETURNING s.order_id
) INSERT INTO a9_deleted_sell SELECT order_id FROM deleted;
CREATE TEMP TABLE a9_deleted_orders(order_id bigint) ON COMMIT DROP;
WITH deleted AS (
  DELETE FROM dune.dune_exchange_orders o USING a9_destination_market_targets t
  WHERE o.id=t.order_id AND EXISTS(SELECT 1 FROM a9_deleted_sell s WHERE s.order_id=o.id) RETURNING o.id
) INSERT INTO a9_deleted_orders SELECT id FROM deleted;
CREATE TEMP TABLE a9_deleted_items(item_id bigint) ON COMMIT DROP;
WITH deleted AS (
  DELETE FROM dune.items i USING a9_destination_market_targets t
  WHERE i.id=t.item_id AND i.inventory_id=t.inventory_id
    AND EXISTS(SELECT 1 FROM a9_deleted_orders o WHERE o.order_id=t.order_id) RETURNING i.id
) INSERT INTO a9_deleted_items SELECT id FROM deleted;
CREATE TEMP TABLE a9_destination_market_after ON COMMIT DROP AS
WITH ` + portableClassificationCtes() + String.raw`
SELECT evidence_id,order_id,classification,canonical FROM evidence_rows;
DO $a9$
DECLARE expected_count bigint; completed_count text; completed_digest_value text;
BEGIN
  SELECT count(*) INTO expected_count FROM a9_destination_market_targets;
  IF (SELECT count(*) FROM a9_deleted_sell) <> expected_count
     OR (SELECT count(*) FROM a9_deleted_orders) <> expected_count
     OR (SELECT count(*) FROM a9_deleted_items) <> expected_count THEN
    RAISE EXCEPTION 'Destination market deletion boundary was not exact.' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM a9_destination_market_after WHERE classification IN ('active','pending-settlement','invalid')) THEN
    RAISE EXCEPTION 'Destination market is not empty and valid after cleanup.' USING ERRCODE='23514';
  END IF;
  SELECT count(*)::text,encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY evidence_id,canonical),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex')
    INTO completed_count,completed_digest_value FROM a9_destination_market_after WHERE classification='completed-history';
  IF completed_count <> ` + quote(source.counts.completedHistory) + ` OR completed_digest_value <> ` + quote(source.digests.completedHistory) + String.raw` THEN
    RAISE EXCEPTION 'Completed or fulfilled payment history changed during destination cleanup.' USING ERRCODE='40001';
  END IF;
END $a9$;
SELECT jsonb_build_object('committed',true,
  'deletedListings',(SELECT count(*)::text FROM a9_deleted_orders),
  'deletedSellRows',(SELECT count(*)::text FROM a9_deleted_sell),
  'deletedItems',(SELECT count(*)::text FROM a9_deleted_items),
  'completedHistory',` + quote(source.counts.completedHistory) + `,
  'completedHistoryDigest',` + quote(source.digests.completedHistory) + String.raw`)::text;
COMMIT;`;
}

function validateDestinationCleanupResult(value, sourceEvidence) {
  const source = validateSourceMarketEvidence(sourceEvidence);
  exactKeys(value, ["committed", "deletedListings", "deletedSellRows", "deletedItems", "completedHistory", "completedHistoryDigest"], "destination cleanup result");
  if (value.committed !== true) throw new DestinationMarketError("Destination market cleanup did not commit.");
  const expected = source.counts.activeListings;
  for (const key of ["deletedListings", "deletedSellRows", "deletedItems"]) if (decimal(value[key], key) !== expected) throw new DestinationMarketError("Destination market cleanup did not delete the exact active listing boundary.");
  if (decimal(value.completedHistory, "completed history") !== source.counts.completedHistory || digest(value.completedHistoryDigest, "completed history digest") !== source.digests.completedHistory) throw new DestinationMarketError("Destination cleanup changed completed or fulfilled payment history.");
  return { ...value, deletedListings: expected };
}

function emptyDestinationMarketEvidence(sourceEvidence) {
  const source = validateSourceMarketEvidence(sourceEvidence);
  const emptyDigest = require("crypto").createHash("sha256").update("[]", "utf8").digest("hex");
  return { counts: { activeListings: "0", pendingSettlements: "0", invalidRelationships: "0", completedHistory: source.counts.completedHistory }, digests: { activeListings: emptyDigest, pendingSettlements: emptyDigest, invalidRelationships: emptyDigest, completedHistory: source.digests.completedHistory } };
}

module.exports = { COUNT_KEYS, DIGEST_KEYS, DestinationMarketError, buildDestinationMarketCleanupSql, emptyDestinationMarketEvidence, validateDestinationCleanupResult, validateSourceMarketEvidence };
