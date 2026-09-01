"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

let outboundRequests = 0;
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const originalHttpGet = http.get;
const originalHttpsGet = https.get;
const blocked = () => {
  outboundRequests += 1;
  throw new Error("Item catalog attempted an outbound network request.");
};
http.request = blocked;
https.request = blocked;
http.get = blocked;
https.get = blocked;

const {
  createItemCatalogProvider,
  isValidTemplateId,
  rawFallback
} = require("../lib/item-catalog-provider");

const root = path.resolve(__dirname, "..");
const bundledCatalogPath = path.join(root, "data", "dune-items-catalog.json");
const bundledImageDir = path.join(root, "data", "gear-images");
const managerCatalogPath = path.join(root, "manager", "dune-item-catalog.json");
const installedGameCatalogPath = path.join(root, "data", "dune-installed-items-catalog.json");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-offline-items-"));

function provider(name, legacyCachePath = path.join(temporaryRoot, name, "dune-items-cache.json")) {
  return createItemCatalogProvider({
    bundledCatalogPath,
    bundledImageDir,
    installedGameCatalogPath,
    managerCatalogPath,
    learnedCatalogPath: path.join(temporaryRoot, name, "server-discovered-items.json"),
    legacyCachePath
  });
}

try {
  // Clean install: there is no AppData cache and the bundled catalog must load immediately.
  const clean = provider("clean");
  const cleanSnapshot = clean.snapshot();
  assert.equal(cleanSnapshot.ok, true);
  assert.ok(cleanSnapshot.items.length >= 1747);
  assert.ok(cleanSnapshot.report.installedGameCatalogItems >= 3500);
  assert.ok(cleanSnapshot.report.installedGameCatalogSchematics >= 1200);
  const spittingCobra = clean.resolve("B1C4_Unique_SMG2_Schematic");
  assert.equal(spittingCobra.name, "Spitting Cobra Schematic");
  assert.equal(spittingCobra.source, "installed-game");
  const itemIds = cleanSnapshot.items.map((item) => item.id.toLowerCase());
  assert.equal(new Set(itemIds).size, itemIds.length, "Merged catalog contains duplicate item identifiers.");
  const categories = [...new Set(cleanSnapshot.items.map((item) => item.category).filter(Boolean))];
  const categoryKeys = categories.map((category) => category.replace(/[\s_-]+/g, "").toLowerCase());
  assert.equal(new Set(categoryKeys).size, categoryKeys.length, "Category menu contains duplicate spelling variants.");
  assert.ok(!categories.includes("Clothes") && !categories.includes("Meleeweapons") && !categories.includes("Rangedweapons") && !categories.includes("Vehicle"));
  assert.equal(cleanSnapshot.report.recoveredFromBundled, true);
  assert.equal(fs.existsSync(path.join(temporaryRoot, "clean", "dune-items-cache.json")), false);

  // A malformed installed cache is ignored and never replaced or rewritten.
  const malformedPath = path.join(temporaryRoot, "malformed", "dune-items-cache.json");
  fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
  const malformedBytes = Buffer.from("{ this cache belongs to the user and is malformed\n", "utf8");
  fs.writeFileSync(malformedPath, malformedBytes);
  const malformed = provider("malformed", malformedPath).snapshot();
  assert.ok(malformed.items.length >= 1747);
  assert.ok(malformed.report.legacyCacheError);
  assert.deepEqual(fs.readFileSync(malformedPath), malformedBytes);

  // Upgrade from 1.0.66: richer bundled metadata wins, while an unknown legacy ID remains visible.
  const known = cleanSnapshot.items.find((item) => item.source === "bundled" && item.name && item.id);
  assert.ok(known);
  const upgradePath = path.join(temporaryRoot, "upgrade", "dune-items-cache.json");
  fs.mkdirSync(path.dirname(upgradePath), { recursive: true });
  const upgradeDocument = {
    version: "1.0.66",
    items: [
      { id: known.id, name: "Do Not Replace Bundled Metadata", category: "Legacy" },
      { id: "Upgrade_Only_Template", name: "Upgrade Only Template", category: "Legacy retained" }
    ]
  };
  const upgradeBytes = Buffer.from(JSON.stringify(upgradeDocument, null, 2), "utf8");
  fs.writeFileSync(upgradePath, upgradeBytes);
  const upgradedProvider = provider("upgrade", upgradePath);
  const upgraded = upgradedProvider.snapshot();
  assert.equal(upgradedProvider.resolve(known.id).name, known.name);
  assert.equal(upgradedProvider.resolve("Upgrade_Only_Template").name, "Upgrade Only Template");
  assert.deepEqual(fs.readFileSync(upgradePath), upgradeBytes);

  // Read-only server observations add only unknown identifiers to the separate learned catalog.
  const learnResult = upgradedProvider.learn([
    { id: known.id, discoverySource: "player-inventory" },
    { id: "Atreides_Outpost_Column", discoverySource: "storage-inventory" }
  ]);
  assert.equal(learnResult.added, 1);
  const learned = upgradedProvider.resolve("Atreides_Outpost_Column");
  assert.equal(learned.name, "Atreides Outpost Column");
  assert.equal(learned.source, "server-discovered");
  assert.ok(learned.icon.startsWith("/gear-codex/"));

  // Give Item raw-ID fallback accepts a valid exact identifier without catalog metadata.
  assert.equal(isValidTemplateId("Manual_Unknown_Template"), true);
  const raw = rawFallback("Manual_Unknown_Template");
  assert.equal(raw.id, "Manual_Unknown_Template");
  assert.equal(raw.name, "Manual Unknown Template");
  assert.equal(raw.source, "raw-id");
  assert.equal(rawFallback("not valid with spaces"), null);

  // Loading/searching/sorting/filtering exercise the same metadata used by the Item Database UI.
  const searchable = upgradedProvider.snapshot({ refresh: true }).items;
  const query = String(known.name).slice(0, 5).toLowerCase();
  assert.ok(searchable.filter((item) => [item.name, item.id, item.category, item.type, item.tier, item.grade].join(" ").toLowerCase().includes(query)).length > 0);
  assert.equal(searchable.slice().sort((a, b) => a.name.localeCompare(b.name)).length, searchable.length);
  const category = searchable.find((item) => item.category)?.category;
  assert.ok(searchable.filter((item) => item.category === category).length > 0);

  // Every runtime icon is local, and every bundled gear image URL resolves to a packaged file.
  for (const item of searchable) {
    assert.ok(String(item.icon || "").startsWith("/"), `Non-local icon for ${item.id}: ${item.icon}`);
    assert.ok(!/^https?:\/\//i.test(String(item.icon || "")), `Remote icon for ${item.id}`);
    if (item.icon.startsWith("/gear-images/")) {
      const file = path.join(bundledImageDir, decodeURIComponent(item.icon.slice("/gear-images/".length)));
      assert.equal(fs.existsSync(file), true, `Missing local item icon: ${item.icon}`);
    } else if (item.icon.startsWith("/gear-codex/")) {
      const file = path.join(root, ...item.icon.replace(/^\//, "").split("/"));
      assert.equal(fs.existsSync(file), true, `Missing local generic icon: ${item.icon}`);
    }
  }

  // Runtime/provider source must not contain a removed catalog domain or network importer.
  for (const relative of ["server.js", "lib/item-catalog-provider.js", "lib/installed-game-item-catalog.js", "lib/item-server-discovery.js", "scripts/build-item-catalog.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.ok(!/gaming\.tools|awakening\.wiki/i.test(source), `${relative} still references a removed item-catalog domain.`);
  }
  assert.equal(outboundRequests, 0);

  console.log(JSON.stringify({
    ok: true,
    internetBlocked: true,
    outboundRequests,
    cleanInstallItems: cleanSnapshot.items.length,
    upgradeItems: upgraded.items.length,
    learnedAdded: learnResult.added,
    malformedCachePreserved: true,
    upgradeCachePreserved: true,
    rawIdFallback: raw.id
  }, null, 2));
} finally {
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
  http.get = originalHttpGet;
  https.get = originalHttpsGet;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
