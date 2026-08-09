"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REQUIRED_EXTENSIONS, SUPPORTED_PROFILE, VERIFICATION_QUERY_VERSION, buildMigrationManifest } = require("../lib/server-migration");
const { FORMAT_VERSION, canonicalJson } = require("../lib/migration-package");
const { IMPORT_CONFIRMATION, ImportJournal, RESTORE_FLAGS, exactCompatibilityPredicates, runServerMigrationImport, validateDestinationPreflight, validateExactCompatibility } = require("../lib/server-migration-import");
const { emptyDestinationMarketEvidence } = require("../lib/migration-destination-market");
const { runReadOnlySshWithRetry } = require("../lib/migration-ssh-retry");
const { BACKUP_INVENTORY_PROFILES } = require("../lib/database-backup");
const { MigrationSchemaRestoreError, normalizeOutsideDuneBoundary } = require("../lib/migration-schema-restore");

const digest = (c) => c.repeat(64);
const entityCounts = Object.fromEntries(require("../lib/server-migration").ENTITY_TABLES ? Object.keys(require("../lib/server-migration").ENTITY_TABLES).map((key) => [key, key === "accounts" ? "9007199254740993" : (["exchangeOrders", "exchangeSellOrders"].includes(key) ? "816" : (key === "items" ? "900" : "0"))]) : []);
const sourceMarket = { counts: { activeListings: "815", pendingSettlements: "0", invalidRelationships: "0", completedHistory: "1" }, digests: { activeListings: digest("1"), pendingSettlements: digest("2"), invalidRelationships: digest("2"), completedHistory: digest("3") } };
const verification = { formatVersion: FORMAT_VERSION, queryVersion: VERIFICATION_QUERY_VERSION, collectedAt: "2026-08-04T10:00:00.000Z", fingerprints: { appliedPatchesSha256: SUPPORTED_PROFILE.appliedPatchSha256, schemaCatalogSha256: SUPPORTED_PROFILE.sourcePortableSchemaSha256 }, requiredExtensions: REQUIRED_EXTENSIONS, entityCounts, sourceMarket, relationships: { foreignKeyCount: "137", invalidForeignKeys: "0", sha256: digest("4") }, sequences: { sequenceCount: "40", sha256: digest("5") } };
const components = [{ path: "world.dump", mediaType: "application/vnd.postgresql.custom-dump", size: "10", sha256: digest("6") }, { path: "verification.json", mediaType: "application/json", size: "10", sha256: digest("7") }];
const manifest = buildMigrationManifest({ suiteVersion: "1.0.84", createdAt: verification.collectedAt, gameBuild: SUPPORTED_PROFILE.gameBuild, postgresServerVersion: "17.4", dumpToolVersion: "17.4", extensions: REQUIRED_EXTENSIONS, appliedPatchSha256: SUPPORTED_PROFILE.appliedPatchSha256, schemaCatalogSha256: SUPPORTED_PROFILE.sourcePortableSchemaSha256, entityCounts, sourceMarket, components });
const packageData = { manifest, verification, wholePackageSha256: digest("8"), wholePackageSize: "9007199254740993" };
const outsideDune = normalizeOutsideDuneBoundary({
  extensions: [
    { name: "pgcrypto", version: "1.3", schema: "ext", namespaceOid: "16384", ownerPresent: true, membershipCount: "1", membershipInput: JSON.stringify([["function", "ext", "ext.digest(bytea,text)"]]) },
    { name: "pg_trgm", version: "1.6", schema: "ext", namespaceOid: "16384", ownerPresent: true, membershipCount: "1", membershipInput: JSON.stringify([["function", "ext", "ext.similarity(text,text)"]]) }
  ], objectCount: "9007199254740993", sha256Input: "outside-dune-fixture"
});
const preflight = { offlineMode: { active: true, failClosed: false }, battlegroup: { offline: true, runningGameWorkloads: "0" }, database: { unexpectedWriters: "0", openTransactions: "0" }, conflictingOperations: false, automaticRestartDisabled: true, compatibility: { gameBuild: SUPPORTED_PROFILE.gameBuild, postgresMajor: "17", restoreToolMajor: "17", schemaCatalogSha256: SUPPORTED_PROFILE.freshDestinationSchemaSha256, appliedPatchSha256: SUPPORTED_PROFILE.appliedPatchSha256, extensions: REQUIRED_EXTENSIONS }, outsideDune, fresh: { authoritativeRows: "0", relationalInvalidity: "0", marketBotTablesPresent: "0" } };
const restored = { fingerprints: manifest.fingerprints, entityCounts, sourceMarket, relationships: verification.relationships, sequences: verification.sequences, relationalInvalidity: "0" };
const finalEntityCounts = { ...entityCounts, exchangeOrders: "1", exchangeSellOrders: "1", items: "85" };
const finalEvidence = { ...restored, entityCounts: finalEntityCounts, sourceMarket: emptyDestinationMarketEvidence(sourceMarket) };
const cleanupResult = { committed: true, deletedListings: "815", deletedSellRows: "815", deletedItems: "815", completedHistory: "1", completedHistoryDigest: digest("3") };

function options(overrides = {}) {
  const stages = []; const journalEvents = []; let backupCalls = 0; let restoreCalls = 0; let rollbackCalls = 0;
  const value = {
    confirmText: IMPORT_CONFIRMATION,
    inspectPackage: async () => packageData,
    preflight: async () => preflight,
    createRollbackBackup: async () => { backupCalls += 1; return { id: "backup" }; },
    verifyRollbackBackup: async () => ({ validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK, sha256: digest("9"), size: "4603966", archiveReadVerified: true, completeDune: true, alphaTables: [] }),
    readArchiveCompletely: async () => ({ ok: true, matchingVersion: true }),
    captureOutsideDune: async () => outsideDune,
    assertCrossSchemaSafe: async () => ({ count: "0", sha256: digest("f") }),
    verifyOutsideDune: async () => outsideDune,
    restorePackage: async (_package, flags) => { restoreCalls += 1; assert.deepEqual(flags, RESTORE_FLAGS); },
    verifyRestored: async () => restored,
    cleanupDestinationMarket: async () => cleanupResult,
    verifyFinal: async () => finalEvidence,
    restoreRollback: async () => { rollbackCalls += 1; },
    verifyRollback: async () => ({ matchesPreImport: true }),
    verifyStopped: async () => true,
    checkpoint: async () => true,
    journal: async (event) => { stages.push(event.stage); journalEvents.push(event); },
    ...overrides
  };
  value.stats = () => ({ stages, backupCalls, restoreCalls, rollbackCalls });
  value.events = () => journalEvents;
  return value;
}

(async () => {
  assert.equal(manifest.fingerprints.schemaCatalogSha256, SUPPORTED_PROFILE.sourcePortableSchemaSha256, "the package must record the source-portable schema fingerprint");
  assert.equal(preflight.compatibility.schemaCatalogSha256, SUPPORTED_PROFILE.freshDestinationSchemaSha256, "pre-import compatibility must use the clean destination fingerprint");
  assert.notEqual(manifest.fingerprints.schemaCatalogSha256, preflight.compatibility.schemaCatalogSha256, "source and destination fingerprints are not required to match before restore");
  const liveShapedCompatibility = {
    ...preflight.compatibility,
    extensions: [
      { name: "pg_trgm", version: "1.6", schema: "ext", ownerClass: "extension-owner", membershipCount: "47", membershipSha256: "1f3521893a3ba294fd3f4758c56d77824c0449335291a5e67c0954c739d38a3a" },
      { name: "pgcrypto", version: "1.3", schema: "ext", ownerClass: "extension-owner", membershipCount: "36", membershipSha256: "b2ae449dc977aecf06e65b71eaf2ea35bc853ac59ee28312faf1a8540e0a0c82" }
    ]
  };
  assert.equal(validateExactCompatibility(liveShapedCompatibility), true, "rich live extension evidence is compared only by explicitly pinned name/version semantics and is order-independent");
  assert.equal(exactCompatibilityPredicates(liveShapedCompatibility).every((row) => row.ok), true);
  assert.throws(() => validateExactCompatibility({ ...liveShapedCompatibility, extensions: liveShapedCompatibility.extensions.map((row) => row.name === "pgcrypto" ? { ...row, version: "1.2" } : row) }), (error) => {
    assert.equal(error.details.field, "extensions");
    assert.match(error.message, /field extensions differs/);
    assert.match(error.message, /pgcrypto/);
    assert.match(error.message, /1\.2/);
    return true;
  });
  validateDestinationPreflight(preflight);
  assert.throws(() => validateDestinationPreflight({ ...preflight, outsideDune: { ...outsideDune, extensionSetSha256: digest("0") } }), /digest is inconsistent/);
  for (const changed of [
    { battlegroup: { offline: false, runningGameWorkloads: "1" } },
    { database: { unexpectedWriters: "1", openTransactions: "0" } },
    { fresh: { ...preflight.fresh, authoritativeRows: "1" } },
    { fresh: { ...preflight.fresh, marketBotTablesPresent: "1" } }
  ]) assert.throws(() => validateDestinationPreflight({ ...preflight, ...changed }));
  assert.throws(() => validateDestinationPreflight({ ...preflight, compatibility: { ...preflight.compatibility, schemaCatalogSha256: SUPPORTED_PROFILE.sourcePortableSchemaSha256 } }), /field schemaCatalogSha256 differs/, "a source-portable schema is not a valid fresh pre-import destination and the public failure identifies the field");
  const successOptions = options();
  const success = await runServerMigrationImport(successOptions);
  assert.equal(success.ok, true); assert.equal(success.rolledBack, false);
  assert.equal(RESTORE_FLAGS.includes("--clean"), false, "migration restoration must never ask pg_restore to clean partition leaves");
  assert.deepEqual(RESTORE_FLAGS, ["--exit-on-error", "--schema=dune", "--no-owner", "--no-privileges"]);
  assert.deepEqual(successOptions.stats(), { stages: ["inspecting-package", "destination-preflight", "destination-rollback-backup", "complete-archive-read", "restoring", "destination-market-cleanup", "post-restore-verification", "complete"], backupCalls: 1, restoreCalls: 1, rollbackCalls: 0 });
  const wrongBackupProfile = options({ verifyRollbackBackup: async () => ({ validationProfile: BACKUP_INVENTORY_PROFILES.MIGRATION_PACKAGE, sha256: digest("9"), size: "4603966", archiveReadVerified: true, completeDune: true, alphaTables: [] }) });
  await assert.rejects(() => runServerMigrationImport(wrongBackupProfile), (error) => error.code === "migration_rollback_backup_invalid");
  assert.equal(wrongBackupProfile.stats().restoreCalls, 0, "a dune-only archive cannot satisfy destination rollback protection");

  let readinessAttempts = 0;
  const recoveredEntry = options({
    inspectPackage: async () => {
      const execution = await runReadOnlySshWithRetry({
        maxRetries: 2,
        sleep: async () => {},
        execute: async () => (++readinessAttempts === 1
          ? { ok: false, code: 255, stderr: "" }
          : { ok: true, code: 0, stdout: "complete-ready-checkpoint", stderr: "" })
      });
      if (!execution.result.ok) throw new Error("import readiness unavailable");
      return packageData;
    }
  });
  await runServerMigrationImport(recoveredEntry);
  assert.equal(readinessAttempts, 2, "internal import readiness retries one transient exit 255 and then continues");
  assert.equal(recoveredEntry.stats().backupCalls, 1, "rollback backup begins only after the recovered complete readiness check");

  readinessAttempts = 0;
  const exhaustedEntry = options({
    inspectPackage: async () => {
      const execution = await runReadOnlySshWithRetry({
        maxRetries: 2,
        sleep: async () => {},
        execute: async () => { readinessAttempts += 1; return { ok: false, code: 255, stderr: "" }; }
      });
      if (!execution.result.ok) throw new Error("import readiness retries exhausted");
      return packageData;
    }
  });
  await assert.rejects(() => runServerMigrationImport(exhaustedEntry), /retries exhausted/);
  assert.equal(readinessAttempts, 3, "import readiness permits the initial process plus at most two fresh attempts");
  assert.deepEqual(exhaustedEntry.stats(), { stages: ["inspecting-package", "failed"], backupCalls: 0, restoreCalls: 0, rollbackCalls: 0 });

  let backupFailureCalls = 0;
  const backupTransportFailure = options({ createRollbackBackup: async () => { backupFailureCalls += 1; throw new Error("ssh exit 255 during backup"); } });
  await assert.rejects(() => runServerMigrationImport(backupTransportFailure), /ssh exit 255 during backup/);
  assert.equal(backupFailureCalls, 1, "rollback-backup creation is never retried");
  assert.equal(backupTransportFailure.stats().restoreCalls, 0);

  let restoreFailureCalls = 0;
  const restoreTransportFailure = options({ restorePackage: async () => { restoreFailureCalls += 1; throw new Error("ssh exit 255 during restore"); } });
  await assert.rejects(() => runServerMigrationImport(restoreTransportFailure), (error) => error.code === "migration_import_rolled_back");
  assert.equal(restoreFailureCalls, 1, "restore is never retried after the modification boundary begins");
  assert.equal(restoreTransportFailure.stats().rollbackCalls, 1, "a failed started restore uses the one verified rollback path instead of retrying restore");


  const preMutation = options({ readArchiveCompletely: async () => ({ ok: false, matchingVersion: true }) });
  await assert.rejects(() => runServerMigrationImport(preMutation), (error) => error.code === "migration_archive_read_failed");
  assert.equal(preMutation.stats().rollbackCalls, 0, "Failure before restore must not run rollback.");

  const postMutation = options({ verifyRestored: async () => ({ ...restored, entityCounts: { ...entityCounts, accounts: "1" } }) });
  await assert.rejects(() => runServerMigrationImport(postMutation), (error) => error.code === "migration_import_rolled_back");
  assert.equal(postMutation.stats().backupCalls, 1); assert.equal(postMutation.stats().rollbackCalls, 1);

  const restoredWithFreshDestinationFingerprint = options({ verifyRestored: async () => ({ ...restored, fingerprints: { ...restored.fingerprints, schemaCatalogSha256: SUPPORTED_PROFILE.freshDestinationSchemaSha256 } }) });
  await assert.rejects(() => runServerMigrationImport(restoredWithFreshDestinationFingerprint), (error) => error.code === "migration_import_rolled_back");
  assert.equal(restoredWithFreshDestinationFingerprint.stats().rollbackCalls, 1, "post-restore verification must require the package's source-portable fingerprint");

  const cleanupFailure = options({ cleanupDestinationMarket: async () => { throw Object.assign(new Error("pending settlement"), { code: "migration_destination_market_failed" }); } });
  await assert.rejects(() => runServerMigrationImport(cleanupFailure), (error) => error.code === "migration_import_rolled_back");
  assert.equal(cleanupFailure.stats().rollbackCalls, 1, "Any destination cleanup rejection after restore must automatically restore the verified backup.");

  const finalVerificationFailure = options({ verifyFinal: async () => restored });
  await assert.rejects(() => runServerMigrationImport(finalVerificationFailure), (error) => error.code === "migration_import_rolled_back");
  assert.equal(finalVerificationFailure.stats().rollbackCalls, 1, "A non-empty destination after committed cleanup must automatically restore the verified backup.");

  const rollbackFailure = options({ restorePackage: async () => { throw new Error("transfer interrupted"); }, restoreRollback: async () => { throw new Error("rollback interrupted"); } });
  await assert.rejects(() => runServerMigrationImport(rollbackFailure), (error) => error.code === "migration_rollback_failed");

  const retainedRollbackFailure = options({
    restorePackage: async () => { throw new Error("package restore failed"); },
    restoreRollback: async () => { throw new MigrationSchemaRestoreError("atomic restore failed", "migration_pod_archive_atomic_dune_restore", { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "ERROR: inherited partition constraint conflict" }); }
  });
  await assert.rejects(() => runServerMigrationImport(retainedRollbackFailure), (error) => error.code === "migration_rollback_failed" && error.details.process.exitCode === 1 && /inherited partition/.test(error.details.process.stderr));
  const retainedEvent = retainedRollbackFailure.events().at(-1);
  assert.equal(retainedEvent.stage, "failed");
  assert.equal(retainedEvent.process.exitCode, 1, "the durable failed journal event retains the child exit code");
  assert.match(retainedEvent.process.stderr, /inherited partition constraint conflict/);

  const crossSchemaDependency = options({ assertCrossSchemaSafe: async () => { throw Object.assign(new Error("outside dependency"), { code: "migration_cross_schema_dependency_present" }); } });
  await assert.rejects(() => runServerMigrationImport(crossSchemaDependency), (error) => error.code === "migration_cross_schema_dependency_present");
  assert.equal(crossSchemaDependency.stats().restoreCalls, 0, "cross-schema dependencies block before the modification boundary");
  assert.equal(crossSchemaDependency.stats().rollbackCalls, 0);

  let outsideReads = 0;
  const outsideChanged = options({ verifyOutsideDune: async () => (++outsideReads === 2 ? { ...outsideDune, sha256: digest("d") } : outsideDune) });
  await assert.rejects(() => runServerMigrationImport(outsideChanged), (error) => error.code === "migration_import_rolled_back");
  assert.equal(outsideChanged.stats().rollbackCalls, 1, "outside-dune drift after restore invokes the verified rollback path");

  const changedOffline = options({ checkpoint: async (stage) => { if (stage === "after database restore") throw Object.assign(new Error("changed"), { code: "migration_offline_checkpoint_changed" }); } });
  await assert.rejects(() => runServerMigrationImport(changedOffline), (error) => error.code === "migration_import_rolled_back");
  assert.equal(changedOffline.stats().rollbackCalls, 1, "Offline-mode drift after mutation must trigger rollback.");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a9-import-journal-"));
  try { const journal = new ImportJournal(path.join(dir, "import.json"), () => "2026-08-04T10:00:00.000Z"); journal.write({ stage: "restoring", packageSha256: digest("a"), backupSha256: digest("b"), packageSize: "9007199254740993" }); assert.equal(canonicalJson(JSON.parse(fs.readFileSync(path.join(dir, "import.json"), "utf8"))), canonicalJson(JSON.parse(fs.readFileSync(path.join(dir, "import.json.previous"), "utf8")))); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log("Server Migration import preflight, exact compatibility, backup, archive-read, bigint, restore, rollback, and journal tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
