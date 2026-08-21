"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
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

const exchangeDiscoveryStart = server.indexOf("async function marketBotExchanges()");
const exchangeDiscoveryEnd = server.indexOf("async function marketPostingStatus", exchangeDiscoveryStart);
const exchangeDiscovery = server.slice(exchangeDiscoveryStart, exchangeDiscoveryEnd);
assert.ok(exchangeDiscoveryStart >= 0 && exchangeDiscoveryEnd > exchangeDiscoveryStart, "Could not isolate Market Bot Exchange discovery.");
assert.ok(exchangeDiscovery.includes("from dune.dune_exchanges e") && exchangeDiscovery.includes("dune.dune_exchange_accesspoints"), "Exchange choices must come from the live game database and verify access points.");
assert.ok(exchangeDiscovery.includes("inventoryConfigured") && exchangeDiscovery.includes("nameCount === 1"), "Unusable or ambiguous Exchanges must not be selectable.");

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
  "The live listings tracker must remain read-only."
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
assert.ok(!renderBlock.includes("Buy & Pay") && !renderBlock.includes("Remove</button>"), "Live listings rows must not expose destructive actions.");

console.log("Live market listings exclude claim, payout, history, and empty-item rows.");
