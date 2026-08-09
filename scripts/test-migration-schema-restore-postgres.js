"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DROP_DUNE_SCHEMA_SQL, DUNE_RUNTIME_ROLE_VERIFY_SQL } = require("../lib/migration-schema-restore");

const bin = path.resolve(process.env.ALPHANINE_TEST_POSTGRES_BIN || "");
if (!bin || !fs.existsSync(path.join(bin, "postgres.exe"))) throw new Error("Set ALPHANINE_TEST_POSTGRES_BIN to a PostgreSQL 17 bin directory for the real restore fixture.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "a9-real-pg-restore-"));
const data = path.join(root, "data");
const port = String(55439 + Math.floor(Math.random() * 500));
let started = false;
const exe = (name) => path.join(bin, `${name}.exe`);
function run(name, args, options = {}) {
  const result = spawnSync(exe(name), args.map(String), { encoding: "utf8", timeout: options.timeout || 120000, windowsHide: true, stdio: options.stdio || "pipe", env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  if (result.error || result.status !== 0) throw new Error(`${name} failed (${result.status ?? "no-exit"}): ${String(result.stderr || result.error?.message || "").replace(/password\s*=\s*\S+/gi, "password=[redacted]").slice(0, 1000)}`);
  return String(result.stdout || "");
}
const psql = (db, ...extra) => run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", db, ...extra]);
const write = (name, text) => { const file = path.join(root, name); fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 }); return file; };
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const schemaDump = (db, ...schemas) => run("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", ...schemas.flatMap((schema) => ["--schema", schema]), "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", db])
  .replace(/^\\(?:un)?restrict\s+\S+\s*$/gm, "\\restrict [canonical]");
const runtimeObjects = (marker) => `
CREATE TABLE dune.actors(id bigint PRIMARY KEY);
CREATE TABLE dune.world_partition(id bigint PRIMARY KEY);
CREATE TABLE dune.parties(id bigint PRIMARY KEY);
CREATE SEQUENCE dune.items_id_seq;
CREATE TABLE dune.items(id bigint PRIMARY KEY DEFAULT nextval('dune.items_id_seq'));
ALTER SEQUENCE dune.items_id_seq OWNED BY dune.items.id;
CREATE TABLE dune.applied_patches(patch text PRIMARY KEY);
INSERT INTO dune.applied_patches VALUES ('${marker}');
CREATE VIEW dune.accounts AS SELECT id FROM dune.actors;
CREATE VIEW dune.player_state AS SELECT id FROM dune.actors;
CREATE FUNCTION dune.get_applied_patches() RETURNS SETOF text LANGUAGE sql STABLE AS $$ SELECT patch FROM dune.applied_patches ORDER BY patch $$;
`;
const ownerEvidence = (db) => psql(db, "-At", "-c", `
SELECT jsonb_build_object(
 'schemaOwner',(SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='dune'),
 'postgresOwned',(SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='dune' AND r.rolname='postgres'),
 'duneOwnedRelations',(SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='dune' AND r.rolname='dune'),
 'duneOwnedFunctions',(SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='dune' AND r.rolname='dune')
)::text;`).trim();

try {
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"], { timeout: 180000 });
  // Detached Windows postgres children must not inherit Node's captured pipe handles.
  run("pg_ctl", ["-D", data, "-l", path.join(root, "postgres.log"), "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"], { timeout: 180000, stdio: "ignore" });
  started = true;
  psql("postgres", "-c", "CREATE ROLE dune;");
  run("createdb", ["-h", "127.0.0.1", "-p", port, "-U", "postgres", "-T", "template0", "source_fixture"]);
  run("createdb", ["-h", "127.0.0.1", "-p", port, "-U", "postgres", "-T", "template0", "destination_fixture"]);

  const common = [
    "CREATE SCHEMA ext;",
    "CREATE EXTENSION pgcrypto WITH SCHEMA ext;",
    "CREATE EXTENSION pg_trgm WITH SCHEMA ext;",
    "GRANT USAGE ON SCHEMA ext TO dune;",
    "CREATE SCHEMA outside_guard;",
    "CREATE TABLE outside_guard.sentinel(value text PRIMARY KEY);",
    "INSERT INTO outside_guard.sentinel VALUES ('unchanged');"
  ].join("\n");
  const fresh = `${common}\nCREATE SCHEMA dune AUTHORIZATION dune;\nCREATE TABLE dune.fresh_marker(id bigint PRIMARY KEY);\nINSERT INTO dune.fresh_marker VALUES (1);\n${runtimeObjects("fresh-patch")}`;
  psql("destination_fixture", "--file", write("fresh.sql", fresh));

  const partitions = Array.from({ length: 31 }, (_, index) => [
    `CREATE TABLE dune.event_log_p${index + 1} PARTITION OF dune.event_log FOR VALUES FROM (${index}) TO (${index + 1});`,
    `INSERT INTO dune.event_log VALUES (${index + 1},${index},'event-${index + 1}');`
  ].join("\n")).join("\n");
  const source = `${common}\nCREATE SCHEMA dune AUTHORIZATION dune;\nCREATE TABLE dune.imported_marker(id bigint PRIMARY KEY, value text NOT NULL);\nINSERT INTO dune.imported_marker VALUES (9007199254740993,'imported');\nCREATE TABLE dune.event_log(event_id bigint NOT NULL,bucket integer NOT NULL,payload text,PRIMARY KEY(event_id,bucket)) PARTITION BY RANGE(bucket);\n${partitions}\n${runtimeObjects("imported-patch")}`;
  psql("source_fixture", "--file", write("source.sql", source));

  const packageArchive = path.join(root, "package.dump");
  const rollbackArchive = path.join(root, "rollback.dump");
  run("pg_dump", ["--format=custom", "--schema=dune", "--no-owner", "--no-privileges", "--file", packageArchive, "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "source_fixture"]);
  run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", rollbackArchive, "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "destination_fixture"]);
  const packageSql = path.join(root, "package-restore.sql");
  const rollbackSql = path.join(root, "rollback-restore.sql");
  for (const [archive, sql] of [[packageArchive, packageSql], [rollbackArchive, rollbackSql]]) {
    run("pg_restore", ["--exit-on-error", "--schema=dune", "--no-owner", "--no-privileges", `--file=${sql}`, archive]);
    const generated = fs.readFileSync(sql, "utf8");
    assert.match(generated, /set_config\('search_path', '', false\)/, "matching-version pg_restore must leave the generated restore session with an empty search_path fixture");
    assert.doesNotMatch(generated, /^CREATE\s+SCHEMA\s+dune\b/im, "archive-generated SQL must not duplicate the explicit schema creation");
    assert.doesNotMatch(generated, /(?:ext|outside_guard)\./i, "dune restore projection must never include outside schemas");
  }
  const reset = write("reset.sql", `${DROP_DUNE_SCHEMA_SQL}\n`);
  const runtimeVerify = write("runtime-role-verify.sql", DUNE_RUNTIME_ROLE_VERIFY_SQL);
  assert.match(fs.readFileSync(reset, "utf8"), /DROP SCHEMA dune CASCADE;\r?\nCREATE SCHEMA dune;/);
  assert.match(fs.readFileSync(reset, "utf8"), /SET ROLE dune;/);

  const freshFingerprint = sha(schemaDump("destination_fixture", "dune"));
  const outsideBefore = sha(schemaDump("destination_fixture", "ext", "outside_guard"));
  psql("destination_fixture", "--single-transaction", "--set=ON_ERROR_STOP=1", `--file=${reset}`, `--file=${packageSql}`, `--file=${runtimeVerify}`);
  assert.equal(psql("destination_fixture", "-At", "-c", "SELECT count(*) FROM dune.event_log;").trim(), "31");
  assert.equal(psql("destination_fixture", "-At", "-c", "SELECT count(*) FROM pg_inherits i JOIN pg_class p ON p.oid=i.inhparent JOIN pg_namespace n ON n.oid=p.relnamespace WHERE n.nspname='dune' AND p.relname='event_log';").trim(), "31");
  assert.equal(sha(schemaDump("destination_fixture", "ext", "outside_guard")), outsideBefore);
  const importedOwnerEvidence = JSON.parse(ownerEvidence("destination_fixture"));
  assert.equal(importedOwnerEvidence.schemaOwner, "dune");
  assert.equal(importedOwnerEvidence.postgresOwned, "0");
  assert(BigInt(importedOwnerEvidence.duneOwnedRelations) > 0n);
  assert(BigInt(importedOwnerEvidence.duneOwnedFunctions) > 0n);
  assert.equal(psql("destination_fixture", "-At", "-c", "SET ROLE dune; SELECT count(*) FROM dune.accounts; SELECT count(*) FROM dune.get_applied_patches();").trim().split(/\r?\n/).at(-1), "1");
  assert.equal(psql("destination_fixture", "-At", "-c", "SET ROLE dune; SET search_path TO dune, ext, public, pg_catalog; SELECT current_setting('search_path'); SELECT current_schemas(true) @> ARRAY['dune','ext','public','pg_catalog']::name[]; SELECT to_regclass('applied_patches')=to_regclass('dune.applied_patches');").trim().split(/\r?\n/).slice(-3).join("|"), "dune, ext, public, pg_catalog|t|t");

  const importedFingerprint = sha(schemaDump("destination_fixture", "dune"));
  const bad = write("bad-restore.sql", "CREATE TABLE dune.must_rollback(id integer);\nSELECT 1/0;\n");
  const ownerBeforeFailure = ownerEvidence("destination_fixture");
  const failed = spawnSync(exe("psql"), ["-X", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "destination_fixture", "--single-transaction", "--set=ON_ERROR_STOP=1", `--file=${reset}`, `--file=${bad}`, `--file=${runtimeVerify}`], { encoding: "utf8", timeout: 120000, windowsHide: true });
  assert.notEqual(failed.status, 0, "the deliberately invalid restore must fail");
  assert.equal(sha(schemaDump("destination_fixture", "dune")), importedFingerprint, "a restore failure after schema creation must preserve the original schema transactionally");
  assert.equal(ownerEvidence("destination_fixture"), ownerBeforeFailure, "an injected failure must preserve the complete owner/ACL class");

  const badOwnerReset = write("bad-owner-reset.sql", "DROP SCHEMA dune CASCADE;\nCREATE SCHEMA dune;\nALTER SCHEMA dune OWNER TO dune;\n");
  const ownerFailure = spawnSync(exe("psql"), ["-X", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "destination_fixture", "--single-transaction", "--set=ON_ERROR_STOP=1", `--file=${badOwnerReset}`, `--file=${packageSql}`, `--file=${runtimeVerify}`], { encoding: "utf8", timeout: 120000, windowsHide: true });
  assert.notEqual(ownerFailure.status, 0, "runtime-role verification must reject objects restored as postgres");
  assert.match(String(ownerFailure.stderr), /owner or ACL class is invalid|runtime role context is invalid/);
  assert.equal(sha(schemaDump("destination_fixture", "dune")), importedFingerprint, "an ownership verification failure must roll back the entire schema replacement");
  assert.equal(ownerEvidence("destination_fixture"), ownerBeforeFailure, "ownership verification failure must preserve the original owner/ACL evidence");

  psql("destination_fixture", "--single-transaction", "--set=ON_ERROR_STOP=1", `--file=${reset}`, `--file=${rollbackSql}`, `--file=${runtimeVerify}`);
  assert.equal(sha(schemaDump("destination_fixture", "dune")), freshFingerprint, "rollback must restore the exact fresh schema fingerprint");
  assert.equal(psql("destination_fixture", "-At", "-c", "SELECT count(*) FROM dune.fresh_marker;").trim(), "1");
  assert.equal(sha(schemaDump("destination_fixture", "ext", "outside_guard")), outsideBefore, "outside-dune objects must remain unchanged across import, failure, and rollback");
  const rollbackOwnerEvidence = JSON.parse(ownerEvidence("destination_fixture"));
  assert.equal(rollbackOwnerEvidence.schemaOwner, "dune");
  assert.equal(rollbackOwnerEvidence.postgresOwned, "0");
  assert(BigInt(rollbackOwnerEvidence.duneOwnedRelations) > 0n);
  assert(BigInt(rollbackOwnerEvidence.duneOwnedFunctions) > 0n);

  console.log("Real PostgreSQL 17 atomic schema recreation, runtime-role ownership/ACL smoke, failure rollback, full-backup dune projection, partition restore, and outside-boundary fixtures passed.");
} finally {
  if (started) spawnSync(exe("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { encoding: "utf8", timeout: 120000, windowsHide: true, stdio: "ignore" });
  if (path.basename(root).startsWith("a9-real-pg-restore-")) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
