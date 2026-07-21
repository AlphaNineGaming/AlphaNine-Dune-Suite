"use strict";

const assert = require("assert");
const { createDatabaseBrowser, quoteIdentifier, normalizeCell } = require("../lib/database-browser");

assert.strictEqual(quoteIdentifier('odd"name'), '"odd""name"');
assert.deepStrictEqual(normalizeCell(Buffer.from("hello")), { kind: "binary", bytes: 5 });

class FakeClient {
  static instances = [];
  constructor(config) { this.config = config; this.queries = []; FakeClient.instances.push(this); }
  async connect() {}
  async end() {}
  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (/from pg_catalog\.pg_class c\s+join pg_catalog\.pg_namespace n/.test(sql) && /limit 1/.test(sql)) {
      return { rows: [{ oid: "42", relkind: "r", estimated_rows: "12" }] };
    }
    if (/from pg_catalog\.pg_attribute a/.test(sql)) {
      return { rows: [
        { name: "id", type: "bigint", nullable: false, default_value: null, primary_key: true, ordinal: 1 },
        { name: "display_name", type: "text", nullable: true, default_value: null, primary_key: false, ordinal: 2 }
      ] };
    }
    if (/from "dune"\."players"/.test(sql)) return { rows: [{ id: "7", display_name: "Paul" }] };
    return { rows: [] };
  }
}

(async () => {
  const browser = createDatabaseBrowser({
    ClientClass: FakeClient,
    getConnectionConfig: async () => ({ host: "127.0.0.1", port: 15432, database: "dune", user: "postgres", password: "secret" })
  });
  const result = await browser.browseRows({
    schema: "dune",
    table: "players",
    filters: [{ column: "display_name", operator: "contains", value: "50%_Paul' OR 1=1 --" }],
    sort: { column: "id", direction: "desc" },
    pageSize: 50
  });
  assert.strictEqual(result.readOnly, true);
  assert.strictEqual(result.rows[0].display_name, "Paul");
  const instance = FakeClient.instances[0];
  assert.ok(instance.queries.some((query) => query.sql === "BEGIN TRANSACTION READ ONLY"), "Browser must begin a read-only transaction.");
  const dataQuery = instance.queries.find((query) => /from "dune"\."players"/.test(query.sql));
  assert.ok(dataQuery, "Expected a generated row query.");
  assert.ok(!dataQuery.sql.includes("OR 1=1"), "Filter values must never be concatenated into SQL.");
  assert.strictEqual(dataQuery.values[0], "%50\\%\\_Paul' OR 1=1 --%", "Wildcard and injection text must remain a parameter value.");
  assert.match(dataQuery.sql, /order by "id" desc nulls last limit \$2 offset \$3/);
  assert.deepStrictEqual(dataQuery.values.slice(1), [51, 0]);

  await assert.rejects(() => browser.browseRows({ schema: "dune", table: "players", filters: [{ column: "missing", operator: "eq", value: "x" }] }), /Unknown filter column/);
  await assert.rejects(() => browser.browseRows({ schema: "dune", table: "players", sort: { column: "missing" } }), /Unknown sort column/);
  console.log("Database browser enforces read-only transactions, metadata allowlists, query limits, and parameterized filters.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
