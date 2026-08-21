const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function includes(text, message) {
  assert(source.includes(text), message || `Missing expected source: ${text}`);
}

includes('const ARRAKEEN_EXCHANGE_NAME = "Arrakeen_EX";', "Arrakeen Exchange name must be exact.");
includes('const ARRAKEEN_ACCESS_POINT_NAME = "Arrakeen_AP";', "Arrakeen access-point name must be exact.");
includes('const ARRAKEEN_EXCHANGE_CONFIRM_TEXT = "INITIALIZE ARRAKEEN EXCHANGE";', "The initializer needs typed confirmation.");
includes('flag: "wx"', "The recovery snapshot must never overwrite another snapshot.");
includes('if (before.signature !== preview.signature || !before.canInitialize)', "Apply must re-check the previewed database state.");
includes('Date.now() - preview.createdAt > ARRAKEEN_EXCHANGE_PREVIEW_TTL_MS', "Previews must expire.");
includes('linkedInventoryCount > 1', "Ambiguous linked inventories must fail closed.");
includes('access point attached to ${ARRAKEEN_EXCHANGE_NAME} is not named', "Unexpected access-point names must fail closed.");
includes('/api/market-bot/exchanges/arrakeen/preview', "The protected preview endpoint is missing.");
includes('/api/market-bot/exchanges/arrakeen/apply', "The protected apply endpoint is missing.");
includes('id="marketBotInitializeArrakeenButton"', "The Arrakeen initialization action is missing from Market Automation.");
includes('Arrakeen · Exchange not initialized', "The selector must explain why Arrakeen is unavailable.");
includes('click Save Exchange when ready', "Initialization must not silently retarget the bot.");

const applyStart = source.indexOf("async function applyArrakeenExchangeInitialization");
const applyEnd = source.indexOf("async function marketBotExchanges", applyStart);
assert(applyStart >= 0 && applyEnd > applyStart, "Could not isolate the Arrakeen apply function.");
const applySource = source.slice(applyStart, applyEnd);

assert(applySource.includes("begin;"), "Initialization must run in a transaction.");
assert(applySource.includes("commit;"), "Initialization transaction must commit only after all statements succeed.");
for (const table of [
  "dune.world_partition",
  "dune.dune_exchanges",
  "dune.dune_exchange_accesspoints",
  "dune.inventories",
  "dune.dune_exchange_orders"
]) {
  assert(applySource.includes(table), `Initialization must inspect or lock ${table}.`);
}
assert(applySource.includes("insert into dune.dune_exchanges(exchange_name)"), "Initializer must add only the exact missing Exchange row.");
assert(applySource.includes("insert into dune.inventories(exchange_id)"), "Initializer must add only the missing linked inventory.");
assert(applySource.includes("insert into dune.dune_exchange_accesspoints(exchange_id, name)"), "Initializer must add only the missing access point.");
assert(!/insert\s+into\s+dune\.dune_exchange_orders/i.test(applySource), "Initializer must never create listings.");
assert(!/update\s+dune\.dune_exchange_orders/i.test(applySource), "Initializer must never move or modify listings.");
assert(!/delete\s+from\s+dune\.dune_exchange_orders/i.test(applySource), "Initializer must never delete listings.");
assert(applySource.includes("'createdListings', false"), "Result must explicitly report that no listings were created.");
assert(applySource.includes("'movedListings', false"), "Result must explicitly report that no listings were moved.");

console.log("Arrakeen Exchange protected initializer checks passed.");
