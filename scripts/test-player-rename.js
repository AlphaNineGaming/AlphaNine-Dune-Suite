const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PLAYER_RENAME_MAX_LENGTH,
  sanitizePlayerRenameName,
  isOfflinePlayerStatus,
  playerRenamePreviewExpired
} = require("../lib/player-rename");

assert.strictEqual(sanitizePlayerRenameName("  Chani  Kynes  "), "Chani Kynes");
assert.strictEqual(sanitizePlayerRenameName("Revy"), "Revy");
assert.throws(() => sanitizePlayerRenameName("   "), /required/i);
assert.throws(() => sanitizePlayerRenameName("Bad\nName"), /control characters/i);
assert.throws(() => sanitizePlayerRenameName("Hidden\u200bName"), /invisible/i);
assert.throws(() => sanitizePlayerRenameName("x".repeat(PLAYER_RENAME_MAX_LENGTH + 1)), /characters or less/i);

for (const value of ["Offline", "disconnected", "FALSE", "0"]) {
  assert.strictEqual(isOfflinePlayerStatus(value), true, `${value} should be offline`);
}
for (const value of ["Online", "Connected", "", "Unknown"]) {
  assert.strictEqual(isOfflinePlayerStatus(value), false, `${value} should not be offline`);
}

const now = Date.now();
assert.strictEqual(playerRenamePreviewExpired(now - 1000, now), false);
assert.strictEqual(playerRenamePreviewExpired(now - 16 * 60 * 1000, now), true);
assert.strictEqual(playerRenamePreviewExpired(0, now), true);

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
for (const required of [
  "/api/admin/players/rename/preview",
  "/api/admin/players/rename/apply",
  "player_state_row_id",
  "dune.encrypt_user_data",
  "pg_advisory_xact_lock",
  "playerRenameOpenButton",
  "playerRenameApplyButton"
]) {
  assert(serverSource.includes(required), `server.js is missing player rename integration: ${required}`);
}

console.log("Player rename validation tests passed.");
