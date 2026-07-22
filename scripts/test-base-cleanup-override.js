const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

assert.match(source, /const expectedConfirmation = `DELETE BASE \$\{actorId\}`/);
assert.match(source, /Owned-base override requires typing \$\{expectedConfirmation\}/);
assert.match(source, /coalesce\(rs\.matched_ref_count, 0\) = 0\s+or\s+\(\s+\$\{allowOwnedSql\}/);
assert.match(source, /not exists \(\s+select 1\s+from ref_matches rm[\s\S]+lower\(coalesce\(rm\.online_status::text, ''\)\) in \('online', 'connected', 'true', '1'\)/);
assert.match(source, /coalesce\(rs\.ref_count, 0\) > 0/);
assert.match(source, /owned_base_override_deleted/);
assert.match(source, /orphan_base_deleted/);
assert.match(source, /row\.status==="owned"\|\|row\.status==="partial-missing"/);
assert.doesNotMatch(source, /row\.status==="unknown-owner"[^\n]+Delete Owned Base/);
assert.match(source, /forceOwned\?"Owned base override deleted":"Orphaned base deleted"/);
assert.match(source, /function requireSqlBigint\(value, name, min = 0n, max = 9223372036854775807n\)/);
assert.match(source, /const actorId = requireSqlBigint\(payload\.actorId, "actor_id", 0n\)/);
assert.match(source, /const actorId=String\(row\.actorId\|\|""\)\.trim\(\);const validActorId=\/\^\\d\+\$\/\.test\(actorId\);/);
assert.match(source, /const exactActorId=String\(actorId\|\|""\)\.trim\(\);/);
assert.match(source, /body:JSON\.stringify\(\{actorId:exactActorId,confirmed:true,forceOwned/);
assert.doesNotMatch(source, /const actorId=Number\(row\.actorId\)\|\|0/);
assert.match(source, /appendAdminAudit\("base_cleanup_delete_requested"/);
assert.match(source, /appendAdminAudit\("base_cleanup_delete_failed", \{ actorId, error: error\.message/);

console.log("Base cleanup override safety test passed.");
