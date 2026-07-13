"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ITEM_DEFAULT_MAX_DURABILITY,
  durabilityNumber,
  allowedRepairMaximum,
  durabilityRepairCandidate
} = require("../lib/durability-repair");

assert.strictEqual(ITEM_DEFAULT_MAX_DURABILITY, 100);
assert.strictEqual(durabilityNumber("42.5"), 42.5);
assert.strictEqual(durabilityNumber(""), null);
assert.strictEqual(allowedRepairMaximum("item", 80), 80, "Permanent item decay must cap repair.");
assert.strictEqual(allowedRepairMaximum("item", 0), 100, "Items with the game's zero default use 100.");
assert.strictEqual(allowedRepairMaximum("vehicle-module", 75), 75);
assert.strictEqual(allowedRepairMaximum("vehicle-module", 0), null, "Unknown vehicle maximums must never be guessed.");
assert.deepStrictEqual(durabilityRepairCandidate("item", 20, 80), {
  repairable: true,
  reason: "Current durability can be restored to the allowed maximum.",
  current: 20,
  maximum: 80
});
assert.strictEqual(durabilityRepairCandidate("item", 80, 80).repairable, false);
assert.strictEqual(durabilityRepairCandidate("vehicle-module", 10, 0).repairable, false);

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
for (const required of [
  'REPAIR_CONFIRM_TEXT = "REPAIR DURABILITY"',
  'where id = ${id} and stats = ${expectedStats}::jsonb',
  'jsonb_set(stats, \'${durabilityPath}\'',
  "liveBattlegroupSupported: true",
  "isOfflinePlayerStatus(player.online_status)",
  "for update;",
  "The player became online or changed after preview. Repair cancelled.",
  "async function dbQueryStreamed",
  "psql -v ON_ERROR_STOP=1",
  "-f -",
  'if (options.inputPath) return runWithStdin("ssh"',
  "durability_repair_preview_created",
  "durability_repair_applied",
  '"/api/admin/repair/inspect"',
  '"/api/admin/repair/preview"',
  '"/api/admin/repair/apply"',
  'id="repairApplyButton"',
  "Permanent maximum-durability decay will remain unchanged"
]) assert(server.includes(required), `Missing repair safeguard: ${required}`);
assert(!server.includes("assertRepairBattlegroupStopped"), "Live repair must not require stopping the battlegroup.");
const applyBlock = server.slice(server.indexOf("async function applyDurabilityRepair"), server.indexOf("function loadRepairQueue"));
assert(applyBlock.includes("await dbQueryStreamed(`"), "Repair apply must stream SQL instead of passing it on the Windows command line.");
assert(!applyBlock.includes("await dbQuery(`"), "Repair apply must not use command-line SQL execution.");

console.log("Durability repair policy, safety gates, protected SQL, API routes, and UI checks passed.");
