const fs = require("fs");
const path = require("path");
const assert = require("assert");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

assert.match(source, /function skillUnlockPointCost\(skill = \{\}, targetLevel = null\)[\s\S]*?costs\.slice\(0, level\)\.reduce/, "Skill rank cost must be cumulative only through the requested rank.");
assert.match(source, /Array\.isArray\(payload\?\.skills\)[\s\S]*?targetLevel/, "Skill grants must accept per-skill target ranks.");
assert.match(source, /Skill rank grants require the selected player to be offline\./, "Skill rank grants must reject online players.");
assert.match(source, /progressionBackupPath\(actorId, "skill_ranks", backupId\)/, "Skill rank grants must create a dedicated backup.");
assert.match(source, /points: Math\.max\(item\.targetPoints,[\s\S]*?level: Math\.max\(item\.targetLevel/, "Skill rank grants must preserve higher existing ranks and point costs.");
assert.match(source, /Number\(item\.moduleSkillPointsSpent\) >= item\.targetPoints[\s\S]*?Number\(item\.perkCurrentLevel\) >= item\.targetLevel/, "Skill rank grants must verify the requested minimum rank and cost.");
assert.match(source, /data-progression-skill-level/, "Skill cards must expose a target-rank selector.");
assert.match(source, /progressionSelectedSkillRequests\(\)/, "The UI must send selected skill IDs with target ranks.");

assert.match(source, /const HOUSE_SCRIP_CURRENCY_ID = 1;/, "House Scrip must use confirmed virtual currency ID 1.");
assert.match(source, /const HOUSE_SCRIP_CONFIRM_TEXT = "GIVE HOUSE SCRIP";/, "House Scrip grants must require exact typed confirmation.");
assert.match(source, /House Scrip grants require the selected player to be offline\./, "House Scrip grants must reject online players.");
assert.match(source, /progressionBackupPath\(controllerId, "house_scrip", backupId\)/, "House Scrip grants must create a backup before writing.");
assert.match(source, /columnTypes\.player_controller_id !== "bigint"[\s\S]*?columnTypes\.currency_id !== "smallint"[\s\S]*?columnTypes\.balance !== "bigint"/, "House Scrip grants must validate the live currency storage column types.");
assert.match(source, /adjust_player_virtual_currency_balance\(bigint, smallint, bigint\)/, "House Scrip grants must require the detected database function signature.");
assert.match(source, /dune\.adjust_player_virtual_currency_balance\(\$\{controllerId\}::bigint, \$\{HOUSE_SCRIP_CURRENCY_ID\}::smallint, \$\{amount\}::bigint\)/, "House Scrip grants must call the database function with its exact argument types.");
assert.match(source, /const verified = balance === expectedBalance;/, "House Scrip grants must verify the exact expected balance.");
assert.match(source, /url\.pathname === "\/api\/progression\/house-scrip" && req\.method === "GET"/, "House Scrip balance route is missing.");
assert.match(source, /url\.pathname === "\/api\/progression\/house-scrip" && req\.method === "POST"/, "House Scrip grant route is missing.");
assert(source.indexOf('progressionBackupPath(controllerId, "house_scrip", backupId)') < source.indexOf('timer.step("currency_update"'), "House Scrip backup must be created before the currency update.");
assert.match(source, /id="progressionHouseScripAmount"[\s\S]*?id="progressionHouseScripConfirm"[\s\S]*?grantProgressionHouseScrip\(\)/, "House Scrip UI controls are incomplete.");
assert.match(source, /\.progression-currency-balance \{[^}]*font-size:clamp\(14px,1\.5vw,20px\)[^}]*overflow-wrap:anywhere/, "House Scrip balance must resize and wrap safely inside its panel.");

console.log("Granular skill rank and House Scrip regression checks passed.");
