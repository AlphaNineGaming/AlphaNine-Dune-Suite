"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const DungeonDifficulty = require("../lib/dungeon-difficulty");

assert.equal(DungeonDifficulty.requiredCompletionDifficulty(3), 0);
assert.equal(DungeonDifficulty.requiredCompletionDifficulty(4), 3);
assert.equal(DungeonDifficulty.requiredCompletionDifficulty(30), 29);
assert.throws(() => DungeonDifficulty.normalizeTargetDifficulty(2), /from 3 to 30/);
assert.throws(() => DungeonDifficulty.normalizeTargetDifficulty(31), /from 3 to 30/);
assert.throws(() => DungeonDifficulty.normalizeDungeonId("bad\nid"), /control characters/);

const records = [
  { completion_id: "2", dungeon_id: "DA_Dgn_Test", difficulty: "8", duration_ms: "200", players_num: "2", party_links: "2" },
  { completion_id: "1", dungeon_id: "DA_Dgn_Test", difficulty: "3", duration_ms: "100", players_num: "1", party_links: "1" }
];
const lowering = DungeonDifficulty.planChange(records, 6);
assert.equal(lowering.requiredCompletionDifficulty, 5);
assert.equal(lowering.removedCompletionLinks, 1);
assert.equal(lowering.insertsSyntheticCompletion, true);
assert.equal(lowering.direction, "lower");

const reset = DungeonDifficulty.planChange(records, 3);
assert.equal(reset.removedCompletionLinks, 2);
assert.equal(reset.insertsSyntheticCompletion, false);

const raiseSql = DungeonDifficulty.buildApplySql({ playerId: 42, dungeonId: "DA_Dgn_O'Brien", targetSelectableDifficulty: 10 });
assert.match(raiseSql, /begin;\s*set local search_path to dune, public;/i);
assert.match(raiseSql, /record_dungeon_completion\('DA_Dgn_O''Brien', 9, 2147483647, array\[42\]::bigint\[\]\)/);
assert.match(raiseSql, /delete from dune\.dungeon_completion_players[\s\S]*dcp\.player_id = 42[\s\S]*dc\.difficulty > 9/);
assert.match(raiseSql, /not exists[\s\S]*dungeon_completion_players/);
assert.match(raiseSql, /commit;$/i);

const resetSql = DungeonDifficulty.buildApplySql({ playerId: 42, dungeonId: "DA_Dgn_Test", targetSelectableDifficulty: 3 });
assert.doesNotMatch(resetSql, /record_dungeon_completion/);
assert.match(resetSql, /and true;/);

assert.equal(DungeonDifficulty.snapshotFingerprint(records), DungeonDifficulty.snapshotFingerprint([...records].reverse()));

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.match(server, /Dungeon Difficulty Unlocks[\s\S]*Experimental/);
assert.match(server, /\/api\/progression\/dungeon-difficulty\/preview/);
assert.match(server, /\/api\/progression\/dungeon-difficulty\/apply/);
assert.match(server, /createDatabaseBackup\(\{[\s\S]*safety:\s*true,[\s\S]*method:\s*"native"[\s\S]*pre-dungeon-difficulty/);
assert.match(server, /DUNGEON_DIFFICULTY_CONFIRM_TEXT\s*=\s*"APPLY DUNGEON EXPERIMENT"/);
assert.match(server, /snapshotFingerprint\(before\)[\s\S]*preview\.snapshotFingerprint/);
assert.match(server, /highest !== requiredDifficulty \|\| !exactRequiredFound/);
assert.match(server, /Dungeon difficulty editing requires the selected player to be offline/);
assert.match(server, /may create a synthetic best-run entry/);

console.log("Dungeon difficulty experimental editor tests passed.");
