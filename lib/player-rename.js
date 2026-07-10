const PLAYER_RENAME_MAX_LENGTH = 32;

function sanitizePlayerRenameName(value) {
  const raw = String(value ?? "");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(raw)) {
    throw new Error("Character name cannot contain control characters, tabs, or line breaks.");
  }
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(raw)) {
    throw new Error("Character name cannot contain invisible formatting characters.");
  }
  const name = raw.trim().replace(/ {2,}/g, " ");
  if (!name) throw new Error("New character name is required.");
  if ([...name].length > PLAYER_RENAME_MAX_LENGTH) {
    throw new Error(`Character name must be ${PLAYER_RENAME_MAX_LENGTH} characters or less.`);
  }
  return name;
}

function isOfflinePlayerStatus(value) {
  return ["offline", "disconnected", "inactive", "false", "f", "0", "no"].includes(String(value || "").trim().toLowerCase());
}

function playerRenamePreviewExpired(createdAt, now = Date.now(), ttlMs = 15 * 60 * 1000) {
  const timestamp = Number(createdAt);
  return !Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp > ttlMs;
}

module.exports = {
  PLAYER_RENAME_MAX_LENGTH,
  sanitizePlayerRenameName,
  isOfflinePlayerStatus,
  playerRenamePreviewExpired
};
