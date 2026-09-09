"use strict";
// Explicit opt-in; all mutations use session-local temporary tables only.
const assert = require("assert/strict");
const fs = require("fs");
const { Client } = require("pg");
const dungeon = require("../lib/dungeon-difficulty");
if (!process.env.ALPHANINE_TEST_PG_CONFIG) throw new Error("Set ALPHANINE_TEST_PG_CONFIG for isolated PostgreSQL tests.");
const cfg = JSON.parse(fs.readFileSync(process.env.ALPHANINE_TEST_PG_CONFIG, "utf8"));
const client = new Client({ host:cfg.databaseHost, port:cfg.databasePort, database:cfg.databaseName, user:cfg.databaseUser, password:cfg.databasePassword, connectionTimeoutMillis:5000 });
async function apply(target) {
  const sql = dungeon.buildApplySql({playerId:13, dungeonId:"DA_Dgn_Test", targetSelectableDifficulty:target, writeMethod:"direct"}).replace(/\bdune\./g, "pg_temp.");
  assert(!/\bdune\./.test(sql));
  await client.query(sql);
}
async function main() {
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE dungeon_completion (
      completion_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      dungeon_id text NOT NULL, difficulty integer NOT NULL, duration_ms integer NOT NULL, players_num integer NOT NULL);
      CREATE TEMP TABLE dungeon_completion_players (
      player_id bigint, completion_id bigint REFERENCES pg_temp.dungeon_completion(completion_id), PRIMARY KEY(player_id,completion_id));
      INSERT INTO pg_temp.dungeon_completion(dungeon_id,difficulty,duration_ms,players_num) VALUES('DA_Dgn_Test',12,100,2),('DA_Dgn_Test',20,100,1);
      INSERT INTO pg_temp.dungeon_completion_players VALUES(13,1),(99,1);`);
    await apply(10);
    let result = await client.query("SELECT dc.difficulty FROM pg_temp.dungeon_completion dc JOIN pg_temp.dungeon_completion_players p USING(completion_id) WHERE p.player_id=13");
    assert.deepEqual(result.rows,[{difficulty:9}]);
    await apply(10);
    result = await client.query("SELECT count(*)::int n FROM pg_temp.dungeon_completion_players WHERE player_id=13");
    assert.equal(result.rows[0].n,1);
    await apply(3);
    result = await client.query("SELECT count(*)::int n FROM pg_temp.dungeon_completion_players WHERE player_id=13");
    assert.equal(result.rows[0].n,0);
    result = await client.query("SELECT completion_id::text FROM pg_temp.dungeon_completion ORDER BY completion_id");
    assert.deepEqual(result.rows,[{completion_id:"1"},{completion_id:"2"}]);
    // No first completion needed after reset.
    await apply(6);
    result = await client.query("SELECT dc.difficulty FROM pg_temp.dungeon_completion dc JOIN pg_temp.dungeon_completion_players p USING(completion_id) WHERE p.player_id=13");
    assert.deepEqual(result.rows,[{difficulty:5}]);
    console.log("Dungeon temporary-table tests passed: raise, repeat, reset, first unlock, shared history and unrelated orphan preservation.");
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
