"use strict";

const crypto = require("crypto");

const CONFIRMATION = "EMPTY MARKET FOR MIGRATION";
const OPTION_KEYS = Object.freeze(["deleteBotListings", "deletePlayerListings", "deleteLegacyNpcListings"]);
const COUNT_KEYS = Object.freeze([
  "botListings", "playerListings", "legacyNpcListings", "unknownNpcListings", "pendingSettlements",
  "completedHistory", "invalidRelationships", "activeTracking", "totalTracking", "retiredTracking"
]);
const DIGEST_KEYS = Object.freeze([
  "botListings", "playerListings", "legacyNpcListings", "unknownNpcListings", "pendingSettlements",
  "completedHistory", "protectedUnselected", "selected"
]);
const DIAGNOSTIC_KEYS = Object.freeze([
  "missingSellRow", "missingItem", "itemAttachmentMismatch", "itemReferenceAmbiguous",
  "itemTemplateMismatch", "exchangeCatalogMismatch", "exchangeCustodyMismatch",
  "accessPointMismatch", "fulfillmentConflict", "botTrackingMismatch",
  "botOwnerMismatch", "playerAccountMismatch", "playerTrackingHistory",
  "hybridNpcOwnership", "totalInvalid"
]);

class EmptyMarketError extends Error {
  constructor(message, code = "empty_market_failed", details = {}) {
    super(message);
    this.name = "EmptyMarketError";
    this.code = code;
    this.details = details;
  }
}

function decimal(value, label) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new EmptyMarketError(`${label} must be an exact decimal string.`, "empty_market_invalid_evidence");
  return BigInt(text).toString(10);
}

function digest(value, label) {
  const text = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new EmptyMarketError(`${label} must be a SHA-256 digest.`, "empty_market_invalid_evidence");
  return text;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EmptyMarketError(`${label} is missing.`, "empty_market_invalid_evidence");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new EmptyMarketError(`${label} contains missing or unknown fields.`, "empty_market_invalid_evidence");
  }
}

function normalizeSelection(value = {}) {
  exactKeys(value, OPTION_KEYS, "Empty Market selection");
  const selection = Object.fromEntries(OPTION_KEYS.map((key) => [key, value[key] === true]));
  if (!selection.deleteBotListings && !selection.deletePlayerListings && !selection.deleteLegacyNpcListings) {
    throw new EmptyMarketError("Select Delete Market Bot Listings, Delete Player Listings, Delete Legacy/Suite NPC Listings, or a combination.", "empty_market_selection_required");
  }
  return selection;
}

function validatePreview(value, selection) {
  const hasSelectedCount = value && Object.prototype.hasOwnProperty.call(value, "selectedCount");
  exactKeys(value, hasSelectedCount ? ["version", "counts", "digests", "diagnostics", "selectedCount"] : ["version", "counts", "digests", "diagnostics"], "Empty Market preview");
  if (value.version !== 2) throw new EmptyMarketError("Empty Market preview version is unsupported.", "empty_market_invalid_evidence");
  exactKeys(value.counts, COUNT_KEYS, "Empty Market counts");
  exactKeys(value.digests, DIGEST_KEYS, "Empty Market digests");
  exactKeys(value.diagnostics, DIAGNOSTIC_KEYS, "Empty Market aggregate diagnostics");
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, decimal(value.counts[key], key)]));
  const digests = Object.fromEntries(DIGEST_KEYS.map((key) => [key, digest(value.digests[key], `${key} digest`)]));
  const diagnostics = Object.fromEntries(DIAGNOSTIC_KEYS.map((key) => [key, decimal(value.diagnostics[key], `${key} diagnostic`)]));
  if (BigInt(counts.activeTracking) + BigInt(counts.retiredTracking) !== BigInt(counts.totalTracking)) {
    throw new EmptyMarketError("Market Bot tracking counts are inconsistent.", "empty_market_invalid_evidence");
  }
  if (counts.unknownNpcListings !== "0") throw new EmptyMarketError("Unknown or untracked NPC listings are present.", "empty_market_unknown_npc");
  if (counts.pendingSettlements !== "0") throw new EmptyMarketError("Pending Exchange settlements are present.", "empty_market_pending_settlement");
  if (counts.invalidRelationships !== "0") throw new EmptyMarketError("Invalid, dangling, or hybrid Exchange relationships are present.", "empty_market_invalid_relationship");
  const selectedCount = (selection.deleteBotListings ? BigInt(counts.botListings) : 0n)
    + (selection.deletePlayerListings ? BigInt(counts.playerListings) : 0n)
    + (selection.deleteLegacyNpcListings ? BigInt(counts.legacyNpcListings) : 0n);
  if (hasSelectedCount && decimal(value.selectedCount, "selected listing count") !== selectedCount.toString(10)) {
    throw new EmptyMarketError("Empty Market selected listing count is inconsistent.", "empty_market_invalid_evidence");
  }
  if (diagnostics.totalInvalid !== counts.invalidRelationships) {
    throw new EmptyMarketError("Empty Market invalid-relationship diagnostics are inconsistent.", "empty_market_invalid_evidence");
  }
  return { version: 2, counts, digests, diagnostics, selectedCount: selectedCount.toString(10) };
}

function canonicalPreview(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function previewsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// All canonical values are persisted fields. PostgreSQL OIDs, transaction metadata,
// clocks, host data, paths, UI classifications, and presentation labels are absent.
// A listed item remains attached to the Exchange's catalog inventory while it is
// listed. The order, sell row, item, Exchange, access point, and custody inventory
// must form one unambiguous persisted relationship before deletion is possible.
function classificationCtes() {
  return String.raw`
tracking AS MATERIALIZED (
  SELECT order_id,item_id,template_id,cycle_id,unit_price,stack_size,expiration_time,retired_at
  FROM public.alphanine_market_bot_listings
),
expected_bot_owner AS MATERIALIZED (
  SELECT id FROM dune.actors
  WHERE class='Duke' AND owner_account_id IS NULL
  ORDER BY id LIMIT 1
),
orders AS MATERIALIZED (
  SELECT o.id,o.exchange_id,o.access_point_id,o.owner_id,o.is_npc_order,o.expiration_time,
    o.template_id,o.durability_cur,o.durability_max,o.category_mask,o.category_depth,
    o.item_price,o.quality_level,o.item_id,
    s.order_id AS sell_order_id,s.initial_stack_size,s.wear_normalized_price,
    i.id AS listed_item_id,i.inventory_id,i.stack_size AS item_stack_size,
    i.position_index,i.template_id AS item_template_id,i.quality_level AS item_quality_level,
    e.id AS catalog_exchange_id,e.inventory_id AS exchange_inventory_id,
    inv.id AS inventory_record_id,inv.exchange_id AS inventory_exchange_id,
    ap.id AS catalog_access_point_id,ap.exchange_id AS access_point_exchange_id,
    a.class AS owner_class,a.owner_account_id,acct.id AS owner_account_record_id,
    (SELECT count(*) FROM dune.dune_exchange_sell_orders exact_sell WHERE exact_sell.order_id=o.id) AS sell_row_count,
    (SELECT count(*) FROM dune.dune_exchange_users eu WHERE eu.owner_id=o.owner_id) AS exchange_user_count,
    EXISTS(SELECT 1 FROM dune.accounts player_account WHERE player_account.id=o.owner_id) AS owner_id_is_account,
    EXISTS(SELECT 1 FROM dune.player_state ps WHERE ps.account_id=o.owner_id
      OR ps.player_controller_id=o.owner_id OR ps.player_state_id=o.owner_id
      OR ps.player_pawn_id=o.owner_id OR ps.id=o.owner_id) AS has_player_state_link,
    (SELECT count(*) FROM tracking t WHERE t.order_id=o.id) AS tracking_history_count,
    (SELECT count(*) FROM tracking t WHERE t.order_id=o.id AND t.retired_at IS NULL) AS active_tracking_count,
    (SELECT count(*) FROM tracking t WHERE t.order_id=o.id AND t.retired_at IS NULL
      AND t.item_id=o.item_id AND t.template_id=o.template_id) AS matching_active_tracking_count,
    EXISTS(SELECT 1 FROM dune.dune_exchange_fulfilled_orders f WHERE f.order_id=o.id) AS has_fulfillment,
    EXISTS(SELECT 1 FROM dune.dune_exchange_fulfilled_orders f
      WHERE f.order_id=o.id AND f.completion_type BETWEEN 1 AND 4
        AND (f.original_order_id IS NOT NULL OR f.source_order_id IS NOT NULL)) AS completed_fulfillment,
    (SELECT count(*) FROM dune.dune_exchange_orders duplicate_order WHERE duplicate_order.item_id=o.item_id) AS item_order_references
  FROM dune.dune_exchange_orders o
  LEFT JOIN dune.dune_exchange_sell_orders s ON s.order_id=o.id
  LEFT JOIN dune.items i ON i.id=o.item_id
  LEFT JOIN dune.dune_exchanges e ON e.id=o.exchange_id
  LEFT JOIN dune.inventories inv ON inv.id=i.inventory_id
  LEFT JOIN dune.dune_exchange_accesspoints ap ON ap.id=o.access_point_id
  LEFT JOIN dune.actors a ON a.id=o.owner_id
  LEFT JOIN dune.accounts acct ON acct.id=a.owner_account_id
),
relationship_state AS MATERIALIZED (
  SELECT orders.*,
    (sell_order_id IS NOT NULL AND sell_row_count=1 AND listed_item_id IS NOT NULL AND item_id=listed_item_id
      AND item_order_references=1 AND NOT has_fulfillment) AS active_sell_shape,
    (item_template_id=template_id) AS template_matches,
    (catalog_exchange_id=exchange_id AND exchange_inventory_id IS NOT NULL) AS exchange_matches,
    (inventory_record_id=inventory_id AND inventory_id=exchange_inventory_id
      AND (inventory_exchange_id IS NULL OR inventory_exchange_id=exchange_id)) AS exchange_custody_matches,
    (catalog_access_point_id=access_point_id AND access_point_exchange_id=exchange_id) AS access_point_matches
  FROM orders
),
classified AS MATERIALIZED (
  SELECT relationship_state.*,
    CASE
      WHEN active_sell_shape AND template_matches AND exchange_matches AND exchange_custody_matches AND access_point_matches
        AND is_npc_order=true AND active_tracking_count=1 AND matching_active_tracking_count=1
        AND owner_id=(SELECT id FROM expected_bot_owner)
        AND owner_class='Duke' AND owner_account_id IS NULL THEN 'bot'
      WHEN active_sell_shape AND template_matches AND exchange_matches AND exchange_custody_matches AND access_point_matches
        AND is_npc_order=false AND owner_account_id IS NOT NULL AND owner_account_record_id=owner_account_id
        AND tracking_history_count=0 THEN 'player'
      WHEN active_sell_shape AND template_matches AND exchange_matches AND exchange_custody_matches AND access_point_matches
        AND is_npc_order=true AND owner_class='AlphaNineMarket' AND owner_account_id IS NULL
        AND exchange_user_count=1 AND owner_id_is_account=false AND has_player_state_link=false
        AND tracking_history_count=0 THEN 'legacy-npc'
      WHEN active_sell_shape AND template_matches AND exchange_matches AND exchange_custody_matches AND access_point_matches
        AND is_npc_order=true AND owner_account_id IS NULL AND tracking_history_count=0 THEN 'other-npc'
      WHEN sell_order_id IS NULL AND item_id IS NULL AND listed_item_id IS NULL
        AND has_fulfillment AND NOT completed_fulfillment THEN 'pending-settlement'
      WHEN sell_order_id IS NULL AND item_id IS NULL AND listed_item_id IS NULL
        AND completed_fulfillment THEN 'completed-history'
      ELSE 'invalid'
    END AS classification,
    jsonb_build_object(
      'orderId',id::text,'exchangeId',exchange_id::text,'accessPointId',access_point_id::text,
      'ownerId',owner_id::text,'isNpcOrder',is_npc_order,'expirationTime',expiration_time::text,
      'templateId',template_id,'durabilityCur',durability_cur::text,'durabilityMax',durability_max::text,
      'categoryMask',category_mask::text,'categoryDepth',category_depth::text,'itemPrice',item_price::text,
      'qualityLevel',quality_level::text,'itemId',item_id::text,
      'sell',CASE WHEN sell_order_id IS NULL THEN NULL ELSE jsonb_build_object(
        'orderId',sell_order_id::text,'initialStackSize',initial_stack_size::text,
        'wearNormalizedPrice',wear_normalized_price::text) END,
      'item',CASE WHEN listed_item_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id',listed_item_id::text,'inventoryId',inventory_id::text,'stackSize',item_stack_size::text,
        'positionIndex',position_index::text,'templateId',item_template_id,
        'qualityLevel',item_quality_level::text) END
    ) AS canonical
  FROM relationship_state
),
class_digests AS MATERIALIZED (
  SELECT classification,count(*)::text AS row_count,
    encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') AS digest
  FROM classified GROUP BY classification
),
completed_history AS MATERIALIZED (
  SELECT c.id,jsonb_build_object('order',c.canonical,'fulfillments',COALESCE(jsonb_agg(jsonb_build_object(
    'orderId',f.order_id::text,'sourceOrderId',f.source_order_id::text,'completionType',f.completion_type::text,
    'stackSize',f.stack_size::text,'originalOrderId',f.original_order_id::text)
    ORDER BY f.order_id,f.source_order_id,f.original_order_id),'[]'::jsonb)) AS canonical
  FROM classified c JOIN dune.dune_exchange_fulfilled_orders f ON f.order_id=c.id
  WHERE c.classification='completed-history' GROUP BY c.id,c.canonical
)`;
}

function buildPreviewSql(selection = { deleteBotListings: false, deletePlayerListings: false, deleteLegacyNpcListings: false }) {
  const chooseBot = selection.deleteBotListings === true ? "true" : "false";
  const choosePlayer = selection.deletePlayerListings === true ? "true" : "false";
  const chooseLegacy = selection.deleteLegacyNpcListings === true ? "true" : "false";
  return `WITH ${classificationCtes()},\n` + String.raw`
selected AS MATERIALIZED (
  SELECT * FROM classified WHERE (` + chooseBot + String.raw` AND classification='bot') OR (` + choosePlayer + String.raw` AND classification='player')
    OR (` + chooseLegacy + String.raw` AND classification='legacy-npc')
),
unselected AS MATERIALIZED (
  SELECT * FROM classified WHERE classification IN ('bot','player','legacy-npc') AND NOT ((` + chooseBot + String.raw` AND classification='bot') OR (` + choosePlayer + String.raw` AND classification='player')
    OR (` + chooseLegacy + String.raw` AND classification='legacy-npc'))
)
SELECT jsonb_build_object(
  'version',2,
  'counts',jsonb_build_object(
    'botListings',COALESCE((SELECT row_count FROM class_digests WHERE classification='bot'),'0'),
    'playerListings',COALESCE((SELECT row_count FROM class_digests WHERE classification='player'),'0'),
    'legacyNpcListings',COALESCE((SELECT row_count FROM class_digests WHERE classification='legacy-npc'),'0'),
    'unknownNpcListings',COALESCE((SELECT row_count FROM class_digests WHERE classification='other-npc'),'0'),
    'pendingSettlements',COALESCE((SELECT row_count FROM class_digests WHERE classification='pending-settlement'),'0'),
    'completedHistory',COALESCE((SELECT count(*)::text FROM completed_history),'0'),
    'invalidRelationships',COALESCE((SELECT row_count FROM class_digests WHERE classification='invalid'),'0'),
    'activeTracking',(SELECT count(*)::text FROM tracking WHERE retired_at IS NULL),
    'totalTracking',(SELECT count(*)::text FROM tracking),
    'retiredTracking',(SELECT count(*)::text FROM tracking WHERE retired_at IS NOT NULL)
  ),
  'digests',jsonb_build_object(
    'botListings',COALESCE((SELECT digest FROM class_digests WHERE classification='bot'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'playerListings',COALESCE((SELECT digest FROM class_digests WHERE classification='player'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'legacyNpcListings',COALESCE((SELECT digest FROM class_digests WHERE classification='legacy-npc'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'unknownNpcListings',COALESCE((SELECT digest FROM class_digests WHERE classification='other-npc'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'pendingSettlements',COALESCE((SELECT digest FROM class_digests WHERE classification='pending-settlement'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'completedHistory',encode(ext.digest(convert_to(COALESCE((SELECT jsonb_agg(canonical ORDER BY id) FROM completed_history),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'),
    'protectedUnselected',encode(ext.digest(convert_to(COALESCE((SELECT jsonb_agg(canonical ORDER BY id) FROM unselected),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'),
    'selected',encode(ext.digest(convert_to(COALESCE((SELECT jsonb_agg(jsonb_build_object('classification',classification,'record',canonical) ORDER BY classification,id) FROM selected),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex')
  ),
  'diagnostics',jsonb_build_object(
    'missingSellRow',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND sell_order_id IS NULL AND NOT has_fulfillment),
    'missingItem',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND (item_id IS NULL OR listed_item_id IS NULL) AND NOT has_fulfillment),
    'itemAttachmentMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND item_id IS NOT NULL AND listed_item_id IS NOT NULL AND item_id<>listed_item_id),
    'itemReferenceAmbiguous',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND item_order_references<>1 AND NOT has_fulfillment),
    'itemTemplateMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND template_matches IS NOT TRUE AND listed_item_id IS NOT NULL),
    'exchangeCatalogMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND exchange_matches IS NOT TRUE AND sell_order_id IS NOT NULL),
    'exchangeCustodyMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND exchange_custody_matches IS NOT TRUE AND listed_item_id IS NOT NULL),
    'accessPointMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND access_point_matches IS NOT TRUE AND sell_order_id IS NOT NULL),
    'fulfillmentConflict',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND has_fulfillment),
    'botTrackingMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND is_npc_order=true AND tracking_history_count>0 AND (active_tracking_count<>1 OR matching_active_tracking_count<>1)),
    'botOwnerMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND is_npc_order=true AND active_tracking_count=1 AND matching_active_tracking_count=1 AND (owner_id IS DISTINCT FROM (SELECT id FROM expected_bot_owner) OR owner_class IS DISTINCT FROM 'Duke' OR owner_account_id IS NOT NULL)),
    'playerAccountMismatch',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND is_npc_order=false AND (owner_account_id IS NULL OR owner_account_record_id IS DISTINCT FROM owner_account_id)),
    'playerTrackingHistory',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND is_npc_order=false AND tracking_history_count>0),
    'hybridNpcOwnership',(SELECT count(*)::text FROM classified WHERE classification='invalid' AND is_npc_order=true AND owner_account_id IS NOT NULL),
    'totalInvalid',COALESCE((SELECT row_count FROM class_digests WHERE classification='invalid'),'0')
  )
)::text;`;
}

// Destination/import evidence intentionally depends only on the portable dune
// boundary. Any active sell listing is classified as "other" and therefore
// blocks completion; Market Bot ownership tables are neither needed nor allowed.
function portableClassificationCtes() {
  return String.raw`
orders AS MATERIALIZED (
  SELECT o.id,o.exchange_id,o.access_point_id,o.owner_id,o.is_npc_order,o.expiration_time,
    o.template_id,o.durability_cur,o.durability_max,o.category_mask,o.category_depth,
    o.item_price,o.quality_level,o.item_id,
    s.order_id AS sell_order_id,s.initial_stack_size,s.wear_normalized_price,
    i.id AS listed_item_id,i.inventory_id,i.stack_size AS item_stack_size,
    i.position_index,i.template_id AS item_template_id,i.quality_level AS item_quality_level,
    e.id AS catalog_exchange_id,e.inventory_id AS exchange_inventory_id,
    inv.id AS inventory_record_id,inv.exchange_id AS inventory_exchange_id,
    ap.id AS catalog_access_point_id,ap.exchange_id AS access_point_exchange_id,
    a.id AS owner_actor_id,a.class AS owner_class,a.owner_account_id,acct.id AS owner_account_record_id,
    (SELECT count(*) FROM dune.dune_exchange_sell_orders exact_sell WHERE exact_sell.order_id=o.id) AS sell_row_count,
    EXISTS(SELECT 1 FROM dune.dune_exchange_fulfilled_orders f WHERE f.order_id=o.id) AS has_fulfillment,
    EXISTS(SELECT 1 FROM dune.dune_exchange_fulfilled_orders f WHERE f.order_id=o.id
      AND f.completion_type BETWEEN 1 AND 4
      AND (f.original_order_id IS NOT NULL OR f.source_order_id IS NOT NULL)) AS completed_fulfillment,
    (SELECT count(*) FROM dune.dune_exchange_orders d WHERE d.item_id=o.item_id) AS item_order_references
  FROM dune.dune_exchange_orders o
  LEFT JOIN dune.dune_exchange_sell_orders s ON s.order_id=o.id
  LEFT JOIN dune.items i ON i.id=o.item_id
  LEFT JOIN dune.dune_exchanges e ON e.id=o.exchange_id
  LEFT JOIN dune.inventories inv ON inv.id=i.inventory_id
  LEFT JOIN dune.dune_exchange_accesspoints ap ON ap.id=o.access_point_id
  LEFT JOIN dune.actors a ON a.id=o.owner_id
  LEFT JOIN dune.accounts acct ON acct.id=a.owner_account_id
), classified AS MATERIALIZED (
  SELECT orders.*,
    CASE
      WHEN sell_order_id IS NOT NULL AND sell_row_count=1 AND listed_item_id IS NOT NULL AND item_id=listed_item_id
        AND item_order_references=1 AND item_template_id=template_id AND NOT has_fulfillment
        AND catalog_exchange_id=exchange_id AND exchange_inventory_id IS NOT NULL
        AND inventory_record_id=inventory_id AND inventory_id=exchange_inventory_id
        AND (inventory_exchange_id IS NULL OR inventory_exchange_id=exchange_id)
        AND catalog_access_point_id=access_point_id AND access_point_exchange_id=exchange_id
        AND owner_actor_id=owner_id
        AND ((is_npc_order=true AND owner_account_id IS NULL)
          OR (is_npc_order=false AND owner_account_id IS NOT NULL AND owner_account_record_id=owner_account_id)) THEN 'active'
      WHEN sell_order_id IS NULL AND item_id IS NULL AND listed_item_id IS NULL
        AND has_fulfillment AND NOT completed_fulfillment THEN 'pending-settlement'
      WHEN sell_order_id IS NULL AND item_id IS NULL AND listed_item_id IS NULL
        AND completed_fulfillment THEN 'completed-history'
      ELSE 'invalid'
    END AS classification,
    jsonb_build_object(
      'orderId',id::text,'exchangeId',exchange_id::text,'accessPointId',access_point_id::text,
      'ownerId',owner_id::text,'ownerClass',owner_class,'ownerAccountId',owner_account_id::text,
      'isNpcOrder',is_npc_order,'expirationTime',expiration_time::text,
      'templateId',template_id,'durabilityCur',durability_cur::text,'durabilityMax',durability_max::text,
      'categoryMask',category_mask::text,'categoryDepth',category_depth::text,'itemPrice',item_price::text,
      'qualityLevel',quality_level::text,'itemId',item_id::text,
      'sell',CASE WHEN sell_order_id IS NULL THEN NULL ELSE jsonb_build_object(
        'orderId',sell_order_id::text,'initialStackSize',initial_stack_size::text,
        'wearNormalizedPrice',wear_normalized_price::text) END,
      'item',CASE WHEN listed_item_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id',listed_item_id::text,'inventoryId',inventory_id::text,'stackSize',item_stack_size::text,
        'positionIndex',position_index::text,'templateId',item_template_id,
        'qualityLevel',item_quality_level::text) END
    ) AS canonical
  FROM orders
), completed_history AS MATERIALIZED (
  SELECT c.id,jsonb_build_object('order',c.canonical,'fulfillments',COALESCE(jsonb_agg(jsonb_build_object(
    'orderId',f.order_id::text,'sourceOrderId',f.source_order_id::text,'completionType',f.completion_type::text,
    'stackSize',f.stack_size::text,'originalOrderId',f.original_order_id::text)
    ORDER BY f.order_id,f.source_order_id,f.original_order_id),'[]'::jsonb)) AS canonical
  FROM classified c JOIN dune.dune_exchange_fulfilled_orders f ON f.order_id=c.id
  WHERE c.classification='completed-history' GROUP BY c.id,c.canonical
), structural_invalidity AS MATERIALIZED (
  SELECT 'orphan-sell:'||s.order_id::text AS evidence_id,jsonb_build_object(
    'kind','orphan-sell','orderId',s.order_id::text,'initialStackSize',s.initial_stack_size::text,
    'wearNormalizedPrice',s.wear_normalized_price::text) AS canonical
  FROM dune.dune_exchange_sell_orders s
  WHERE NOT EXISTS(SELECT 1 FROM dune.dune_exchange_orders o WHERE o.id=s.order_id)
  UNION ALL
  SELECT 'orphan-fulfillment:'||f.order_id::text||':'||COALESCE(f.source_order_id::text,'')||':'||COALESCE(f.original_order_id::text,''),jsonb_build_object(
    'kind','orphan-fulfillment','orderId',f.order_id::text,'sourceOrderId',f.source_order_id::text,
    'originalOrderId',f.original_order_id::text,'completionType',f.completion_type::text,'stackSize',f.stack_size::text)
  FROM dune.dune_exchange_fulfilled_orders f
  WHERE NOT EXISTS(SELECT 1 FROM dune.dune_exchange_orders o WHERE o.id=f.order_id)
  UNION ALL
  SELECT 'orphan-custody-item:'||i.id::text,jsonb_build_object(
    'kind','orphan-custody-item','itemId',i.id::text,'inventoryId',i.inventory_id::text,
    'templateId',i.template_id,'stackSize',i.stack_size::text,'positionIndex',i.position_index::text,
    'qualityLevel',i.quality_level::text)
  FROM dune.items i JOIN dune.dune_exchanges e ON e.inventory_id=i.inventory_id
  WHERE NOT EXISTS(SELECT 1 FROM dune.dune_exchange_orders o WHERE o.item_id=i.id)
), evidence_rows AS MATERIALIZED (
  SELECT 'order:'||id::text AS evidence_id,id AS order_id,item_id,inventory_id,classification,canonical
  FROM classified WHERE classification<>'completed-history'
  UNION ALL
  SELECT 'order:'||c.id::text,c.id,c.item_id,c.inventory_id,c.classification,h.canonical
  FROM classified c JOIN completed_history h USING(id) WHERE c.classification='completed-history'
  UNION ALL
  SELECT evidence_id,NULL::bigint,NULL::bigint,NULL::bigint,'invalid',canonical FROM structural_invalidity
), class_digests AS MATERIALIZED (
  SELECT classification,count(*)::text AS row_count,
    encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical ORDER BY evidence_id,canonical),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') AS digest
  FROM evidence_rows GROUP BY classification
)`;
}

function buildPortableEvidenceSql() {
  return `WITH ${portableClassificationCtes()}\n` + String.raw`
SELECT jsonb_build_object('counts',jsonb_build_object(
  'activeListings',COALESCE((SELECT row_count FROM class_digests WHERE classification='active'),'0'),
  'pendingSettlements',COALESCE((SELECT row_count FROM class_digests WHERE classification='pending-settlement'),'0'),
  'invalidRelationships',COALESCE((SELECT row_count FROM class_digests WHERE classification='invalid'),'0'),
  'completedHistory',COALESCE((SELECT row_count FROM class_digests WHERE classification='completed-history'),'0')),
  'digests',jsonb_build_object(
    'activeListings',COALESCE((SELECT digest FROM class_digests WHERE classification='active'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'pendingSettlements',COALESCE((SELECT digest FROM class_digests WHERE classification='pending-settlement'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'invalidRelationships',COALESCE((SELECT digest FROM class_digests WHERE classification='invalid'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')),
    'completedHistory',COALESCE((SELECT digest FROM class_digests WHERE classification='completed-history'),encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')))
)::text;`;
}

// A small data-shaped reference classifier keeps regression fixtures readable.
// It intentionally accepts only persisted relationship fields and mirrors the SQL
// boundary; it is never used to classify live records or to authorize deletion.
function classifyFixtureRecord(record = {}) {
  const order = record.order || {};
  const sell = record.sell || null;
  const item = record.item || null;
  const exchange = record.exchange || null;
  const inventory = record.inventory || null;
  const accessPoint = record.accessPoint || null;
  const owner = record.owner || null;
  const tracking = Array.isArray(record.tracking) ? record.tracking : [];
  const fulfillments = Array.isArray(record.fulfillments) ? record.fulfillments : [];
  const same = (left, right) => left !== null && left !== undefined && String(left) === String(right);
  const history = tracking.filter((row) => same(row.orderId, order.id));
  const active = history.filter((row) => row.active === true);
  const matching = active.filter((row) => same(row.itemId, order.itemId) && String(row.templateId || "") === String(order.templateId || ""));
  const itemReferences = String(record.itemOrderReferences ?? "0");
  const completed = fulfillments.some((row) => Number(row.completionType) >= 1 && Number(row.completionType) <= 4 && (row.originalOrderId != null || row.sourceOrderId != null));
  const hasFulfillment = fulfillments.length > 0;
  const sellRowCount = String(record.sellRowCount ?? (sell ? "1" : "0"));
  const activeSellShape = Boolean(sell && sellRowCount === "1" && item && same(sell.orderId, order.id) && same(order.itemId, item.id) && itemReferences === "1" && !hasFulfillment);
  const templateMatches = Boolean(item && String(item.templateId || "") === String(order.templateId || ""));
  const exchangeMatches = Boolean(exchange && same(exchange.id, order.exchangeId) && exchange.inventoryId != null);
  const custodyMatches = Boolean(item && inventory && exchange && same(inventory.id, item.inventoryId)
    && same(item.inventoryId, exchange.inventoryId) && (inventory.exchangeId == null || same(inventory.exchangeId, order.exchangeId)));
  const accessPointMatches = Boolean(accessPoint && same(accessPoint.id, order.accessPointId) && same(accessPoint.exchangeId, order.exchangeId));
  const activeRelationship = activeSellShape && templateMatches && exchangeMatches && custodyMatches && accessPointMatches;
  let classification = "invalid";
  if (activeRelationship && order.isNpcOrder === true && active.length === 1 && matching.length === 1
      && owner && same(owner.id, record.expectedBotOwnerId) && owner.class === "Duke" && owner.ownerAccountId == null) classification = "bot";
  else if (activeRelationship && order.isNpcOrder === false && owner && owner.ownerAccountId != null
      && owner.accountExists === true && history.length === 0) classification = "player";
  else if (activeRelationship && order.isNpcOrder === true && owner?.class === "AlphaNineMarket"
      && owner.ownerAccountId == null && owner.exchangeUserCount === "1"
      && owner.ownerIdIsAccount !== true && owner.playerOwnershipLink !== true && history.length === 0) classification = "legacy-npc";
  else if (activeRelationship && order.isNpcOrder === true && owner && owner.ownerAccountId == null && history.length === 0) classification = "other-npc";
  else if (!sell && order.itemId == null && !item && hasFulfillment && !completed) classification = "pending-settlement";
  else if (!sell && order.itemId == null && !item && completed) classification = "completed-history";
  const reasons = [];
  if (classification === "invalid") {
    if (!sell && !hasFulfillment) reasons.push("missingSellRow");
    if ((!item || order.itemId == null) && !hasFulfillment) reasons.push("missingItem");
    if (item && order.itemId != null && !same(order.itemId, item.id)) reasons.push("itemAttachmentMismatch");
    if (itemReferences !== "1" && !hasFulfillment) reasons.push("itemReferenceAmbiguous");
    if (item && !templateMatches) reasons.push("itemTemplateMismatch");
    if (sell && !exchangeMatches) reasons.push("exchangeCatalogMismatch");
    if (item && !custodyMatches) reasons.push("exchangeCustodyMismatch");
    if (sell && !accessPointMatches) reasons.push("accessPointMismatch");
    if (hasFulfillment) reasons.push("fulfillmentConflict");
    if (order.isNpcOrder === true && history.length > 0 && (active.length !== 1 || matching.length !== 1)) reasons.push("botTrackingMismatch");
    if (order.isNpcOrder === true && active.length === 1 && matching.length === 1
        && (!owner || !same(owner.id, record.expectedBotOwnerId) || owner.class !== "Duke" || owner.ownerAccountId != null)) reasons.push("botOwnerMismatch");
    if (order.isNpcOrder === false && (!owner || owner.ownerAccountId == null || owner.accountExists !== true)) reasons.push("playerAccountMismatch");
    if (order.isNpcOrder === false && history.length > 0) reasons.push("playerTrackingHistory");
    if (order.isNpcOrder === true && owner?.ownerAccountId != null) reasons.push("hybridNpcOwnership");
  }
  return { classification, reasons };
}

function aggregateFixtureClassifications(records = []) {
  const counts = { bot: 0, player: 0, "legacy-npc": 0, "other-npc": 0, "pending-settlement": 0, "completed-history": 0, invalid: 0 };
  const diagnostics = Object.fromEntries(DIAGNOSTIC_KEYS.map((key) => [key, 0]));
  for (const record of records) {
    const result = classifyFixtureRecord(record);
    counts[result.classification] += 1;
    for (const reason of result.reasons) diagnostics[reason] += 1;
  }
  diagnostics.totalInvalid = counts.invalid;
  return { counts, diagnostics };
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildCleanupSql(selectionValue, previewValue) {
  const selection = normalizeSelection(selectionValue);
  const preview = validatePreview(previewValue, selection);
  const chooseBot = selection.deleteBotListings ? "true" : "false";
  const choosePlayer = selection.deletePlayerListings ? "true" : "false";
  const chooseLegacy = selection.deleteLegacyNpcListings ? "true" : "false";
  return String.raw`BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='5min';
LOCK TABLE dune.dune_exchange_orders,dune.dune_exchange_sell_orders,dune.dune_exchange_fulfilled_orders,
  dune.dune_exchanges,dune.dune_exchange_accesspoints,dune.dune_exchange_users,dune.inventories,dune.items,dune.actors,dune.accounts,dune.player_state,
  public.alphanine_market_bot_listings,public.alphanine_market_bot_audit IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE a9_empty_market_classified ON COMMIT DROP AS
WITH ` + classificationCtes() + String.raw`
SELECT id,item_id,inventory_id,classification,canonical FROM classified;
CREATE TEMP TABLE a9_empty_market_targets ON COMMIT DROP AS
SELECT id AS order_id,item_id,inventory_id,classification,canonical FROM a9_empty_market_classified
WHERE (` + chooseBot + String.raw` AND classification='bot') OR (` + choosePlayer + String.raw` AND classification='player')
  OR (` + chooseLegacy + String.raw` AND classification='legacy-npc');
DO $a9$
DECLARE selected_count text; selected_digest text; unknown_count text; pending_count text; invalid_count text;
BEGIN
  SELECT count(*)::text,
    encode(ext.digest(convert_to(COALESCE(jsonb_agg(jsonb_build_object('classification',classification,'record',canonical)
      ORDER BY classification,order_id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex')
  INTO selected_count,selected_digest FROM a9_empty_market_targets;
  SELECT count(*) FILTER (WHERE classification='other-npc')::text,
         count(*) FILTER (WHERE classification='pending-settlement')::text,
         count(*) FILTER (WHERE classification='invalid')::text
  INTO unknown_count,pending_count,invalid_count FROM a9_empty_market_classified;
  IF selected_count <> ` + sqlLiteral(preview.selectedCount) + ` OR selected_digest <> ` + sqlLiteral(preview.digests.selected) + String.raw`
     OR unknown_count <> '0' OR pending_count <> '0' OR invalid_count <> '0' THEN
    RAISE EXCEPTION 'Empty Market preview changed or unsafe records appeared.' USING ERRCODE='40001';
  END IF;
END $a9$;
CREATE TEMP TABLE a9_empty_market_history_baseline ON COMMIT DROP AS
WITH ` + portableClassificationCtes() + String.raw`
SELECT COALESCE((SELECT row_count FROM class_digests WHERE classification='completed-history'),'0') AS history_count,
  COALESCE((SELECT digest FROM class_digests WHERE classification='completed-history'),
    encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex')) AS history_digest;
CREATE TEMP TABLE a9_empty_market_write_result ON COMMIT DROP AS
WITH deleted_sell AS (
  DELETE FROM dune.dune_exchange_sell_orders s USING a9_empty_market_targets t
  WHERE s.order_id=t.order_id RETURNING s.order_id
), deleted_orders AS (
  DELETE FROM dune.dune_exchange_orders o USING a9_empty_market_targets t
  WHERE o.id=t.order_id AND EXISTS(SELECT 1 FROM deleted_sell s WHERE s.order_id=o.id) RETURNING o.id
), deleted_items AS (
  DELETE FROM dune.items i USING a9_empty_market_targets t
  WHERE i.id=t.item_id AND i.inventory_id=t.inventory_id
    AND EXISTS(SELECT 1 FROM deleted_orders o WHERE o.id=t.order_id) RETURNING i.id
), retired AS (
  UPDATE public.alphanine_market_bot_listings m SET retired_at=clock_timestamp()
  FROM a9_empty_market_targets t
  WHERE t.classification='bot' AND m.order_id=t.order_id AND m.retired_at IS NULL RETURNING m.order_id
), audit AS (
  INSERT INTO public.alphanine_market_bot_audit(cycle_id,event,details)
  SELECT NULL,'empty-market-migration',jsonb_build_object(
    'botListings',(SELECT count(*)::text FROM a9_empty_market_targets WHERE classification='bot'),
    'playerListings',(SELECT count(*)::text FROM a9_empty_market_targets WHERE classification='player'),
    'legacyNpcListings',(SELECT count(*)::text FROM a9_empty_market_targets WHERE classification='legacy-npc'))
  WHERE EXISTS(SELECT 1 FROM a9_empty_market_targets) RETURNING id
)
SELECT (SELECT count(*)::text FROM deleted_orders) AS deleted_orders,
  (SELECT count(*)::text FROM deleted_sell) AS deleted_sell_rows,
  (SELECT count(*)::text FROM deleted_items) AS deleted_items,
  (SELECT count(*)::text FROM a9_empty_market_targets WHERE classification='bot') AS deleted_bot_listings,
  (SELECT count(*)::text FROM a9_empty_market_targets WHERE classification='player') AS deleted_player_listings,
  (SELECT count(*)::text FROM a9_empty_market_targets WHERE classification='legacy-npc') AS deleted_legacy_npc_listings,
  (SELECT count(*)::text FROM retired) AS retired_tracking;
DO $a9_verify$
DECLARE expected_selected text; expected_retired text;
  deleted_orders text; deleted_sell_rows text; deleted_items text; retired_tracking text;
  residual_bot text; residual_player text; residual_legacy text; residual_unknown text;
  active_count text; pending_count text; invalid_count text;
  expected_history_count text; actual_history_count text; expected_history_digest text; actual_history_digest text;
  assertion_detail text;
BEGIN
  expected_selected := ` + sqlLiteral(preview.selectedCount) + `;
  expected_retired := ` + sqlLiteral(selection.deleteBotListings ? preview.counts.botListings : "0") + `;
  SELECT w.deleted_orders,w.deleted_sell_rows,w.deleted_items,w.retired_tracking
    INTO deleted_orders,deleted_sell_rows,deleted_items,retired_tracking FROM a9_empty_market_write_result w;
  WITH ` + classificationCtes() + String.raw`
  SELECT count(*) FILTER (WHERE classification='bot')::text,
         count(*) FILTER (WHERE classification='player')::text,
         count(*) FILTER (WHERE classification='legacy-npc')::text,
         count(*) FILTER (WHERE classification='other-npc')::text
    INTO residual_bot,residual_player,residual_legacy,residual_unknown FROM classified;
  WITH ` + portableClassificationCtes() + String.raw`
  SELECT COALESCE((SELECT row_count FROM class_digests WHERE classification='active'),'0'),
         COALESCE((SELECT row_count FROM class_digests WHERE classification='pending-settlement'),'0'),
         COALESCE((SELECT row_count FROM class_digests WHERE classification='invalid'),'0'),
         COALESCE((SELECT row_count FROM class_digests WHERE classification='completed-history'),'0'),
         COALESCE((SELECT digest FROM class_digests WHERE classification='completed-history'),
           encode(ext.digest(convert_to('[]','UTF8'),'sha256'),'hex'))
    INTO active_count,pending_count,invalid_count,actual_history_count,actual_history_digest;
  SELECT history_count,history_digest INTO expected_history_count,expected_history_digest
    FROM a9_empty_market_history_baseline;
  assertion_detail := format(
    'expectedSelected=%s actualOrders=%s actualSellRows=%s actualCustodyItems=%s expectedRetired=%s actualRetired=%s residualBot=%s residualPlayer=%s residualLegacy=%s residualUnknown=%s active=%s pending=%s invalid=%s expectedHistoryCount=%s actualHistoryCount=%s expectedHistoryDigest=%s actualHistoryDigest=%s',
    expected_selected,deleted_orders,deleted_sell_rows,deleted_items,expected_retired,retired_tracking,
    residual_bot,residual_player,residual_legacy,residual_unknown,active_count,pending_count,invalid_count,
    expected_history_count,actual_history_count,expected_history_digest,actual_history_digest);
  IF deleted_orders <> expected_selected OR deleted_sell_rows <> expected_selected
     OR deleted_items <> expected_selected OR retired_tracking <> expected_retired THEN
    RAISE EXCEPTION 'Empty Market exact-deletion assertion failed.' USING ERRCODE='40001',DETAIL=assertion_detail;
  END IF;
  IF residual_bot <> '0' OR residual_player <> '0' OR residual_legacy <> '0' OR residual_unknown <> '0'
     OR active_count <> '0' OR pending_count <> '0' OR invalid_count <> '0' THEN
    RAISE EXCEPTION 'Empty Market residual-boundary assertion failed.' USING ERRCODE='40001',DETAIL=assertion_detail;
  END IF;
  IF actual_history_count <> expected_history_count OR actual_history_digest <> expected_history_digest THEN
    RAISE EXCEPTION 'Empty Market fulfilled-history assertion failed.' USING ERRCODE='40001',DETAIL=assertion_detail;
  END IF;
END $a9_verify$;
SELECT jsonb_build_object('committed',true,
  'deletedOrders',deleted_orders,'deletedSellRows',deleted_sell_rows,'deletedItems',deleted_items,
  'deletedBotListings',deleted_bot_listings,'deletedPlayerListings',deleted_player_listings,
  'deletedLegacyNpcListings',deleted_legacy_npc_listings,'retiredTracking',retired_tracking)::text
FROM a9_empty_market_write_result;
COMMIT;`;
}

function validateSafetyPreflight(evidence) {
  if (evidence?.offlineMode?.active !== true || evidence.offlineMode.failClosed === true) throw new EmptyMarketError("Healthy Migration Offline Mode is required.", "empty_market_offline_required");
  if (evidence?.battlegroup?.stopped !== true || evidence.battlegroup.controllersSuspended !== true || decimal(evidence.battlegroup.runningGameWorkloads, "running game workloads") !== "0") throw new EmptyMarketError("Battlegroup must be stopped with suspended controllers and zero workloads.", "empty_market_server_online");
  if (evidence?.database?.postgresqlHealthy !== true) throw new EmptyMarketError("PostgreSQL must be healthy and reachable.", "empty_market_postgresql_unhealthy");
  const marketBotState = String(evidence?.marketBot?.state || "");
  if (!(["Service stopped", "Service absent"].includes(marketBotState) && evidence.marketBot.authoritative === true)) throw new EmptyMarketError("Market Bot service and process infrastructure must be stopped or absent.", "empty_market_bot_unsafe");
  if (evidence.marketBot.pidPresent !== false || decimal(evidence.marketBot.matchingProcesses, "matching Market Bot processes") !== "0"
    || decimal(evidence.marketBot.supervisorProcesses, "Market Bot supervisor processes") !== "0"
    || evidence.marketBot.defaultRunlevelRegistered !== false || evidence.marketBot.restartPathActive !== false) {
    throw new EmptyMarketError("Market Bot process or restart infrastructure is active or ambiguous.", "empty_market_bot_unsafe");
  }
  for (const key of ["unexpectedWriters", "openTransactions"]) if (decimal(evidence?.database?.[key], key) !== "0") throw new EmptyMarketError("An unexpected writer or open transaction is active.", "empty_market_writer");
  if (evidence.conflictingOperations !== false) throw new EmptyMarketError("A conflicting Suite or vendor operation is active.", "empty_market_conflict");
  return true;
}

function validateInfrastructureState(evidence, requireAbsent = false) {
  const state = String(evidence?.state || "");
  if (evidence?.authoritative !== true || evidence.pidPresent !== false
    || decimal(evidence.matchingProcesses, "matching Market Bot processes") !== "0"
    || decimal(evidence.supervisorProcesses, "Market Bot supervisor processes") !== "0"
    || evidence.defaultRunlevelRegistered !== false
    || evidence.restartPathActive !== false) {
    throw new EmptyMarketError("Market Bot infrastructure state is not independently safe.", "empty_market_bot_unsafe");
  }
  if (requireAbsent) {
    if (state !== "Service absent" || evidence.serviceInstalled !== false || evidence.runtimeInstalled !== false) {
      throw new EmptyMarketError("Market Bot service and runtime were not fully removed after cleanup.", "empty_market_bot_uninstall_failed");
    }
  } else if (!["Service stopped", "Service absent"].includes(state)) {
    throw new EmptyMarketError("Market Bot service did not stop through the supported operation.", "empty_market_bot_stop_failed");
  }
  return true;
}

function validateBackup(backup) {
  if (backup?.verified !== true || backup.usableForRestore !== true || backup.archiveReadVerified !== true || backup.completeDune !== true) throw new EmptyMarketError("The fresh rollback backup is not independently verified.", "empty_market_backup_invalid");
  decimal(backup.size, "rollback backup size");
  digest(backup.sha256, "rollback backup SHA-256");
  const required = ["alphanine_market_bot_audit", "alphanine_market_bot_cycle_evidence", "alphanine_market_bot_cycles", "alphanine_market_bot_listings"];
  const actual = Array.isArray(backup.alphaTables) ? [...backup.alphaTables].sort() : [];
  if (JSON.stringify(actual) !== JSON.stringify(required.sort())) throw new EmptyMarketError("The rollback backup does not contain all four Market Bot tables.", "empty_market_backup_invalid");
  return backup;
}

function verifyPostCleanup(before, afterValue, selection, writeResult = {}) {
  const after = validatePreview(afterValue, selection);
  if (selection.deleteBotListings && after.counts.botListings !== "0") throw new EmptyMarketError("Bot listings remain after cleanup.", "empty_market_post_verify");
  if (selection.deletePlayerListings && after.counts.playerListings !== "0") throw new EmptyMarketError("Player listings remain after cleanup.", "empty_market_post_verify");
  if (selection.deleteLegacyNpcListings && after.counts.legacyNpcListings !== "0") throw new EmptyMarketError("Legacy/Suite NPC listings remain after cleanup.", "empty_market_post_verify");
  if (!selection.deleteBotListings && after.digests.botListings !== before.digests.botListings) throw new EmptyMarketError("Unselected bot listings changed.", "empty_market_post_verify");
  if (!selection.deletePlayerListings && after.digests.playerListings !== before.digests.playerListings) throw new EmptyMarketError("Unselected player listings changed.", "empty_market_post_verify");
  if (!selection.deleteLegacyNpcListings && after.digests.legacyNpcListings !== before.digests.legacyNpcListings) throw new EmptyMarketError("Unselected Legacy/Suite NPC listings changed.", "empty_market_post_verify");
  if (after.digests.completedHistory !== before.digests.completedHistory || after.counts.completedHistory !== before.counts.completedHistory) throw new EmptyMarketError("Completed or fulfilled payment history changed.", "empty_market_post_verify");
  const expectedRemoved = before.selectedCount;
  for (const key of ["deletedOrders", "deletedSellRows", "deletedItems"]) if (decimal(writeResult[key], key) !== expectedRemoved) throw new EmptyMarketError("Cleanup did not remove the exact selected order, sell-row, and item set.", "empty_market_post_verify");
  const expectedRetired = selection.deleteBotListings ? before.counts.botListings : "0";
  if (decimal(writeResult.retiredTracking, "retired tracking") !== expectedRetired) throw new EmptyMarketError("Cleanup did not retire the exact selected bot tracking set.", "empty_market_post_verify");
  const expectedByCategory = {
    botListings: selection.deleteBotListings ? before.counts.botListings : "0",
    playerListings: selection.deletePlayerListings ? before.counts.playerListings : "0",
    legacyNpcListings: selection.deleteLegacyNpcListings ? before.counts.legacyNpcListings : "0"
  };
  for (const [resultKey, countKey] of [["deletedBotListings", "botListings"], ["deletedPlayerListings", "playerListings"], ["deletedLegacyNpcListings", "legacyNpcListings"]]) {
    if (decimal(writeResult[resultKey], resultKey) !== expectedByCategory[countKey]) throw new EmptyMarketError("Cleanup category counts do not match the exact selected boundaries.", "empty_market_post_verify");
  }
  if (!migrationMarketIsEmpty(after)) throw new EmptyMarketError("Migration requires zero bot, player, Legacy/Suite NPC, unknown NPC, pending-settlement, and invalid listings.", "empty_market_not_empty");
  return { before, after, removed: expectedRemoved, removedByCategory: expectedByCategory };
}

async function runEmptyMarket(options = {}) {
  const selection = normalizeSelection(options.selection || {});
  if (options.confirmText !== CONFIRMATION || options.acknowledged !== true) throw new EmptyMarketError(`Acknowledge the warning and type ${CONFIRMATION} exactly.`, "empty_market_confirmation_required");
  const required = ["stopMarketBot", "verifyMarketBotStopped", "preflight", "createBackup", "verifyBackup", "preview", "execute", "postVerify", "uninstallMarketBot", "verifyMarketBotAbsent", "restoreBackup", "verifyRestore", "checkpoint"];
  for (const name of required) if (typeof options[name] !== "function") throw new EmptyMarketError(`Empty Market implementation is missing ${name}.`, "empty_market_implementation");
  let backup = null;
  let before = null;
  let writeStarted = false;
  let infrastructureRemoved = false;
  const stage = async (name, detail = {}) => { await options.onStage?.(name, detail); await options.checkpoint(name); };
  try {
    await stage("preflight");
    const initialSafety = await options.preflight();
    validateSafetyPreflight(initialSafety);
    // A successful preflight is already an independent, authoritative proof that
    // the service is stopped/absent and has no PID, process, runlevel registration,
    // supervisor, or restart path. Do not issue a redundant OpenRC stop command.
    validateInfrastructureState(initialSafety.marketBot, false);
    before = validatePreview(await options.preview(selection), selection);
    await stage("rollback-backup");
    backup = validateBackup(await options.verifyBackup(await options.createBackup()));
    await stage("immediately-before-write");
    validateSafetyPreflight(await options.preflight());
    const lockedPreview = validatePreview(await options.preview(selection), selection);
    if (!previewsMatch(before, lockedPreview)) throw new EmptyMarketError("The selected Exchange record set changed after backup verification.", "empty_market_preview_drift");
    writeStarted = true;
    const writeResult = await options.execute(selection, lockedPreview);
    if (writeResult?.committed !== true) throw new EmptyMarketError("Empty Market cleanup did not report a committed transaction.", "empty_market_write_failed");
    await stage("post-verification");
    const verified = verifyPostCleanup(lockedPreview, await options.postVerify(selection), selection, writeResult);
    await stage("remove-market-bot-infrastructure");
    await options.uninstallMarketBot();
    validateInfrastructureState(await options.verifyMarketBotAbsent(), true);
    infrastructureRemoved = true;
    await stage("complete", { backup: { size: backup.size, sha256: backup.sha256 }, removed: verified.removed });
    return { ok: true, status: "complete", selection, backup: { size: backup.size, sha256: backup.sha256 }, removed: verified.removed, removedByCategory: verified.removedByCategory, marketBotInfrastructureRemoved: infrastructureRemoved, before: verified.before.counts, after: verified.after.counts };
  } catch (error) {
    if (!writeStarted || !backup) throw error;
    try {
      await options.onStage?.("automatic-rollback", { cause: error.code || "empty_market_failed" });
      await options.restoreBackup(backup);
      const restored = await options.verifyRestore(backup, before);
      if (restored?.matchesBefore !== true) throw new EmptyMarketError("Automatic rollback could not be verified.", "empty_market_rollback_failed");
      throw new EmptyMarketError("Empty Market failed post-verification and the verified rollback backup was restored.", "empty_market_rolled_back", { cause: error.code || "empty_market_failed" });
    } catch (rollbackError) {
      if (rollbackError?.code === "empty_market_rolled_back") throw rollbackError;
      throw new EmptyMarketError("Empty Market failed and automatic rollback could not be verified. Keep the server stopped.", "empty_market_rollback_failed", { cleanupCause: error.code || "empty_market_failed", rollbackCause: rollbackError.code || "rollback_failed" });
    }
  }
}

function migrationMarketIsEmpty(previewValue) {
  const counts = previewValue?.counts || {};
  return ["botListings", "playerListings", "legacyNpcListings", "unknownNpcListings", "pendingSettlements"].every((key) => String(counts[key]) === "0")
    && String(counts.invalidRelationships) === "0";
}

function sha256(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }

module.exports = {
  CONFIRMATION,
  COUNT_KEYS,
  DIAGNOSTIC_KEYS,
  DIGEST_KEYS,
  EmptyMarketError,
  aggregateFixtureClassifications,
  buildCleanupSql,
  buildPortableEvidenceSql,
  portableClassificationCtes,
  buildPreviewSql,
  canonicalPreview,
  classifyFixtureRecord,
  decimal,
  digest,
  migrationMarketIsEmpty,
  normalizeSelection,
  runEmptyMarket,
  sha256,
  validateBackup,
  validatePreview,
  validateSafetyPreflight,
  verifyPostCleanup
};
