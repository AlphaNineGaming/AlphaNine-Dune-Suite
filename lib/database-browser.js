"use strict";

const { Client } = require("pg");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const MAX_SELECTED_COLUMNS = 40;
const MAX_FILTERS = 8;
const MAX_OFFSET = 250000;
const MAX_CELL_CHARACTERS = 4000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ALLOWED_RELKINDS = new Set(["r", "p", "v", "m", "f"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function requiredName(value, label) {
  const name = String(value || "").trim();
  if (!name) throw new Error(`${label} is required.`);
  if (name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`${label} is invalid.`);
  return name;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function relationLabel(relkind) {
  return ({ r: "table", p: "partitioned table", v: "view", m: "materialized view", f: "foreign table" })[relkind] || "relation";
}

function publicColumn(row) {
  return {
    name: String(row.name || ""),
    type: String(row.type || ""),
    nullable: row.nullable === true,
    default: row.default_value == null ? null : String(row.default_value),
    primaryKey: row.primary_key === true,
    ordinal: Number(row.ordinal || 0)
  };
}

function normalizeCell(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return { kind: "binary", bytes: value.length };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (value.length <= MAX_CELL_CHARACTERS) return value;
    return { kind: "truncated", characters: value.length, preview: value.slice(0, MAX_CELL_CHARACTERS) };
  }
  if (typeof value === "object") {
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch { return { kind: "unavailable", preview: "[Unserializable value]" }; }
    if (serialized.length <= MAX_CELL_CHARACTERS) return value;
    return { kind: "truncated-json", characters: serialized.length, preview: serialized.slice(0, MAX_CELL_CHARACTERS) };
  }
  return value;
}

function normalizeRow(row, columns) {
  const normalized = {};
  for (const column of columns) normalized[column] = normalizeCell(row[column]);
  return normalized;
}

function createDatabaseBrowser({ getConnectionConfig, ClientClass = Client, audit = () => {} }) {
  if (typeof getConnectionConfig !== "function") throw new Error("Database browser requires a connection-config provider.");

  async function withReadOnlyClient(action, callback) {
    const connection = await getConnectionConfig();
    const client = new ClientClass({
      host: connection.host,
      port: Number(connection.port),
      database: connection.database,
      user: connection.user,
      password: String(connection.password || ""),
      ssl: false,
      connectionTimeoutMillis: 10000,
      application_name: "AlphaNine Dune Suite Database Explorer"
    });
    let began = false;
    try {
      await client.connect();
      await client.query("BEGIN TRANSACTION READ ONLY");
      began = true;
      await client.query("SET LOCAL statement_timeout = '8s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
      const result = await callback(client, connection);
      await client.query("COMMIT");
      began = false;
      audit("database_browser_read", { action, source: connection.connectionSource || "database" });
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  async function relationMetadata(client, schema, table) {
    const relationResult = await client.query(`
      select c.oid::text as oid, c.relkind, coalesce(c.reltuples, 0)::bigint::text as estimated_rows
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind::text = any($3::text[])
      limit 1
    `, [schema, table, [...ALLOWED_RELKINDS]]);
    const relation = relationResult.rows[0];
    if (!relation) throw new Error("The selected table or view no longer exists. Refresh the schema list.");

    const columnResult = await client.query(`
      select
        a.attname as name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
        not a.attnotnull as nullable,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value,
        exists (
          select 1 from pg_catalog.pg_index i
          where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)
        ) as primary_key,
        a.attnum as ordinal
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `, [relation.oid]);
    return {
      schema,
      table,
      kind: relationLabel(relation.relkind),
      relkind: relation.relkind,
      estimatedRows: Number(relation.estimated_rows || 0),
      columns: columnResult.rows.map(publicColumn)
    };
  }

  async function listSchemas() {
    return withReadOnlyClient("schemas", async (client, connection) => {
      const result = await client.query(`
        select n.nspname as name, count(c.oid)::integer as relation_count
        from pg_catalog.pg_namespace n
        left join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relkind::text = any($1::text[])
        where n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg_toast%'
          and n.nspname not like 'pg_temp%'
        group by n.nspname
        having count(c.oid) > 0
        order by n.nspname
      `, [[...ALLOWED_RELKINDS]]);
      return {
        ok: true,
        readOnly: true,
        source: connection.connectionSource || "database",
        schemas: result.rows.map((row) => ({ name: row.name, relationCount: Number(row.relation_count || 0) }))
      };
    });
  }

  async function listTables(schemaValue) {
    const schema = requiredName(schemaValue, "Schema");
    return withReadOnlyClient("tables", async (client) => {
      const result = await client.query(`
        select c.relname as name, c.relkind, greatest(coalesce(c.reltuples, 0), 0)::bigint::text as estimated_rows,
          pg_catalog.pg_total_relation_size(c.oid)::bigint::text as total_bytes
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind::text = any($2::text[])
        order by c.relname
      `, [schema, [...ALLOWED_RELKINDS]]);
      return {
        ok: true,
        readOnly: true,
        schema,
        tables: result.rows.map((row) => ({
          name: row.name,
          kind: relationLabel(row.relkind),
          estimatedRows: Number(row.estimated_rows || 0),
          totalBytes: Number(row.total_bytes || 0)
        }))
      };
    });
  }

  async function describeTable(schemaValue, tableValue) {
    const schema = requiredName(schemaValue, "Schema");
    const table = requiredName(tableValue, "Table");
    return withReadOnlyClient("describe", async (client) => ({ ok: true, readOnly: true, ...(await relationMetadata(client, schema, table)) }));
  }

  async function browseRows(payload = {}) {
    const schema = requiredName(payload.schema, "Schema");
    const table = requiredName(payload.table, "Table");
    const pageSize = boundedInteger(payload.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = boundedInteger(payload.offset, 0, 0, MAX_OFFSET);
    return withReadOnlyClient("rows", async (client) => {
      const metadata = await relationMetadata(client, schema, table);
      const columnMap = new Map(metadata.columns.map((column) => [column.name, column]));
      const requestedColumns = Array.isArray(payload.columns) ? payload.columns.map(String) : [];
      const selectedColumns = (requestedColumns.length ? requestedColumns : metadata.columns.map((column) => column.name)).slice(0, MAX_SELECTED_COLUMNS);
      if (!selectedColumns.length) throw new Error("The selected relation has no readable columns.");
      for (const column of selectedColumns) if (!columnMap.has(column)) throw new Error(`Unknown column: ${column}`);

      const values = [];
      const predicates = [];
      const filters = Array.isArray(payload.filters) ? payload.filters.slice(0, MAX_FILTERS) : [];
      const operatorSql = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      for (const filter of filters) {
        const column = String(filter?.column || "");
        const operator = String(filter?.operator || "eq");
        if (!columnMap.has(column)) throw new Error(`Unknown filter column: ${column}`);
        const identifier = quoteIdentifier(column);
        if (operator === "is_null") predicates.push(`${identifier} is null`);
        else if (operator === "is_not_null") predicates.push(`${identifier} is not null`);
        else if (operator === "contains") {
          values.push(`%${String(filter.value ?? "").replace(/[\\%_]/g, "\\$&")}%`);
          predicates.push(`${identifier}::text ilike $${values.length} escape '\\'`);
        } else if (operatorSql[operator]) {
          values.push(filter.value);
          predicates.push(`${identifier} ${operatorSql[operator]} $${values.length}`);
        } else throw new Error(`Unsupported filter operator: ${operator}`);
      }

      const sortColumn = String(payload.sort?.column || metadata.columns.find((column) => column.primaryKey)?.name || selectedColumns[0]);
      if (!columnMap.has(sortColumn)) throw new Error(`Unknown sort column: ${sortColumn}`);
      const sortDirection = String(payload.sort?.direction || "asc").toLowerCase() === "desc" ? "desc" : "asc";
      values.push(pageSize + 1, offset);
      const selectExpressions = selectedColumns.map((name) => {
        const identifier = quoteIdentifier(name);
        const column = columnMap.get(name);
        if (String(column.type).toLowerCase() === "bytea") {
          return `case when ${identifier} is null then null else '[binary - ' || pg_catalog.octet_length(${identifier})::text || ' bytes]' end as ${identifier}`;
        }
        return `case when ${identifier} is null then null when pg_catalog.length(${identifier}::text) > ${MAX_CELL_CHARACTERS} then pg_catalog.left(${identifier}::text, ${MAX_CELL_CHARACTERS}) || ' ... [truncated]' else ${identifier}::text end as ${identifier}`;
      });
      const sql = `select ${selectExpressions.join(", ")} from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
        + (predicates.length ? ` where ${predicates.join(" and ")}` : "")
        + ` order by ${quoteIdentifier(sortColumn)} ${sortDirection} nulls last limit $${values.length - 1} offset $${values.length}`;
      const result = await client.query(sql, values);
      const hasMore = result.rows.length > pageSize;
      const rows = result.rows.slice(0, pageSize).map((row) => normalizeRow(row, selectedColumns));
      if (Buffer.byteLength(JSON.stringify(rows), "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("The result exceeded the 5 MB safety limit. Use a smaller page size or narrower table.");
      }
      return {
        ok: true,
        readOnly: true,
        schema,
        table,
        kind: metadata.kind,
        estimatedRows: metadata.estimatedRows,
        columns: selectedColumns.map((name) => columnMap.get(name)),
        allColumns: metadata.columns,
        omittedColumns: Math.max(0, metadata.columns.length - selectedColumns.length),
        rows,
        pageSize,
        offset,
        hasMore,
        sort: { column: sortColumn, direction: sortDirection },
        filters
      };
    });
  }

  return { listSchemas, listTables, describeTable, browseRows };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SELECTED_COLUMNS,
  MAX_FILTERS,
  MAX_OFFSET,
  quoteIdentifier,
  normalizeCell,
  createDatabaseBrowser
};
