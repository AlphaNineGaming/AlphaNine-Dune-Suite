"use strict";

const assert = require("assert");
const { createPlayerDirectory, parsePlayerSelector } = require("../lib/player-directory");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function main() {
  assert.deepStrictEqual(parsePlayerSelector("controller:4"), {
    type: "controller",
    value: "4",
    column: "player_controller_id",
    matchedColumn: "player_controller_id"
  });
  assert.strictEqual(parsePlayerSelector("account:9223372036854775807").value, "9223372036854775807", "Large database IDs must remain exact strings.");
  assert.strictEqual(parsePlayerSelector("controller:4 OR 1=1"), null, "Malformed selectors must be rejected.");
  assert.strictEqual(parsePlayerSelector("unknown:4"), null, "Unknown selector types must be rejected.");
  let time = Date.parse("2026-07-15T10:00:00.000Z");
  let calls = 0;
  let next = deferred();
  const directory = createPlayerDirectory({
    now: () => time,
    freshMs: 1000,
    staleMs: 5000,
    load: () => {
      calls += 1;
      return next.promise;
    }
  });

  const first = directory.get();
  const concurrent = directory.get();
  assert.strictEqual(calls, 1, "Concurrent consumers must share one backend load.");
  next.resolve({ ok: true, players: [{ id: "1", name: "Confirmed" }] });
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  assert.deepStrictEqual(firstResult.players, concurrentResult.players);
  assert.strictEqual(firstResult.playerDirectory.cacheStatus, "refreshed");

  time += 500;
  const fresh = await directory.get();
  assert.strictEqual(calls, 1, "Fresh data must be reused without another load.");
  assert.strictEqual(fresh.playerDirectory.cacheStatus, "fresh");

  next = deferred();
  const forced = directory.get({ force: true });
  assert.strictEqual(calls, 2, "Explicit refresh must start one new load.");
  next.reject(new Error("temporary database delay"));
  const stale = await forced;
  assert.strictEqual(stale.playerDirectory.cacheStatus, "stale");
  assert.match(stale.playerDirectory.warning, /keeping the last confirmed directory/i);
  assert.deepStrictEqual(stale.players, [{ id: "1", name: "Confirmed" }]);

  time += 6000;
  next = deferred();
  const expired = directory.get();
  next.reject(new Error("database unavailable"));
  await assert.rejects(expired, /database unavailable/);

  const invalid = createPlayerDirectory({ load: async () => ({ ok: false, players: [], error: "bad result" }) });
  await assert.rejects(invalid.get(), /bad result/);

  console.log("Player directory single-flight, freshness, forced refresh, stale fallback, expiry, and validation checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
