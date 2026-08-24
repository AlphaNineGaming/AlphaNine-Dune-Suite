"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const normalizeStart = source.indexOf("function normalizeMarketBotExchangeRow");
const marketBotExchangesStart = source.indexOf("async function marketBotExchanges()", normalizeStart);
const discoveryStart = normalizeStart;
const discoveryEnd = source.indexOf("async function marketPostingStatus", discoveryStart);
const discovery = source.slice(discoveryStart, discoveryEnd);
const uiStart = source.indexOf("function fillMarketBotExchange");
const uiEnd = source.indexOf("function chooseMarketBotExchange", uiStart);
const ui = source.slice(uiStart, uiEnd);

assert(discoveryStart >= 0 && discoveryEnd > discoveryStart, "Market Bot Exchange discovery block is missing.");
assert(uiStart >= 0 && uiEnd > uiStart, "Market Bot Exchange selector renderer is missing.");
assert.match(discovery, /row\.name === "HarkoVillage_EX"[\s\S]*linkedInventoryCount <= 1/, "Harko must be selectable when its only missing structure is the Exchange inventory link.");
assert.match(discovery, /async function ensureMarketBotExchangeInventory[\s\S]*insert into dune\.inventories\(exchange_id\)/, "Harko first use must create a missing Exchange inventory.");
assert.match(discovery, /update dune\.dune_exchanges e[\s\S]*set inventory_id = selected\.id/, "Harko first use must save the resolved inventory on the Exchange row.");
assert.match(discovery, /lock table dune\.dune_exchanges, dune\.inventories/, "Harko inventory preparation must lock both affected tables transactionally.");
assert.match(discovery, /'movedListings', false/, "Harko inventory preparation must not move existing listings.");
assert.match(discovery, /options\.prepareInventory === true/, "Database mutation must require an explicit preparation option from a write workflow.");
assert.match(ui, /exchange\.selectable===true/, "The selector must enable a repairable Harko Exchange.");
assert.match(ui, /inventory prepared on use/, "The selector must explain Harko's one-time inventory preparation.");
assert(source.includes('requireUsableMarketBotExchange(exchangeName, { prepareInventory: true })'), "Guided Exchange switching must prepare Harko inventory before validation.");

const sandbox = {};
vm.runInNewContext(`${source.slice(normalizeStart, marketBotExchangesStart)}\nresult = normalizeMarketBotExchangeRow;`, sandbox);
const normalize = sandbox.result;
const base = {
  id: "25",
  name: "HarkoVillage_EX",
  savedInventoryId: "",
  linkedInventoryId: "",
  linkedInventoryCount: "0",
  savedInventoryRowCount: "0",
  savedInventoryExchangeId: "",
  accessPointCount: "1",
  listingCount: "2",
  nameCount: "1"
};
assert.deepEqual(
  { usable: normalize(base).usable, repairable: normalize(base).repairable, selectable: normalize(base).selectable },
  { usable: false, repairable: true, selectable: true },
  "A native Harko Exchange with only a missing inventory must remain selectable."
);
assert.equal(normalize({ ...base, linkedInventoryId: "601", linkedInventoryCount: "1" }).repairable, true, "One existing Harko-linked inventory must be repairable.");
assert.equal(normalize({ ...base, linkedInventoryCount: "2" }).selectable, false, "Ambiguous Harko inventories must remain blocked.");
assert.equal(normalize({ ...base, accessPointCount: "0" }).selectable, false, "Harko without an access point must remain blocked.");
assert.equal(normalize({ ...base, nameCount: "2" }).selectable, false, "Duplicate Harko Exchange names must remain blocked.");
assert.equal(normalize({ ...base, name: "Global" }).selectable, false, "Global must not gain automatic inventory creation.");
const ready = normalize({ ...base, savedInventoryId: "601", savedInventoryRowCount: "1", savedInventoryExchangeId: "25" });
assert.equal(ready.usable, true, "A fully linked Harko Exchange must remain usable.");
assert.equal(ready.inventoryId, "601");

console.log("Harko Exchange selection and first-use inventory preparation checks passed.");
