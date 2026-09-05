"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const clockStart = server.indexOf("async function marketListingGameNow()");
const clockEnd = server.indexOf("async function marketListingExpiryTime", clockStart);
assert.ok(clockStart >= 0 && clockEnd > clockStart, "Could not isolate the live market-listings clock.");
const clockBlock = server.slice(clockStart, clockEnd);
assert.ok(
  clockBlock.includes("from dune.farm_variables")
    && clockBlock.includes("universe_time_timestamp"),
  "Live Market Listings must use the authoritative Dune universe clock."
);
assert(!clockBlock.includes("down_time_accumulation"), "The server universe clock must not add a downtime adjustment.");
assert(!clockBlock.includes("extract(epoch from clock_timestamp())"), "An unavailable game clock must not fall back to Unix time.");
assert.ok(
  !clockBlock.includes("max(expiration_time)") && !clockBlock.includes("player_clock"),
  "Live Market Listings must not infer game time from player listing expiration."
);
const start = server.indexOf("async function marketListings(payload = {})");
const end = server.indexOf("async function buyMarketListingAsAdmin", start);
assert.ok(start >= 0 && end > start, "Could not isolate the live market-listings query.");

const block = server.slice(start, end);
assert.ok(
  block.includes("join dune.dune_exchange_sell_orders s on s.order_id = o.id"),
  "Live Market Listings must require a sell-order row."
);
assert.ok(
  !block.includes("left join dune.dune_exchange_sell_orders s on s.order_id = o.id"),
  "Claim and payout records must not be included through an optional sell-order join."
);
assert.ok(
  block.includes("join dune.items i on i.id = o.item_id"),
  "Live Market Listings must require the listed item to still exist."
);
assert.ok(
  block.includes('const listingPredicates = ["i.stack_size > 0"]'),
  "Empty claimed item stacks must not appear as live listings."
);
assert.ok(
  block.includes('const where = `where ${listingPredicates.join(" and ")}`'),
  "The active-listing filter must apply even when no search text is provided."
);

const exchangeDiscoveryStart = server.indexOf("function normalizeMarketBotExchangeRow");
const exchangeDiscoveryEnd = server.indexOf("async function marketPostingStatus", exchangeDiscoveryStart);
const exchangeDiscovery = server.slice(exchangeDiscoveryStart, exchangeDiscoveryEnd);
assert.ok(exchangeDiscoveryStart >= 0 && exchangeDiscoveryEnd > exchangeDiscoveryStart, "Could not isolate Market Bot Exchange discovery.");
assert.ok(exchangeDiscovery.includes("from dune.dune_exchanges e") && exchangeDiscovery.includes("dune.dune_exchange_accesspoints"), "Exchange choices must come from the live game database and verify access points.");
assert.ok(
  exchangeDiscovery.includes("savedInventoryValid")
    && exchangeDiscovery.includes("nameCount === 1")
    && exchangeDiscovery.includes("linkedInventoryCount <= 1"),
  "Unusable or ambiguous Exchanges must not be selectable."
);

const marketViewStart = server.indexOf('<section id="market" class="view">');
const legacyViewStart = server.indexOf('<section id="legacy-market"', marketViewStart);
assert.ok(marketViewStart >= 0 && legacyViewStart > marketViewStart, "Could not isolate the primary Market Automation view.");
const marketView = server.slice(marketViewStart, legacyViewStart);
assert.ok(
  marketView.includes('<details id="marketBotPreviewPanel" class="panel pad mt">')
    && !marketView.includes('<details id="marketBotPreviewPanel" class="panel pad mt" open>'),
  "The Market Bot catalog must be collapsible and closed by default."
);
assert.ok(
  marketView.includes('id="liveMarketListingsPanel"')
    && marketView.includes('id="marketListingsSearch"')
    && marketView.includes('id="marketListingsLimit"')
    && marketView.includes('id="marketListingsSummary"')
    && marketView.includes('id="marketListings"'),
  "The primary Market Automation view must expose the live in-game listings tracker."
);
assert.ok(marketView.includes('id="marketBotExchange"') && marketView.includes('id="marketBotSaveExchangeButton"'), "Market Automation must expose the Bot Listing Exchange selector.");
assert.ok(marketView.includes("Existing listings stay at their original Exchange"), "The Exchange selector must explain that existing listings are not moved.");
assert.ok(
  !marketView.includes("removeSelectedMarketListings") && !marketView.includes("buyMarketListing("),
  "Live listings must not expose the legacy bulk removal controls."
);
assert.equal((server.match(/id="marketListings"/g) || []).length, 1, "The live listings tracker must have one unique rendered target.");
assert.ok(
  server.includes('if(name==="market"){refreshMarketBot();refreshMarketListings();}'),
  "Opening Market Automation must refresh both bot status and live listings."
);
const renderStart = server.indexOf("function renderMarketListings(data)");
const renderEnd = server.indexOf("async function refreshMarketListings", renderStart);
const renderBlock = server.slice(renderStart, renderEnd);
assert.ok(renderBlock.includes("tracking-only") && renderBlock.includes("Seller / Type"), "Live listings must render the read-only tracking columns.");
assert.ok(renderBlock.includes("marketListingPurchaseAction(row,gameNow)") && !renderBlock.includes("Remove</button>"), "Live listings must expose guarded player purchases, not arbitrary removal.");

console.log("Live market listings use the Dune universe clock and exclude claim, payout, history, and empty-item rows.");

async function testClockBehavior() {
  const vm = require("vm");
  const calls = [];
  let clockResult = "8220467";
  const context = {
    dbQuery: async (sql) => { calls.push(sql); if (clockResult instanceof Error) throw clockResult; return clockResult; },
    parseDbRows: (text) => [{ expirationTime: text }]
  };
  const expiryEnd = server.indexOf("async function cleanupExpiredMarketListings", clockEnd);
  vm.runInNewContext(server.slice(clockStart, expiryEnd), context);
  const formatterStart = server.indexOf("function formatMarketListingExpiry(");
  const formatterEnd = server.indexOf("function renderMarketListings(", formatterStart);
  vm.runInNewContext(server.slice(formatterStart, formatterEnd), context);
  // Read-only live snapshot: three active orders, with 11d 15h of persisted downtime.
  // Applying that downtime again falsely expires two orders and shortens Ambition.
  const serverNow = Math.floor((Date.parse("2026-09-05T15:28:33.474522Z") - Date.parse("2026-06-02T12:00:46.169462Z")) / 1000);
  assert.equal(serverNow, 8220467);
  assert.equal(await context.marketListingGameNow(), serverNow);
  for (const [expiry, expected] of [[9429712, "13d 23h remaining"], [8479264, "2d 23h remaining"], [8479251, "2d 23h remaining"]]) {
    const result = context.formatMarketListingExpiry(expiry, serverNow);
    assert.equal(result.label, expected);
    assert.equal(result.expired, false);
  }
  assert.equal(await context.marketListingExpiryTime(14), serverNow + 14 * 86400);
  clockResult = String(serverNow + 60);
  assert.equal(await context.marketListingGameNow(), serverNow + 60, "Each refresh must fetch a new server-clock value.");
  assert.equal(calls.length, 3);
  for (const invalid of ["", "0", "-1", "NaN", "Infinity", "1.5", "9007199254740992", new Error("Database unavailable")]) {
    clockResult = invalid;
    const unavailable = await context.marketListingGameNow();
    assert.equal(unavailable, 0);
    assert.equal(context.formatMarketListingExpiry(9429712, unavailable).label, "Expiry unavailable");
    assert.equal(context.formatMarketListingExpiry(9429712, unavailable).expired, false);
    await assert.rejects(context.marketListingExpiryTime(14), /Server game clock is unavailable/);
  }
  const startup = server.slice(server.indexOf("const STARTUP_TASKS=["), server.indexOf("function mountStartupProgressPopup"));
  assert.match(startup, /key:"market"[^\n]+run:refreshMarketListings/);
  assert.match(block, /const gameNow = await marketListingGameNow\(\)/);
  // Ensure both independent runtime queries calculate the exact same clock expression.
  const goSource = fs.readFileSync(path.join(__dirname, "..", "market-bot", "main.go"), "utf8");
  const expression = /extract\(epoch from \(\(clock_timestamp\(\) at time zone 'UTC'\) - universe_time_timestamp\)\)/g;
  assert.equal((clockBlock.match(expression) || []).length, 1);
  assert.equal((goSource.match(expression) || []).length, 2);
  assert(!goSource.includes("down_time_accumulation"));
  console.log("Market clock regression: 14-day listing, active 3-day listings, fresh server reads, startup fetch, and unavailable-clock write protection passed.");
}
testClockBehavior().catch(error => { console.error(error); process.exitCode = 1; });
