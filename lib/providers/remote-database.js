"use strict";
const fs = require("node:fs");
const net = require("node:net");

const ROLE_SQL = `/* provider-role */ SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls, r.rolcreatedb AS create_database, r.rolcreaterole AS create_role,
 pg_catalog.has_database_privilege(pg_catalog.current_database(),'CREATE') AS database_create,
 EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND pg_catalog.has_schema_privilege(n.oid,'CREATE')) AS schema_create,
 EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) AS table_write
 FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER`;
const RELATION_SQL = `/* provider-relation */ SELECT c.relkind AS kind, c.relrowsecurity AS rls, c.relhassubclass AS subclasses,
 pg_catalog.has_table_privilege(c.oid,'SELECT') AS can_select,
 EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND i.indisvalid AND i.indnatts=1 AND (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=i.indkey[0])='id') AS id_primary
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dune' AND c.relname='player_state'`;
const COLUMNS_SQL = `/* provider-columns */ SELECT a.attname AS name,t.typname AS type, tn.nspname AS type_schema, a.attnotnull AS not_null
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
 WHERE n.nspname='dune' AND c.relname='player_state' AND a.attnum>0 AND NOT a.attisdropped AND a.attname IN ('id','character_name','online_status') ORDER BY a.attname`;
const PLAYERS_SQL = `/* provider-players */ SELECT id::pg_catalog.text AS id, pg_catalog.substring(character_name,1,128) AS name, online_status::pg_catalog.text AS status FROM dune.player_state ORDER BY id LIMIT $1`;
const EXPLORER_SQL = `/* provider-explorer */ SELECT id::pg_catalog.text AS id, pg_catalog.substring(character_name,1,128) AS character_name, online_status::pg_catalog.text AS online_status FROM dune.player_state ORDER BY id LIMIT $1 OFFSET $2`;
const SCHEMA_TYPES = { id: ["int8", "int4", "uuid"], character_name: ["text", "varchar"], online_status: ["text", "varchar", "int4", "int2", "bool"] };
function validateExplorer(action, input = {}) {
  if (!["schemas", "tables", "describe", "rows"].includes(action) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("unsupported_explorer_request");
  const allowed = action === "schemas" ? [] : action === "tables" ? ["schema"] : action === "describe" ? ["schema", "table"] : ["schema", "table", "pageSize", "offset", "filters", "sort"];
  if (Object.keys(input).some(key => !allowed.includes(key)) || (input.schema !== undefined && input.schema !== "dune") || (input.table !== undefined && input.table !== "player_state")) throw new Error("unsupported_explorer_request");
  if (action === "rows") {
    if (input.schema !== "dune" || input.table !== "player_state" || (input.filters && (!Array.isArray(input.filters) || input.filters.length)) || (input.sort && (Object.keys(input.sort).some(key => !["column", "direction"].includes(key)) || input.sort.column !== "id" || input.sort.direction !== "asc"))) throw new Error("unsupported_explorer_request");
    const pageSize = input.pageSize ?? 50, offset = input.offset ?? 0;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error("unsupported_explorer_request");
    return { schema: "dune", table: "player_state", pageSize, offset };
  }
  return { schema: "dune", table: "player_state" };
}
function readOnlyRole(row) {
  return Boolean(row && ["superuser", "bypass_rls", "create_database", "create_role", "database_create", "schema_create", "table_write"].every(key => row[key] === false));
}
function schemaMatches(relation, columns) {
  if (!relation || relation.kind !== "r" || relation.rls !== false || relation.subclasses !== false || relation.can_select !== true || relation.id_primary !== true || !Array.isArray(columns) || columns.length !== 3) return false;
  return Object.entries(SCHEMA_TYPES).every(([name, types]) => columns.filter(column => column.name === name && column.type_schema === "pg_catalog" && types.includes(column.type)).length === 1);
}
function databaseSettings(config) {
  if (config.remoteDatabaseEnabled !== true) return null;
  const host = config.remoteDatabaseHost, port = config.remoteDatabasePort ?? 5432;
  if (typeof host !== "string" || host.length > 253 || (!net.isIP(host) && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_database_endpoint");
  const database = config.remoteDatabaseName, user = config.remoteDatabaseUser;
  if (![database, user].every(value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/.test(value))) throw new Error("invalid_database_identity");
  if (typeof config.remoteDatabasePassword !== "string" || config.remoteDatabasePassword.length > 4096 || config.remoteDatabasePassword.includes("\0")) throw new Error("invalid_database_credentials");
  const ssl = { rejectUnauthorized: true };
  if (config.remoteDatabaseCaPath) {
    if (typeof config.remoteDatabaseCaPath !== "string" || !require("node:path").isAbsolute(config.remoteDatabaseCaPath)) throw new Error("invalid_database_trust");
    const size = fs.statSync(config.remoteDatabaseCaPath).size;
    if (size > 65536 || size < 1) throw new Error("invalid_database_trust");
    ssl.ca = fs.readFileSync(config.remoteDatabaseCaPath, "utf8");
  }
  return { host, port, database, user, password: config.remoteDatabasePassword, ssl, connectionTimeoutMillis: 3000, query_timeout: 3500, statement_timeout: 3000, application_name: "alphanine-read-only-provider", options: "-c default_transaction_read_only=on -c search_path=pg_catalog -c idle_in_transaction_session_timeout=5000" };
}
const unknown = reason => ({ authenticated: false, readOnlyRole: false, schemaValidated: false, schemaProfile: "unsupported", versionNumber: null, connectionMethod: "explicit-direct-tls", reason });
function createRemoteDatabase({ clientFactory = options => new (require("pg").Client)(options) } = {}) {
  return Object.freeze({ async inspect(config, { players = false, limit = 50, explorer } = {}) {
    const browsing = explorer ? validateExplorer(explorer.action, explorer.input) : null;
    const settings = databaseSettings(config);
    if (!settings) return { ...unknown("not_configured"), connectionMethod: "not_configured" };
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_player_limit");
    const client = clientFactory(settings);
    client.on?.("error", () => {}); // Driver failures must not crash the Suite.
    let connected = false;
    try {
      await client.connect(); connected = true;
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = 3000");
      const readOnly = await client.query("SHOW transaction_read_only");
      if (readOnly.rows?.[0]?.transaction_read_only !== "on") return unknown("read_only_not_established");
      await client.query("SELECT 1 AS connected");
      const version = await client.query("SELECT pg_catalog.current_setting('server_version_num') AS version");
      const role = await client.query(ROLE_SQL);
      if (!readOnlyRole(role.rows?.[0])) return unknown("read_only_role_required");
      let relation = await client.query(RELATION_SQL);
      if (relation.rows?.length === 1 && relation.rows[0].kind === "r" && relation.rows[0].can_select === true) {
        // Hold the selected relation against replacement/schema changes until rollback.
        await client.query("LOCK TABLE dune.player_state IN ACCESS SHARE MODE");
        relation = await client.query(RELATION_SQL);
      }
      const columns = await client.query(COLUMNS_SQL);
      const schemaValidated = relation.rows?.length === 1 && schemaMatches(relation.rows[0], columns.rows);
      const number = String(version.rows?.[0]?.version || "");
      const result = { authenticated: true, readOnlyRole: true, schemaValidated, schemaProfile: schemaValidated ? "dune-player-state-v1" : "unsupported", versionNumber: /^[0-9]{5,6}$/.test(number) ? number : null, connectionMethod: "explicit-direct-tls", reason: schemaValidated ? "observed" : "schema_not_supported" };
      if (players) {
        if (!schemaValidated) return { ...result, reason: "schema_not_supported" };
        // Admission and query run in this same connection/transaction. Client
        // reports/cached capability flags never authorize private player reads.
        const stillReadOnly = await client.query("SHOW transaction_read_only");
        if (stillReadOnly.rows?.[0]?.transaction_read_only !== "on") return unknown("read_only_not_established");
        const queried = await client.query(PLAYERS_SQL, [limit]);
        if (!Array.isArray(queried.rows) || queried.rows.length > limit) return unknown("response_invalid");
        result.players = queried.rows.map(row => ({ id: typeof row.id === "string" && /^(?:[0-9]{1,20}|[a-f0-9-]{36})$/.test(row.id) ? row.id : "unavailable", name: typeof row.name === "string" ? row.name.slice(0, 128).replace(/[\x00-\x1f\x7f]/g, "") : "", status: typeof row.status === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(row.status) ? row.status : "unknown" }));
      }
      if (explorer && schemaValidated) {
        const metadata = columns.rows.map(column => ({ name: column.name, type: column.type, nullable: column.not_null === false, primaryKey: column.name === "id", default: null, ordinal: ["id", "character_name", "online_status"].indexOf(column.name) + 1 })).sort((a, b) => a.ordinal - b.ordinal);
        const base = { ok: true, readOnly: true, source: "validated-provider-table", schema: "dune", table: "player_state", kind: "table", estimatedRows: null, columns: metadata, supportedSort: "id-asc-only", supportedFilters: false };
        result.explorer = explorer.action === "schemas" ? { ok: true, schemas: [{ name: "dune", relationCount: 1 }], source: base.source }
          : explorer.action === "tables" ? { ok: true, tables: [{ name: "player_state", kind: "table", estimatedRows: null }], source: base.source } : base;
        if (explorer.action === "rows") {
          const stillReadOnly = await client.query("SHOW transaction_read_only");
          if (stillReadOnly.rows?.[0]?.transaction_read_only !== "on") return unknown("read_only_not_established");
          const queried = await client.query(EXPLORER_SQL, [browsing.pageSize + 1, browsing.offset]);
          if (!Array.isArray(queried.rows) || queried.rows.length > browsing.pageSize + 1) return unknown("response_invalid");
          const { normalizeCell } = require("../database-browser");
          const rows = queried.rows.slice(0, browsing.pageSize).map(row => Object.fromEntries(metadata.map(column => [column.name, normalizeCell(typeof row[column.name] === "string" ? row[column.name].slice(0, 128) : null)])));
          result.explorer = { ...base, rows, pageSize: browsing.pageSize, offset: browsing.offset, hasMore: queried.rows.length > browsing.pageSize, omittedColumns: 0, sort: { column: "id", direction: "asc" }, filters: [] };
        }
      }
      return result;
    } catch {
      // Never export driver diagnostics, SQL, connection strings or credentials.
      return unknown("connection_or_query_failed");
    } finally {
      if (connected) { try { await client.query("ROLLBACK"); } catch {} }
      try { await client.end(); } catch {}
    }
  } });
}
function publicDatabase(result = {}) {
  const reasons = ["not_configured", "observed", "schema_not_supported", "read_only_role_required", "read_only_not_established", "connection_or_query_failed", "deployment_not_established", "response_invalid"];
  const authenticated = result.authenticated === true && result.readOnlyRole === true;
  return { authenticated, readOnlyRole: result.readOnlyRole === true, schemaValidated: authenticated && result.schemaValidated === true && result.schemaProfile === "dune-player-state-v1", schemaProfile: authenticated && result.schemaValidated === true && result.schemaProfile === "dune-player-state-v1" ? "dune-player-state-v1" : "unsupported", versionNumber: typeof result.versionNumber === "string" && /^[0-9]{5,6}$/.test(result.versionNumber) ? result.versionNumber : null, connectionMethod: result.connectionMethod === "explicit-direct-tls" ? "explicit-direct-tls" : "not_configured", reason: reasons.includes(result.reason) ? result.reason : "connection_or_query_failed" };
}
module.exports = { ROLE_SQL, RELATION_SQL, COLUMNS_SQL, PLAYERS_SQL, EXPLORER_SQL, validateExplorer, readOnlyRole, schemaMatches, databaseSettings, createRemoteDatabase, publicDatabase };
