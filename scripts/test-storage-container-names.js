"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

assert.match(source, /from dune\.permission_actor pa[\s\S]+pa\.actor_id = a\.id/);
assert.match(source, /name: customName \|\| typeName,\s+customName,\s+typeName/);
assert.match(source, /\["actorId", "inventoryId"[\s\S]+?"actorClass", "customName", "map"/);
assert.match(source, /\["status", "accountId"[\s\S]+?"actorClass", "customName", "map"/);
assert.match(source, /\[row\.name,row\.customName,row\.typeName,row\.kind/);

const start = source.indexOf("function giveStorageLabel");
const end = source.indexOf("function renderGiveStorageTargets", start);
assert(start >= 0 && end > start, "Could not locate the storage picker label helper.");

const context = {};
vm.runInNewContext(`${source.slice(start, end)} this.giveStorageLabel = giveStorageLabel;`, context);

assert.equal(
  context.giveStorageLabel({
    name: "Fuel Cells",
    customName: "Fuel Cells",
    typeName: "Medium Storage Container",
    actorId: "42",
    itemCount: 12,
    maxItemCount: 50
  }),
  "Fuel Cells / Medium Storage Container / Actor 42 / 12 of 50 slots"
);

assert.equal(
  context.giveStorageLabel({
    name: "Spice Silo",
    customName: "",
    typeName: "Spice Silo",
    actorId: "84",
    itemCount: 1,
    maxItemCount: 20
  }),
  "Spice Silo / Actor 84 / 1 of 20 slots"
);

console.log("Storage container custom-name regression tests passed.");
