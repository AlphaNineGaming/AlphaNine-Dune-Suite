"use strict";

const { Client } = require("pg");

const DEFAULT_DISCOVERY_LIMIT = 5000;
const MAX_DISCOVERY_LIMIT = 10000;
const DISCOVERY_TABLES = Object.freeze([
  "dune.items",
  "dune.inventories",
  "dune.player_state",
  "dune.dune_exchange_orders",
  "dune.vehicle_modules",
  "dune.landsraad_task_rewards"
]);

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return DEFAULT_DISCOVERY_LIMIT;
  return Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, number));
}

function createItemServerDiscovery({ getConnectionConfig, ClientClass = Client, audit = () => {} } = {}) {
  if (typeof getConnectionConfig !== "function") throw new Error("Item server discovery requires a connection-config provider.");

  async function discover(limitValue = DEFAULT_DISCOVERY_LIMIT) {
    const limit = boundedLimit(limitValue);
    const connection = await getConnectionConfig();
    const client = new ClientClass({
      host: connection.host,
      port: Number(connection.port),
      database: connection.database,
      user: connection.user,
      password: String(connection.password || ""),
      ssl: false,
      connectionTimeoutMillis: 10000,
      application_name: "AlphaNine Item Catalog Read-Only Discovery"
    });
    let began = false;
    const records = [];
    const sources = {};
    try {
      await client.connect();
      await client.query("BEGIN TRANSACTION READ ONLY");
      began = true;
      await client.query("SET LOCAL statement_timeout = '8s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      const relationResult = await client.query(
        "select relation_name from unnest($1::text[]) as relations(relation_name) where to_regclass(relation_name) is not null",
        [DISCOVERY_TABLES]
      );
      const available = new Set(relationResult.rows.map((row) => String(row.relation_name)));
      const run = async (source, requiredTables, sql) => {
        if (requiredTables.some((table) => !available.has(table))) return;
        const result = await client.query(sql, [limit]);
        sources[source] = result.rows.length;
        for (const row of result.rows) records.push({ id: row.template_id, discoverySource: row.discovery_source || source });
      };
      await run("inventories", ["dune.items", "dune.inventories", "dune.player_state"], `
        select distinct i.template_id,
          case when ps.player_pawn_id is null then 'storage-inventory' else 'player-inventory' end as discovery_source
        from dune.items i
        join dune.inventories inv on inv.id = i.inventory_id
        left join dune.player_state ps on ps.player_pawn_id = inv.actor_id
        where i.template_id is not null and i.template_id <> ''
        order by i.template_id, discovery_source
        limit $1
      `);
      await run("market-listings", ["dune.dune_exchange_orders", "dune.items"], `
        select distinct i.template_id, 'market-listing'::text as discovery_source
        from dune.dune_exchange_orders o
        join dune.items i on i.id = o.item_id
        where i.template_id is not null and i.template_id <> ''
        order by i.template_id
        limit $1
      `);
      await run("vehicle-modules", ["dune.vehicle_modules"], `
        select distinct template_id, 'vehicle-module'::text as discovery_source
        from dune.vehicle_modules
        where template_id is not null and template_id <> ''
        order by template_id
        limit $1
      `);
      await run("landsraad-rewards", ["dune.landsraad_task_rewards"], `
        select distinct template_id, 'landsraad-reward'::text as discovery_source
        from dune.landsraad_task_rewards
        where template_id is not null and template_id <> ''
        order by template_id
        limit $1
      `);
      await client.query("COMMIT");
      began = false;
      const byId = new Map();
      for (const record of records) {
        const id = String(record.id || "").trim();
        if (id && !byId.has(id.toLowerCase())) byId.set(id.toLowerCase(), { id, discoverySource: record.discoverySource });
      }
      const result = { ok: true, readOnly: true, limit, records: [...byId.values()], sources, tables: [...available] };
      audit("item_catalog_server_discovery", { readOnly: true, found: result.records.length, sources, tables: result.tables });
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  return { discover };
}

module.exports = { DEFAULT_DISCOVERY_LIMIT, MAX_DISCOVERY_LIMIT, DISCOVERY_TABLES, boundedLimit, createItemServerDiscovery };
