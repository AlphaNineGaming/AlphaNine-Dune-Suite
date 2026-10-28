"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRemoteDatabase, databaseSettings, publicDatabase } = require("../lib/providers/remote-database");
const config = { remoteDatabaseEnabled: true, remoteDatabaseHost: "fixture.example", remoteDatabaseName: "dune", remoteDatabaseUser: "reader", remoteDatabasePassword: "secret-canary" };
const role = Object.fromEntries(["superuser", "bypass_rls", "create_database", "create_role", "database_create", "schema_create", "table_write"].map(key => [key, false]));
const relation = { kind: "r", rls: false, subclasses: false, can_select: true, id_primary: true };
const columns = [{ name: "id", type: "int8", type_schema: "pg_catalog" }, { name: "character_name", type: "text", type_schema: "pg_catalog" }, { name: "online_status", type: "int4", type_schema: "pg_catalog" }];
function fixture(options = {}) {
  const queries = []; let ended = false, settings, readOnlyChecks = 0;
  const client = { on() {}, async connect() { if (options.connectFail) throw new Error("secret-canary"); }, async end() { ended = true; }, async query(sql, params) {
    queries.push({ sql, params }); if (options.failAt && sql.includes(options.failAt)) throw new Error("secret-canary");
    const rows = sql === "SHOW transaction_read_only" ? [{ transaction_read_only: options.readOnlyLost && ++readOnlyChecks > 1 ? "off" : "on" }]
      : sql.includes("provider-role") ? [options.role || role] : sql.includes("provider-relation") ? (options.noRelation ? [] : [options.relation || relation])
      : sql.includes("provider-columns") ? (options.columns || columns) : sql.includes("server_version_num") ? [{ version: "160010" }]
      : sql.includes("provider-players") ? [{ id: "1", name: "Fixture\nPlayer", status: "1" }] : sql.includes("provider-explorer") ? [{ id: "1", character_name: "Fixture Player", online_status: "1", password: "secret-canary" }] : [];
    return { rows };
  } };
  const database = createRemoteDatabase({ clientFactory(value) { settings = value; return client; } });
  return { database, queries, ended: () => ended, settings: () => settings };
}
test("TLS-only explicit credentials never reuse legacy database settings", () => {
  assert.equal(databaseSettings({ databaseHost: "legacy", databasePassword: "legacy" }), null);
  assert.equal(databaseSettings(config).ssl.rejectUnauthorized, true);
  for (const invalid of [{ remoteDatabaseHost: "x;id" }, { remoteDatabasePort: "5432" }, { remoteDatabaseUser: "--user" }, { remoteDatabasePassword: null }]) assert.throws(() => databaseSettings({ ...config, ...invalid }));
});
test("player reads use fixed SQL, same-session checks, a bounded parameter and rollback", async () => {
  const f = fixture(), result = await f.database.inspect(config, { players: true, limit: 3 });
  assert.equal(result.schemaValidated, true); assert.equal(result.players[0].name, "FixturePlayer");
  assert.equal(f.queries[0].sql, "BEGIN READ ONLY"); assert.equal(f.queries.at(-1).sql, "ROLLBACK"); assert(f.ended());
  assert.equal(f.queries.filter(q => q.sql === "SHOW transaction_read_only").length, 2);
  assert.deepEqual(f.queries.find(q => q.sql.includes("provider-players")).params, [3]);
  assert.equal(f.settings().ssl.rejectUnauthorized, true);
  assert(!f.queries.some(q => /^(?:COMMIT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COPY)\b/.test(q.sql)));
  assert(!JSON.stringify(publicDatabase(result)).includes("FixturePlayer"));
});
test("all write/admin privilege failures block player queries", async () => {
  for (const key of Object.keys(role)) {
    const f = fixture({ role: { ...role, [key]: true } }), result = await f.database.inspect(config, { players: true });
    assert.equal(result.reason, "read_only_role_required"); assert(!f.queries.some(q => q.sql.includes("provider-players"))); assert(f.ended());
  }
});
test("unknown schema, views, RLS, inheritance, invalid PK or custom types never authorize players", async () => {
  for (const options of [{ noRelation: true }, { relation: { ...relation, kind: "v" } }, { relation: { ...relation, rls: true } }, { relation: { ...relation, subclasses: true } }, { relation: { ...relation, can_select: false } }, { relation: { ...relation, id_primary: false } }, { columns: columns.slice(1) }, { columns: columns.map(c => ({ ...c, type_schema: "custom" })) }]) {
    const f = fixture(options), result = await f.database.inspect(config, { players: true });
    assert.equal(result.authenticated, true); assert.equal(result.schemaValidated, false); assert(!f.queries.some(q => q.sql.includes("provider-players"))); assert.equal(f.queries.at(-1).sql, "ROLLBACK");
  }
});
test("lost read-only state, authentication, query and interrupted connection failures expose no details", async () => {
  for (const options of [{ connectFail: true }, { failAt: "provider-role" }, { failAt: "provider-players" }, { readOnlyLost: true }, { failAt: "ROLLBACK" }]) {
    const f = fixture(options), result = await f.database.inspect(config, { players: true });
    assert(f.ended()); assert(!JSON.stringify(result).includes("secret-canary"));
    if (!options.failAt || options.failAt !== "ROLLBACK") assert.equal(result.authenticated, false);
    if (options.readOnlyLost) assert(!f.queries.some(q => q.sql.includes("provider-players")));
  }
});
test("every Explorer adapter revalidates schema/privileges and exposes only the allowlisted table/columns", async () => {
  for (const action of ["schemas", "tables", "describe", "rows"]) {
    const f = fixture(), input = action === "rows" ? { schema: "dune", table: "player_state", pageSize: 10, offset: 20 } : {};
    const result = await f.database.inspect(config, { explorer: { action, input } });
    assert(result.explorer?.ok, action); assert(!JSON.stringify(result.explorer).includes("secret-canary"));
    assert(f.queries.some(q => q.sql.includes("provider-role"))); assert(f.queries.some(q => q.sql === "LOCK TABLE dune.player_state IN ACCESS SHARE MODE"));
    if (action === "rows") { assert.deepEqual(f.queries.find(q => q.sql.includes("provider-explorer")).params, [11, 20]); assert.equal(result.explorer.rows[0].password, undefined); }
    assert.equal(f.queries.at(-1).sql, "ROLLBACK"); assert.equal(publicDatabase(result).explorer, undefined);
  }
});
test("Explorer rejects arbitrary relations, filters, sorting, output limits and read-only/schema failures", async () => {
  for (const invalid of [{ table: "accounts" }, { schema: "public" }, { filters: [{ column: "id", value: "1" }] }, { sort: { column: "name", direction: "desc" } }, { sql: "SELECT 1" }, { pageSize: 101 }, { offset: 10001 }]) {
    const f = fixture(); await assert.rejects(f.database.inspect(config, { explorer: { action: "rows", input: { schema: "dune", table: "player_state", ...invalid } } })); assert.equal(f.queries.length, 0);
  }
  for (const options of [{ role: { ...role, table_write: true } }, { noRelation: true }, { readOnlyLost: true }, { failAt: "provider-explorer" }]) {
    const f = fixture(options), result = await f.database.inspect(config, { explorer: { action: "rows", input: { schema: "dune", table: "player_state" } } }); assert.equal(result.explorer, undefined); assert(f.ended());
  }
});
