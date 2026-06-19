(function coordinateSystemModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AlphaNineCoordinates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCoordinateSystem() {
  "use strict";

  const IMAGE_SIZE = Object.freeze({ width: 4096, height: 4096 });
  const MAP_CONFIGS = Object.freeze({
    HaggaBasin: Object.freeze({ key: "HaggaBasin", label: "Hagga Basin", minX: -456752.21, maxX: 354547.46, minY: -450630.14, maxY: 353821.95, flipX: false, flipY: true, width: 4096, height: 4096, defaultPartitionId: 1 }),
    DeepDesert: Object.freeze({ key: "DeepDesert", label: "Deep Desert", minX: -1268624.82, maxX: 1163312.83, minY: -1266548.17, maxY: 1162416.13, flipX: false, flipY: false, width: 4096, height: 4096, defaultPartitionId: 8 }),
    Arrakeen: Object.freeze({ key: "Arrakeen", label: "Arrakeen", minX: -32000, maxX: 17000, minY: -10000, maxY: 9500, flipX: false, flipY: true, width: 4096, height: 4096, defaultPartitionId: 0 }),
    HarkoVillage: Object.freeze({ key: "HarkoVillage", label: "Harko Village", minX: -5000, maxX: 14500, minY: -5500, maxY: 32000, flipX: false, flipY: false, width: 4096, height: 4096, defaultPartitionId: 0 })
  });
  const SAFE_ELEVATION_SOURCES = Object.freeze(["manual-input", "location-preset", "player-position", "actor-transform", "live-map-drag"]);

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function mapConfig(mapOrConfig) {
    if (mapOrConfig && typeof mapOrConfig === "object") return { ...MAP_CONFIGS.HaggaBasin, ...mapOrConfig };
    return MAP_CONFIGS[String(mapOrConfig || "HaggaBasin")] || MAP_CONFIGS.HaggaBasin;
  }

  function clampUnit(value) {
    return Math.max(0, Math.min(1, value));
  }

  function withinBounds(point, mapOrConfig) {
    const cfg = mapConfig(mapOrConfig);
    const x = finiteNumber(point && point.x);
    const y = finiteNumber(point && point.y);
    return x !== null && y !== null && x >= cfg.minX && x <= cfg.maxX && y >= cfg.minY && y <= cfg.maxY;
  }

  function worldToNormalized(point, mapOrConfig, options) {
    const cfg = mapConfig(mapOrConfig);
    const x = finiteNumber(point && point.x);
    const y = finiteNumber(point && point.y);
    if (x === null || y === null) throw new Error("World X/Y must be finite numbers.");
    const rawX = (x - cfg.minX) / (cfg.maxX - cfg.minX);
    const rawY = (y - cfg.minY) / (cfg.maxY - cfg.minY);
    const normalized = {
      x: cfg.flipX ? 1 - rawX : rawX,
      y: cfg.flipY ? 1 - rawY : rawY
    };
    if (options && options.clamp === true) {
      normalized.x = clampUnit(normalized.x);
      normalized.y = clampUnit(normalized.y);
    }
    return normalized;
  }

  function normalizedToWorld(point, mapOrConfig) {
    const cfg = mapConfig(mapOrConfig);
    const normalizedX = finiteNumber(point && point.x);
    const normalizedY = finiteNumber(point && point.y);
    if (normalizedX === null || normalizedY === null) throw new Error("Normalized X/Y must be finite numbers.");
    const rawX = cfg.flipX ? 1 - normalizedX : normalizedX;
    const rawY = cfg.flipY ? 1 - normalizedY : normalizedY;
    return {
      x: rawX * (cfg.maxX - cfg.minX) + cfg.minX,
      y: rawY * (cfg.maxY - cfg.minY) + cfg.minY
    };
  }

  function worldToMapPoint(point, mapOrConfig, options) {
    const cfg = mapConfig(mapOrConfig);
    const normalized = worldToNormalized(point, cfg, options);
    return {
      px: normalized.x * Number(cfg.width || IMAGE_SIZE.width),
      py: normalized.y * Number(cfg.height || IMAGE_SIZE.height),
      normalizedX: normalized.x,
      normalizedY: normalized.y
    };
  }

  function mapPointToWorld(point, mapOrConfig) {
    const cfg = mapConfig(mapOrConfig);
    const px = finiteNumber(point && (point.px ?? point.x));
    const py = finiteNumber(point && (point.py ?? point.y));
    if (px === null || py === null) throw new Error("Map pixel X/Y must be finite numbers.");
    return normalizedToWorld({
      x: px / Number(cfg.width || IMAGE_SIZE.width),
      y: py / Number(cfg.height || IMAGE_SIZE.height)
    }, cfg);
  }

  function resolveElevation(candidate) {
    const source = String(candidate && candidate.source || "unknown").trim() || "unknown";
    const z = finiteNumber(candidate && candidate.z);
    if (z === null || z === 0) return { safe: false, z: null, source, reason: "Z/elevation is unknown." };
    if (!SAFE_ELEVATION_SOURCES.includes(source)) return { safe: false, z, source, reason: "Z/elevation source is not trusted." };
    if (source === "manual-input" && candidate.confirmed !== true) return { safe: false, z, source, reason: "Manual Z/elevation has not been confirmed." };
    return { safe: true, z, source, reason: "" };
  }

  function diagnostics(point, mapOrConfig) {
    const cfg = mapConfig(mapOrConfig);
    const world = { x: finiteNumber(point && point.x), y: finiteNumber(point && point.y), z: finiteNumber(point && point.z) };
    const projected = world.x === null || world.y === null ? null : worldToMapPoint(world, cfg, { clamp: false });
    return {
      world,
      mapPoint: projected,
      withinBounds: withinBounds(world, cfg),
      map: cfg.key,
      bounds: { minX: cfg.minX, maxX: cfg.maxX, minY: cfg.minY, maxY: cfg.maxY, flipX: Boolean(cfg.flipX), flipY: Boolean(cfg.flipY), width: cfg.width, height: cfg.height }
    };
  }

  return Object.freeze({ IMAGE_SIZE, MAP_CONFIGS, SAFE_ELEVATION_SOURCES, finiteNumber, mapConfig, withinBounds, worldToNormalized, normalizedToWorld, worldToMapPoint, mapPointToWorld, resolveElevation, diagnostics });
});
