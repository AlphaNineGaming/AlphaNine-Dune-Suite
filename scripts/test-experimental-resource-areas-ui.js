"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const startMarker = "// EXPERIMENTAL_RESOURCE_AREAS_CLIENT_START";
const endMarker = "// EXPERIMENTAL_RESOURCE_AREAS_CLIENT_END";
const start = serverSource.indexOf(startMarker);
const end = serverSource.indexOf(endMarker, start);
assert(start >= 0 && end > start, "Experimental Resource Areas client block was not found.");
const clientSource = serverSource.slice(start + startMarker.length, end);

const resources = [
  ["bauxite", "Bauxite", "#f0b98f"],
  ["magnetite", "Magnetite", "#9aaabd"],
  ["azurite", "Azurite", "#2f83ff"],
  ["dolomite", "Dolomite", "#d7dda8"],
  ["erythrite", "Erythrite", "#df5e78"],
  ["jasmium", "Jasmium", "#a66bdd"],
  ["basalt", "Basalt", "#77818f"],
  ["cistanche", "Cistanche", "#e2b43e"],
  ["primrose-field", "Primrose Field", "#ef7eb1"],
  ["saguaro", "Saguaro", "#61b76d"]
].map(([key, name, color]) => ({ key, name, color }));

function classList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach(item => values.add(item)),
    remove: (...items) => items.forEach(item => values.delete(item)),
    toggle: (item, force) => {
      if (force === undefined ? !values.has(item) : force) values.add(item);
      else values.delete(item);
      return values.has(item);
    },
    contains: item => values.has(item)
  };
}

function createHarness(options = {}) {
  const storage = new Map();
  if (options.saved !== undefined) storage.set("alphanine.live.experimental-resource-areas.v1", JSON.stringify(options.saved));
  let inputs = [];
  let imageMode = options.imageMode || "load";
  let generateCalls = 0;
  const layers = new Set();
  const elements = {};
  const makeElement = (id, extra = {}) => elements[id] = Object.assign({ id, checked: false, value: "", textContent: "", className: "", disabled: false, style: { setProperty() {} }, classList: classList() }, extra);
  makeElement("liveLayerExperimentalResources", { checked: false });
  makeElement("liveExperimentalResourceOpacity", { value: "45" });
  makeElement("liveExperimentalResourceOpacityValue");
  makeElement("liveExperimentalResourceLegend");
  makeElement("liveExperimentalResourceStatus");
  makeElement("liveExperimentalResourceErrorActions");
  makeElement("liveExperimentalResourceRetry");
  makeElement("liveExperimentalResourceSelectFolder");
  makeElement("liveExperimentalResourceDiagnosticLog");
  makeElement("liveExperimentalResourceGenerate");
  const host = makeElement("liveExperimentalResourceFilters");
  Object.defineProperty(host, "innerHTML", {
    get() { return this._html || ""; },
    set(value) {
      this._html = String(value);
      inputs = Array.from(this._html.matchAll(/<input type="checkbox" value="([^"]+)"\s+(checked\s+)?onchange=/g), match => ({ value: match[1], checked: Boolean(match[2]) }));
    }
  });

  const status = options.status || {
    ok: true,
    available: true,
    needsGeneration: false,
    cacheKey: "build-test-tools-" + "a".repeat(64),
    generatedAt: "2026-08-02T00:00:00.000Z",
    source: { pakPath: "D:\\Dune\\DuneSandbox\\Content\\Paks\\Tools.pak", pakExists: true },
    cache: { directory: "C:\\Users\\Tester\\AppData\\Roaming\\AlphaNine\\resource-areas", schema: 3, hit: true, missing: 0 },
    resources,
    calibration: { distributionBounds: { minX: -457200, maxX: 355600, minY: -457200, maxY: 355600 } }
  };
  const generatedStatus = options.generatedStatus || {
    ...status,
    available: true,
    needsGeneration: false,
    cacheKey: status.cacheKey || "build-test-tools-" + "b".repeat(64),
    generatedAt: status.generatedAt || "2026-08-02T00:00:00.000Z",
    cache: { ...status.cache, hit: false, missing: 0 }
  };

  class FakeOverlay {
    constructor(url, bounds, overlayOptions) {
      this.url = url;
      this.bounds = bounds;
      this.options = overlayOptions;
      this.handlers = {};
      this.zIndex = null;
      this.opacity = overlayOptions.opacity;
    }
    on(event, callback) { this.handlers[event] = callback; return this; }
    setZIndex(value) { this.zIndex = value; return this; }
    setOpacity(value) { this.opacity = value; return this; }
    addTo(map) {
      map.layers.add(this);
      queueMicrotask(() => {
        if (imageMode === "error") this.handlers.error?.({ error: new Error("simulated image load failure") });
        else this.handlers.load?.();
      });
      return this;
    }
  }

  const context = {
    Array, Boolean, Date, Error, JSON, Map, Math, Number, Object, Promise, Set, String,
    console: { debug() {} }, encodeURIComponent, queueMicrotask,
    LIVE_EXPERIMENTAL_RESOURCE_SETTINGS_KEY: "alphanine.live.experimental-resource-areas.v1",
    liveExperimentalResourceStatus: options.initialStatus === undefined ? status : options.initialStatus,
    liveExperimentalResourceOverlays: new Map(),
    liveExperimentalResourceStatusPromise: null,
    liveExperimentalResourceGenerationPromise: null,
    liveExperimentalResourceRenderSerial: 0,
    liveExperimentalResourceDiagnostics: [],
    liveMapKey: "HaggaBasin",
    liveMap: { layers, hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer) },
    L: { imageOverlay: (url, bounds, overlayOptions) => new FakeOverlay(url, bounds, overlayOptions) },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    document: {
      getElementById: id => elements[id] || null,
      querySelectorAll: selector => selector.endsWith(":checked") ? inputs.filter(input => input.checked) : selector === "[data-experimental-resource] input" ? inputs : []
    },
    window: {},
    setText: (id, value) => { if (elements[id]) elements[id].textContent = String(value); },
    esc: value => String(value),
    betterError: error => String(error?.message || error || ""),
    playUiSound() {},
    liveMapChecked: id => Boolean(elements[id]?.checked),
    liveMapBounds: () => [[0, 0], [1024, 1024]],
    getJson: async (route, requestOptions = {}) => {
      if (route === "/api/live-map/resource-areas/status") return status;
      if (route === "/api/live-map/resource-areas/generate" && requestOptions.method === "POST") {
        generateCalls += 1;
        if (options.generationError) throw new Error(options.generationError);
        return generatedStatus;
      }
      throw new Error(`Unexpected route: ${route}`);
    }
  };
  vm.createContext(context);
  vm.runInContext(clientSource, context, { filename: "experimental-resource-areas-client.js" });
  if (context.liveExperimentalResourceStatus) context.renderExperimentalResourceControls();
  return {
    context, elements, storage, layers,
    inputs: () => inputs,
    generateCalls: () => generateCalls,
    setImageMode: value => { imageMode = value; }
  };
}

(async () => {
  {
    const harness = createHarness({ initialStatus: null, status: {
      ok: true, available: false, needsGeneration: true, cacheKey: "", generatedAt: "",
      source: { pakPath: "D:\\Dune\\DuneSandbox\\Content\\Paks\\Tools.pak", pakExists: true },
      cache: { directory: "C:\\Users\\Tester\\AppData\\Roaming\\AlphaNine\\resource-areas", schema: 3, hit: false, missing: 10 },
      resources, calibration: { distributionBounds: { minX: -457200, maxX: 355600, minY: -457200, maxY: 355600 } }
    } });
    harness.elements.liveLayerExperimentalResources.checked = true;
    const attached = await harness.context.toggleExperimentalResourceAreas(true);
    assert.equal(harness.generateCalls(), 1, "First click must start cache generation.");
    assert.equal(harness.inputs().filter(input => input.checked).length, 10, "First click must select all ten resource types.");
    assert.equal(attached, 10, "First click must attach all ten overlays.");
    assert.equal(harness.elements.liveExperimentalResourceStatus.textContent, "Resource areas ready.");
  }

  {
    const harness = createHarness({ saved: { opacity: 45, selected: ["jasmium", "azurite"] } });
    harness.elements.liveLayerExperimentalResources.checked = true;
    assert.equal(await harness.context.toggleExperimentalResourceAreas(true), 2, "Saved individual selections must be restored.");
    harness.elements.liveLayerExperimentalResources.checked = false;
    await harness.context.toggleExperimentalResourceAreas(false);
    assert.deepStrictEqual(harness.inputs().filter(input => input.checked).map(input => input.value), ["azurite", "jasmium"], "Master off must preserve individual selections.");
    harness.elements.liveLayerExperimentalResources.checked = true;
    assert.equal(await harness.context.toggleExperimentalResourceAreas(true), 2, "Master on must restore the preserved selections.");
    const bauxite = harness.inputs().find(input => input.value === "bauxite");
    bauxite.checked = true;
    assert.equal(await harness.context.changeExperimentalResourceFilter(), 3, "Individual filters must remain usable while enabled.");
  }

  {
    const missing = createHarness({ status: {
      ok: true, available: false, needsGeneration: false, cacheKey: "",
      source: { error: "Tools.pak was not found under the selected game path", detectedGamePath: "D:\\MissingDune", pakExists: false },
      cache: { directory: "C:\\Users\\Tester\\AppData\\Roaming\\AlphaNine\\resource-areas", schema: 3, hit: false, missing: 10 },
      resources, calibration: { distributionBounds: { minX: -457200, maxX: 355600, minY: -457200, maxY: 355600 } }
    } });
    missing.elements.liveLayerExperimentalResources.checked = true;
    await missing.context.toggleExperimentalResourceAreas(true);
    assert.match(missing.elements.liveExperimentalResourceStatus.textContent, /Tools\.pak was not found.*D:\\MissingDune/i);
    assert.equal(missing.elements.liveExperimentalResourceRetry.classList.contains("hidden"), false);
    assert.equal(missing.elements.liveExperimentalResourceSelectFolder.classList.contains("hidden"), false);
  }

  {
    const failed = createHarness({ generationError: "repak extraction failed safely", status: {
      ok: true, available: false, needsGeneration: true, cacheKey: "",
      source: { pakPath: "D:\\Dune\\DuneSandbox\\Content\\Paks\\Tools.pak", pakExists: true },
      cache: { directory: "C:\\Users\\Tester\\AppData\\Roaming\\AlphaNine\\resource-areas", schema: 3, hit: false, missing: 10 },
      resources, calibration: { distributionBounds: { minX: -457200, maxX: 355600, minY: -457200, maxY: 355600 } }
    } });
    failed.elements.liveLayerExperimentalResources.checked = true;
    await failed.context.toggleExperimentalResourceAreas(true);
    assert.match(failed.elements.liveExperimentalResourceStatus.textContent, /repak extraction failed safely/);
    assert.equal(failed.elements.liveExperimentalResourceRetry.classList.contains("hidden"), false, "Generation failure must show Retry.");
  }

  {
    const failedImages = createHarness({ imageMode: "error" });
    failedImages.elements.liveLayerExperimentalResources.checked = true;
    await failedImages.context.toggleExperimentalResourceAreas(true);
    assert.match(failedImages.elements.liveExperimentalResourceStatus.textContent, /10 of 10 resource overlay images failed to load/);
    assert.equal(failedImages.context.liveExperimentalResourceDiagnostics.filter(row => row.event === "image-load-failure").length, 10);
  }

  {
    const visible = createHarness({ saved: { opacity: 45, selected: ["jasmium"] } });
    visible.elements.liveLayerExperimentalResources.checked = true;
    assert.equal(await visible.context.toggleExperimentalResourceAreas(true), 1);
    const overlay = Array.from(visible.context.liveExperimentalResourceOverlays.values())[0];
    assert.equal(overlay.options.opacity, 0.45, "Default overlay opacity must be 45%.");
    assert.equal(overlay.options.interactive, false, "Resource areas must never become teleport targets.");
    assert(overlay.zIndex >= 300, "Resource areas need a visible map z-index.");
    assert.deepStrictEqual(Array.from(overlay.bounds[0]), [0, 0]);
    assert.equal(visible.context.liveExperimentalResourceDiagnostics.some(row => row.event === "render-complete" && row.attached === 1), true);
  }

  assert.doesNotMatch(clientSource, /catch\s*\([^)]*\)\s*\{\s*\}/, "Resource Areas client must not swallow errors in empty catch blocks.");
  assert.doesNotMatch(clientSource, /teleport|liveMapSelectedEntity|selectLiveCoordinates/i, "Resource overlays must remain isolated from teleport and player selection.");
  console.log("Experimental Resource Areas master toggle, saved filters, visible errors, image loading, opacity, z-index, and teleport isolation tests passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
