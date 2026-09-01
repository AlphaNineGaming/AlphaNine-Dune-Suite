"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server.js");
const source = fs.readFileSync(serverPath, "utf8");
const start = source.indexOf("function itemClassificationText");
const end = source.indexOf("function recipeCategory", start);
assert(start >= 0 && end > start, "Could not locate schematic routing helpers in server.js.");

const context = {};
vm.runInNewContext(
  `${source.slice(start, end)}
  this.routing = {
    isRecipeSchematicItem,
    dynamicGiveItemsWithoutSpawnableSchematicDuplicates
  };`,
  context
);

const physicalSchematic = {
  id: "SandcrawlerSpiceContainer_Unique_Capacity_6_Schematic",
  name: "Upgraded Regis Spice Container Schematic",
  category: "Schematics",
  subtype: "Schematic Item",
  source: "manager-catalog",
  spawnable: true
};
const physicalSchematicFromAnyCatalog = {
  ...physicalSchematic,
  source: "bundled"
};
const installedGameSchematic = {
  ...physicalSchematic,
  id: "B1C4_Unique_SMG2_Schematic",
  name: "Spitting Cobra Schematic",
  source: "installed-game"
};
const matchingRecipeUnlock = {
  id: "recipe:SandcrawlerSpiceContainer_Unique_Capacity_6_Recipe",
  recipeId: "SandcrawlerSpiceContainer_Unique_Capacity_6_Recipe",
  name: "Sandcrawler Spice Container Unique Capacity 6",
  category: "Schematics",
  source: "Live DB Known Recipes"
};
const recipeOnlyUnlock = {
  id: "recipe:Server_Only_Recipe",
  recipeId: "Server_Only_Recipe",
  name: "Server Only",
  category: "Schematics",
  source: "Live DB Known Recipes"
};
const researchUnlock = {
  id: "tech:RCP_Server_Only_Recipe",
  name: "Server Only",
  category: "Schematics",
  source: "Live DB Research Tree"
};

assert.equal(context.routing.isRecipeSchematicItem(physicalSchematic), false, "Manager schematic must use inventory Live Give.");
assert.equal(context.routing.isRecipeSchematicItem(physicalSchematicFromAnyCatalog), false, "A physical _Schematic template must not be inferred as a database command.");
assert.equal(context.routing.isRecipeSchematicItem(installedGameSchematic), false, "An installed-game schematic must use inventory Live Give.");
assert.equal(context.routing.isRecipeSchematicItem(matchingRecipeUnlock), true, "Explicit recipe: records must remain database unlocks.");

const visible = context.routing.dynamicGiveItemsWithoutSpawnableSchematicDuplicates(
  [matchingRecipeUnlock, recipeOnlyUnlock, researchUnlock],
  [physicalSchematic]
);
assert.equal(visible.some((item) => item.id === matchingRecipeUnlock.id), false, "Duplicate recipe unlock must be hidden when its inventory schematic is spawnable.");
assert.equal(visible.some((item) => item.id === recipeOnlyUnlock.id), true, "A genuine recipe-only unlock must remain available.");
assert.equal(visible.some((item) => item.id === researchUnlock.id), true, "Research unlock entries must remain available.");

assert(source.includes('if(data?.status==="recipe-unlocked")return"Crafting recipe unlocked.";'), "Recipe unlock success is not mapped in the UI.");
assert(source.includes('if(data?.status==="research-unlocked")return"Research blueprint unlocked.";'), "Research unlock success is not mapped in the UI.");
assert(source.includes("const usesDirectDbUnlock=isTechKnowledgeItem(selectedAdminItem)||isRecipeSchematicItem(selectedAdminItem);"), "Database unlock controls still depend on receiver availability.");

console.log("Schematic Give Item routing regression tests passed.");
