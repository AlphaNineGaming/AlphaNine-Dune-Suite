"use strict";

const assert = require("assert");
const {
  USER_GAME_SETTINGS_SCHEMA,
  parseUserGameIni,
  updateUserGameIni
} = require("../lib/user-game-settings");

const liveSample = `; preserved comment\r\n[/Script/DuneSandbox.BuildingSettings]\r\nm_MaxNumLandclaimSegments=6\r\nm_BuildingBlueprintMaxExtensions=12\r\nm_BaseBackupMaxExtensions=24\r\nm_bBuildingRestrictionLimitsEnabled=True\r\nUnknownBuildingValue=keep-me\r\n[/Script/DuneSandbox.DuneGameMode]\r\nm_GlobalXPMultiplier=5.00\r\nm_GlobalFameMultiplier=1.00\r\n`;

assert.equal(USER_GAME_SETTINGS_SCHEMA.length, 18, "The exact live UserGame.ini control set changed unexpectedly.");
const parsed = parseUserGameIni(liveSample);
assert.equal(parsed.m_MaxNumLandclaimSegments, 6);
assert.equal(parsed.m_bBuildingRestrictionLimitsEnabled, true);
assert.equal(parsed.m_GlobalXPMultiplier, 5);

const updated = updateUserGameIni(liveSample, {
  m_MaxNumLandclaimSegments: 18,
  m_bBuildingRestrictionLimitsEnabled: false,
  m_GlobalXPMultiplier: 7.5,
  m_GlobalHarvestAmountMultiplier: 2.25
});
assert(updated.content.includes("m_MaxNumLandclaimSegments=18"));
assert(updated.content.includes("m_bBuildingRestrictionLimitsEnabled=False"));
assert(updated.content.includes("m_GlobalXPMultiplier=7.50"));
assert(updated.content.includes("m_GlobalHarvestAmountMultiplier=2.25"), "Missing allowlisted keys must be added to their existing section.");
assert(updated.content.includes("UnknownBuildingValue=keep-me"), "Unknown UserGame.ini settings must be preserved.");
assert(updated.content.includes("; preserved comment"), "Comments must be preserved.");
assert(updated.content.includes("\r\n"), "Existing CRLF line endings must be preserved.");
assert.deepEqual(updated.changedKeys.sort(), [
  "m_GlobalHarvestAmountMultiplier",
  "m_GlobalXPMultiplier",
  "m_MaxNumLandclaimSegments",
  "m_bBuildingRestrictionLimitsEnabled"
].sort());

assert.throws(() => updateUserGameIni(liveSample, { NotAllowed: 1 }), /Unsupported/);
assert.throws(() => updateUserGameIni(liveSample, { m_MaxNumLandclaimSegments: 1000 }), /between 1 and 64/);
assert.throws(() => updateUserGameIni(liveSample, { m_bBuildingRestrictionLimitsEnabled: "sometimes" }), /True or False/);

console.log("Live UserGame.ini parsing, validation, preservation, and update tests passed.");
