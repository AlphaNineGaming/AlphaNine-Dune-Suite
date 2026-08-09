"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const {
  ATOMIC_PSQL_FLAGS,
  DUNE_SCHEMA_OWNER,
  DUNE_RUNTIME_ROLE_VERIFY_SQL,
  DROP_DUNE_SCHEMA_SQL,
  DUNE_RESTORE_FLAGS,
  atomicDunePsqlArgs,
  assertOutsideDuneBoundaryUnchanged,
  normalizeCrossSchemaDependencyEvidence,
  normalizeOutsideDuneBoundary,
  runAtomicDuneSchemaRestore,
  validateDuneSchemaToc
} = require("../lib/migration-schema-restore");
const { PGPASS_PREPARATION_MARKER, POD_ARCHIVE_PATHS } = require("../lib/server-migration-export");

const digest = (value) => value.repeat(64);
const target = { namespace: "fresh-destination", dbPod: "postgres-0" };
const base = {
  archivePath: POD_ARCHIVE_PATHS.legacyRecovery,
  restoreExecutable: "/usr/local/bin/pg_restore",
  psqlExecutable: "/usr/local/bin/psql",
  dbSvc: "postgres-service",
  sshArgs: ["test-target"],
  target,
  timeoutMs: 60000,
  runCredentialScript: async () => ({ ok: true, code: 0, inputComplete: true, stdout: `${PGPASS_PREPARATION_MARKER}\n`, stderr: "" }),
  runStdinScript: async ({ args, script }) => {
    const expectedPath = script === DROP_DUNE_SCHEMA_SQL ? POD_ARCHIVE_PATHS.dropSql : POD_ARCHIVE_PATHS.runtimeRoleVerifySql;
    assert([DROP_DUNE_SCHEMA_SQL,DUNE_RUNTIME_ROLE_VERIFY_SQL].includes(script));
    assert(args.includes("-i"), "only bounded fixed-file writes attach stdin");
    assert(args.includes(`of=${expectedPath}`));
    assert(!args.includes(script), "SQL bytes must never be present in a process argument");
    return { ok: true, code: 0, inputComplete: true, stdout: "", stderr: "" };
  }
};

const eventLogFixture = Array.from({ length: 31 }, (_, index) => ({
  partition: `event_log_p${index + 1}`,
  inheritedPrimaryKey: `event_log_p${index + 1}_pkey`
}));
assert.equal(eventLogFixture.length, 31);
const eventLogRestoreSql = [
  "CREATE TABLE dune.event_log (event_id bigint NOT NULL, partition_key integer NOT NULL) PARTITION BY RANGE (partition_key);",
  "ALTER TABLE ONLY dune.event_log ADD CONSTRAINT event_log_pkey PRIMARY KEY (event_id, partition_key);",
  ...eventLogFixture.flatMap((row, index) => [
    `CREATE TABLE dune.${row.partition} PARTITION OF dune.event_log FOR VALUES FROM (${index}) TO (${index + 1});`,
    `CREATE UNIQUE INDEX ${row.inheritedPrimaryKey} ON dune.${row.partition} USING btree (event_id, partition_key);`,
    `ALTER INDEX dune.event_log_pkey ATTACH PARTITION dune.${row.inheritedPrimaryKey};`
  ])
].join("\n");
assert.equal((eventLogRestoreSql.match(/CREATE TABLE dune\.event_log_p/g) || []).length, 31);
assert.equal((eventLogRestoreSql.match(/ATTACH PARTITION dune\.event_log_p/g) || []).length, 31);
assert.doesNotMatch(eventLogRestoreSql, /DROP CONSTRAINT/);

// Sanitized definitions extracted from the accepted v4 archive's TOC SQL.
const verifiedPackageExtensionReferences = [
  "ext.encrypt(convert_to(in_data, 'utf8'), key, 'aes')",
  "ext.decrypt(in_encrypted_data, key, 'aes')",
  "ext.SIMILARITY(player_state.character_name, in_player_name)",
  "ext.digest(encryption_key, 'md5')",
  "decrypt_user_data(encrypted_character_name) ext.gin_trgm_ops",
  "dune.decrypt_user_data(encrypted_character_name) ext.gin_trgm_ops"
];
assert.deepEqual(verifiedPackageExtensionReferences.flatMap((sql) => [...sql.matchAll(/\b(public|ext)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)/giu)].map((match) => [match[1].toLowerCase(), match[2].toLowerCase()])), [
  ["ext", "encrypt"], ["ext", "decrypt"], ["ext", "similarity"], ["ext", "digest"], ["ext", "gin_trgm_ops"], ["ext", "gin_trgm_ops"]
], "the verified package SQL is explicitly compatible with ext, not namespace-independent");
assert.equal(verifiedPackageExtensionReferences.some((sql) => /\bpublic\s*\./iu.test(sql)), false);

function fakeRun(options = {}) {
  const calls = [];
  let schema = options.initialSchema || "fresh";
  let cleanupCount = 0;
  let generatedSql = "";
  const runCommand = async (_command, args) => {
    const command = args.slice(args.indexOf("--") + 1);
    calls.push(command);
    if (command[0] === "find") return { ok: true, code: 0, stdout: "", stderr: "" };
    if (command[0] === "rm") { cleanupCount += 1; return { ok: true, code: 0, stdout: "", stderr: "" }; }
    if (command[0] === "stat" && command[2] === "%a") return { ok: true, code: 0, stdout: "600\n", stderr: "" };
    if (command[0] === "stat" && command[2] === "%s") {
      const bytes = command[3] === POD_ARCHIVE_PATHS.dropSql ? Buffer.byteLength(DROP_DUNE_SCHEMA_SQL) : command[3] === POD_ARCHIVE_PATHS.runtimeRoleVerifySql ? Buffer.byteLength(DUNE_RUNTIME_ROLE_VERIFY_SQL) : Buffer.byteLength(generatedSql);
      return { ok: true, code: 0, stdout: `${bytes}\n`, stderr: "" };
    }
    if (command[0] === "sha256sum" && command[1] === POD_ARCHIVE_PATHS.dropSql) return { ok: true, code: 0, stdout: `${crypto.createHash("sha256").update(DROP_DUNE_SCHEMA_SQL).digest("hex")}  ${POD_ARCHIVE_PATHS.dropSql}\n`, stderr: "" };
    if (command[0] === "sha256sum" && command[1] === POD_ARCHIVE_PATHS.restoreSql) return { ok: true, code: 0, stdout: `${crypto.createHash("sha256").update(generatedSql).digest("hex")}  ${POD_ARCHIVE_PATHS.restoreSql}\n`, stderr: "" };
    if (command[0] === "sha256sum" && command[1] === POD_ARCHIVE_PATHS.runtimeRoleVerifySql) return { ok: true, code: 0, stdout: `${crypto.createHash("sha256").update(DUNE_RUNTIME_ROLE_VERIFY_SQL).digest("hex")}  ${POD_ARCHIVE_PATHS.runtimeRoleVerifySql}\n`, stderr: "" };
    if (command.some((value) => /(?:^|\/)pg_restore$/.test(value))) {
      assert.equal(command.includes("--clean"), false);
      if (command.includes("--list")) return { ok: true, code: 0, stdout: "7; 2615 16387 SCHEMA - dune dune\n", stderr: "" };
      assert.equal(command.includes("--schema=dune"), true);
      assert.equal(command.some((value) => /DROP CONSTRAINT/i.test(value)), false, "no inherited partition constraint is directly dropped");
      generatedSql = options.duplicateSchema ? "CREATE SCHEMA dune;\n" : eventLogRestoreSql;
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    assert.notEqual(command[0], "grep", "restore SQL validation must never execute a remote regex command");
    if (command.some((value) => /(?:^|\/)psql$/.test(value))) {
      assert.equal(command.includes("--single-transaction"), true);
      assert.equal(command.includes("--set=ON_ERROR_STOP=1"), true);
      assert.equal(command.includes(`--file=${POD_ARCHIVE_PATHS.dropSql}`), true);
      assert.equal(command.includes(`--file=${POD_ARCHIVE_PATHS.restoreSql}`), true);
      assert.equal(command.includes(`--file=${POD_ARCHIVE_PATHS.runtimeRoleVerifySql}`), true);
      assert.equal(command.filter((value) => value.startsWith("--file=")).length, 3);
      assert(command.indexOf(`--file=${POD_ARCHIVE_PATHS.dropSql}`) < command.indexOf(`--file=${POD_ARCHIVE_PATHS.restoreSql}`), "the reset file must precede the generated restore file in the same psql transaction");
      assert(command.indexOf(`--file=${POD_ARCHIVE_PATHS.restoreSql}`) < command.indexOf(`--file=${POD_ARCHIVE_PATHS.runtimeRoleVerifySql}`), "runtime-role verification must run after restoration and before the transaction commits");
      assert.equal(command.includes(DROP_DUNE_SCHEMA_SQL), false);
      assert.equal(command.includes("--command"), false);
      assert.equal(command.includes("sh"), false);
      assert.equal(command.includes("bash"), false);
      assert(command.every((value) => !/\s/.test(value)), "the final SSH→kubectl→psql vector cannot contain whitespace-bearing arguments");
      assert.equal((generatedSql.match(/CREATE TABLE dune\.event_log_p/g) || []).length, 31, "matching-version restore SQL carries all 31 event_log partitions");
      assert.equal((generatedSql.match(/ATTACH PARTITION dune\.event_log_p/g) || []).length, 31, "partitioned primary-key indexes are attached without leaf constraint drops");
      assert.doesNotMatch(generatedSql, /DROP CONSTRAINT/);
      if (options.failAtomic) return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: "ERROR: restore fixture failed password=not-a-secret" };
      schema = options.nextSchema || "imported";
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const streamToFile = async ({ outputPath, expectedBytes }) => {
    fs.writeFileSync(outputPath, generatedSql, { flag: "wx", mode: 0o600 });
    const size = String(Buffer.byteLength(generatedSql));
    assert.equal(String(expectedBytes), size);
    return { size, sha256: crypto.createHash("sha256").update(generatedSql).digest("hex") };
  };
  return { runCommand, streamToFile, calls, schema: () => schema, cleanupCount: () => cleanupCount };
}

(async () => {
  assert.deepEqual(DUNE_RESTORE_FLAGS, ["--exit-on-error", "--schema=dune", "--no-owner", "--no-privileges"]);
  assert.equal(DUNE_SCHEMA_OWNER, "dune");
  assert.equal(DROP_DUNE_SCHEMA_SQL, "DROP SCHEMA dune CASCADE;\nCREATE SCHEMA dune;\nALTER SCHEMA dune OWNER TO dune;\nSET ROLE dune;");
  assert.match(DUNE_RUNTIME_ROLE_VERIFY_SQL, /get_applied_patches\(\)/);
  assert.match(DUNE_RUNTIME_ROLE_VERIFY_SQL, /^\s*SET LOCAL search_path TO dune, ext, public, pg_catalog;/);
  assert.match(DUNE_RUNTIME_ROLE_VERIFY_SQL, /current_schemas\(true\)/);
  assert.match(DUNE_RUNTIME_ROLE_VERIFY_SQL, /to_regclass\('applied_patches'\).*to_regclass\('dune\.applied_patches'\)/s);
  assert.match(DUNE_RUNTIME_ROLE_VERIFY_SQL, /has_sequence_privilege/);
  assert.match(DUNE_RUNTIME_ROLE_VERIFY_SQL, /r\.rolname<>'dune'/);
  assert.deepEqual(ATOMIC_PSQL_FLAGS, ["--no-password", "--single-transaction", "--set=ON_ERROR_STOP=1"]);
  const directVector = atomicDunePsqlArgs({ psqlExecutable: "/usr/local/bin/psql", dbSvc: "postgres-service" });
  assert(directVector.every((value) => !/\s/.test(value)), "serialized psql arguments must be whitespace-free");
  assert(directVector.every((value) => !/DROP|SCHEMA|CASCADE|;/i.test(value)), "serialized psql arguments must contain no SQL");
  assert.equal(directVector.includes("--command"), false);
  assert(directVector.includes(`--file=${POD_ARCHIVE_PATHS.runtimeRoleVerifySql}`));
  assert.deepEqual(validateDuneSchemaToc("7; 2615 16387 SCHEMA - dune dune\n"), { schemaDescriptorCount: "1", owner: "dune" });
  assert.throws(() => validateDuneSchemaToc("7; 2615 16387 SCHEMA - dune postgres\n"), /owner differs/);
  assert.throws(() => validateDuneSchemaToc(""), /exactly one dune schema descriptor/);

  const dependency = normalizeCrossSchemaDependencyEvidence({ count: "0", sha256Input: "[]" });
  assert.equal(dependency.count, "0");
  assert.throws(() => normalizeCrossSchemaDependencyEvidence({ count: "1", sha256Input: "[[\"view\",\"public\"]]" }), /outside dune depends/);

  const collectedExtensions = (schema = "ext", namespaceOid = "16384") => [
    { name: "pgcrypto", version: "1.3", schema, namespaceOid, ownerPresent: true, membershipCount: "2", membershipInput: JSON.stringify([["function", schema, `${schema}.digest(bytea,text)`], ["type", schema, `${schema}.digest`]]) },
    { name: "pg_trgm", version: "1.6", schema, namespaceOid, ownerPresent: true, membershipCount: "2", membershipInput: JSON.stringify([["operator", schema, `${schema}.%(text,text)`], ["function", schema, `${schema}.similarity(text,text)`]]) }
  ];
  const outside = normalizeOutsideDuneBoundary({
    extensions: collectedExtensions(),
    objectCount: "9007199254740993",
    sha256Input: "outside-object-canonical-fixture"
  });
  const differentOid = normalizeOutsideDuneBoundary({ extensions: collectedExtensions("ext", "987654"), objectCount: "9007199254740993", sha256Input: "outside-object-canonical-fixture" });
  assert.deepEqual(differentOid, outside, "namespace OIDs are validated but excluded from canonical evidence");
  const reorderedMembers = collectedExtensions();
  reorderedMembers[0].membershipInput = JSON.stringify(JSON.parse(reorderedMembers[0].membershipInput).reverse());
  assert.deepEqual(normalizeOutsideDuneBoundary({ extensions: reorderedMembers, objectCount: "9007199254740993", sha256Input: "outside-object-canonical-fixture" }), outside, "extension membership order is canonicalized");
  assert.throws(() => normalizeOutsideDuneBoundary({ extensions: collectedExtensions("public", "2200"), objectCount: "152", sha256Input: "public-fixture" }), /Required ext-schema extension evidence/, "public is not accepted as an alternate extension namespace");
  assert.throws(() => normalizeOutsideDuneBoundary({ extensions: collectedExtensions().slice(0, 1), objectCount: "1", sha256Input: "missing" }), /Required ext-schema extension evidence/);
  assert.throws(() => normalizeOutsideDuneBoundary({ extensions: [collectedExtensions()[0], collectedExtensions()[0]], objectCount: "1", sha256Input: "duplicate" }), /duplicated/);
  assert.throws(() => normalizeOutsideDuneBoundary({ extensions: collectedExtensions().map((row) => row.name === "pgcrypto" ? { ...row, version: "1.2" } : row), objectCount: "1", sha256Input: "version" }), /Required ext-schema extension evidence/);
  assert.throws(() => normalizeOutsideDuneBoundary({ extensions: collectedExtensions().map((row) => ({ ...row, ownerPresent: false })), objectCount: "1", sha256Input: "owner" }), /ownership evidence/);
  assert.throws(() => normalizeOutsideDuneBoundary({ extensions: collectedExtensions().map((row) => ({ ...row, membershipInput: "truncated" })), objectCount: "1", sha256Input: "membership" }), /membership evidence is malformed/);
  assertOutsideDuneBoundaryUnchanged(outside, { ...outside });
  assert.throws(() => assertOutsideDuneBoundaryUnchanged(outside, { ...outside, sha256: digest("a") }), /outside dune changed/);
  const changedMembership = JSON.parse(JSON.stringify(outside));
  changedMembership.extensions[0].membershipSha256 = digest("b");
  assert.throws(() => assertOutsideDuneBoundaryUnchanged(outside, changedMembership), /inconsistent|outside dune changed/, "extension membership is pinned across import and rollback checkpoints");

  const packageRestore = fakeRun({ initialSchema: "fresh", nextSchema: "imported" });
  const packageResult = await runAtomicDuneSchemaRestore({ ...base, runCommand: packageRestore.runCommand, streamToFile: packageRestore.streamToFile });
  assert.equal(packageResult.ok, true);
  assert.equal(packageRestore.schema(), "imported", "successful package restore replaces dune");
  assert.ok(packageRestore.cleanupCount() >= 8, "drop SQL, restore SQL, and credential artifacts are cleaned before and after use");

  const interruptedDrop = fakeRun({ initialSchema: "fresh", nextSchema: "imported" });
  await assert.rejects(() => runAtomicDuneSchemaRestore({
    ...base,
    runCommand: interruptedDrop.runCommand,
    streamToFile: interruptedDrop.streamToFile,
    runStdinScript: async () => ({ ok: false, code: 0, inputComplete: false, stdout: "", stderr: "" })
  }), /stdin transfer failed/);
  assert.equal(interruptedDrop.schema(), "fresh", "an incomplete drop-file stdin transfer cannot reach psql");
  assert.ok(interruptedDrop.cleanupCount() >= 8, "an interrupted drop-file transfer cleans every fixed SQL and credential path");

  const failedRestore = fakeRun({ initialSchema: "fresh", nextSchema: "imported", failAtomic: true });
  await assert.rejects(() => runAtomicDuneSchemaRestore({ ...base, runCommand: failedRestore.runCommand, streamToFile: failedRestore.streamToFile }), (error) => {
    assert.equal(error.details.stage, "atomic_dune_restore");
    assert.equal(error.details.exitCode, 1);
    assert.equal(error.details.timedOut, false);
    assert.match(error.details.stderr, /restore fixture failed/);
    assert.doesNotMatch(error.details.stderr, /not-a-secret/);
    return true;
  });
  assert.equal(failedRestore.schema(), "fresh", "a failed single transaction leaves the original dune schema unchanged");

  const duplicateSchema = fakeRun({ initialSchema: "fresh", duplicateSchema: true });
  await assert.rejects(() => runAtomicDuneSchemaRestore({ ...base, runCommand: duplicateSchema.runCommand, streamToFile: duplicateSchema.streamToFile }), /duplicates CREATE SCHEMA dune/);
  assert.equal(duplicateSchema.schema(), "fresh", "duplicate schema creation is rejected before psql can replace dune");

  const rollbackRestore = fakeRun({ initialSchema: "partial", nextSchema: "fresh" });
  await runAtomicDuneSchemaRestore({ ...base, runCommand: rollbackRestore.runCommand, streamToFile: rollbackRestore.streamToFile });
  assert.equal(rollbackRestore.schema(), "fresh", "the full rollback archive restores only its dune boundary");

  const dryRun = fakeRun({ initialSchema: "fresh", nextSchema: "imported" });
  const dryResult = await runAtomicDuneSchemaRestore({ ...base, runCommand: dryRun.runCommand, streamToFile: dryRun.streamToFile, stopBeforePsql: true });
  assert.equal(dryResult.stoppedBeforePsql, true);
  assert.equal(dryRun.schema(), "fresh", "transport-only validation must stop before psql");
  assert.equal(dryRun.calls.some((command) => command.some((value) => /(?:^|\/)psql$/.test(value))), false);

  for (const call of [...packageRestore.calls, ...failedRestore.calls, ...rollbackRestore.calls]) {
    assert.equal(call.includes("--clean"), false, "neither import nor rollback can use pg_restore --clean");
    assert.equal(call.some((value) => eventLogFixture.some((row) => value.includes(`DROP CONSTRAINT ${row.inheritedPrimaryKey}`))), false);
  }

  console.log("Atomic dune schema replacement, outside-boundary, 31-partition event_log, rollback, and retained-diagnostic tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
