"use strict";

const PLAYER_SELECTOR_COLUMNS = Object.freeze({
  account: "account_id",
  controller: "player_controller_id",
  pawn: "player_pawn_id",
  state: "player_state_id",
  row: "id"
});
const PLAYER_SELECTOR_MATCHED_COLUMNS = Object.freeze({
  account: "account_id",
  controller: "player_controller_id",
  pawn: "player_pawn_id",
  state: "player_state_id",
  row: "player_state_row_id"
});

function parsePlayerSelector(input) {
  const match = String(input || "").trim().match(/^(account|controller|pawn|state|row):(\d+)$/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  return {
    type,
    value: match[2],
    column: PLAYER_SELECTOR_COLUMNS[type],
    matchedColumn: PLAYER_SELECTOR_MATCHED_COLUMNS[type]
  };
}

function createPlayerDirectory(options = {}) {
  if (typeof options.load !== "function") throw new TypeError("Player directory requires a load function.");

  const load = options.load;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const freshMs = Math.max(0, Number(options.freshMs ?? 15000));
  const staleMs = Math.max(freshMs, Number(options.staleMs ?? 300000));
  let cached = null;
  let inFlight = null;

  function valid(result) {
    return Boolean(result && result.ok !== false && Array.isArray(result.players));
  }

  function snapshot(entry, cacheStatus, extra = {}) {
    return {
      ...entry.value,
      playerDirectory: {
        cacheStatus,
        loadedAt: new Date(entry.loadedAt).toISOString(),
        ageMs: Math.max(0, now() - entry.loadedAt),
        ...extra
      }
    };
  }

  function cachedWithin(maxAgeMs) {
    return cached && now() - cached.loadedAt <= maxAgeMs ? cached : null;
  }

  async function startLoad(loadOptions) {
    try {
      const result = await load(loadOptions);
      if (!valid(result)) {
        const message = result?.error || result?.reason || "Player directory returned an invalid response.";
        throw new Error(message);
      }
      cached = { value: result, loadedAt: now() };
      return snapshot(cached, "refreshed");
    } catch (error) {
      const stale = cachedWithin(staleMs);
      if (stale) {
        return snapshot(stale, "stale", {
          warning: `Player refresh failed; keeping the last confirmed directory. ${error.message}`
        });
      }
      throw error;
    } finally {
      inFlight = null;
    }
  }

  function get(loadOptions = {}) {
    const force = loadOptions.force === true;
    if (!force) {
      const fresh = cachedWithin(freshMs);
      if (fresh) return Promise.resolve(snapshot(fresh, "fresh"));
      if (inFlight) return inFlight;
    } else if (inFlight) {
      return inFlight;
    }

    inFlight = startLoad({ ...loadOptions, force: undefined });
    return inFlight;
  }

  function clear() {
    cached = null;
  }

  function state() {
    return {
      cached: Boolean(cached),
      loadedAt: cached ? new Date(cached.loadedAt).toISOString() : "",
      ageMs: cached ? Math.max(0, now() - cached.loadedAt) : null,
      inFlight: Boolean(inFlight)
    };
  }

  return { get, clear, state };
}

module.exports = { createPlayerDirectory, parsePlayerSelector };
