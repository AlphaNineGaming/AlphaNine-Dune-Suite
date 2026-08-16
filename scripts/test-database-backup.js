"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Writable } = require("stream");
const {
  BACKUP_INVENTORY_PROFILES,
  FULL_BACKUP_ALPHA_TABLES,
  buildExpectedBackupInventory,
  decimalString,
  parsePgRestoreToc,
  resolveVendorArtifactIdentity,
  validateFullBackupToc,
  validatePgDumpHeader,
  validateSchemaOnlyBackupToc,
  validateStableSamples,
  validateVendorTerminalOperation,
  verifyMatchingArchive,
  writeJsonAtomic
} = require("../lib/database-backup");
const { publishVerifiedPackage, streamCommandToFile } = require("../lib/server-migration-export");
const { CODEX_BACKUP_ARTIFACTS, CODEX_BACKUP_SEQUENCES } = require("../lib/server-migration");

function operation(phase = "Succeeded", backup = "/safe/operation-1.backup") {
  return { metadata: { name: "operation-1" }, spec: { action: "dump", backup }, status: { phase, conditions: [] } };
}

function tocLine(id, descriptor, fields, owner = "postgres") {
  return `${id}; 1259 ${1000 + id} ${descriptor} ${fields}${owner === null ? "" : ` ${owner}`}`;
}

function schemaFixture() {
  let id = 1;
  const rows = [
    tocLine(id++, "EXTENSION", "- pgcrypto"),
    tocLine(id++, "COMMENT", "- EXTENSION pgcrypto"),
    tocLine(id++, "EXTENSION", "- pg_trgm"),
    tocLine(id++, "COMMENT", "- EXTENSION pg_trgm"),
    tocLine(id++, "SCHEMA", "- dune"),
    tocLine(id++, "TYPE", "dune custom_type"),
    tocLine(id++, "DOMAIN", "dune positive_number"),
    tocLine(id++, "FUNCTION", "dune calculate(integer)"),
    tocLine(id++, "PROCEDURE", "dune refresh_world()"),
    tocLine(id++, "TABLE", "dune parent_table"),
    tocLine(id++, "TABLE", "dune child_partition"),
    tocLine(id++, "TABLE ATTACH", "dune child_partition"),
    tocLine(id++, "TABLE", "dune orders"),
    tocLine(id++, "TABLE", 'dune "Quoted Table"'),
    tocLine(id++, "VIEW", "dune order_view"),
    tocLine(id++, "MATERIALIZED VIEW", "dune order_summary"),
    tocLine(id++, "SEQUENCE", "dune orders_id_seq"),
    tocLine(id++, "SEQUENCE OWNED BY", "dune orders_id_seq"),
    // Identity ownership may be embedded in the table definition and therefore
    // does not universally create a separate SEQUENCE OWNED BY TOC entry.
    tocLine(id++, "SEQUENCE", "dune identity_id_seq"),
    tocLine(id++, "DEFAULT", "dune orders id"),
    // Primary/unique/exclusion backing indexes are represented by constraints,
    // never by independent INDEX entries.
    tocLine(id++, "CONSTRAINT", "dune orders orders_pkey"),
    tocLine(id++, "CONSTRAINT", "dune orders orders_external_key_key"),
    tocLine(id++, "CONSTRAINT", "dune orders orders_no_overlap"),
    tocLine(id++, "FK CONSTRAINT", "dune orders orders_parent_id_fkey"),
    tocLine(id++, "INDEX", "dune orders_created_idx"),
    tocLine(id++, "INDEX", "dune child_partition_created_idx"),
    tocLine(id++, "INDEX ATTACH", "dune child_partition_created_idx"),
    tocLine(id++, "TRIGGER", "dune orders orders_audit_trigger"),
    ...FULL_BACKUP_ALPHA_TABLES.map((table) => tocLine(id++, "TABLE", `public ${table}`))
  ];
  return rows.join("\n");
}

function catalogFixture() {
  return { dataEntries: [
    { descriptor: "TABLE DATA", schema: "dune", name: "child_partition" },
    { descriptor: "TABLE DATA", schema: "dune", name: "orders" },
    { descriptor: "TABLE DATA", schema: "dune", name: "Quoted Table" },
    { descriptor: "MATERIALIZED VIEW DATA", schema: "dune", name: "order_summary" },
    { descriptor: "SEQUENCE SET", schema: "dune", name: "orders_id_seq" },
    { descriptor: "SEQUENCE SET", schema: "dune", name: "identity_id_seq" },
    // Production-shaped identity state: pg_dump can carry a SEQUENCE SET data
    // entry even when schema-only representation is embedded in TABLE syntax.
    { descriptor: "SEQUENCE SET", schema: "dune", name: "implicit_identity_id_seq" },
    ...FULL_BACKUP_ALPHA_TABLES.map((name) => ({ descriptor: "TABLE DATA", schema: "public", name }))
  ] };
}

function fullFixture(schema = schemaFixture()) {
  let id = 100;
  return `${schema}\n${[
    tocLine(id++, "TABLE DATA", "dune child_partition"),
    tocLine(id++, "TABLE DATA", "dune orders"),
    tocLine(id++, "TABLE DATA", 'dune "Quoted Table"'),
    tocLine(id++, "MATERIALIZED VIEW DATA", "dune order_summary"),
    tocLine(id++, "SEQUENCE SET", "dune orders_id_seq"),
    tocLine(id++, "SEQUENCE SET", "dune identity_id_seq"),
    tocLine(id++, "SEQUENCE SET", "dune implicit_identity_id_seq"),
    ...FULL_BACKUP_ALPHA_TABLES.map((table) => tocLine(id++, "TABLE DATA", `public ${table}`))
  ].join("\n")}`;
}

async function main() {
  validateVendorTerminalOperation(operation(), "operation-1");
  assert.throws(() => validateVendorTerminalOperation(operation("Ongoing"), "operation-1"), /not in an unambiguous successful terminal state/);
  assert.throws(() => validateVendorTerminalOperation(operation(""), "operation-1"), /missing/);
  assert.throws(() => validateVendorTerminalOperation({ ...operation(), status: { phase: "Succeeded", conditions: [{ type: "Failed", status: "True" }] } }), /failing terminal condition/);
  assert.strictEqual(resolveVendorArtifactIdentity(operation(), "/safe/operation-1.backup").fileName, "operation-1.backup");
  assert.deepStrictEqual(
    resolveVendorArtifactIdentity(operation(), ""),
    { path: "/safe/operation-1.backup", fileName: "operation-1.backup", operationReference: "/safe/operation-1.backup", source: "database-operation" }
  );
  assert.throws(() => resolveVendorArtifactIdentity({ ...operation(), spec: { backup: ["/safe/one.backup", "/safe/two.backup"] } }, ""), /unambiguous absolute backup artifact path/);
  assert.throws(() => resolveVendorArtifactIdentity(operation(), "/safe/stale.backup"), /could not be resolved unambiguously/);

  assert.deepStrictEqual(validateStableSamples([
    { size: "900719925474099312345", modified: "1", identity: "7:8" },
    { size: "900719925474099312345", modified: "1", identity: "7:8" }
  ]), { size: "900719925474099312345", modified: "1", identity: "7:8" });
  assert.strictEqual(decimalString("900719925474099312345"), "900719925474099312345");
  assert.throws(() => validateStableSamples([{ size: "10", modified: "1" }, { size: "11", modified: "2" }]), /still changing/);
  validatePgDumpHeader(Buffer.from("PGDMP\u0001\u0010", "binary"));

  const schema = schemaFixture();
  const full = fullFixture(schema);
  const inventory = buildExpectedBackupInventory(schema, catalogFixture(), { validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK });
  assert(!parsePgRestoreToc(schema).some((entry) => ["TABLE DATA", "SEQUENCE SET", "MATERIALIZED VIEW DATA"].includes(entry.descriptor)), "schema-only inventory fixture must contain no data entries");
  assert(inventory.dataDefinitions.some((definition) => definition.includes("implicit_identity_id_seq")), "catalog-derived identity state must be deferred to the full archive instead of rejected against schema-only TOC");
  const verified = validateFullBackupToc(full, inventory);
  assert.strictEqual(verified.valid, true);
  assert.strictEqual(verified.validationProfile, BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK);
  assert.deepStrictEqual(verified.requiredExtensions, ["pgcrypto", "pg_trgm"]);
  assert.strictEqual(Object.hasOwn(verified, "archiveReadVerified"), false, "TOC matching alone must never claim full archive-read verification");

  // Clean destination shape: public schema metadata and required extensions are
  // part of the complete rollback boundary, while the portable package remains
  // strictly dune-only.
  const cleanDestinationSchema = [
    tocLine(700, "ENCODING", "UTF8", null),
    tocLine(701, "STDSTRINGS", "on", null),
    tocLine(702, "SEARCHPATH", "''", null),
    tocLine(703, "SCHEMA", "- public"),
    tocLine(704, "EXTENSION", "- pgcrypto", null),
    tocLine(705, "COMMENT", "- EXTENSION pgcrypto", null),
    tocLine(706, "EXTENSION", "- pg_trgm", null),
    tocLine(707, "COMMENT", "- EXTENSION pg_trgm", null),
    tocLine(708, "SCHEMA", "- dune"),
    tocLine(709, "TABLE", "dune bootstrap_marker")
  ].join("\n");
  const cleanCatalog = { dataEntries: [{ descriptor: "TABLE DATA", schema: "dune", name: "bootstrap_marker" }] };
  const cleanInventory = buildExpectedBackupInventory(cleanDestinationSchema, cleanCatalog, { validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK });
  const cleanParsed = parsePgRestoreToc(cleanDestinationSchema);
  assert.deepStrictEqual(cleanParsed.filter((entry) => entry.descriptor === "EXTENSION").map((entry) => entry.fields[1]), ["pgcrypto", "pg_trgm"], "ownerless extension TOC entries must retain their semantic name");
  assert.deepStrictEqual(cleanParsed.filter((entry) => entry.descriptor === "COMMENT").map((entry) => entry.fields.at(-1)), ["pgcrypto", "pg_trgm"], "ownerless extension comments must retain their semantic target");
  const cleanFull = `${cleanDestinationSchema}\n${tocLine(710, "TABLE DATA", "dune bootstrap_marker")}`;
  assert.strictEqual(validateFullBackupToc(cleanFull, cleanInventory).valid, true, "ordinary Funcom backups must not require optional AlphaNine Market Bot tables");
  assert.strictEqual(validateFullBackupToc(cleanFull, cleanInventory, { requiredAlphaTables: [] }).valid, true);
  assert.throws(() => validateSchemaOnlyBackupToc(cleanDestinationSchema, { validationProfile: BACKUP_INVENTORY_PROFILES.MIGRATION_PACKAGE }), /outside dune \(COMMENT=2, EXTENSION=2, SCHEMA=1\)/, "migration-package validation must reject the exact clean-destination outside-dune descriptors");
  assert.throws(() => buildExpectedBackupInventory(cleanDestinationSchema.replace(`${tocLine(704, "EXTENSION", "- pgcrypto", null)}\n`, ""), cleanCatalog, { validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK }), /missing required extension objects: pgcrypto/);
  assert.throws(() => validateFullBackupToc(`${cleanFull}\n${tocLine(710, "TABLE DATA", "dune bootstrap_marker")}`, cleanInventory, { requiredAlphaTables: [] }), /duplicate TOC entries \(TABLE DATA=1\)/);
  assert.throws(() => validateFullBackupToc(`${cleanFull}\n${tocLine(711, "TABLE", "public unexpected_table")}`, cleanInventory, { requiredAlphaTables: [] }), /unexpected schema object/);

  const parsed = parsePgRestoreToc(schema);
  assert(parsed.some((entry) => entry.descriptor === "CONSTRAINT" && entry.fields.includes("orders_pkey")));
  assert(!parsed.some((entry) => entry.descriptor === "INDEX" && entry.fields.includes("orders_pkey")), "constraint-backed primary index must not be expected independently");
  assert(parsed.some((entry) => entry.descriptor === "INDEX" && entry.fields.includes("orders_created_idx")), "ordinary index must remain independently required");
  assert(parsed.some((entry) => entry.descriptor === "FK CONSTRAINT"));
  assert(parsed.some((entry) => entry.descriptor === "TABLE ATTACH"));
  assert(parsed.some((entry) => entry.descriptor === "INDEX ATTACH"));
  assert(parsed.some((entry) => entry.descriptor === "SEQUENCE OWNED BY"));
  assert(parsed.some((entry) => entry.descriptor === "SEQUENCE" && entry.fields.includes("identity_id_seq")));
  assert(!parsed.some((entry) => entry.descriptor === "SEQUENCE OWNED BY" && entry.fields.includes("identity_id_seq")), "identity sequence ownership must follow actual pg_dump semantics");
  assert(parsed.some((entry) => entry.descriptor === "TABLE" && entry.fields.includes("Quoted Table")), "quoted identifier must remain one semantic token");

  const requiredSchemaDescriptors = ["TABLE", "SEQUENCE", "TYPE", "DOMAIN", "FUNCTION", "VIEW", "TRIGGER", "CONSTRAINT", "FK CONSTRAINT", "INDEX", "TABLE ATTACH", "INDEX ATTACH"];
  for (const descriptor of requiredSchemaDescriptors) {
    const line = schema.split("\n").find((row) => row.includes(` ${descriptor} `));
    const missing = full.split("\n").filter((row) => row !== line).join("\n");
    assert.throws(() => validateFullBackupToc(missing, inventory), /missing a required schema entry/, `${descriptor} must be required`);
  }
  for (const descriptor of ["TABLE DATA", "SEQUENCE SET", "MATERIALIZED VIEW DATA"]) {
    const line = full.split("\n").find((row) => row.includes(` ${descriptor} `));
    const missing = full.split("\n").filter((row) => row !== line).join("\n");
    assert.throws(() => validateFullBackupToc(missing, inventory), /missing a required data entry/, `${descriptor} must be required`);
  }
  assert.throws(() => validateFullBackupToc(`${full}\n${tocLine(999, "TABLE", "pg_catalog injected")}`, inventory), /excluded-schema/);
  const deferredData = buildExpectedBackupInventory(schema, { dataEntries: [{ descriptor: "TABLE DATA", schema: "dune", name: "catalog_only_data_target" }] }, { validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK });
  assert.throws(() => validateFullBackupToc(schema, deferredData, { requiredAlphaTables: [] }), /missing a required data entry \(TABLE DATA=1\)/, "catalog data must be checked against the final archive, never schema-only TOC");
  assert.throws(() => validateFullBackupToc(`${full}\n${tocLine(998, "TABLE DATA", "dune unexpected_data")}`, inventory), /unexpected data entry \(TABLE DATA=1\)/, "unexpected final-world data must remain blocking");

  const excludedRelations = [
    ...CODEX_BACKUP_ARTIFACTS.map((name) => ({ schema: "dune", name })),
    ...CODEX_BACKUP_SEQUENCES.map((name) => ({ schema: "dune", name }))
  ];
  const excludedCatalog = { dataEntries: [
    ...catalogFixture().dataEntries,
    ...CODEX_BACKUP_ARTIFACTS.map((name) => ({ descriptor: "TABLE DATA", schema: "dune", name })),
    ...CODEX_BACKUP_SEQUENCES.map((name) => ({ descriptor: "SEQUENCE SET", schema: "dune", name }))
  ] };
  const excludedInventory = buildExpectedBackupInventory(schema, excludedCatalog, { validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK, excludedRelations });
  assert.deepStrictEqual(excludedInventory.dataDefinitions, inventory.dataDefinitions, "the four positively-proven Suite backup tables and owned sequence states must be absent from data inventory");
  assert.throws(() => buildExpectedBackupInventory(`${schema}\n${tocLine(997, "TABLE", `dune ${CODEX_BACKUP_ARTIFACTS[0]}`)}`, catalogFixture(), { validationProfile: BACKUP_INVENTORY_PROFILES.DESTINATION_ROLLBACK, excludedRelations }), /excluded schema object \(TABLE=1\)/, "excluded Suite artifacts must remain forbidden in schema inventory");

  // Production-shaped v4 world boundary: these three ordinary persistent
  // public relations exist in the source catalog, but --schema=dune means
  // matching pg_dump emits no TABLE DATA entry for any of them. The virtual
  // partition parent remains a required TABLE definition while only its
  // storage-bearing leaf has an independent TABLE DATA entry.
  const partitionSchema = [
    tocLine(1200, "SCHEMA", "- dune"),
    tocLine(1201, "TABLE", "dune event_log"),
    tocLine(1202, "TABLE", "dune event_log_p1"),
    tocLine(1203, "TABLE ATTACH", "dune event_log_p1")
  ].join("\n");
  const productionCatalog = { dataEntries: [
    { descriptor: "TABLE DATA", schema: "dune", name: "event_log_p1" },
    { descriptor: "TABLE DATA", schema: "public", name: "alphanine_market_bot_audit" },
    { descriptor: "TABLE DATA", schema: "public", name: "alphanine_market_bot_cycles" },
    { descriptor: "TABLE DATA", schema: "public", name: "alphanine_market_bot_listings" }
  ] };
  const worldInventory = buildExpectedBackupInventory(partitionSchema, productionCatalog, { validationProfile: BACKUP_INVENTORY_PROFILES.MIGRATION_PACKAGE, includedSchemas: ["dune"] });
  assert.deepStrictEqual(worldInventory.dataDefinitions, ["TABLE DATA\u0000[\"dune\",\"event_log_p1\"]"]);
  assert(worldInventory.schemaDefinitions.some((entry) => entry.definition === "TABLE\u0000[\"dune\",\"event_log\"]"), "partition parent definition must remain required");
  assert.strictEqual(validateFullBackupToc(`${partitionSchema}\n${tocLine(1204, "TABLE DATA", "dune event_log_p1")}`, worldInventory, { requiredAlphaTables: [] }).valid, true);
  assert.throws(() => validateFullBackupToc(`${partitionSchema}\n${tocLine(1205, "TABLE DATA", "dune event_log")}`, worldInventory, { requiredAlphaTables: [] }), /missing a required data entry|unexpected data entry/, "partition parent data must not substitute for leaf data");

  let listed = false;
  let fullyRead = false;
  const archiveCheck = await verifyMatchingArchive({
    listArchive: async () => { listed = true; return full; },
    readArchive: async () => { fullyRead = true; }
  });
  assert(listed && fullyRead && archiveCheck.archiveReadVerified);
  await assert.rejects(verifyMatchingArchive({
    listArchive: async () => full,
    readArchive: async () => { throw new Error("corrupted data block"); }
  }), /corrupted data block/, "a structurally valid TOC must not hide corrupted data blocks");

  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a9-backup-test-"));
  try {
    const binaryPath = path.join(folder, "binary.backup.partial-test");
    const binary = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0x00, 0xff, 0x0a, 0x0d]);
    const streamed = await streamCommandToFile({ command: process.execPath, args: ["-e", `process.stderr.write('diagnostic-only');process.stdout.write(Buffer.from('${binary.toString("base64")}', 'base64'))`], outputPath: binaryPath });
    assert.deepStrictEqual(await fs.promises.readFile(binaryPath), binary, "stderr must never enter binary stdout");
    assert.strictEqual(streamed.size, String(binary.length));
    const interrupted = path.join(folder, "interrupted.partial-test");
    await assert.rejects(streamCommandToFile({ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.from('PGDMP'));process.stderr.write('transfer interrupted');process.exit(9)"], outputPath: interrupted }), /ended unexpectedly/);
    assert.strictEqual(fs.existsSync(interrupted), false);
    const diskFull = path.join(folder, "disk-full.partial-test");
    await assert.rejects(streamCommandToFile({ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(4096))"], outputPath: diskFull, createWriteStreamImpl: () => new Writable({ write(chunk, encoding, callback) { const error = new Error("disk full"); error.code = "ENOSPC"; callback(error); } }) }), /disk full/);
    assert.strictEqual(fs.existsSync(diskFull), false);
    const partial = path.join(folder, "atomic.backup.partial-id");
    const final = path.join(folder, "atomic.backup");
    await fs.promises.writeFile(partial, binary);
    await publishVerifiedPackage(partial, final);
    const metadataPath = `${final}.json`;
    assert.strictEqual(fs.existsSync(metadataPath), false);
    await writeJsonAtomic(metadataPath, { verified: true, size: "900719925474099312345" });
    assert.strictEqual((await fs.promises.readdir(folder)).some((name) => name.includes(".json.partial-")), false);
  } finally { await fs.promises.rm(folder, { recursive: true, force: true }); }

  const server = await fs.promises.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  const backupLibrary = await fs.promises.readFile(path.join(__dirname, "..", "lib", "database-backup.js"), "utf8");
  assert(server.includes('const dumpFlags = options.dumpFlags || ["--format=custom", "--no-owner", "--no-privileges"]'));
  assert(server.includes('...dumpFlags, "--schema-only"'));
  const backupInspector = server.slice(server.indexOf("async function inspectSeekableArchive"), server.indexOf("async function createExpectedBackupInventory"));
  assert.match(backupInspector, /inspectClosedArchive/);
  assert.match(backupInspector, /inspectRecoveryArchive/);
  assert.doesNotMatch(backupInspector, /shQuote\(|sh\s+-c|buildSeekableArchiveInspectionScript|base64/i);
  assert.doesNotMatch(backupInspector, /matchingPgRestore\(localPath[\s\S]*--list|matchingPgRestore\(localPath[\s\S]*--file=\/dev\/null/, "full backup verification must not stream the archive directly into pg_restore");
  const nativeBackup = server.slice(server.indexOf("async function createNativeDatabaseBackup"), server.indexOf("async function createDatabaseBackup"));
  assert(nativeBackup.indexOf("generateValidatedPodArchive") < nativeBackup.indexOf("publishVerifiedPackage"), "pod-side TOC and complete-read verification must finish before atomic backup publication");
  assert.match(nativeBackup, /kind:\s*"rollback"[\s\S]*validateFullBackupToc/, "destination rollback backup must use the pod-native complete-database validation profile");
  assert.doesNotMatch(nativeBackup, /inspectLocalBackupArchive|kubectl exec -i|PGPASSWORD=|sh -c/, "destination rollback backup must not upload an archive back into the pod or embed credentials in shell text");
  assert(nativeBackup.indexOf("publishVerifiedPackage") < nativeBackup.indexOf("writeDatabaseBackupJsonAtomic"), "verified metadata must be published only after the payload is atomically published");
  assert.match(nativeBackup, /finally\s*\{[\s\S]*rm\(partialPath[\s\S]*rm\(metadataPath/, "backup partials and failed metadata must be removed unconditionally");
  const vendorLocalCopy = server.slice(server.indexOf("async function copyVerifiedVendorBackupToLocal"), server.indexOf("function nativeDatabaseBackupFilename"));
  assert.match(vendorLocalCopy, /streamCommandToFile[\s\S]*expectedBytes:\s*verification\.size/, "manual vendor backups must stream the verified payload into the configured local folder");
  assert.match(vendorLocalCopy, /streamed\.size[^\n]+verification\.size[\s\S]*streamed\.sha256[^\n]+verification\.sha256/, "the local vendor copy must match the independently verified VM size and SHA-256");
  assert.match(vendorLocalCopy, /hashDatabaseBackupFile\(finalPath\)[\s\S]*publishedComponent\.size[^\n]+verification\.size[\s\S]*publishedComponent\.sha256[^\n]+verification\.sha256/, "the atomically published local file must be independently re-hashed against the VM artifact");
  assert(vendorLocalCopy.indexOf("publishVerifiedPackage") < vendorLocalCopy.indexOf("writeDatabaseBackupJsonAtomic"), "manual vendor backup metadata must be published only after the local payload is atomically published");
  assert.match(vendorLocalCopy, /type:\s*"verified-database-backup"[\s\S]*localBackupPath:\s*finalPath[\s\S]*storage:\s*"vm\+local"/, "manual vendor backups must be listed and restorable as verified local payloads");
  const remoteVendorInspection = server.slice(server.indexOf("async function inspectRemoteBackupArchive"), server.indexOf("async function verifyVendorBackup"));
  assert.match(remoteVendorInspection, /requiredAlphaTables:\s*\[\]/, "real Funcom VM archives must be checked against their actual catalog without optional Suite-table requirements");
  const standardConnection = server.slice(server.indexOf("async function standardVmSshConnection"), server.indexOf("async function serverHealthRemoteCheck"));
  assert.doesNotMatch(standardConnection, /migration|known.?host|UserKnownHostsFile/i, "normal Suite SSH must not depend on migration-only pinned known-host files");
  const completeBackupFeature = server.slice(server.indexOf("async function databaseBackupSshConnection"), server.indexOf("function listDatabaseBackups"));
  assert.doesNotMatch(completeBackupFeature, /migrationSshConnection|migrationPodArchiveTools|runMigrationCredentialScript|migrationSql|migrationEvidence|collectMigration|migrationOfflineMode|known.?host|UserKnownHostsFile/i, "backup creation, verification, and local transport must have no migration runtime dependency");
  assert.match(completeBackupFeature, /databaseBackupSshConnection[\s\S]*standardVmSshConnection/, "backup transport must use the Suite's normal VM connection");
  assert.match(completeBackupFeature, /collectDatabaseBackupOfflineEvidence/, "Safety Backup must use dedicated database offline evidence");
  const manualBackup = server.slice(server.indexOf("async function createDatabaseBackup(options"), server.indexOf("function listDatabaseBackups"));
  assert.match(manualBackup, /copyVerifiedVendorBackupToLocal/, "successful manual vendor backups must be copied to local storage");
  assert.match(manualBackup, /localBackupPath:\s*local\.localBackupPath/, "manual backup responses must report the actual local payload path");
  assert.match(manualBackup, /vmBackupParts\(verification\.identity\.path/, "the successful DatabaseOperation artifact path must drive the VM-to-local copy even when command output omits it");
  assert(manualBackup.indexOf('options.onStatus?.("Succeeded"') > manualBackup.indexOf("copyVerifiedVendorBackupToLocal"), "backup success must be reported only after the actual VM artifact is copied locally");
  assert.match(manualBackup, /allowNativeFallback\s*===\s*true/, "a routine vendor backup must fail if its actual VM artifact cannot be copied unless native fallback was explicitly requested");
  assert.doesNotMatch(manualBackup, /Migration Maintenance|maintenanceCheckpoint|verifyMaintenanceCheckpointRemote/, "routine backups must not depend on the removed Migration Maintenance workflow");
  assert.match(manualBackup, /verifyDatabaseTargetCheckpoint/, "routine backups must keep the exact selected battlegroup pinned throughout the operation");
  assert.match(nativeBackup, /verifyDatabaseOfflineCheckpoint/, "standalone safety backups must repeatedly verify that the selected battlegroup remains offline");
  const restoreWorkflow = server.slice(server.indexOf("function startDatabaseRestoreJob"), server.indexOf("const migrationExportJobs"));
  assert.doesNotMatch(restoreWorkflow, /Migration Maintenance|migrationMaintenance|maintenanceCheckpoint|verifyMaintenanceCheckpointRemote/, "database import and restore must not depend on the removed Migration Maintenance workflow");
  assert.match(restoreWorkflow, /verifyDatabaseOfflineCheckpoint/, "database import must revalidate the stopped battlegroup before destructive stages");
  const schedulerBackup = server.slice(server.indexOf("function startVmSchedulerAction"), server.indexOf("function marketBotCatalog"));
  assert.doesNotMatch(schedulerBackup, /migrationMaintenance|verifyMaintenanceCheckpointRemote/, "manual scheduler backups must not depend on the removed Migration Maintenance workflow");
  const battlegroupActions = server.slice(server.indexOf("async function battlegroup(action"), server.indexOf("function serverControlConfigured"));
  assert.doesNotMatch(battlegroupActions, /assertWorkflowActive\("Database backup"\)/, "the Server page backup action must not require Migration Maintenance Mode");
  assert.match(battlegroupActions, /action\s*===\s*"backup"[\s\S]*createDatabaseBackup/, "the Server page Backup button must copy and verify the real VM artifact locally");
  assert(server.includes("createExpectedBackupInventory"));
  assert(server.includes("buildExpectedBackupInventory"));
  assert(server.includes("dumpIncludedSchemas(dumpFlags)"));
  assert(server.includes("includedSchemas"));
  assert.match(server, /n\.nspname !~ '\^pg_'[\s\S]*n\.nspname <> 'information_schema'[\s\S]*c\.relkind in \('r','S','m'\)/, "full catalog data inventory must include every user schema while excluding system and partition-parent relations");
  assert.match(server, /validationProfile:\s*BACKUP_INVENTORY_PROFILES\.DESTINATION_ROLLBACK/, "rollback backup inventory must select the full-database profile explicitly");
  assert.match(server, /validationProfile:\s*BACKUP_INVENTORY_PROFILES\.MIGRATION_PACKAGE[\s\S]*dumpFlags:\s*worldDumpFlags/, "migration package inventory must select the dune-only profile explicitly");
  assert.match(backupLibrary, /Schema-only migration archive contains an object outside dune/);
  assert.match(backupLibrary, /Schema-only full-database archive is missing required extension objects/);
  console.log("database backup catalog-to-TOC and full archive-read tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
