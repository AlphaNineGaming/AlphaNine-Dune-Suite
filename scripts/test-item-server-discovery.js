"use strict";

const assert = require("assert");
const {
  MAX_DISCOVERY_LIMIT,
  DISCOVERY_TABLES,
  boundedLimit,
  createItemServerDiscovery
} = require("../lib/item-server-discovery");

class FakeClient {
  static instances = [];

  constructor(config) {
    this.config = config;
    this.queries = [];
    FakeClient.instances.push(this);
  }

  async connect() {}

  async query(sql, params) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    this.queries.push({ text, params });
    if (text.includes("to_regclass")) return { rows: DISCOVERY_TABLES.map((relation_name) => ({ relation_name })) };
    if (/from dune\.dune_exchange_orders/i.test(text)) return { rows: [{ template_id: "Market_Template", discovery_source: "market-listing" }] };
    if (/from dune\.items/i.test(text)) return { rows: [{ template_id: "Inventory_Template", discovery_source: "player-inventory" }, { template_id: "Storage_Template", discovery_source: "storage-inventory" }] };
    if (/from dune\.vehicle_modules/i.test(text)) return { rows: [{ template_id: "Vehicle_Template", discovery_source: "vehicle-module" }] };
    if (/from dune\.landsraad_task_rewards/i.test(text)) return { rows: [{ template_id: "Reward_Template", discovery_source: "landsraad-reward" }] };
    return { rows: [] };
  }

  async end() {}
}

(async () => {
  const audits = [];
  const discovery = createItemServerDiscovery({
    getConnectionConfig: async () => ({ host: "127.0.0.1", port: 15432, database: "dune", user: "postgres", password: "test" }),
    ClientClass: FakeClient,
    audit: (action, payload) => audits.push({ action, payload })
  });
  const result = await discovery.discover(MAX_DISCOVERY_LIMIT + 5000);
  const client = FakeClient.instances[0];

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.limit, MAX_DISCOVERY_LIMIT);
  assert.equal(result.records.length, 5);
  assert.ok(result.records.some((record) => record.id === "Storage_Template" && record.discoverySource === "storage-inventory"));
  assert.equal(boundedLimit(0), 1);
  assert.equal(boundedLimit("bad"), 5000);
  assert.equal(client.config.application_name, "AlphaNine Item Catalog Read-Only Discovery");

  const texts = client.queries.map((query) => query.text);
  assert.equal(texts[0], "BEGIN TRANSACTION READ ONLY");
  assert.equal(texts[texts.length - 1], "COMMIT");
  assert.ok(texts.some((text) => text.includes("SET LOCAL statement_timeout")));
  assert.ok(texts.some((text) => text.includes("SET LOCAL lock_timeout")));
  assert.ok(!texts.some((text) => /\b(insert|update|delete|merge|truncate|alter|drop|create)\b/i.test(text)), "A discovery query contains a write operation.");

  for (const query of client.queries.filter((entry) => /\blimit \$1\b/i.test(entry.text))) {
    assert.deepEqual(query.params, [MAX_DISCOVERY_LIMIT]);
  }
  const relationQuery = client.queries.find((entry) => entry.text.includes("to_regclass"));
  assert.deepEqual(relationQuery.params, [DISCOVERY_TABLES]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].payload.readOnly, true);

  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    boundedLimit: result.limit,
    records: result.records,
    tables: result.tables,
    statements: texts
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
