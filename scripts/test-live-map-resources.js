const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Coordinates = require("../assets/coordinate-system");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dataset = JSON.parse(fs.readFileSync(path.join(root, "data", "dune-resource-spawn-locations.json"), "utf8"));

function functionSource(name) {
  const start = serverSource.indexOf(`function ${name}(`);
  assert(start >= 0, `Function ${name} is missing.`);
  const bodyStart = serverSource.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < serverSource.length; index += 1) {
    const char = serverSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return serverSource.slice(start, index + 1);
    }
  }
  throw new Error(`Function ${name} is incomplete.`);
}

assert.equal(dataset.schemaVersion, 2);
assert.equal(dataset.map, "HaggaBasin");
assert.equal(dataset.locations.length, 117);
assert.deepStrictEqual(
  dataset.locations.reduce((counts, row) => {
    counts[row.name] = (counts[row.name] || 0) + 1;
    return counts;
  }, {}),
  { "Flour Sand": 30, "Small Spice": 87 }
);
assert.equal(dataset.provenance.packagedFields, "Resource name and numeric X/Y/Z coordinates only.");
assert.match(dataset.provenance.semantics, /does not prove that a resource is currently active/i);

for (const [index, row] of dataset.locations.entries()) {
  assert.deepStrictEqual(Object.keys(row).sort(), ["name", "x", "y", "z"], `Dataset row ${index + 1} contains extra packaged fields.`);
  assert([row.x, row.y, row.z].every(Number.isFinite), `Dataset row ${index + 1} has invalid coordinates.`);
  assert(Coordinates.withinBounds(row, dataset.map), `Dataset row ${index + 1} is outside Hagga Basin bounds.`);
  const point = Coordinates.worldToMapPoint(row, dataset.map, { clamp: false });
  assert(point.px >= 0 && point.px <= Coordinates.MAP_CONFIGS.HaggaBasin.width);
  assert(point.py >= 0 && point.py <= Coordinates.MAP_CONFIGS.HaggaBasin.height);
  const roundTrip = Coordinates.mapPointToWorld(point, dataset.map);
  assert(Math.abs(roundTrip.x - row.x) < 0.000001 && Math.abs(roundTrip.y - row.y) < 0.000001, `Coordinate round trip failed for row ${index + 1}.`);
}

if (packageJson.build?.files) {
  assert.equal(packageJson.build.files.includes("data/dune-resource-spawn-locations.json"), true, "Resource dataset is not packaged.");
}
if (packageJson.scripts) {
  assert.equal(packageJson.scripts["test:live-map-resources"], "node scripts/test-live-map-resources.js");
}
assert.match(serverSource, /Known Resource Spawn Locations/);
assert.match(serverSource, /id="liveLayerResources" type="checkbox" onchange=/, "Resources layer control is missing or enabled by default.");
assert.doesNotMatch(serverSource, /id="liveLayerResources" type="checkbox" checked/, "Resources layer must remain disabled by default until alignment is approved.");
assert.match(serverSource, /id="liveResourceSmallSpice"/);
assert.match(serverSource, /id="liveResourceFlourSand"/);
assert.match(serverSource, /id="liveResourceSearch"/);
assert.match(serverSource, />Show All</);
assert.match(serverSource, />Hide All</);
assert.match(serverSource, /Possible spawn locations only\. A marker does not prove that a resource is currently active\./);
assert.doesNotMatch(serverSource, /resourcefield_state|field_kind_id|remaining[_-]?value|resource.*depleted|depleted.*resource/i, "Static spawn markers contain a live resource-state claim or join.");

const elements = {
  liveLayerResources: { checked: false },
  liveResourceSmallSpice: { checked: true },
  liveResourceFlourSand: { checked: true },
  liveResourceSearch: { value: "" },
  liveResourceSmallCount: { textContent: "" },
  liveResourceFlourCount: { textContent: "" },
  liveResourceShownCount: { textContent: "" }
};
const context = {
  document: { getElementById: (id) => elements[id] || null },
  liveMapData: {
    layers: {
      resources: [
        { id: "spice", type: "resource", resourceType: "small-spice", name: "Small Spice", map: "HaggaBasin", x: 101, y: 202, z: 303 },
        { id: "flour", type: "resource", resourceType: "flour-sand", name: "Flour Sand", map: "HaggaBasin", x: 404, y: 505, z: 606 },
        { id: "other-map", type: "resource", resourceType: "small-spice", name: "Small Spice", map: "DeepDesert", x: 707, y: 808, z: 909 }
      ]
    }
  },
  liveMapKey: "HaggaBasin",
  renderCalls: 0,
  renderLiveMapLayers() { this.renderCalls += 1; },
  setText(id, value) { if (elements[id]) elements[id].textContent = String(value); }
};
vm.createContext(context);
for (const name of ["liveMapChecked", "liveMapRowMatchesSelectedMap", "liveMapRowsForSelectedMap", "liveMapResourceRows", "renderLiveMapResourceCounts", "toggleKnownResourceLayer", "showAllKnownResources", "hideAllKnownResources"]) {
  vm.runInContext(functionSource(name), context);
}

assert.deepStrictEqual(Array.from(context.liveMapResourceRows(), (row) => row.id), ["spice", "flour"]);
elements.liveResourceFlourSand.checked = false;
assert.deepStrictEqual(Array.from(context.liveMapResourceRows(), (row) => row.id), ["spice"]);
elements.liveResourceFlourSand.checked = true;
elements.liveResourceSearch.value = "505";
assert.deepStrictEqual(Array.from(context.liveMapResourceRows(), (row) => row.id), ["flour"], "Coordinate search did not filter resources.");
elements.liveResourceSearch.value = "spice";
assert.deepStrictEqual(Array.from(context.liveMapResourceRows(), (row) => row.id), ["spice"], "Resource-name search did not filter resources.");
elements.liveResourceSearch.value = "";
context.renderLiveMapResourceCounts();
assert.equal(elements.liveResourceSmallCount.textContent, "1");
assert.equal(elements.liveResourceFlourCount.textContent, "1");
assert.equal(elements.liveResourceShownCount.textContent, "0 of 2 shown");
context.showAllKnownResources();
assert.equal(elements.liveLayerResources.checked, true);
assert.equal(elements.liveResourceSmallSpice.checked, true);
assert.equal(elements.liveResourceFlourSand.checked, true);
context.hideAllKnownResources();
assert.equal(elements.liveLayerResources.checked, false);
assert.equal(elements.liveResourceSmallSpice.checked, false);
assert.equal(elements.liveResourceFlourSand.checked, false);

const resourceMarkerSource = functionSource("addKnownResourceMarkers");
assert.match(resourceMarkerSource, /draggable:false/);
assert.match(resourceMarkerSource, /bubblingMouseEvents:false/);
assert.match(resourceMarkerSource, /L\.DomEvent\.stop/);
assert.match(resourceMarkerSource, /marker\.openPopup\(\)/, "Resource marker clicks do not explicitly open their coordinate popup.");
assert.doesNotMatch(resourceMarkerSource, /captureLiveMapMarkerAsTeleport|handleLiveMapDestinationClick|selectLiveCoordinates|liveMapSelectedEntity/, "Resource markers can enter the teleport path.");
const resourceCenterSource = functionSource("centerLiveMapResourceMarker");
assert.doesNotMatch(resourceCenterSource, /selectLiveCoordinates|teleport|liveMapSelectedEntity/i, "Resource table selection can populate a teleport target.");
assert.match(functionSource("liveMapResourcePopup"), /World X[\s\S]*World Y[\s\S]*World Z/);
assert.match(functionSource("liveMapResourceClusterRows"), /bucketSize/);

console.log("Static Live Map resource dataset, filtering, bounds, clustering, popup, and teleport-isolation tests passed.");
