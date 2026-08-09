"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_ENTRY_LIMIT,
  FORMAT_VERSION,
  canonicalJson,
  entryHeader,
  inspectMigrationPackage,
  sha256Buffer,
  writeMigrationArchive,
  writeMigrationPackage
} = require("../lib/migration-package");
const {
  CODEX_BACKUP_ARTIFACTS,
  CODEX_BACKUP_ARTIFACT_SQL,
  CODEX_BACKUP_SEQUENCES,
  DUMP_FLAGS,
  ENTITY_TABLES,
  EXCLUDED_BOUNDARIES,
  FRESH_DESTINATION_SQL,
  INCLUDED_BOUNDARIES,
  MARKET_BOT_TABLES,
  PATCH_CATALOG_SQL,
  SCHEMA_CATALOG_SQL,
  REQUIRED_EXTENSIONS,
  SUPPORTED_PROFILE,
  VERIFICATION_QUERY_VERSION,
  assessOutputPath,
  buildMigrationManifest,
  classifyMigrationOfflineStatus,
  collectIndependentWriterSamples,
  evaluateIndependentWriterSamples,
  validateMigrationManifest,
  validateNoSensitiveManifestData,
  validatePgRestoreToc,
  validateVerificationEvidence
} = require("../lib/server-migration");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-migration-test-"));
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const profile = { ...SUPPORTED_PROFILE, appliedPatchSha256: digestA, sourcePortableSchemaSha256: digestB, freshDestinationSchemaSha256: "e".repeat(64) };

function entityCounts() {
  return Object.fromEntries(Object.keys(ENTITY_TABLES).map((key) => [key, key === "accounts" ? "9007199254740993" : (key === "items" ? "18446744073709551615" : "0")]));
}

function evidence() {
  return {
    formatVersion: FORMAT_VERSION,
    queryVersion: VERIFICATION_QUERY_VERSION,
    collectedAt: "2026-08-03T10:20:30.000Z",
    fingerprints: { appliedPatchesSha256: digestA, schemaCatalogSha256: digestB },
    requiredExtensions: REQUIRED_EXTENSIONS,
    entityCounts: entityCounts(),
    sourceMarket: sourceMarketEvidence(),
    relationships: { foreignKeyCount: "137", invalidForeignKeys: "0", sha256: "c".repeat(64) },
    sequences: { sequenceCount: "40", sha256: "d".repeat(64) }
  };
}

function sourceMarketEvidence() { return { counts: { activeListings: "815", pendingSettlements: "0", invalidRelationships: "0", completedHistory: "1" }, digests: { activeListings: "1".repeat(64), pendingSettlements: "2".repeat(64), invalidRelationships: "2".repeat(64), completedHistory: "3".repeat(64) } }; }

async function fixture() {
  const worldPath = path.join(root, `world-${Math.random()}.dump`);
  const packagePath = path.join(root, `package-${Math.random()}.a9migration.partial-test`);
  const world = Buffer.from("PGDMP\u0001\u000f\u0000synthetic-custom-format-dump", "binary");
  fs.writeFileSync(worldPath, world);
  const verification = evidence();
  const verificationBuffer = Buffer.from(canonicalJson(verification));
  const components = [
    { path: "world.dump", mediaType: "application/vnd.postgresql.custom-dump", size: String(world.length), sha256: sha256Buffer(world) },
    { path: "verification.json", mediaType: "application/json", size: String(verificationBuffer.length), sha256: sha256Buffer(verificationBuffer) }
  ];
  const manifest = buildMigrationManifest({
    suiteVersion: "1.0.84",
    createdAt: "2026-08-03T10:20:30.000Z",
    gameBuild: profile.gameBuild,
    postgresServerVersion: "17.4",
    dumpToolVersion: "17.10",
    extensions: REQUIRED_EXTENSIONS,
    appliedPatchSha256: digestA,
    schemaCatalogSha256: digestB,
    entityCounts: verification.entityCounts,
    sourceMarket: verification.sourceMarket,
    components,
    profile
  });
  await writeMigrationPackage({ partialPath: packagePath, worldDumpPath: worldPath, manifest, verification });
  return { worldPath, packagePath, manifest, verification };
}

async function testManifestAndRoundTrip() {
  const data = await fixture();
  const inspection = await inspectMigrationPackage(data.packagePath);
  assert.equal(inspection.ok, true);
  assert.deepEqual(inspection.entries.map((entry) => entry.path), ["manifest.json", "world.dump", "verification.json"]);
  validateMigrationManifest(inspection.manifest, profile);
  validateVerificationEvidence(inspection.verification, inspection.manifest);
  assert.equal(inspection.verification.sourceMarket.counts.activeListings, "815", "active source listings are recorded, not deleted or made an export prerequisite");
  assert.equal(inspection.manifest.entityCounts.accounts, "9007199254740993", "64-bit counts must remain exact decimal strings");
  assert(DEFAULT_ENTRY_LIMIT > 0xffffffffn, "A9MIG entry lengths must exceed the ZIP32 limit");
  const overZip32 = 0x100000001n;
  assert.equal(entryHeader({ path: "world.dump", mediaType: "application/vnd.postgresql.custom-dump" }, overZip32).header.readBigUInt64LE(8), overZip32, "A9MIG must encode lengths above 4 GiB without truncation");
  assert.deepEqual(DUMP_FLAGS, ["--format=custom", "--no-owner", "--no-privileges", "--schema=dune"]);
  assert.doesNotMatch(PATCH_CATALOG_SQL, /\bdate\b|timestamp|count\s*\(/i, "Patch canonicalization must exclude timestamps and row counts");
  assert.doesNotMatch(SCHEMA_CATALOG_SQL, /\b(?:now|clock_timestamp|current_timestamp|pg_database_size|inet_server_addr|current_user|session_user)\s*\(|pg_stat_|last_value|reltuples|relpages|['\"]oid['\"]|password|credential|hostpath/i, "Schema canonicalization must exclude volatile runtime and sensitive values");
  assert.match(CODEX_BACKUP_ARTIFACT_SQL, /con\.contype='f'\s+AND\s+\(con\.conrelid=c\.oid OR con\.confrelid=c\.oid\)/, "backup-artifact classification must count only foreign-key constraints");
  assert.doesNotMatch(CODEX_BACKUP_ARTIFACT_SQL, /(?:relname|name)\s+(?:LIKE|~)|da_codex.*%/i, "backup-artifact classification must not use a broad name-pattern exclusion");
  for (const name of CODEX_BACKUP_ARTIFACTS) {
    assert.match(CODEX_BACKUP_ARTIFACT_SQL, new RegExp(`'${name}'`), `backup-artifact classification must explicitly allowlist ${name}`);
  }
  for (const name of CODEX_BACKUP_SEQUENCES) {
    assert.match(CODEX_BACKUP_ARTIFACT_SQL, new RegExp(`'${name}'`), `backup-artifact classification must explicitly allowlist ${name}`);
  }
  assert.equal(SUPPORTED_PROFILE.sourcePortableSchemaSha256, "7e856adc532ce12ceac6439fa0657335369a7fc9f3bc775d33d185994cb50a9d", "export must use the exact approved source-portable schema pin");
  assert.equal(SUPPORTED_PROFILE.restoredPortableSchemaSha256, "529bf0fb4172de29972be2e825d6ad6c2089179ca98dfd7c1c6eda9b9c0f2fd7", "post-restore validation must use its independently stable exact catalog pin");
  assert.equal(SUPPORTED_PROFILE.freshDestinationSchemaSha256, "00ab81294372490cbb7bad54df9edc5adc5d95fe4cb833e4e587284613b109b8", "import preflight must retain the distinct clean-destination schema pin");
  assert.notEqual(SUPPORTED_PROFILE.restoredPortableSchemaSha256, SUPPORTED_PROFILE.sourcePortableSchemaSha256, "source and restored pins must remain explicit rather than silently conflated");
  assert.notEqual(SUPPORTED_PROFILE.sourcePortableSchemaSha256, SUPPORTED_PROFILE.freshDestinationSchemaSha256, "source and fresh-destination schema pins must remain independent");
  assert.match(FRESH_DESTINATION_SQL, /marketBotTablesPresent/);
  assert.match(FRESH_DESTINATION_SQL, /relationalInvalidity/);
}

async function testSourceMarketEvidenceFailClosed() {
  const data = await fixture();
  for (const mutate of [
    (row) => { delete row.sourceMarket; },
    (row) => { row.sourceMarket.counts.activeListings = 815; },
    (row) => { row.sourceMarket.counts.pendingSettlements = "-1"; },
    (row) => { row.sourceMarket.digests.activeListings = "bad"; }
  ]) {
    const changed = JSON.parse(JSON.stringify(data.verification));
    mutate(changed);
    assert.throws(() => validateVerificationEvidence(changed, data.manifest));
  }
}

async function testCorruptionAndTruncation() {
  const corrupt = await fixture();
  const inspected = await inspectMigrationPackage(corrupt.packagePath);
  const world = inspected.entries.find((entry) => entry.path === "world.dump");
  const handle = fs.openSync(corrupt.packagePath, "r+");
  const byte = Buffer.alloc(1);
  fs.readSync(handle, byte, 0, 1, Number(world.dataOffset));
  byte[0] ^= 0xff;
  fs.writeSync(handle, byte, 0, 1, Number(world.dataOffset));
  fs.closeSync(handle);
  await assert.rejects(() => inspectMigrationPackage(corrupt.packagePath), /SHA-256/);

  const truncated = await fixture();
  const size = fs.statSync(truncated.packagePath).size;
  fs.truncateSync(truncated.packagePath, size - 12);
  await assert.rejects(() => inspectMigrationPackage(truncated.packagePath), /footer|truncated|corrupt/i);
}

async function testArchiveAttackRejection() {
  const base = await fixture();
  await assert.rejects(() => writeMigrationArchive(path.join(root, "duplicate"), [
    { path: "manifest.json", content: "{}" },
    { path: "manifest.json", content: "{}" },
    { path: "verification.json", content: "{}" }
  ]), /duplicate/);
  await assert.rejects(() => writeMigrationArchive(path.join(root, "traversal"), [
    { path: "manifest.json", content: "{}" },
    { path: "../world.dump", content: "x" },
    { path: "verification.json", content: "{}" }
  ]), /traversal|unsafe/);
  await assert.rejects(() => inspectMigrationPackage(base.packagePath, { maxEntryBytes: "2" }), /size limit/);

  const compressed = await fixture();
  const file = fs.readFileSync(compressed.packagePath);
  const marker = file.indexOf(Buffer.from('"compression":"none"'));
  assert(marker > 0);
  file.write("zlib", marker + '"compression":"'.length, "ascii");
  fs.writeFileSync(compressed.packagePath, file);
  await assert.rejects(() => inspectMigrationPackage(compressed.packagePath), /decompression bombs/);

  const malformed = path.join(root, "malformed.a9migration");
  await writeMigrationArchive(malformed, [
    { path: "manifest.json", mediaType: "application/json", content: "not json" },
    { path: "world.dump", content: "dump" },
    { path: "verification.json", mediaType: "application/json", content: "{}" }
  ]);
  await assert.rejects(() => inspectMigrationPackage(malformed), /manifest is malformed JSON/);
}

function testManifestFailClosed() {
  const valid = {
    format: "alphanine-server-migration",
    formatVersion: FORMAT_VERSION,
    suiteVersion: "1.0.84",
    createdAt: "2026-08-03T10:20:30.000Z",
    source: { gameBuild: profile.gameBuild, postgresServerVersion: "17.4", dumpToolVersion: "17.10", requiredExtensions: REQUIRED_EXTENSIONS },
    fingerprints: { appliedPatchesSha256: digestA, schemaCatalogSha256: digestB },
    boundary: {
      included: [...INCLUDED_BOUNDARIES],
      excluded: [...EXCLUDED_BOUNDARIES]
    },
    verificationQueryVersion: VERIFICATION_QUERY_VERSION,
    entityCounts: entityCounts(),
    sourceMarket: sourceMarketEvidence(),
    components: [
      { path: "manifest.json", mediaType: "application/json", size: "1", sha256: "c".repeat(64) },
      { path: "world.dump", mediaType: "application/vnd.postgresql.custom-dump", size: "1", sha256: digestA },
      { path: "verification.json", mediaType: "application/json", size: "1", sha256: digestB }
    ],
    compatibility: { mode: "exact", profileId: profile.id }
  };
  for (let attempt = 0; attempt < 4; attempt += 1) valid.components[0].size = String(Buffer.byteLength(canonicalJson(valid)));
  const selfInput = JSON.parse(JSON.stringify(valid));
  selfInput.components[0].sha256 = "0".repeat(64);
  valid.components[0].sha256 = sha256Buffer(Buffer.from(canonicalJson(selfInput)));
  validateMigrationManifest(valid, profile);
  for (const mutate of [
    (row) => { row.formatVersion = 99; },
    (row) => { row.source.gameBuild = "unknown"; },
    (row) => { row.source.postgresServerVersion = "18.0"; },
    (row) => { row.source.requiredExtensions[0] = { name: "pgcrypto", version: "9.9" }; },
    (row) => { row.fingerprints.appliedPatchesSha256 = "e".repeat(64); },
    (row) => { row.fingerprints.schemaCatalogSha256 = "f".repeat(64); },
    (row) => { row.entityCounts.accounts = 9007199254740992; }
  ]) {
    const changed = JSON.parse(JSON.stringify(valid));
    mutate(changed);
    assert.throws(() => validateMigrationManifest(changed, profile));
  }
  assert.throws(() => validateNoSensitiveManifestData({ databasePassword: "secret" }), /forbidden field/);
  assert.throws(() => validateNoSensitiveManifestData({ value: "C:\\server\\secret" }), /forbidden/);
  assert.throws(() => validateNoSensitiveManifestData({ value: "192.0.2.4" }), /IP address/);
}

function testTocBoundary() {
  const toc = `
; Archive created at 2026-08-03
1; 0 0 ENCODING - ENCODING postgres
2; 0 0 STDSTRINGS - STDSTRINGS postgres
3; 2615 100 SCHEMA - dune postgres
4; 1247 101 TYPE dune actor_kind postgres
5; 1255 102 FUNCTION dune calculate_state() postgres
6; 1255 103 PROCEDURE dune rotate_world() postgres
7; 1259 104 TABLE dune actors postgres
8; 1259 105 TABLE dune world_partition postgres
9; 1259 106 SEQUENCE dune actors_id_seq postgres
10; 2604 107 DEFAULT dune actors id postgres
11; 2606 108 CONSTRAINT dune actors actors_pkey postgres
12; 1259 109 VIEW dune actor_view postgres
13; 2620 110 TRIGGER dune actors actors_trigger postgres
14; 0 104 TABLE DATA dune actors postgres
15; 0 106 SEQUENCE SET dune actors_id_seq postgres
16; 2606 111 FK CONSTRAINT dune actors actors_partition_fk postgres
17; 0 112 TABLE ATTACH dune world_partition world_partition_0 postgres
`;
  const result = validatePgRestoreToc(toc, { scope: "dune" });
  assert.equal(result.ok, true);
  assert.equal(result.objectClasses.partitions, true);
  assert.throws(() => validatePgRestoreToc(`${toc}18; 1259 220 TABLE public alphanine_market_bot_listings postgres\n`, { scope: "dune" }), /excluded public/);
  assert.throws(() => validatePgRestoreToc(`${toc}18; 1259 220 TABLE telemetry unrelated postgres\n`, { scope: "dune" }), /outside the authoritative dune schema/);
  assert.throws(() => validatePgRestoreToc(toc.replace(/16;.*\n/, ""), { scope: "dune" }), /foreignKeys/);
  assert.throws(() => validatePgRestoreToc(`${toc}18; 1259 220 TABLE dune da_codex_story_gate_backup_20260624 postgres\n`, { scope: "dune" }), /Codex backup artifact/);
  assert.throws(() => validatePgRestoreToc(`${toc}18; 1259 220 SEQUENCE dune da_codex_story_gate_backup_20260624_backup_id_seq postgres\n`, { scope: "dune" }), /Codex backup artifact/);
  assert.throws(() => validatePgRestoreToc(`${toc}18; 3079 120 EXTENSION - pgcrypto postgres\n`, { scope: "dune" }), /infrastructure/);
}

function testPathAssessment() {
  const safe = assessOutputPath(path.join(root, "exports", "world.a9migration"), { unsafeRoots: [path.join(root, "server")] });
  assert.equal(safe.unsafe, false);
  assert.equal(safe.fileName, "world.a9migration");
  const unsafe = assessOutputPath(path.join(root, "server", "world.a9migration"), { unsafeRoots: [path.join(root, "server")] });
  assert.equal(unsafe.unsafe, true);
  assert.throws(() => assessOutputPath(path.join(root, "world.zip")), /\.a9migration/);
}

function testStoppedSuspendedOfflineClassifier() {
  const stoppedSuspended = {
    phase: "Stopped",
    gateway: "Suspended",
    director: "Suspended"
  };
  const noGameWorkloads = { items: [] };
  const expectedOffline = classifyMigrationOfflineStatus(stoppedSuspended, noGameWorkloads);
  assert.equal(expectedOffline.offline, true, "Stopped phase with suspended controllers and zero game workloads must be accepted");
  assert.equal(expectedOffline.authoritativePhaseOffline, true);

  for (const phase of ["Running", "Active", "Starting"]) {
    const active = classifyMigrationOfflineStatus({ ...stoppedSuspended, phase }, noGameWorkloads);
    assert.equal(active.offline, false, `Active/running phase ${phase} must be rejected`);
  }

  const runningGameWorkload = {
    items: [{ status: { phase: "Running" }, spec: { containers: [{ image: "registry.example/seabass-server:2051294-0-shipping" }] } }]
  };
  assert.equal(classifyMigrationOfflineStatus(stoppedSuspended, runningGameWorkload).offline, false, "Any running game workload must be rejected");

  for (const ambiguous of [
    {},
    { phase: "Unknown", gateway: "Suspended", director: "Suspended" },
    { phase: "Stopped", gateway: "Unknown", director: "Suspended" },
    { phase: "Stopped", gateway: "Suspended" }
  ]) {
    assert.equal(classifyMigrationOfflineStatus(ambiguous, noGameWorkloads).offline, false, "Ambiguous or unknown states must be rejected");
  }
}

async function testWriterSamplesSurviveIndependentMarketBotFailure() {
  const calls = [];
  const samples = await collectIndependentWriterSamples(async (index) => {
    calls.push(index);
    return { unexpectedActiveClients: "0", openTransactions: "0" };
  }, async () => { calls.push("delay"); });
  let marketBot;
  try { throw Object.assign(new Error("legacy local evidence"), { code: "market_bot_evidence_local_legacy_incompatible" }); }
  catch (error) { marketBot = { ok: false, code: error.code }; }
  const writerEvidence = evaluateIndependentWriterSamples(samples);
  assert.equal(marketBot.ok, false, "Market Bot evidence must fail independently");
  assert.equal(writerEvidence.ok, true, "two clean writer samples must remain valid when Market Bot evidence fails");
  assert.deepEqual(writerEvidence.samples, [
    { unexpectedActiveClients: "0", openTransactions: "0" },
    { unexpectedActiveClients: "0", openTransactions: "0" }
  ]);
  assert.deepEqual(calls, [0, "delay", 1], "writer sessions must remain independently ordered");
  assert.equal(evaluateIndependentWriterSamples([samples[0]]).ok, false, "one clean sample must still fail closed");
}

async function main() {
  try {
    await testManifestAndRoundTrip();
    await testSourceMarketEvidenceFailClosed();
    await testCorruptionAndTruncation();
    await testArchiveAttackRejection();
    testManifestFailClosed();
    testTocBoundary();
    testPathAssessment();
    testStoppedSuspendedOfflineClassifier();
    await testWriterSamplesSurviveIndependentMarketBotFailure();
    console.log("Server Migration package, manifest, boundary, bigint, and attack-rejection tests passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
