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

console.log("Live market listings exclude claim, payout, history, and empty-item rows.");
