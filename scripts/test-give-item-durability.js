"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SET_DURABILITY_VALUE,
  durabilityEligibility,
  durabilityExpectation,
  itemStatsForGrant,
  classifyDurabilityReadBack,
  buildDurabilityInvestigationSql
} = require("../lib/give-item-durability");

const weapon = { id: "LongRifle_Unique_Poison_06", category: "Weapons", type: "Spitdart" };
const armor = { id: "Combat_Heavy_Unique_Reinforced_Boots_06", category: "Garment", type: "Feet" };
const installedGameClothing = { id: "Atreides_Heavy_Armor", category: "Clothing", type: "" };
const tool = { id: "DewReaper_1h_Tier6", category: "Utility", type: "Watertools" };
const equipment = { id: "OrnithopterMediumEngine_6", category: "Vehicles", type: "Engine" };
const resource = { id: "Silicone", category: "Misc", type: "Refinedresources" };
const consumable = { id: "healthpack_channeled", category: "Utility", type: "Healkit" };
const schematic = { id: "Schematic_UniquePincushionHands", category: "Schematics", type: "Contract" };

for (const [item, kind] of [[weapon, "weapon"], [armor, "armor"], [installedGameClothing, "armor"], [tool, "tool"], [equipment, "equipment"]]) {
  const eligible = durabilityEligibility(item);
  assert.equal(eligible.applicable, true, `${item.id} must be eligible`);
  assert.equal(eligible.kind, kind);
  const expectation = durabilityExpectation(item, true);
  assert.equal(expectation.currentDurability, SET_DURABILITY_VALUE);
  assert.equal(expectation.maximumDurability, SET_DURABILITY_VALUE);
  const stats = itemStatsForGrant(expectation);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 200);
  assert.equal(typeof stats.FItemStackAndDurabilityStats[1].CurrentDurability, "number");
  assert.equal(stats.FItemStackAndDurabilityStats[1].DecayedMaxDurability, 200);
  assert.equal(typeof stats.FItemStackAndDurabilityStats[1].DecayedMaxDurability, "number");
  assert.equal(Object.hasOwn(stats.FItemStackAndDurabilityStats[1], "MaxDurability"), false, "the authoritative per-instance maximum is DecayedMaxDurability");
}

for (const item of [resource, consumable, schematic, null]) {
  const expectation = durabilityExpectation(item, true);
  assert.equal(expectation.applicable, false);
  assert.equal(expectation.display, "Durability not applicable");
  assert.deepEqual(itemStatsForGrant(expectation).FItemStackAndDurabilityStats[1], {}, "non-durable items must not receive fabricated durability data");
}

// Production-shaped rows establish the authoritative leaf and JSON-number encoding.
const productionWeaponStats = JSON.parse('{"FWeaponItemStats":[[],{"CurrentAmmo":2}],"FCustomizationStats":[[],{}],"FItemStackAndDurabilityStats":[[],{"CurrentDurability":83.923133,"DecayedMaxDurability":96.473129}]}');
const productionResourceStats = JSON.parse('{"FItemStackAndDurabilityStats":[[],{"DecayedMaxDurability":0.0}]}');
assert.equal(typeof productionWeaponStats.FItemStackAndDurabilityStats[1].CurrentDurability, "number");
assert.equal(typeof productionWeaponStats.FItemStackAndDurabilityStats[1].DecayedMaxDurability, "number");
assert.equal(Object.hasOwn(productionResourceStats.FItemStackAndDurabilityStats[1], "CurrentDurability"), false, "the shared wrapper is not durability eligibility evidence");

const investigationSql = buildDurabilityInvestigationSql("'LongRifle_Unique_Poison_06'");
assert.match(investigationSql, /information_schema\.columns/);
assert.match(investigationSql, /t\.typname='inventoryitem'/);
assert.match(investigationSql, /FItemStackAndDurabilityStats,1,CurrentDurability/);
assert.match(investigationSql, /FItemStackAndDurabilityStats,1,DecayedMaxDurability/);
assert.match(investigationSql, /jsonb_typeof[\s\S]*='number'/);

const expected = durabilityExpectation(weapon, true);
const exact200 = { foundStacks: 2, durabilityPresentStacks: 2, numericDurabilityStacks: 2, exactDurabilityStacks: 2, maximumDurabilityPresentStacks: 2, numericMaximumDurabilityStacks: 2, exactMaximumDurabilityStacks: 2 };
assert.equal(classifyDurabilityReadBack(expected, exact200).ok, true);
assert.equal(classifyDurabilityReadBack(expected, { ...exact200, exactDurabilityStacks: 1 }).status, "durability-mismatch");
assert.equal(classifyDurabilityReadBack(expected, { ...exact200, exactMaximumDurabilityStacks: 1 }).status, "durability-mismatch", "a maximum durability mismatch must fail verification");
assert.equal(classifyDurabilityReadBack(expected, { foundStacks: 0 }).status, "runtime-overwrite");
assert.equal(classifyDurabilityReadBack(durabilityExpectation(resource, true), { foundStacks: 1, durabilityPresentStacks: 1 }).status, "fabricated-durability");
assert.equal(classifyDurabilityReadBack(durabilityExpectation(resource, true), { foundStacks: 1, maximumDurabilityPresentStacks: 1 }).status, "fabricated-durability");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const playerGrant = server.slice(server.indexOf("async function adminGiveDbItemToPlayer"), server.indexOf("async function adminGiveItem(payload)"));
const storageGrant = server.slice(server.indexOf("async function adminGiveItemToStorage"), server.indexOf("function giveItemReceipt"));
assert.match(playerGrant, /begin;[\s\S]*player_grant_slots[\s\S]*GIVE_ITEM_DURABILITY_SQL_PATH[\s\S]*raise exception 'Player item grant failed transactional identity, quantity, slot, grade, or durability verification'[\s\S]*commit;/);
assert.match(playerGrant, /free_slot_count[\s\S]*coalesce\(\(select free_slots from free_slot_count\), 0\) < \$\{stackCount\}/, "player precheck must count actual free normal slots instead of treating special or legacy positions as occupied capacity");
assert.doesNotMatch(playerGrant, /Player inventory contains invalid occupied slot positions/, "unrelated legacy or special positions must not block a valid grant");
assert.doesNotMatch(playerGrant, /Player inventory contains duplicate occupied slot positions/, "unrelated existing slot conflicts must not block allocation of a different free slot");
assert.match(playerGrant, /bool_and\(i\.position_index>=0[\s\S]*occupied\.position_index=i\.position_index\)=1\)/, "the transaction must validate the newly inserted slots without rejecting unrelated existing rows");
assert.match(storageGrant, /storage_grant_slots[\s\S]*GIVE_ITEM_DURABILITY_SQL_PATH[\s\S]*Storage deposit failed transactional slot and quantity verification[\s\S]*commit;/);
assert.match(playerGrant, /i\.stats #> '\$\{GIVE_ITEM_DURABILITY_SQL_PATH\}' is null/, "non-durable player transaction verification must require an absent durability leaf");
assert.match(storageGrant, /i\.stats #> '\$\{GIVE_ITEM_DURABILITY_SQL_PATH\}' is null/, "non-durable storage transaction verification must require an absent durability leaf");
assert.match(playerGrant, /GIVE_ITEM_MAXIMUM_DURABILITY_SQL_PATH/, "player transaction must verify the per-instance maximum");
assert.match(storageGrant, /GIVE_ITEM_MAXIMUM_DURABILITY_SQL_PATH/, "storage transaction must verify the per-instance maximum");
assert.match(server, /function verifyGiveItemReceipt[\s\S]*read-back-mismatch/);
assert.match(server, /function verifyStorageDepositReceipt[\s\S]*classifyDurabilityReadBack/);
assert.match(server, /pollGiveItemReceipt[\s\S]*delays=\[2000,3000,10000,15000\]/);
assert.match(server, /pollStorageDeposit[\s\S]*delays=\[2000,3000,10000,15000\]/);
assert.match(server, /id="giveDurabilityWrap" class="give-durability-card unavailable"[\s\S]*id="adminSetDurability200"[\s\S]*Give at full durability — 200 \/ 200/);
assert.match(server, /id="giveDurabilityBadge"[\s\S]*Choose an item/);
assert.match(server, /Full durability is enabled[\s\S]*200 current and 200 maximum durability/);
assert.ok(!/wrap\.classList\.toggle\("unsupported-control",!applicable\)/.test(server), "Durability guidance must remain visible in Simple mode.");
assert.match(server, /Durability not applicable/);
assert.match(server, /\/api\/admin\/give-item-receipts\/recheck/);
assert.match(server, /storage_item_deposited[\s\S]*durabilityEvidence[\s\S]*durabilityVerification/);
assert.match(server, /give_item_db_grade_inserted[\s\S]*durabilityEvidence[\s\S]*receiptId/);

console.log("Give Item Set Durability to 200 schema, eligibility, transaction rollback, destination, receipt, read-back, and delayed verification tests passed.");
