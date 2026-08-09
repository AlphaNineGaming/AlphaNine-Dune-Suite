"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { BACKUP_INVENTORY_PROFILES } = require("./database-backup");
const { canonicalJson } = require("./migration-package");
const { SUPPORTED_PROFILE, validateMigrationManifest, validateVerificationEvidence } = require("./server-migration");
const { emptyDestinationMarketEvidence, validateDestinationCleanupResult, validateSourceMarketEvidence } = require("./migration-destination-market");

const IMPORT_CONFIRMATION = "IMPORT SERVER MIGRATION PACKAGE";
const { DUNE_RESTORE_FLAGS, assertOutsideDuneBoundaryUnchanged, normalizeStoredOutsideBoundary, sanitizeChildDiagnostic } = require("./migration-schema-restore");
const RESTORE_FLAGS = DUNE_RESTORE_FLAGS;
const ROLLBACK_FLAGS = DUNE_RESTORE_FLAGS;
const STAGES = Object.freeze({
  INSPECTING: "inspecting-package", PREFLIGHT: "destination-preflight", BACKUP: "destination-rollback-backup",
  ARCHIVE_READ: "complete-archive-read", RESTORING: "restoring", MARKET_CLEANUP: "destination-market-cleanup", VERIFYING: "post-restore-verification",
  ROLLING_BACK: "automatic-rollback", COMPLETE: "complete", ROLLED_BACK: "rolled-back", FAILED: "failed"
});

class MigrationImportError extends Error {
  constructor(message, code = "migration_import_failed", details = {}) { super(message); this.name = "MigrationImportError"; this.code = code; this.details = details; }
}

function decimal(value, label) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new MigrationImportError(`${label} must be an exact decimal string.`, "migration_import_bigint_invalid");
  return BigInt(text).toString(10);
}

function digest(value, label) {
  const text = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(text)) throw new MigrationImportError(`${label} is not a SHA-256 digest.`, "migration_import_digest_invalid");
  return text;
}

function compatibilityExtensionIdentities(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => ({ name: String(row?.name || ""), version: String(row?.version || "") }))
    .sort((left, right) => left.name < right.name ? -1 : (left.name > right.name ? 1 : (left.version < right.version ? -1 : (left.version > right.version ? 1 : 0))));
}

function exactCompatibilityPredicates(facts, profile = SUPPORTED_PROFILE) {
  const actual = facts && typeof facts === "object" ? facts : {};
  const pairs = [
    ["gameBuild", String(profile.gameBuild || ""), String(actual.gameBuild || "")],
    ["postgresMajor", String(profile.postgresMajor || ""), String(actual.postgresMajor || "")],
    ["restoreToolMajor", String(profile.dumpToolMajor || ""), String(actual.restoreToolMajor || "")],
    ["schemaCatalogSha256", String(profile.freshDestinationSchemaSha256 || ""), String(actual.schemaCatalogSha256 || "")],
    ["appliedPatchSha256", String(profile.appliedPatchSha256 || ""), String(actual.appliedPatchSha256 || "")],
    ["extensions", compatibilityExtensionIdentities(profile.extensions), compatibilityExtensionIdentities(actual.extensions)]
  ];
  return pairs.map(([field, expected, received]) => ({ field, expected, actual: received, ok: canonicalJson(expected) === canonicalJson(received) }));
}

function validateExactCompatibility(facts, profile = SUPPORTED_PROFILE) {
  const failed = exactCompatibilityPredicates(facts, profile).find((predicate) => !predicate.ok);
  if (failed) {
    const expected = canonicalJson(failed.expected);
    const actual = canonicalJson(failed.actual);
    throw new MigrationImportError(`Destination compatibility field ${failed.field} differs: expected ${expected}; actual ${actual}.`, "migration_destination_incompatible", { field: failed.field, expected: failed.expected, actual: failed.actual });
  }
  return true;
}

function validateFreshDestination(fresh) {
  if (!fresh || typeof fresh !== "object") throw new MigrationImportError("Fresh-destination evidence is missing.", "migration_destination_not_fresh");
  if (decimal(fresh.authoritativeRows, "authoritative row count") !== "0" || decimal(fresh.relationalInvalidity, "relational invalidity") !== "0") throw new MigrationImportError("Destination contains authoritative state or relational invalidity.", "migration_destination_not_fresh");
  if (decimal(fresh.marketBotTablesPresent, "destination Market Bot table count") !== "0") throw new MigrationImportError("Destination must not require or contain Market Bot tables.", "migration_destination_not_fresh");
  return true;
}

function validateDestinationPreflight(evidence, profile = SUPPORTED_PROFILE) {
  if (evidence?.offlineMode?.active !== true || evidence.offlineMode.failClosed === true) throw new MigrationImportError("Migration Offline Mode is not healthy and active.", "migration_offline_required");
  if (evidence?.battlegroup?.offline !== true || String(evidence.battlegroup.runningGameWorkloads) !== "0") throw new MigrationImportError("Destination battlegroup is not authoritatively stopped.", "migration_destination_online");
  for (const field of ["unexpectedWriters", "openTransactions"]) if (decimal(evidence?.database?.[field], field) !== "0") throw new MigrationImportError("Destination has an unexpected writer or open transaction.", "migration_destination_writer");
  if (evidence.conflictingOperations !== false) throw new MigrationImportError("A conflicting Suite or vendor operation is active.", "migration_operation_conflict");
  if (evidence.automaticRestartDisabled !== true) throw new MigrationImportError("Automatic restart scheduling is active or ambiguous.", "migration_automatic_restart_active");
  validateExactCompatibility(evidence.compatibility, profile);
  normalizeStoredOutsideBoundary(evidence.outsideDune);
  validateFreshDestination(evidence.fresh);
  return true;
}

function compareRestoredEvidence(manifest, verification, restored) {
  validateMigrationManifest(manifest);
  validateVerificationEvidence(verification, manifest);
  if (!restored || typeof restored !== "object") throw new MigrationImportError("Post-restore evidence is missing.", "migration_restore_verification");
  const comparisons = {
    fingerprints: canonicalJson(restored.fingerprints) === canonicalJson(manifest.fingerprints),
    entityCounts: canonicalJson(restored.entityCounts) === canonicalJson(manifest.entityCounts),
    sourceMarket: canonicalJson(restored.sourceMarket) === canonicalJson(manifest.sourceMarket),
    relationships: canonicalJson(restored.relationships) === canonicalJson(verification.relationships),
    sequences: canonicalJson(restored.sequences) === canonicalJson(verification.sequences)
  };
  if (Object.values(comparisons).some((value) => !value) || restored.relationalInvalidity !== "0") throw new MigrationImportError("Restored database evidence does not exactly match the migration package.", "migration_restore_verification", { comparisons });
  return comparisons;
}

function expectedFinalEntityCounts(sourceCounts, deletedListings) {
  const deleted = BigInt(decimal(deletedListings, "deleted listing count"));
  const result = { ...sourceCounts };
  for (const key of ["exchangeOrders", "exchangeSellOrders", "items"]) {
    const before = BigInt(decimal(result[key], `${key} source count`));
    if (before < deleted) throw new MigrationImportError("Destination cleanup count exceeds the restored source entity count.", "migration_restore_verification");
    result[key] = (before - deleted).toString(10);
  }
  return result;
}

function compareFinalEvidence(manifest, verification, finalEvidence, cleanupResult) {
  const cleanup = validateDestinationCleanupResult(cleanupResult, manifest.sourceMarket);
  const expectedMarket = emptyDestinationMarketEvidence(manifest.sourceMarket);
  const expectedCounts = expectedFinalEntityCounts(manifest.entityCounts, cleanup.deletedListings);
  const comparisons = {
    fingerprints: canonicalJson(finalEvidence?.fingerprints) === canonicalJson(manifest.fingerprints),
    entityCounts: canonicalJson(finalEvidence?.entityCounts) === canonicalJson(expectedCounts),
    destinationMarket: canonicalJson(finalEvidence?.sourceMarket) === canonicalJson(expectedMarket),
    relationships: canonicalJson(finalEvidence?.relationships) === canonicalJson(verification.relationships),
    sequences: canonicalJson(finalEvidence?.sequences) === canonicalJson(verification.sequences)
  };
  if (Object.values(comparisons).some((value) => !value) || finalEvidence?.relationalInvalidity !== "0") throw new MigrationImportError("Final destination evidence does not match the verified restore and market-cleanup boundary.", "migration_restore_verification", { comparisons });
  return comparisons;
}

class ImportJournal {
  constructor(filePath, now = () => new Date().toISOString()) { this.filePath = path.resolve(filePath); this.recoveryPath = `${this.filePath}.previous`; this.now = now; }
  write(value) {
    const body = { version: 1, ...value, updatedAt: this.now() };
    const bytes = `${JSON.stringify(body, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.partial-${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const handle = fs.openSync(temporary, "r+"); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    try { fs.renameSync(temporary, this.filePath); } finally { fs.rmSync(temporary, { force: true }); }
    fs.copyFileSync(this.filePath, this.recoveryPath);
    return body;
  }
}

async function runServerMigrationImport(options = {}) {
  const requiredFunctions = ["inspectPackage", "preflight", "createRollbackBackup", "verifyRollbackBackup", "readArchiveCompletely", "captureOutsideDune", "assertCrossSchemaSafe", "verifyOutsideDune", "restorePackage", "verifyRestored", "cleanupDestinationMarket", "verifyFinal", "restoreRollback", "verifyRollback", "verifyStopped", "checkpoint"];
  for (const name of requiredFunctions) if (typeof options[name] !== "function") throw new MigrationImportError(`Import implementation is missing ${name}.`, "migration_import_implementation");
  if (options.confirmText !== IMPORT_CONFIRMATION) throw new MigrationImportError(`Type ${IMPORT_CONFIRMATION} exactly.`, "confirmation_required");
  const transition = async (stage, extra = {}) => { await options.journal?.({ stage, ...extra }); await options.onStage?.(stage, extra); };
  let backup = null;
  let restoreStarted = false;
  let packageData = null;
  let outsideDune = null;
  try {
    await transition(STAGES.INSPECTING);
    packageData = await options.inspectPackage();
    validateMigrationManifest(packageData.manifest);
    validateVerificationEvidence(packageData.verification, packageData.manifest);
    digest(packageData.wholePackageSha256, "whole-package SHA-256");
    decimal(packageData.wholePackageSize, "whole-package size");
    await options.checkpoint("after package validation");

    await transition(STAGES.PREFLIGHT);
    const preflight = await options.preflight(packageData);
    validateDestinationPreflight(preflight);
    await options.verifyStopped("before destination backup");
    await options.checkpoint("before destination rollback backup");
    outsideDune = normalizeStoredOutsideBoundary(await options.captureOutsideDune("before destination rollback backup"));
    assertOutsideDuneBoundaryUnchanged(preflight.outsideDune, outsideDune);

    await transition(STAGES.BACKUP);
    backup = await options.createRollbackBackup();
    const verifiedBackup = await options.verifyRollbackBackup(backup);
    digest(verifiedBackup.sha256, "rollback-backup SHA-256");
    decimal(verifiedBackup.size, "rollback-backup size");
    if (verifiedBackup.validationProfile !== BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK || verifiedBackup.archiveReadVerified !== true || verifiedBackup.completeDune !== true || (verifiedBackup.alphaTables || []).length !== 0) throw new MigrationImportError("Destination rollback backup is incomplete, unreadable, not a complete-database backup, or unexpectedly requires Market Bot tables.", "migration_rollback_backup_invalid");
    await options.checkpoint("after destination rollback backup verification");

    await transition(STAGES.ARCHIVE_READ);
    const archiveRead = await options.readArchiveCompletely(packageData);
    if (archiveRead?.ok !== true || archiveRead?.matchingVersion !== true) throw new MigrationImportError("Migration archive did not pass the complete matching-version read.", "migration_archive_read_failed");
    await options.checkpoint("before database restore");
    await options.verifyStopped("immediately before database restore");
    assertOutsideDuneBoundaryUnchanged(outsideDune, await options.verifyOutsideDune("before database restore"));
    await options.assertCrossSchemaSafe("before database restore");

    await transition(STAGES.RESTORING);
    restoreStarted = true;
    await options.restorePackage(packageData, RESTORE_FLAGS);
    assertOutsideDuneBoundaryUnchanged(outsideDune, await options.verifyOutsideDune("after database restore"));
    await options.checkpoint("after database restore");
    await options.verifyStopped("after database restore");

    const restored = await options.verifyRestored(packageData);
    compareRestoredEvidence(packageData.manifest, packageData.verification, restored);
    await transition(STAGES.MARKET_CLEANUP);
    await options.checkpoint("before destination market cleanup transaction");
    await options.verifyStopped("before destination market cleanup transaction");
    const cleanup = validateDestinationCleanupResult(await options.cleanupDestinationMarket(packageData), packageData.manifest.sourceMarket);
    await options.checkpoint("after destination market cleanup transaction");

    await transition(STAGES.VERIFYING);
    const finalEvidence = await options.verifyFinal(packageData, cleanup);
    const comparisons = compareFinalEvidence(packageData.manifest, packageData.verification, finalEvidence, cleanup);
    await options.checkpoint("before import completion publication");
    await options.verifyStopped("at import completion");
    await transition(STAGES.COMPLETE, { rollbackBackup: { size: verifiedBackup.size, sha256: verifiedBackup.sha256 }, cleanup, comparisons });
    return { ok: true, stage: STAGES.COMPLETE, rolledBack: false, rollbackBackup: verifiedBackup, cleanup, comparisons };
  } catch (error) {
    if (!restoreStarted || !backup) {
      await transition(STAGES.FAILED, { code: error.code || "migration_import_failed" });
      throw error;
    }
    try {
      await transition(STAGES.ROLLING_BACK, { cause: error.code || "migration_import_failed" });
      await options.checkpoint("before automatic rollback");
      await options.assertCrossSchemaSafe("before automatic rollback");
      await options.restoreRollback(backup, ROLLBACK_FLAGS);
      assertOutsideDuneBoundaryUnchanged(outsideDune, await options.verifyOutsideDune("after automatic rollback"));
      const rollbackEvidence = await options.verifyRollback(backup);
      if (rollbackEvidence?.matchesPreImport !== true) throw new MigrationImportError("Rollback verification does not match the pre-import destination.", "migration_rollback_verification_failed");
      await options.verifyStopped("after automatic rollback");
      await transition(STAGES.ROLLED_BACK, { cause: error.code || "migration_import_failed" });
      throw new MigrationImportError("Import failed and the verified destination rollback was restored.", "migration_import_rolled_back", { cause: error.code || "migration_import_failed" });
    } catch (rollbackError) {
      if (rollbackError?.code === "migration_import_rolled_back") throw rollbackError;
      const process = rollbackError?.details && typeof rollbackError.details === "object" ? {
        stage: String(rollbackError.details.stage || "automatic rollback restore"),
        code: String(rollbackError.code || "rollback_failed"),
        exitCode: Number.isInteger(rollbackError.details.exitCode) ? rollbackError.details.exitCode : null,
        signal: rollbackError.details.signal || null,
        timedOut: rollbackError.details.timedOut === true,
        stdout: sanitizeChildDiagnostic(rollbackError.details.stdout || ""),
        stderr: sanitizeChildDiagnostic(rollbackError.details.stderr || rollbackError.message || "rollback failed")
      } : { stage: "automatic rollback restore", code: String(rollbackError?.code || "rollback_failed"), exitCode: null, signal: null, timedOut: false, stdout: "", stderr: sanitizeChildDiagnostic(rollbackError?.message || "rollback failed") };
      await transition(STAGES.FAILED, { code: "migration_rollback_failed", process });
      throw new MigrationImportError("Import failed and automatic rollback could not be verified. Keep the destination stopped.", "migration_rollback_failed", { importCause: error.code || "migration_import_failed", rollbackCause: rollbackError.code || "rollback_failed", process });
    }
  }
}

module.exports = { IMPORT_CONFIRMATION, ImportJournal, MigrationImportError, RESTORE_FLAGS, ROLLBACK_FLAGS, STAGES, compareFinalEvidence, compareRestoredEvidence, compatibilityExtensionIdentities, decimal, exactCompatibilityPredicates, expectedFinalEntityCounts, runServerMigrationImport, validateDestinationPreflight, validateExactCompatibility, validateFreshDestination };
