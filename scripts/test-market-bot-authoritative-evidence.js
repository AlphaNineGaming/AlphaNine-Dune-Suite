"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  defaultMarketBotConfig,
  pinnedCatalogPolicy,
  runtimeConfig
} = require("../lib/market-bot");
const {
  MarketBotAuthoritativeEvidenceError,
  buildAuthoritativeMarketBotEvidence
} = require("../lib/market-bot-authoritative-evidence");

const runtimeBinaryFingerprint = "b".repeat(64);

function catalogItems(count = 2131) {
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture-template-${String(index + 1).padStart(4, "0")}`,
    name: `Fixture ${index + 1}`,
    category: "Items",
    tier: "1",
    enabled: true,
    unitPrice: 1000 + index,
    stackSize: 1,
    targetListings: index % 2,
    categoryMask: 1,
    categoryDepth: 1
  }));
}

function fixture() {
  const catalogPolicy = pinnedCatalogPolicy(catalogItems());
  const localConfig = {
    ...defaultMarketBotConfig(),
    enabled: true,
    activated: true,
    paused: true,
    pauseState: "Pause requested",
    configGeneration: "6",
    pauseGeneration: "6",
    catalogPolicy
  };
  const configuration = runtimeConfig(localConfig, {
    name: "fixture-battlegroup",
    namespace: "fixture-namespace",
    dbPod: "fixture-db-pod",
    dbSvc: "fixture-db-service"
  }, [], "1.0.84");
  localConfig.runtimeFingerprint = configuration.configFingerprint;
  const configurationSha256 = crypto.createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  const status = {
    ok: true,
    installedVersion: "1.0.84",
    config: {
      schemaVersion: configuration.schemaVersion,
      paused: configuration.paused,
      pauseState: configuration.pauseState,
      configGeneration: configuration.configGeneration,
      pauseGeneration: configuration.pauseGeneration,
      configFingerprint: configuration.configFingerprint,
      runtimeVersion: configuration.runtimeVersion
      // Deliberately no items: the public/UI status contract is summary-only.
    },
    state: {
      status: "Quiescent",
      pauseState: "Quiescent",
      configGeneration: "6",
      pauseGeneration: "6",
      installedVersion: "1.0.84",
      cycleQueued: false,
      cycleRunning: false,
      incompleteCycle: false,
      lastRunAt: null,
      nextRunAt: null,
      updatedAt: null
    }
  };
  const sample = {
    advisoryLocks: "0",
    incompleteCycles: "0",
    cycleEvidenceRows: "0",
    cycleEvidenceDigest: "1".repeat(64),
    activeTracking: "775",
    totalTracking: "1675",
    protectedOrders: "41",
    protectedSellOrders: "40",
    protectedItems: "40",
    fulfilledPayments: "1",
    invalidBotTracking: "0",
    invalidProtected: "0",
    protectedDigest: "2".repeat(64),
    botOwnedDigest: "3".repeat(64)
  };
  const writer = { unexpectedActiveClients: "0", openTransactions: "0" };
  const capture = {
    config: configuration,
    configSha256: configurationSha256,
    remoteBinaryHash: runtimeBinaryFingerprint
  };
  return {
    status,
    capture,
    localConfig,
    sample,
    writer,
    expected: {
      generation: "6",
      configFingerprint: configuration.configFingerprint,
      runtimeBinarySha256: runtimeBinaryFingerprint,
      catalogItemCount: "2131",
      catalogFingerprint: catalogPolicy.fingerprint,
      runtimeVersion: "1.0.84"
    }
  };
}

function build(value = fixture()) {
  return buildAuthoritativeMarketBotEvidence({
    statusSamples: [structuredClone(value.status), structuredClone(value.status)],
    runtimeCaptures: [structuredClone(value.capture), structuredClone(value.capture)],
    samples: [structuredClone(value.sample), structuredClone(value.sample)],
    writers: [structuredClone(value.writer), structuredClone(value.writer)],
    localConfig: { ...structuredClone(value.localConfig), evidencePersisted: true },
    expected: value.expected
  });
}

function testSummaryMayOmitCatalog() {
  const value = fixture();
  assert.equal(Object.prototype.hasOwnProperty.call(value.status.config, "items"), false, "fixture must reproduce the summary-only status contract");
  const result = build(value);
  assert.equal(result.ok, true);
  assert.equal(result.quiescence.state, "Quiescent");
  assert.equal(result.publicEvidence.generation, "6");
  assert.equal(result.publicEvidence.catalogPolicy.itemCount, "2131");
  assert.equal(result.publicEvidence.catalogPolicy.fingerprint, value.expected.catalogFingerprint);
  assert.equal(result.configuration.items.length, 2131, "the internal authoritative configuration must retain the complete catalog");
  assert.equal(Object.prototype.hasOwnProperty.call(result.publicEvidence.catalogPolicy, "items"), false, "public evidence must not expose catalog contents");
  assert.doesNotMatch(JSON.stringify(result.publicEvidence), /fixture-template-/i, "public evidence must not leak item policies");
}

function testFailClosedCatalogAndConfigurationEvidence() {
  const missingConfiguration = fixture();
  missingConfiguration.capture.config = null;
  assert.throws(() => build(missingConfiguration), /configuration sample 1 is missing or malformed/i);

  const missing = fixture();
  missing.capture.config.items = [];
  missing.capture.config.configFingerprint = require("../lib/market-bot").activationFingerprint(missing.capture.config);
  assert.throws(() => build(missing), (error) => error instanceof MarketBotAuthoritativeEvidenceError && error.code === "market_bot_authoritative_catalog_missing");

  const malformed = fixture();
  malformed.capture.config.items[0].unitPrice = "1000";
  malformed.capture.config.configFingerprint = require("../lib/market-bot").activationFingerprint(malformed.capture.config);
  assert.throws(() => build(malformed), /authoritative pinned catalog is malformed/i);

  const changed = fixture();
  const secondCapture = structuredClone(changed.capture);
  secondCapture.config.generatedAt = "2026-08-05T00:00:00.000Z";
  secondCapture.configSha256 = "c".repeat(64);
  assert.throws(() => buildAuthoritativeMarketBotEvidence({
    statusSamples: [changed.status, changed.status],
    runtimeCaptures: [changed.capture, secondCapture],
    samples: [changed.sample, changed.sample],
    writers: [changed.writer, changed.writer],
    localConfig: { ...changed.localConfig, evidencePersisted: true },
    expected: changed.expected
  }), /changed between bounded samples/i);
}

function testFailClosedSummaryRuntimeAndDatabaseDisagreement() {
  const statusMismatch = fixture();
  statusMismatch.status.config.configGeneration = "7";
  assert.throws(() => build(statusMismatch), /status summary.*disagrees/i);

  const generationMismatch = fixture();
  generationMismatch.expected.generation = "7";
  assert.throws(() => build(generationMismatch), /generation does not match/i);

  const binaryMismatch = fixture();
  binaryMismatch.expected.runtimeBinarySha256 = "d".repeat(64);
  assert.throws(() => build(binaryMismatch), /runtime binary fingerprint/i);

  const catalogFingerprintMismatch = fixture();
  catalogFingerprintMismatch.expected.catalogFingerprint = "e".repeat(64);
  assert.throws(() => build(catalogFingerprintMismatch), /pinned catalog fingerprint/i);

  const notQuiescent = fixture();
  notQuiescent.status.state.status = "Draining";
  assert.throws(() => build(notQuiescent), /not authoritatively Quiescent/i);

  const activeWriter = fixture();
  activeWriter.writer.unexpectedActiveClients = "1";
  assert.throws(() => build(activeWriter), /quiescence validation failed.*writer-state/i);
}

function testServerWiringAudit() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const migrationEvidenceSource = source.slice(
    source.indexOf("async function migrationEvidence"),
    source.indexOf("async function migrationExportPreflight")
  );
  const reconciliationSource = source.slice(
    source.indexOf("async function migrationOfflineMarketBotReconciliationPreflight"),
    source.indexOf("async function reconcileLocalMarketBotEvidenceInOfflineMode")
  );
  assert.match(migrationEvidenceSource, /collectAuthoritativeMarketBotEvidence/);
  assert.match(reconciliationSource, /collectAuthoritativeMarketBotEvidence/);
  assert.doesNotMatch(migrationEvidenceSource, /marketBotStatus[\s\S]{0,500}\.config\??\.items|remote\.config\??\.items/, "export evidence must never reconstruct the catalog from a public status envelope");
  assert.match(source, /runtimeCaptures:\s*\[first\.runtime, second\.runtime\]/, "authoritative configuration must be sampled twice");
  const publicPreflight = source.slice(source.indexOf("function publicMigrationPreflight"), source.indexOf("async function cleanInterruptedMigrationPartials"));
  assert.doesNotMatch(publicPreflight, /catalogPolicy\.items|configuration\.items/, "public migration preflight must not expose catalog contents");
}

function main() {
  testSummaryMayOmitCatalog();
  testFailClosedCatalogAndConfigurationEvidence();
  testFailClosedSummaryRuntimeAndDatabaseDisagreement();
  testServerWiringAudit();
  console.log("Authoritative Market Bot runtime evidence, summary-only status, drift, catalog, fingerprint, quiescence, and disclosure tests passed.");
}

main();
