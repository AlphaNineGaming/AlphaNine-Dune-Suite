"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  POD_ARCHIVE_PATHS,
  cleanupPodArchivePaths,
  exactPodExecutable,
  installPodPgpass,
  hashStableFile,
  podExecArgs,
  podCredentialPreparationArgs,
  requirePodCommand,
  runPodStage,
  streamCommandToFile
} = require("./server-migration-export");

const DUNE_RESTORE_FLAGS = Object.freeze(["--exit-on-error", "--schema=dune", "--no-owner", "--no-privileges"]);
const ATOMIC_PSQL_FLAGS = Object.freeze(["--no-password", "--single-transaction", "--set=ON_ERROR_STOP=1"]);
const DUNE_SCHEMA_OWNER = "dune";
const DROP_DUNE_SCHEMA_SQL = [
  "DROP SCHEMA dune CASCADE;",
  "CREATE SCHEMA dune;",
  `ALTER SCHEMA dune OWNER TO ${DUNE_SCHEMA_OWNER};`,
  `SET ROLE ${DUNE_SCHEMA_OWNER};`
].join("\n");
const DROP_DUNE_SCHEMA_BYTES = Buffer.from(DROP_DUNE_SCHEMA_SQL, "utf8");
const DROP_DUNE_SCHEMA_SHA256 = crypto.createHash("sha256").update(DROP_DUNE_SCHEMA_BYTES).digest("hex");

// This file is executed after the archive-generated SQL but before psql may
// commit its single transaction.  It deliberately uses catalog ownership and
// privilege predicates instead of attempting to repair a bad restore with
// broad grants.
const DUNE_RUNTIME_ROLE_VERIFY_SQL = String.raw`
SET LOCAL search_path TO dune, ext, public, pg_catalog;
DO $a9_runtime_role_verify$
DECLARE
  required_relation text;
  relation_oid oid;
  required_function oid;
BEGIN
  IF current_user <> 'dune' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration runtime role context is invalid';
  END IF;
  IF current_setting('search_path') <> 'dune, ext, public, pg_catalog' THEN
    RAISE EXCEPTION 'migration runtime search_path is invalid';
  END IF;
  IF (SELECT array_agg(schema_name ORDER BY schema_name)
      FROM unnest(current_schemas(true)) schema_name
      WHERE schema_name !~ '^pg_(?:temp|toast_temp)_')
     <> ARRAY['dune','ext','pg_catalog','public']::name[] THEN
    RAISE EXCEPTION 'migration runtime current_schemas evidence is invalid: %',current_schemas(true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='dune' AND r.rolname='dune' AND n.nspacl IS NULL
  ) THEN
    RAISE EXCEPTION 'dune schema owner or ACL class is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='dune' AND (r.rolname<>'dune' OR c.relacl IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='dune' AND (r.rolname<>'dune' OR p.proacl IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_roles r ON r.oid=t.typowner
    WHERE n.nspname='dune' AND (r.rolname<>'dune' OR t.typacl IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM pg_collation x JOIN pg_namespace n ON n.oid=x.collnamespace
    JOIN pg_roles r ON r.oid=x.collowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) OR EXISTS (
    SELECT 1 FROM pg_conversion x JOIN pg_namespace n ON n.oid=x.connamespace
    JOIN pg_roles r ON r.oid=x.conowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) OR EXISTS (
    SELECT 1 FROM pg_operator x JOIN pg_namespace n ON n.oid=x.oprnamespace
    JOIN pg_roles r ON r.oid=x.oprowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) OR EXISTS (
    SELECT 1 FROM pg_opclass x JOIN pg_namespace n ON n.oid=x.opcnamespace
    JOIN pg_roles r ON r.oid=x.opcowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) OR EXISTS (
    SELECT 1 FROM pg_opfamily x JOIN pg_namespace n ON n.oid=x.opfnamespace
    JOIN pg_roles r ON r.oid=x.opfowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) OR EXISTS (
    SELECT 1 FROM pg_ts_config x JOIN pg_namespace n ON n.oid=x.cfgnamespace
    JOIN pg_roles r ON r.oid=x.cfgowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) OR EXISTS (
    SELECT 1 FROM pg_ts_dict x JOIN pg_namespace n ON n.oid=x.dictnamespace
    JOIN pg_roles r ON r.oid=x.dictowner WHERE n.nspname='dune' AND r.rolname<>'dune'
  ) THEN
    RAISE EXCEPTION 'one or more dune objects has an unexpected owner or ACL class';
  END IF;

  FOREACH required_relation IN ARRAY ARRAY[
    'accounts','actors','world_partition','player_state','parties','items','applied_patches'
  ] LOOP
    relation_oid := to_regclass(format('dune.%I',required_relation));
    IF relation_oid IS NULL OR NOT has_table_privilege(current_user,relation_oid,'SELECT') THEN
      RAISE EXCEPTION 'runtime role cannot read required dune relation category %',required_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='dune' AND c.relkind='S'
      AND NOT (
        has_sequence_privilege(current_user,c.oid,'USAGE')
        AND has_sequence_privilege(current_user,c.oid,'SELECT')
        AND has_sequence_privilege(current_user,c.oid,'UPDATE')
      )
  ) THEN
    RAISE EXCEPTION 'runtime role lacks required dune sequence privileges';
  END IF;
  relation_oid := to_regclass('dune.items_id_seq');
  IF relation_oid IS NULL
     OR NOT has_sequence_privilege(current_user,relation_oid,'USAGE')
     OR NOT has_sequence_privilege(current_user,relation_oid,'SELECT')
     OR NOT has_sequence_privilege(current_user,relation_oid,'UPDATE') THEN
    RAISE EXCEPTION 'runtime role cannot use the required items sequence';
  END IF;

  required_function := to_regprocedure('dune.get_applied_patches()');
  IF required_function IS NULL OR NOT has_function_privilege(current_user,required_function,'EXECUTE') THEN
    RAISE EXCEPTION 'runtime role cannot execute get_applied_patches()';
  END IF;
  IF to_regclass('applied_patches') IS DISTINCT FROM to_regclass('dune.applied_patches') THEN
    RAISE EXCEPTION 'get_applied_patches() would not resolve dune.applied_patches';
  END IF;

  -- These are zero-row reads: they exercise real relation/view resolution and
  -- permissions without observing or changing game data.
  PERFORM 1 FROM dune.accounts LIMIT 0;
  PERFORM 1 FROM dune.actors LIMIT 0;
  PERFORM 1 FROM dune.world_partition LIMIT 0;
  PERFORM 1 FROM dune.player_state LIMIT 0;
  PERFORM 1 FROM dune.parties LIMIT 0;
  PERFORM 1 FROM dune.items LIMIT 0;
  PERFORM 1 FROM dune.applied_patches LIMIT 0;
  PERFORM dune.get_applied_patches();
END
$a9_runtime_role_verify$;
`;
const DUNE_RUNTIME_ROLE_VERIFY_BYTES = Buffer.from(DUNE_RUNTIME_ROLE_VERIFY_SQL, "utf8");
const DUNE_RUNTIME_ROLE_VERIFY_SHA256 = crypto.createHash("sha256").update(DUNE_RUNTIME_ROLE_VERIFY_BYTES).digest("hex");

const CROSS_SCHEMA_DEPENDENCY_SQL = String.raw`
WITH dependency_rows AS (
  SELECT dependent.type AS dependent_type,dependent.schema AS dependent_schema,dependent.identity AS dependent_identity,
         referenced.type AS referenced_type,referenced.identity AS referenced_identity,d.deptype
  FROM pg_depend d
  CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) dependent
  CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) referenced
  WHERE referenced.schema='dune'
    AND dependent.schema IS NOT NULL AND dependent.schema<>'dune'
    AND dependent.schema!~'^pg_' AND dependent.schema<>'information_schema'
), canonical AS (
  SELECT count(*)::text AS count,
         COALESCE(jsonb_agg(jsonb_build_array(dependent_type,dependent_schema,dependent_identity,
           referenced_type,referenced_identity,deptype)
           ORDER BY dependent_type,dependent_schema,dependent_identity,referenced_type,referenced_identity,deptype),'[]'::jsonb)::text AS rows
  FROM dependency_rows
)
SELECT jsonb_build_object('count',count,'sha256Input',rows)::text FROM canonical;
`;

const OUTSIDE_DUNE_BOUNDARY_SQL = String.raw`
WITH extension_base AS (
  SELECT e.oid,e.extname,e.extversion,n.nspname AS schema_name,n.oid::text AS namespace_oid,(e.extowner<>0) AS owner_present
  FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
  WHERE e.extname IN ('pgcrypto','pg_trgm')
), extension_member_rows AS (
  SELECT e.extname,identified.type,COALESCE(identified.schema,'') AS member_schema,identified.identity
  FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
  CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) identified
  WHERE e.extname IN ('pgcrypto','pg_trgm')
), extension_members AS (
  SELECT extname,count(*)::text AS member_count,
         COALESCE(jsonb_agg(jsonb_build_array(type,member_schema,identity) ORDER BY type,member_schema,identity),'[]'::jsonb)::text AS membership_input
  FROM extension_member_rows GROUP BY extname
), extension_rows AS (
  SELECT b.extname,b.extversion,b.schema_name,b.namespace_oid,b.owner_present,m.member_count,m.membership_input
  FROM extension_base b JOIN extension_members m USING(extname)
), object_rows AS (
  SELECT 'schema' AS kind,n.nspname AS identity,to_jsonb(n.nspname) AS definition
  FROM pg_namespace n WHERE n.nspname NOT IN ('dune','pg_catalog','information_schema') AND n.nspname!~'^pg_toast' AND n.nspname!~'^pg_temp'
  UNION ALL
  SELECT 'relation',format('%I.%I',n.nspname,c.relname),jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname<>'dune' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_toast' AND n.nspname!~'^pg_temp'
    AND c.relkind IN ('r','p','v','m','S','f','i','I')
  UNION ALL
  SELECT 'column',format('%I.%I.%I',n.nspname,c.relname,a.attname),
         jsonb_build_object('position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
           'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(ad.adbin,ad.adrelid,true))
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname<>'dune' AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname!~'^pg_toast' AND n.nspname!~'^pg_temp'
  UNION ALL
  SELECT 'constraint',format('%I.%I',n.nspname,con.conname),to_jsonb(pg_get_constraintdef(con.oid,true))
  FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
  WHERE n.nspname<>'dune' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_temp'
  UNION ALL
  SELECT 'routine',format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),
         jsonb_build_object('kind',p.prokind,'language',l.lanname,'definition',pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname<>'dune' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_temp'
  UNION ALL
  SELECT 'type',format('%I.%I',n.nspname,t.typname),jsonb_build_object('kind',t.typtype,'category',t.typcategory,'base',format_type(t.typbasetype,t.typtypmod))
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
  WHERE n.nspname<>'dune' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_toast' AND n.nspname!~'^pg_temp'
    AND t.typtype IN ('c','d','e','r','m')
  UNION ALL
  SELECT 'trigger',format('%I.%I.%I',n.nspname,c.relname,t.tgname),to_jsonb(pg_get_triggerdef(t.oid,true))
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE NOT t.tgisinternal AND n.nspname<>'dune' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_temp'
  UNION ALL
  SELECT 'extension-member',format('%I:%s',e.extname,identified.identity),
         jsonb_build_object('type',identified.type,'schema',identified.schema,'identity',identified.identity)
  FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
  CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) identified
  WHERE e.extname IN ('pgcrypto','pg_trgm')
), canonical AS (
  SELECT count(*)::text AS object_count,
         COALESCE(jsonb_agg(jsonb_build_array(kind,identity,definition) ORDER BY kind,identity,definition::text),'[]'::jsonb)::text AS objects
  FROM object_rows
)
SELECT jsonb_build_object(
  'extensions',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name',extname,'version',extversion,'schema',schema_name,'namespaceOid',namespace_oid,
    'ownerPresent',owner_present,'membershipCount',member_count,'membershipInput',membership_input
  ) ORDER BY extname),'[]'::jsonb) FROM extension_rows),
  'objectCount',object_count,'sha256Input',objects
)::text FROM canonical;
`;

class MigrationSchemaRestoreError extends Error {
  constructor(message, code = "migration_schema_restore_failed", details = {}) {
    super(message);
    this.name = "MigrationSchemaRestoreError";
    this.code = code;
    this.details = details;
  }
}

function digestText(value) { return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex"); }
function exactDecimal(value, label) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new MigrationSchemaRestoreError(`${label} is not an exact decimal string.`, "migration_schema_restore_evidence_invalid");
  return text;
}
function exactDigest(value, label) {
  const text = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new MigrationSchemaRestoreError(`${label} is not a SHA-256 digest.`, "migration_schema_restore_evidence_invalid");
  return text;
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new MigrationSchemaRestoreError(`${label} is missing, malformed, or has unknown fields.`, "migration_outside_dune_extensions_changed");
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  throw new MigrationSchemaRestoreError("Extension evidence contains an unsupported value.", "migration_outside_dune_extensions_changed");
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }

const REQUIRED_MIGRATION_EXTENSIONS = Object.freeze([
  Object.freeze({ name: "pg_trgm", version: "1.6", schema: "ext" }),
  Object.freeze({ name: "pgcrypto", version: "1.3", schema: "ext" })
].sort((a, b) => a.name.localeCompare(b.name)));

function normalizeExtensionMembers(value, expectedCount) {
  let members;
  try { members = JSON.parse(String(value || "")); } catch { throw new MigrationSchemaRestoreError("Extension membership evidence is malformed.", "migration_outside_dune_extensions_changed"); }
  if (!Array.isArray(members)) throw new MigrationSchemaRestoreError("Extension membership evidence is malformed.", "migration_outside_dune_extensions_changed");
  const normalized = members.map((member) => {
    if (!Array.isArray(member) || member.length !== 3 || member.some((field) => typeof field !== "string" || !field)) throw new MigrationSchemaRestoreError("Extension membership evidence is malformed.", "migration_outside_dune_extensions_changed");
    return member.map(String);
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (BigInt(expectedCount) !== BigInt(normalized.length)) throw new MigrationSchemaRestoreError("Extension membership count disagrees with its canonical inventory.", "migration_outside_dune_extensions_changed");
  return normalized;
}

function normalizeCollectedExtensions(rows) {
  if (!Array.isArray(rows) || rows.length !== REQUIRED_MIGRATION_EXTENSIONS.length) throw new MigrationSchemaRestoreError("Required ext-schema extension evidence is missing or changed.", "migration_outside_dune_extensions_changed");
  const seen = new Set();
  const normalized = rows.map((row) => {
    exactObjectKeys(row, ["name", "version", "schema", "namespaceOid", "ownerPresent", "membershipCount", "membershipInput"], "Collected extension evidence");
    const name = String(row.name || "");
    if (seen.has(name)) throw new MigrationSchemaRestoreError("Required ext-schema extension evidence is duplicated.", "migration_outside_dune_extensions_changed");
    seen.add(name);
    const membershipCount = exactDecimal(row.membershipCount, "Extension membership count");
    exactDecimal(row.namespaceOid, "Extension namespace OID"); // Presence/type only; OIDs are deliberately excluded below.
    if (row.ownerPresent !== true) throw new MigrationSchemaRestoreError("Extension ownership evidence is missing.", "migration_outside_dune_extensions_changed");
    const members = normalizeExtensionMembers(row.membershipInput, membershipCount);
    const canonical = {
      name,
      version: String(row.version || ""),
      schema: String(row.schema || ""),
      ownerClass: "extension-owner",
      membershipCount,
      membershipSha256: digestText(canonicalJson(members))
    };
    const serialized = canonicalJson(canonical);
    return { ...canonical, canonical: serialized, sha256: digestText(serialized) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const semantic = normalized.map(({ canonical, sha256, ...row }) => ({ ...row }));
  if (canonicalJson(semantic.map(({ ownerClass, membershipCount, membershipSha256, ...identity }) => identity)) !== canonicalJson(REQUIRED_MIGRATION_EXTENSIONS)) {
    throw new MigrationSchemaRestoreError("Required ext-schema extension evidence is missing or changed.", "migration_outside_dune_extensions_changed", { actual: semantic.map(({ name, version, schema }) => ({ name, version, schema })), expected: REQUIRED_MIGRATION_EXTENSIONS });
  }
  return normalized;
}

function normalizeStoredExtensions(rows) {
  if (!Array.isArray(rows) || rows.length !== REQUIRED_MIGRATION_EXTENSIONS.length) throw new MigrationSchemaRestoreError("Stored ext-schema extension evidence is missing.", "migration_outside_dune_boundary_ambiguous");
  const normalized = rows.map((row) => {
    exactObjectKeys(row, ["name", "version", "schema", "ownerClass", "membershipCount", "membershipSha256", "canonical", "sha256"], "Stored extension evidence");
    const canonical = { name: String(row.name || ""), version: String(row.version || ""), schema: String(row.schema || ""), ownerClass: String(row.ownerClass || ""), membershipCount: exactDecimal(row.membershipCount, "Extension membership count"), membershipSha256: exactDigest(row.membershipSha256, "Extension membership") };
    const serialized = canonicalJson(canonical);
    if (row.ownerClass !== "extension-owner" || row.canonical !== serialized || exactDigest(row.sha256, "Canonical extension") !== digestText(serialized)) throw new MigrationSchemaRestoreError("Stored extension evidence is inconsistent.", "migration_outside_dune_boundary_ambiguous");
    return { ...canonical, canonical: serialized, sha256: digestText(serialized) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const identities = normalized.map(({ ownerClass, membershipCount, membershipSha256, canonical, sha256, ...identity }) => identity);
  if (canonicalJson(identities) !== canonicalJson(REQUIRED_MIGRATION_EXTENSIONS)) throw new MigrationSchemaRestoreError("Stored ext-schema extension identity changed.", "migration_outside_dune_extensions_changed");
  return normalized;
}

function normalizeCrossSchemaDependencyEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "count,sha256Input") {
    throw new MigrationSchemaRestoreError("Cross-schema dependency evidence is missing or malformed.", "migration_cross_schema_dependency_ambiguous");
  }
  const count = exactDecimal(value.count, "Cross-schema dependency count");
  const sha256 = digestText(String(value.sha256Input || ""));
  if (count !== "0") throw new MigrationSchemaRestoreError("An object outside dune depends on the dune schema; atomic replacement is unsafe.", "migration_cross_schema_dependency_present", { count, sha256 });
  return { count, sha256 };
}

function normalizeOutsideDuneBoundary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "extensions,objectCount,sha256Input") {
    throw new MigrationSchemaRestoreError("Outside-dune boundary evidence is missing or malformed.", "migration_outside_dune_boundary_ambiguous");
  }
  const extensions = normalizeCollectedExtensions(value.extensions);
  return { extensions, extensionSetSha256: digestText(canonicalJson(extensions)), objectCount: exactDecimal(value.objectCount, "Outside-dune object count"), sha256: digestText(String(value.sha256Input || "")) };
}

function assertOutsideDuneBoundaryUnchanged(expected, actual) {
  const before = normalizeStoredOutsideBoundary(expected);
  const after = normalizeStoredOutsideBoundary(actual);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new MigrationSchemaRestoreError("An object outside dune changed during schema replacement.", "migration_outside_dune_boundary_changed", { expected: before, actual: after });
  return after;
}

function normalizeStoredOutsideBoundary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MigrationSchemaRestoreError("Outside-dune checkpoint is missing.", "migration_outside_dune_boundary_ambiguous");
  exactObjectKeys(value, ["extensions", "extensionSetSha256", "objectCount", "sha256"], "Outside-dune checkpoint");
  const extensions = normalizeStoredExtensions(value.extensions);
  const extensionSetSha256 = exactDigest(value.extensionSetSha256, "Extension set");
  if (extensionSetSha256 !== digestText(canonicalJson(extensions))) throw new MigrationSchemaRestoreError("Stored extension-set digest is inconsistent.", "migration_outside_dune_boundary_ambiguous");
  return { extensions, extensionSetSha256, objectCount: exactDecimal(value.objectCount, "Outside-dune object count"), sha256: exactDigest(value.sha256, "Outside-dune boundary") };
}

function sanitizeChildDiagnostic(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\b(?:PGPASSWORD|password|token|secret)\s*[=:]\s*[^\s;]+/gi, (match) => `${match.split(/[=:]/, 1)[0]}=[redacted]`)
    .trim().slice(0, 1024);
}

function retainedFailure(error, stage) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return new MigrationSchemaRestoreError(`Atomic dune schema replacement failed during ${stage}: ${sanitizeChildDiagnostic(details.stderr || error?.message || "command failed")}`,
    error?.code || "migration_schema_restore_failed", {
      stage,
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
      signal: details.signal || null,
      timedOut: details.timedOut === true,
      stdout: sanitizeChildDiagnostic(details.stdout || ""),
      stderr: sanitizeChildDiagnostic(details.stderr || error?.message || "command failed")
    });
}

function atomicDunePsqlArgs({ psqlExecutable, dbSvc }) {
  return [
    "env", `PGPASSFILE=${POD_ARCHIVE_PATHS.credential}`, psqlExecutable, ...ATOMIC_PSQL_FLAGS,
    "-h", dbSvc, "-p", "15432", "-U", "postgres", "-d", "dune",
    `--file=${POD_ARCHIVE_PATHS.dropSql}`, `--file=${POD_ARCHIVE_PATHS.restoreSql}`,
    `--file=${POD_ARCHIVE_PATHS.runtimeRoleVerifySql}`
  ];
}

function validateDuneSchemaToc(tocText) {
  const lines = String(tocText || "").split(/\r?\n/).filter((line) => /^\d+;/.test(line));
  const schemas = lines.filter((line) => /;\s+\d+\s+\d+\s+SCHEMA\s+-\s+dune\s+\S+\s*$/.test(line));
  if (schemas.length !== 1) throw new MigrationSchemaRestoreError("The restore archive must contain exactly one dune schema descriptor.", "migration_schema_restore_toc_invalid", { schemaDescriptorCount: String(schemas.length) });
  const owner = schemas[0].trim().split(/\s+/).at(-1) || "";
  if (owner !== DUNE_SCHEMA_OWNER) throw new MigrationSchemaRestoreError("The dune schema owner differs from the supported profile.", "migration_schema_restore_owner_invalid", { expectedOwner: DUNE_SCHEMA_OWNER, actualOwner: owner });
  return { schemaDescriptorCount: "1", owner };
}

function tokenizeSqlStatements(sqlText) {
  const source = String(sqlText || "");
  const statements = [];
  let statement = [];
  let index = 0;
  const finish = () => { if (statement.length) statements.push(statement); statement = []; };
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1] || "";
    if (/\s/.test(current)) { index += 1; continue; }
    if (current === "-" && next === "-") {
      index += 2; while (index < source.length && source[index] !== "\n") index += 1; continue;
    }
    if (current === "/" && next === "*") {
      let depth = 1; index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") { depth += 1; index += 2; }
        else if (source[index] === "*" && source[index + 1] === "/") { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth !== 0) throw new MigrationSchemaRestoreError("Generated restore SQL contains an unterminated comment.", "migration_schema_restore_sql_validation_failed");
      continue;
    }
    if (current === "'") {
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index] === "'") { index += 1; closed = true; break; }
        else index += 1;
      }
      if (!closed) throw new MigrationSchemaRestoreError("Generated restore SQL contains an unterminated string.", "migration_schema_restore_sql_validation_failed");
      continue;
    }
    if (current === '"') {
      let identifier = ""; index += 1; let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') { identifier += '"'; index += 2; }
        else if (source[index] === '"') { index += 1; closed = true; break; }
        else { identifier += source[index]; index += 1; }
      }
      if (!closed) throw new MigrationSchemaRestoreError("Generated restore SQL contains an unterminated quoted identifier.", "migration_schema_restore_sql_validation_failed");
      statement.push(identifier.toLowerCase());
      continue;
    }
    if (current === "$" && /^\$[A-Za-z_0-9]*\$/.test(source.slice(index))) {
      const delimiter = source.slice(index).match(/^\$[A-Za-z_0-9]*\$/)[0];
      const end = source.indexOf(delimiter, index + delimiter.length);
      if (end < 0) throw new MigrationSchemaRestoreError("Generated restore SQL contains an unterminated dollar string.", "migration_schema_restore_sql_validation_failed");
      index = end + delimiter.length;
      continue;
    }
    if (current === ";") { finish(); index += 1; continue; }
    if (/[A-Za-z_]/.test(current)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z_0-9$]*/)[0];
      statement.push(match.toLowerCase()); index += match.length; continue;
    }
    index += 1;
  }
  finish();
  return statements;
}

function validateGeneratedRestoreSqlLocal(sqlText) {
  const source = String(sqlText || "");
  if (!source || source.includes("\0") || source.includes("\uFFFD")) throw new MigrationSchemaRestoreError("Generated restore SQL is empty or not valid text.", "migration_schema_restore_sql_validation_failed");
  const duplicate = tokenizeSqlStatements(source).some((tokens) => {
    if (tokens[0] !== "create" || tokens[1] !== "schema") return false;
    if (tokens[2] === "dune") return true;
    if (tokens[2] === "authorization" && tokens[3] === "dune") return true;
    return tokens[2] === "if" && tokens[3] === "not" && tokens[4] === "exists" && tokens[5] === "dune";
  });
  if (duplicate) throw new MigrationSchemaRestoreError("Generated archive SQL duplicates CREATE SCHEMA dune.", "migration_schema_restore_duplicate_schema");
  return { duplicateSchemaCreation: false, validation: "local-node-sql-tokenizer-v1" };
}

async function podFileIdentity(shared, remotePath, stagePrefix) {
  const mode = await requirePodCommand(shared, ["stat", "-c", "%a", remotePath], `${stagePrefix}_mode`);
  const size = await requirePodCommand(shared, ["stat", "-c", "%s", remotePath], `${stagePrefix}_size`);
  const hash = await requirePodCommand(shared, ["sha256sum", remotePath], `${stagePrefix}_hash`);
  const sha256 = hash.stdout.trim().match(/^([a-f0-9]{64})\b/i)?.[1]?.toLowerCase() || "";
  if (mode.stdout.trim() !== "600" || !/^[1-9][0-9]*$/.test(size.stdout.trim()) || !sha256) {
    throw new MigrationSchemaRestoreError("Generated restore SQL failed restrictive remote identity validation.", "migration_schema_restore_sql_invalid");
  }
  return { mode: "600", size: size.stdout.trim(), sha256 };
}

async function downloadAndValidateRestoreSql(options, shared, localPath, expected) {
  const streamToFile = options.streamToFile || streamCommandToFile;
  const downloaded = await streamToFile({
    command: "ssh",
    args: [...shared.sshArgs, ...podExecArgs(shared.target, ["cat", POD_ARCHIVE_PATHS.restoreSql])],
    outputPath: localPath,
    expectedBytes: expected.size,
    timeoutMs: shared.timeoutMs
  });
  if (String(downloaded?.size || "") !== expected.size || String(downloaded?.sha256 || "").toLowerCase() !== expected.sha256) {
    throw new MigrationSchemaRestoreError("Downloaded restore SQL differs from the pod size or SHA-256.", "migration_schema_restore_sql_transfer_mismatch");
  }
  const independent = await hashStableFile(localPath, "downloaded restore SQL");
  if (independent.size !== expected.size || independent.sha256 !== expected.sha256) throw new MigrationSchemaRestoreError("Independent local restore SQL identity differs from the pod evidence.", "migration_schema_restore_sql_transfer_mismatch");
  const validation = validateGeneratedRestoreSqlLocal(await fs.promises.readFile(localPath, "utf8"));
  return { ...validation, component: independent, downloadedOnce: true };
}

async function writeDropSqlFile(options, shared) {
  if (typeof options.runStdinScript !== "function") {
    throw new MigrationSchemaRestoreError("The bounded stdin writer for the drop SQL file is unavailable.", "migration_schema_restore_drop_writer_missing");
  }
  await requirePodCommand(shared, ["install", "-m", "0600", "/dev/null", POD_ARCHIVE_PATHS.dropSql], "drop_sql_prepare");
  const args = [...shared.sshArgs, ...podCredentialPreparationArgs(shared.target, ["dd", `of=${POD_ARCHIVE_PATHS.dropSql}`, "status=none"])];
  const written = await options.runStdinScript({ command: "ssh", args, script: DROP_DUNE_SCHEMA_SQL, timeoutMs: 30000 });
  if (!written || written.ok !== true || written.code !== 0 || written.inputComplete !== true) {
    throw new MigrationSchemaRestoreError("The fixed drop SQL file was not transferred completely.", "migration_schema_restore_drop_write_incomplete", {
      exitCode: Number.isInteger(written?.code) ? written.code : null,
      signal: written?.signal || null,
      timedOut: written?.timedOut === true,
      stderr: sanitizeChildDiagnostic(written?.stderr || written?.error || "stdin transfer failed")
    });
  }
  const mode = await requirePodCommand(shared, ["stat", "-c", "%a", POD_ARCHIVE_PATHS.dropSql], "drop_sql_mode");
  const size = await requirePodCommand(shared, ["stat", "-c", "%s", POD_ARCHIVE_PATHS.dropSql], "drop_sql_size");
  const hash = await requirePodCommand(shared, ["sha256sum", POD_ARCHIVE_PATHS.dropSql], "drop_sql_hash");
  const actualHash = hash.stdout.trim().match(/^([a-f0-9]{64})\b/i)?.[1]?.toLowerCase() || "";
  if (mode.stdout.trim() !== "600" || size.stdout.trim() !== String(DROP_DUNE_SCHEMA_BYTES.length) || actualHash !== DROP_DUNE_SCHEMA_SHA256) {
    throw new MigrationSchemaRestoreError("The fixed drop SQL file failed restrictive size/hash verification.", "migration_schema_restore_drop_file_invalid");
  }
  return { mode: "600", size: String(DROP_DUNE_SCHEMA_BYTES.length), sha256: actualHash };
}

async function writeRuntimeRoleVerifySqlFile(options, shared) {
  if (typeof options.runStdinScript !== "function") {
    throw new MigrationSchemaRestoreError("The bounded stdin writer for runtime-role verification is unavailable.", "migration_schema_restore_verify_writer_missing");
  }
  const remotePath = POD_ARCHIVE_PATHS.runtimeRoleVerifySql;
  await requirePodCommand(shared, ["install", "-m", "0600", "/dev/null", remotePath], "runtime_role_verify_sql_prepare");
  const args = [...shared.sshArgs, ...podCredentialPreparationArgs(shared.target, ["dd", `of=${remotePath}`, "status=none"])];
  const written = await options.runStdinScript({ command: "ssh", args, script: DUNE_RUNTIME_ROLE_VERIFY_SQL, timeoutMs: 30000 });
  if (!written || written.ok !== true || written.code !== 0 || written.inputComplete !== true) {
    throw new MigrationSchemaRestoreError("The fixed runtime-role verification SQL was not transferred completely.", "migration_schema_restore_verify_write_incomplete", {
      exitCode: Number.isInteger(written?.code) ? written.code : null,
      signal: written?.signal || null,
      timedOut: written?.timedOut === true,
      stderr: sanitizeChildDiagnostic(written?.stderr || written?.error || "stdin transfer failed")
    });
  }
  const mode = await requirePodCommand(shared, ["stat", "-c", "%a", remotePath], "runtime_role_verify_sql_mode");
  const size = await requirePodCommand(shared, ["stat", "-c", "%s", remotePath], "runtime_role_verify_sql_size");
  const hash = await requirePodCommand(shared, ["sha256sum", remotePath], "runtime_role_verify_sql_hash");
  const actualHash = hash.stdout.trim().match(/^([a-f0-9]{64})\b/i)?.[1]?.toLowerCase() || "";
  if (mode.stdout.trim() !== "600" || size.stdout.trim() !== String(DUNE_RUNTIME_ROLE_VERIFY_BYTES.length) || actualHash !== DUNE_RUNTIME_ROLE_VERIFY_SHA256) {
    throw new MigrationSchemaRestoreError("The fixed runtime-role verification SQL failed restrictive size/hash verification.", "migration_schema_restore_verify_file_invalid");
  }
  return { mode: "600", size: String(DUNE_RUNTIME_ROLE_VERIFY_BYTES.length), sha256: actualHash };
}

async function runAtomicDuneSchemaRestore(options = {}) {
  const archivePath = String(options.archivePath || "");
  if (archivePath !== POD_ARCHIVE_PATHS.legacyRecovery) throw new MigrationSchemaRestoreError("The staged restore archive path is not approved.", "migration_schema_restore_path_invalid");
  const restoreExecutable = exactPodExecutable(options.restoreExecutable, "pg_restore");
  const psqlExecutable = exactPodExecutable(options.psqlExecutable, "psql");
  const dbSvc = String(options.dbSvc || "");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(dbSvc)) throw new MigrationSchemaRestoreError("The PostgreSQL service target is invalid.", "migration_schema_restore_target_invalid");
  const shared = { runCommand: options.runCommand, sshArgs: (options.sshArgs || []).map(String), target: options.target, timeoutMs: options.timeoutMs || 60 * 60 * 1000, onHeartbeat: options.onHeartbeat, heartbeatIntervalMs: options.heartbeatIntervalMs };
  const localDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a9migration-restore-sql-"));
  const localSqlPath = path.join(localDirectory, "dune-restore.sql");
  let primaryError = null;
  try {
    await cleanupPodArchivePaths(shared, [POD_ARCHIVE_PATHS.dropSql, POD_ARCHIVE_PATHS.restoreSql, POD_ARCHIVE_PATHS.runtimeRoleVerifySql, POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext]);
    const listed = await runPodStage(shared, [restoreExecutable, "--list", archivePath], "restore_toc_list");
    const schemaToc = validateDuneSchemaToc(listed.stdout);
    await requirePodCommand(shared, ["install", "-m", "0600", "/dev/null", POD_ARCHIVE_PATHS.restoreSql], "restore_sql_prepare");
    await runPodStage(shared, [restoreExecutable, ...DUNE_RESTORE_FLAGS, `--file=${POD_ARCHIVE_PATHS.restoreSql}`, archivePath], "restore_sql_generate");
    const remoteSql = await podFileIdentity(shared, POD_ARCHIVE_PATHS.restoreSql, "restore_sql");
    const generatedSql = await downloadAndValidateRestoreSql(options, shared, localSqlPath, remoteSql);
    const dropSql = await writeDropSqlFile(options, shared);
    const runtimeRoleVerification = await writeRuntimeRoleVerifySqlFile(options, shared);
    let immediateRemoteSql = await podFileIdentity(shared, POD_ARCHIVE_PATHS.restoreSql, "restore_sql_pre_execute");
    if (immediateRemoteSql.size !== remoteSql.size || immediateRemoteSql.sha256 !== remoteSql.sha256) throw new MigrationSchemaRestoreError("Remote restore SQL changed after local validation.", "migration_schema_restore_sql_drift");
    if (options.stopBeforePsql === true) return { ok: true, stoppedBeforePsql: true, dropSql, runtimeRoleVerification, generatedSql, schemaToc, generatedSqlSize: remoteSql.size, restoreMode: "transport-validation-only" };
    await installPodPgpass({ runCredentialScript: options.runCredentialScript, dbSvc }, shared);
    immediateRemoteSql = await podFileIdentity(shared, POD_ARCHIVE_PATHS.restoreSql, "restore_sql_immediate_pre_execute");
    if (immediateRemoteSql.size !== remoteSql.size || immediateRemoteSql.sha256 !== remoteSql.sha256) throw new MigrationSchemaRestoreError("Remote restore SQL changed immediately before execution.", "migration_schema_restore_sql_drift");
    const result = await runPodStage(shared, atomicDunePsqlArgs({ psqlExecutable, dbSvc }), "atomic_dune_restore");
    return { ok: true, exitCode: result.code, dropSql, runtimeRoleVerification, generatedSql, schemaToc, generatedSqlSize: remoteSql.size, restoreMode: "atomic-dune-schema-replacement-with-runtime-role-verification" };
  } catch (error) {
    primaryError = retainedFailure(error, error?.details?.stage || "schema replacement");
    throw primaryError;
  } finally {
    await fs.promises.rm(localDirectory, { recursive: true, force: true }).catch(() => {});
    try { await cleanupPodArchivePaths(shared, [POD_ARCHIVE_PATHS.dropSql, POD_ARCHIVE_PATHS.restoreSql, POD_ARCHIVE_PATHS.runtimeRoleVerifySql, POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext]); }
    catch (cleanupError) {
      if (!primaryError) throw retainedFailure(cleanupError, "temporary cleanup");
      primaryError.details = { ...primaryError.details, cleanupFailed: true, cleanupError: sanitizeChildDiagnostic(cleanupError.message) };
    }
  }
}

module.exports = {
  ATOMIC_PSQL_FLAGS,
  CROSS_SCHEMA_DEPENDENCY_SQL,
  DUNE_SCHEMA_OWNER,
  DUNE_RUNTIME_ROLE_VERIFY_SQL,
  DROP_DUNE_SCHEMA_SQL,
  DUNE_RESTORE_FLAGS,
  MigrationSchemaRestoreError,
  OUTSIDE_DUNE_BOUNDARY_SQL,
  REQUIRED_MIGRATION_EXTENSIONS,
  assertOutsideDuneBoundaryUnchanged,
  atomicDunePsqlArgs,
  normalizeCrossSchemaDependencyEvidence,
  normalizeOutsideDuneBoundary,
  normalizeStoredOutsideBoundary,
  retainedFailure,
  runAtomicDuneSchemaRestore,
  sanitizeChildDiagnostic,
  tokenizeSqlStatements,
  validateGeneratedRestoreSqlLocal,
  validateDuneSchemaToc
};
