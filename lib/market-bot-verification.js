"use strict";

const crypto = require("crypto");

const PAUSE_STATES = Object.freeze({
  REQUESTED: "Pause requested",
  DRAINING: "Draining",
  QUIESCENT: "Quiescent",
  RUNNING: "Running",
  UNKNOWN: "Unknown"
});

function normalizeGeneration(value, fallback = "0") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  return BigInt(text).toString(10);
}

function nextGeneration(...values) {
  let highest = 0n;
  for (const value of values) {
    const normalized = normalizeGeneration(value, "0");
    const candidate = BigInt(normalized);
    if (candidate > highest) highest = candidate;
  }
  return (highest + 1n).toString(10);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function decimalId(value, label = "identifier") {
  if (typeof value === "number") throw new Error(`${label} must be represented as a decimal string.`);
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${label} is not a decimal integer.`);
  return BigInt(text).toString(10);
}

function classifyProtectedOrder(row = {}) {
  const hasSell = row.sellOrder != null;
  const hasItemReference = row.itemId != null && String(row.itemId) !== "";
  const hasItem = row.item != null;
  const fulfilled = row.fulfilledOrder || null;
  const completionType = fulfilled == null ? null : Number(fulfilled.completionType);
  const hasSettlementReference = fulfilled != null
    && (fulfilled.originalOrderId != null || fulfilled.sourceOrderId != null)
    && Number.isInteger(completionType) && completionType >= 1 && completionType <= 4;
  if (hasSell && hasItemReference && hasItem && fulfilled == null) return { subtype: "sell", valid: true };
  if (!hasSell && !hasItemReference && !hasItem && hasSettlementReference) return { subtype: "fulfilled-payment", valid: true };
  return { subtype: "invalid", valid: false };
}

function canonicalProtectedOrders(rows = []) {
  const canonical = rows.map((row) => {
    const classification = classifyProtectedOrder(row);
    return {
      orderId: decimalId(row.orderId, "order ID"),
      subtype: classification.subtype,
      valid: classification.valid,
      order: row.order || {},
      sellOrder: row.sellOrder || null,
      item: row.item || null,
      fulfilledOrder: row.fulfilledOrder || null
    };
  });
  canonical.sort((left, right) => {
    const a = BigInt(left.orderId);
    const b = BigInt(right.orderId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return canonical;
}

function stableSampleView(sample = {}) {
  return {
    activeTracking: String(sample.activeTracking ?? ""),
    cycleEvidenceRows: String(sample.cycleEvidenceRows ?? ""),
    cycleEvidenceDigest: String(sample.cycleEvidenceDigest || ""),
    totalTracking: String(sample.totalTracking ?? ""),
    protectedOrders: String(sample.protectedOrders ?? ""),
    protectedSellOrders: String(sample.protectedSellOrders ?? ""),
    protectedItems: String(sample.protectedItems ?? ""),
    fulfilledPayments: String(sample.fulfilledPayments ?? ""),
    invalidBotTracking: String(sample.invalidBotTracking ?? ""),
    invalidProtected: String(sample.invalidProtected ?? ""),
    protectedDigest: String(sample.protectedDigest || ""),
    botOwnedDigest: String(sample.botOwnedDigest || "")
  };
}

function evaluateAuthoritativeQuiescence({ localConfig = {}, remote = {}, samples = [], writers = {} } = {}) {
  const reasons = [];
  const remoteConfig = remote.config || {};
  const state = remote.state || {};
  const localGeneration = normalizeGeneration(localConfig.configGeneration, "-1");
  const localPauseGeneration = normalizeGeneration(localConfig.pauseGeneration, "-1");
  const remoteGeneration = normalizeGeneration(remoteConfig.configGeneration, "-2");
  const remotePauseGeneration = normalizeGeneration(remoteConfig.pauseGeneration, "-2");
  const stateGeneration = normalizeGeneration(state.configGeneration, "-3");
  const statePauseGeneration = normalizeGeneration(state.pauseGeneration, "-3");
  if (localConfig.paused !== true) reasons.push("Local pause configuration is not requested.");
  if (remoteConfig.paused !== true) reasons.push("Remote pause configuration is not requested.");
  if (localConfig.pauseState !== PAUSE_STATES.REQUESTED || remoteConfig.pauseState !== PAUSE_STATES.REQUESTED) {
    reasons.push("The persisted pause request is missing or ambiguous.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(localConfig.runtimeFingerprint || ""))
    || String(localConfig.runtimeFingerprint) !== String(remoteConfig.configFingerprint || "")) {
    reasons.push("Local and remote persisted Market Bot configurations do not agree.");
  }
  if (state.pauseState !== PAUSE_STATES.QUIESCENT || state.status !== PAUSE_STATES.QUIESCENT) reasons.push("Remote runtime is not authoritatively Quiescent.");
  if (new Set([localGeneration, localPauseGeneration, remoteGeneration, remotePauseGeneration, stateGeneration, statePauseGeneration]).size !== 1) {
    reasons.push("Local, remote, and runtime pause generations do not match.");
  }
  if (state.cycleQueued !== false || state.cycleRunning !== false || state.incompleteCycle !== false) reasons.push("A queued, running, or incomplete cycle is reported.");
  if (samples.length < 2) reasons.push("Two independent stable-state samples are required.");
  for (const sample of samples) {
    if (String(sample.advisoryLocks) !== "0") reasons.push("A Market Bot advisory lock is present.");
    if (String(sample.incompleteCycles) !== "0") reasons.push("An incomplete Market Bot cycle is present.");
    if (String(sample.invalidProtected) !== "0") reasons.push("Protected Exchange relationships contain invalid records.");
    if (String(sample.invalidBotTracking) !== "0") reasons.push("Market Bot ownership tracking contains invalid active records.");
  }
  if (samples.length >= 2 && stableStringify(stableSampleView(samples[0])) !== stableStringify(stableSampleView(samples[1]))) {
    reasons.push("Relevant Market Bot and protected Exchange counts or digests are unstable.");
  }
  const writerSamples = Array.isArray(writers) ? writers : [writers];
  if (writerSamples.length < 2) reasons.push("Two independent writer/transaction samples are required.");
  for (const writerSample of writerSamples) {
    if (String(writerSample.unexpectedActiveClients ?? "0") !== "0" || String(writerSample.openTransactions ?? "0") !== "0") {
      reasons.push("An unexpected writer or open transaction is active.");
    }
  }
  return {
    ok: reasons.length === 0,
    state: reasons.length === 0 ? PAUSE_STATES.QUIESCENT : (state.pauseState || PAUSE_STATES.UNKNOWN),
    generation: localPauseGeneration,
    reasons: [...new Set(reasons)],
    samples: samples.map(stableSampleView)
  };
}

// The protected boundary excludes every order ever claimed by the strict ownership
// table, not merely rows that are currently active. This prevents retirement timing
// from moving an order into or out of the protected set. Persisted game fields are
// canonicalized as text; PostgreSQL runtime metadata and clock-derived labels never
// enter either digest.
const MARKET_BOT_MIGRATION_SAMPLE_SQL = String.raw`
WITH tracking AS MATERIALIZED (
  SELECT order_id,item_id,template_id,cycle_id,unit_price,stack_size,expiration_time,retired_at
  FROM public.alphanine_market_bot_listings
),
protected AS MATERIALIZED (
  SELECT o.*
  FROM dune.dune_exchange_orders o
  WHERE NOT EXISTS (SELECT 1 FROM tracking t WHERE t.order_id=o.id)
),
classified AS MATERIALIZED (
  SELECT o.id,
    CASE
      WHEN s.order_id IS NOT NULL AND o.item_id IS NOT NULL AND i.id IS NOT NULL AND f.order_id IS NULL THEN 'sell'
      WHEN s.order_id IS NULL AND o.item_id IS NULL AND i.id IS NULL
        AND f.order_id IS NOT NULL AND f.completion_type BETWEEN 1 AND 4
        AND (f.original_order_id IS NOT NULL OR f.source_order_id IS NOT NULL) THEN 'fulfilled-payment'
      ELSE 'invalid'
    END subtype,
    jsonb_build_object(
      'kind','order','id',o.id::text,'exchangeId',o.exchange_id::text,
      'accessPointId',o.access_point_id::text,'ownerId',o.owner_id::text,
      'isNpcOrder',o.is_npc_order,'expirationTime',o.expiration_time::text,
      'templateId',o.template_id,'durabilityCur',o.durability_cur::text,
      'durabilityMax',o.durability_max::text,'categoryMask',o.category_mask::text,
      'categoryDepth',o.category_depth::text,'itemPrice',o.item_price::text,
      'qualityLevel',o.quality_level::text,'itemId',o.item_id::text
    ) || CASE WHEN s.order_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'sell',jsonb_build_object('orderId',s.order_id::text,'initialStackSize',s.initial_stack_size::text,
        'wearNormalizedPrice',s.wear_normalized_price::text)) END
      || CASE WHEN i.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'item',jsonb_build_object('id',i.id::text,'inventoryId',i.inventory_id::text,
        'stackSize',i.stack_size::text,'positionIndex',i.position_index::text,
        'templateId',i.template_id,'qualityLevel',i.quality_level::text)) END
      || CASE WHEN f.order_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'fulfilled',jsonb_build_object('orderId',f.order_id::text,'sourceOrderId',f.source_order_id::text,
        'completionType',f.completion_type::text,'stackSize',f.stack_size::text,
        'originalOrderId',f.original_order_id::text)) END AS canonical
  FROM protected o
  LEFT JOIN dune.dune_exchange_sell_orders s ON s.order_id=o.id
  LEFT JOIN dune.items i ON i.id=o.item_id
  LEFT JOIN dune.dune_exchange_fulfilled_orders f ON f.order_id=o.id
),
protected_digest AS (
  SELECT encode(ext.digest(convert_to(COALESCE(jsonb_agg(canonical || jsonb_build_object('subtype',subtype)
    ORDER BY id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') value FROM classified
),
bot_digest AS (
  SELECT encode(ext.digest(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
    'tracking',jsonb_build_object('orderId',t.order_id::text,'itemId',t.item_id::text,'templateId',t.template_id,
      'cycleId',t.cycle_id,'unitPrice',t.unit_price::text,'stackSize',t.stack_size::text,
      'expirationTime',t.expiration_time::text,'retiredAt',t.retired_at),
    'order',CASE WHEN o.id IS NULL THEN null ELSE jsonb_build_object('id',o.id::text,'exchangeId',o.exchange_id::text,
      'accessPointId',o.access_point_id::text,'ownerId',o.owner_id::text,'isNpcOrder',o.is_npc_order,
      'expirationTime',o.expiration_time::text,'templateId',o.template_id,'durabilityCur',o.durability_cur::text,
      'durabilityMax',o.durability_max::text,'categoryMask',o.category_mask::text,'categoryDepth',o.category_depth::text,
      'itemPrice',o.item_price::text,'qualityLevel',o.quality_level::text,'itemId',o.item_id::text) END,
    'sell',CASE WHEN s.order_id IS NULL THEN null ELSE jsonb_build_object('orderId',s.order_id::text,
      'initialStackSize',s.initial_stack_size::text,'wearNormalizedPrice',s.wear_normalized_price::text) END,
    'item',CASE WHEN i.id IS NULL THEN null ELSE jsonb_build_object('id',i.id::text,'inventoryId',i.inventory_id::text,
      'stackSize',i.stack_size::text,'positionIndex',i.position_index::text,'templateId',i.template_id,
      'qualityLevel',i.quality_level::text) END,
    'fulfilled',CASE WHEN f.order_id IS NULL THEN null ELSE jsonb_build_object('orderId',f.order_id::text,
      'sourceOrderId',f.source_order_id::text,'completionType',f.completion_type::text,
      'stackSize',f.stack_size::text,'originalOrderId',f.original_order_id::text) END
  ) ORDER BY t.order_id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') value
  FROM tracking t
  LEFT JOIN dune.dune_exchange_orders o ON o.id=t.order_id
  LEFT JOIN dune.dune_exchange_sell_orders s ON s.order_id=o.id
  LEFT JOIN dune.items i ON i.id=t.item_id AND i.id=o.item_id
  LEFT JOIN dune.dune_exchange_fulfilled_orders f ON f.order_id=o.id
),
cycle_state AS (
  SELECT count(*) FILTER (WHERE completed_at IS NULL)::text legacy_incomplete
  FROM public.alphanine_market_bot_cycles
),
evidence_state AS (
  SELECT count(*) FILTER (WHERE completed_at IS NULL OR state IN ('queued','started','transaction_committed'))::text incomplete,
    count(*)::text total,
    encode(ext.digest(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
      'cycleId',cycle_id,'configGeneration',config_generation::text,'state',state,
      'queuedAt',queued_at::text,'startedAt',started_at::text,'transactionCommittedAt',transaction_committed_at::text,
      'failedAt',failed_at::text,'completedAt',completed_at::text,'failureKind',failure_kind,'updatedAt',updated_at::text
    ) ORDER BY cycle_id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') digest
  FROM public.alphanine_market_bot_cycle_evidence
)
SELECT jsonb_build_object(
  'version',1,
  'sample',jsonb_build_object(
  'advisoryLocks',(SELECT count(*)::text FROM pg_catalog.pg_locks WHERE locktype='advisory' AND granted),
  'incompleteCycles',((SELECT legacy_incomplete::bigint FROM cycle_state)+(SELECT incomplete::bigint FROM evidence_state))::text,
  'cycleEvidenceRows',(SELECT total FROM evidence_state),
  'cycleEvidenceDigest',(SELECT digest FROM evidence_state),
  'activeTracking',(SELECT count(*)::text FROM tracking WHERE retired_at IS NULL),
  'totalTracking',(SELECT count(*)::text FROM tracking),
  'protectedOrders',(SELECT count(*)::text FROM classified),
  'protectedSellOrders',(SELECT count(*)::text FROM classified WHERE subtype='sell'),
  'protectedItems',(SELECT count(*)::text FROM classified WHERE subtype='sell'),
  'fulfilledPayments',(SELECT count(*)::text FROM classified WHERE subtype='fulfilled-payment'),
  'invalidBotTracking',(SELECT count(*)::text FROM tracking t
    WHERE t.retired_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM dune.dune_exchange_orders o
      JOIN dune.dune_exchange_sell_orders s ON s.order_id=o.id
      JOIN dune.items i ON i.id=o.item_id AND i.id=t.item_id
      WHERE o.id=t.order_id AND o.template_id=t.template_id AND o.is_npc_order=true
    )),
  'invalidProtected',(SELECT count(*)::text FROM classified WHERE subtype='invalid'),
  'protectedDigest',(SELECT value FROM protected_digest),
  'botOwnedDigest',(SELECT value FROM bot_digest)
)
)::text;
`;

module.exports = {
  PAUSE_STATES,
  MARKET_BOT_MIGRATION_SAMPLE_SQL,
  normalizeGeneration,
  nextGeneration,
  stableStringify,
  sha256Canonical,
  decimalId,
  classifyProtectedOrder,
  canonicalProtectedOrders,
  stableSampleView,
  evaluateAuthoritativeQuiescence
};
