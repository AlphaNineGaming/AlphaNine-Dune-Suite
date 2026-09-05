"use strict";

const crypto = require("crypto");

const MIN_SELECTABLE_DIFFICULTY = 3;
const MAX_EXPERIMENTAL_DIFFICULTY = 30;
const SYNTHETIC_DURATION_MS = 2147483647;

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeDungeonId(value) {
  const dungeonId = String(value ?? "").trim();
  if (!dungeonId) throw new Error("Dungeon id is required.");
  if (dungeonId.length > 160) throw new Error("Dungeon id must be 160 characters or fewer.");
  if (/[\u0000-\u001f\u007f]/.test(dungeonId)) throw new Error("Dungeon id cannot contain control characters.");
  return dungeonId;
}

function normalizeTargetDifficulty(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error("Target difficulty must be a whole number.");
  const target = Number(text);
  if (!Number.isSafeInteger(target) || target < MIN_SELECTABLE_DIFFICULTY || target > MAX_EXPERIMENTAL_DIFFICULTY) {
    throw new Error(`Target difficulty must be from ${MIN_SELECTABLE_DIFFICULTY} to ${MAX_EXPERIMENTAL_DIFFICULTY}.`);
  }
  return target;
}

function normalizePlayerId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error("A valid player actor id is required.");
  const playerId = Number(text);
  if (!Number.isSafeInteger(playerId) || playerId < 1) throw new Error("A valid player actor id is required.");
  return playerId;
}

function requiredCompletionDifficulty(targetSelectableDifficulty) {
  const target = normalizeTargetDifficulty(targetSelectableDifficulty);
  return target <= MIN_SELECTABLE_DIFFICULTY ? 0 : target - 1;
}

function canonicalRecords(records = []) {
  return records.map((row) => ({
    completion_id: String(row.completion_id ?? row.completionId ?? ""),
    dungeon_id: String(row.dungeon_id ?? row.dungeonId ?? ""),
    difficulty: Number(row.difficulty || 0),
    duration_ms: Number(row.duration_ms ?? row.durationMs ?? 0),
    players_num: Number(row.players_num ?? row.playersNum ?? 0),
    party_links: Number(row.party_links ?? row.partyLinks ?? 0)
  })).sort((left, right) => left.difficulty - right.difficulty || left.completion_id.localeCompare(right.completion_id));
}

function snapshotFingerprint(records = []) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalRecords(records))).digest("hex");
}

function planChange(records = [], targetSelectableDifficulty) {
  const target = normalizeTargetDifficulty(targetSelectableDifficulty);
  const requiredDifficulty = requiredCompletionDifficulty(target);
  const normalized = canonicalRecords(records);
  const currentHighestCompletion = normalized.reduce((highest, row) => Math.max(highest, row.difficulty), 0);
  const removed = normalized.filter((row) => requiredDifficulty === 0 || row.difficulty > requiredDifficulty);
  const alreadyHasRequired = requiredDifficulty === 0 || normalized.some((row) => row.difficulty === requiredDifficulty);
  const insertsSyntheticCompletion = requiredDifficulty > 0 && !alreadyHasRequired;
  return {
    targetSelectableDifficulty: target,
    requiredCompletionDifficulty: requiredDifficulty,
    currentHighestCompletion,
    estimatedCurrentMaximumSelectable: Math.max(MIN_SELECTABLE_DIFFICULTY, currentHighestCompletion + 1),
    removedCompletionLinks: removed.length,
    preservedCompletionLinks: normalized.length - removed.length,
    insertsSyntheticCompletion,
    changesRequired: removed.length > 0 || insertsSyntheticCompletion,
    direction: requiredDifficulty > currentHighestCompletion ? "raise" : (requiredDifficulty < currentHighestCompletion ? "lower" : "unchanged")
  };
}

function buildSnapshotSql(playerIdValue, dungeonIdValue) {
  const playerId = normalizePlayerId(playerIdValue);
  const dungeonId = normalizeDungeonId(dungeonIdValue);
  return `
select dc.completion_id::text,
       dc.dungeon_id,
       dc.difficulty::text,
       dc.duration_ms::text,
       dc.players_num::text,
       (select count(*) from dune.dungeon_completion_players links where links.completion_id = dc.completion_id)::text as party_links
from dune.dungeon_completion_players dcp
join dune.dungeon_completion dc on dc.completion_id = dcp.completion_id
where dcp.player_id = ${playerId}
  and dc.dungeon_id = ${sqlLiteral(dungeonId)}
order by dc.difficulty, dc.completion_id;`.trim();
}

function buildApplySql({ playerId: playerIdValue, dungeonId: dungeonIdValue, targetSelectableDifficulty }) {
  const playerId = normalizePlayerId(playerIdValue);
  const dungeonId = normalizeDungeonId(dungeonIdValue);
  const target = normalizeTargetDifficulty(targetSelectableDifficulty);
  const requiredDifficulty = requiredCompletionDifficulty(target);
  const dungeon = sqlLiteral(dungeonId);
  const removalPredicate = requiredDifficulty === 0 ? "true" : `dc.difficulty > ${requiredDifficulty}`;
  const insert = requiredDifficulty > 0 ? `
do $dungeon_unlock$
begin
  if not exists (
    select 1
    from dune.dungeon_completion_players dcp
    join dune.dungeon_completion dc on dc.completion_id = dcp.completion_id
    where dcp.player_id = ${playerId}
      and dc.dungeon_id = ${dungeon}
      and dc.difficulty = ${requiredDifficulty}
  ) then
    perform dune.record_dungeon_completion(${dungeon}, ${requiredDifficulty}, ${SYNTHETIC_DURATION_MS}, array[${playerId}]::bigint[]);
  end if;
end
$dungeon_unlock$;` : "";
  return `
begin;
set local search_path to dune, public;

delete from dune.dungeon_completion_players dcp
using dune.dungeon_completion dc
where dcp.completion_id = dc.completion_id
  and dcp.player_id = ${playerId}
  and dc.dungeon_id = ${dungeon}
  and ${removalPredicate};

delete from dune.dungeon_completion dc
where dc.dungeon_id = ${dungeon}
  and not exists (
    select 1 from dune.dungeon_completion_players dcp where dcp.completion_id = dc.completion_id
  );
${insert}

commit;`.trim();
}

module.exports = {
  MAX_EXPERIMENTAL_DIFFICULTY,
  MIN_SELECTABLE_DIFFICULTY,
  SYNTHETIC_DURATION_MS,
  buildApplySql,
  buildSnapshotSql,
  canonicalRecords,
  normalizeDungeonId,
  normalizePlayerId,
  normalizeTargetDifficulty,
  planChange,
  requiredCompletionDifficulty,
  snapshotFingerprint
};
