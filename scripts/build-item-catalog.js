const fs = require("fs");
const https = require("https");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const IMAGE_DIR = path.join(DATA_DIR, "gear-images");
const CATALOG_PATH = path.join(DATA_DIR, "dune-items-catalog.json");
const ENTITY_URL = "https://cdn-hosted.gaming.tools/dune/data/en/entities.d.json";
const CDN_BASE = "https://cdn-hosted.gaming.tools/dune";
const ALLOW_EMPTY = process.argv.includes("--allow-empty");
const GRADE_VALUES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Unique", "Unknown"];

function requestBuffer(url, timeoutMs = 30000, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        "User-Agent": "AlphaNine-Dune-Suite item catalog builder",
        "Accept": "*/*"
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        requestBuffer(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve({ body, contentType: String(res.headers["content-type"] || "") });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.end();
  });
}

function safeName(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "item";
}

function imageExt(url, contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("webp")) return ".webp";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("png")) return ".png";
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  } catch {}
  return ".png";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
    }
  }
  return "";
}

function stripTags(value = "") {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function titleCaseGearCategory(value = "") {
  return String(value || "")
    .replace(/^items\//, "")
    .split("/")
    .pop()
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function gearItemCategory(entity = {}) {
  const categories = Array.isArray(entity.categories) ? entity.categories : [];
  const primary = categories.find((entry) => /^items\/[^/]+$/i.test(entry)) || categories[0] || "";
  return titleCaseGearCategory(primary || entity.category || entity.categoryName || entity.mainCategoryName || entity.mainCategoryId || "");
}

function gearItemSubtype(entity = {}) {
  const categories = Array.isArray(entity.categories) ? entity.categories : [];
  const deepest = categories.slice().sort((a, b) => b.length - a.length)[0] || "";
  const subtype = titleCaseGearCategory(deepest);
  const category = gearItemCategory(entity);
  return subtype && subtype !== category ? subtype : firstString(entity.subtype, entity.subType, entity.type, entity.itemType, entity.subCategoryName, entity.subCategoryId);
}

function gearItemDetail(entity = {}) {
  const lines = [];
  if (entity.description) lines.push(stripTags(entity.description));
  if (Array.isArray(entity.stats) && entity.stats.length) {
    for (const stat of entity.stats) {
      if (!stat || stat.value == null) continue;
      lines.push(`${String(stat.name || stat.key || "Stat").replace(/:+$/, "")}: ${stat.value}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function normalizeGrade(...values) {
  const text = values.map((value) => firstString(value)).filter(Boolean).join(" ").toLowerCase();
  if (/\bunique\b/.test(text)) return "Unique";
  if (/\blegendary\b/.test(text)) return "Legendary";
  if (/\bepic\b/.test(text)) return "Epic";
  if (/\brare\b/.test(text)) return "Rare";
  if (/\buncommon\b/.test(text)) return "Uncommon";
  if (/\bcommon\b/.test(text)) return "Common";
  return "Unknown";
}

function emptyGradeCounts() {
  return Object.fromEntries(GRADE_VALUES.map((grade) => [grade, 0]));
}

function gradeCounts(items = []) {
  const counts = emptyGradeCounts();
  for (const item of items) counts[normalizeGrade(item.grade, item.rarity, item.quality, item.tier, item.itemGrade, item.itemRarity)] += 1;
  return counts;
}

function parseJsonResponse(response, url) {
  const text = response.body.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Empty response while fetching ${url}`);
  if (trimmed.startsWith("<")) {
    throw new Error(`Expected JSON from ${url}, but received HTML. The source may be blocked by a CDN challenge.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Could not parse JSON from ${url}: ${error.message}`);
  }
}

function parseSvelteDevalueJson(text) {
  const UNDEFINED = -1;
  const HOLE = -2;
  const NAN = -3;
  const POSITIVE_INFINITY = -4;
  const NEGATIVE_INFINITY = -5;
  const NEGATIVE_ZERO = -6;
  const SPARSE_ARRAY = -7;
  const values = JSON.parse(String(text || ""));
  const hydrated = new Array(values.length);
  function hydrate(index, strict = false) {
    if (index === UNDEFINED) return undefined;
    if (index === NAN) return NaN;
    if (index === POSITIVE_INFINITY) return Infinity;
    if (index === NEGATIVE_INFINITY) return -Infinity;
    if (index === NEGATIVE_ZERO) return -0;
    if (strict || typeof index !== "number") throw new Error("Invalid devalue reference.");
    if (index in hydrated) return hydrated[index];
    const value = values[index];
    if (!value || typeof value !== "object") {
      hydrated[index] = value;
    } else if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        const type = value[0];
        if (type === "Date") hydrated[index] = new Date(value[1]);
        else if (type === "Set") {
          const set = new Set();
          hydrated[index] = set;
          for (let i = 1; i < value.length; i++) set.add(hydrate(value[i]));
        } else if (type === "Map") {
          const map = new Map();
          hydrated[index] = map;
          for (let i = 1; i < value.length; i += 2) map.set(hydrate(value[i]), hydrate(value[i + 1]));
        } else if (type === "Object") {
          hydrated[index] = Object(value[1]);
        } else {
          hydrated[index] = value;
        }
      } else if (value[0] === SPARSE_ARRAY) {
        const sparse = new Array(value[1]);
        hydrated[index] = sparse;
        for (let i = 2; i < value.length; i += 2) sparse[value[i]] = hydrate(value[i + 1]);
      } else {
        const array = new Array(value.length);
        hydrated[index] = array;
        for (let i = 0; i < value.length; i++) if (value[i] !== HOLE) array[i] = hydrate(value[i]);
      }
    } else {
      const object = {};
      hydrated[index] = object;
      for (const key of Object.keys(value)) {
        if (key !== "__proto__") object[key] = hydrate(value[key]);
      }
    }
    return hydrated[index];
  }
  return hydrate(0);
}

function parseEntityFeed(response, url) {
  const text = response.body.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Empty response while fetching ${url}`);
  if (trimmed.startsWith("<")) {
    throw new Error(`Expected item data from ${url}, but received HTML. The source may be blocked by a CDN challenge.`);
  }
  try {
    return parseSvelteDevalueJson(trimmed);
  } catch (devalueError) {
    try {
      return parseJsonResponse(response, url);
    } catch {
      throw new Error(`Could not parse item feed from ${url}: ${devalueError.message}`);
    }
  }
}

function collectEntityObjects(root, out = [], seen = new Set()) {
  if (!root || typeof root !== "object" || seen.has(root)) return out;
  seen.add(root);
  if (Array.isArray(root)) {
    for (const entry of root) collectEntityObjects(entry, out, seen);
    return out;
  }
  if (Object.values(root).some((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
    out.push(root);
  }
  for (const value of Object.values(root)) {
    if (value && typeof value === "object") collectEntityObjects(value, out, seen);
  }
  return out;
}

function fieldText(entity) {
  return Object.entries(entity || {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}:${value}`)
    .join(" ")
    .toLowerCase();
}

function isLikelyItemEntity(entity) {
  const text = fieldText(entity);
  if (/\bmaincategoryid:items\b/.test(text)) return true;
  if (/\b(category|type|kind|path|class|asset|template)[^ ]*(item|weapon|armor|armour|resource|equipment|tool|vehicle|consumable|schematic|blueprint|material|module|component|placeable|building)/i.test(text)) return true;
  if (/\b(item|inventory|equipment|weapon|armor|resource|consumable|schematic|blueprint|material|module|component)[-_./\\]/i.test(text)) return true;
  return false;
}

function resolveImageUrl(entity) {
  const raw = firstString(
    entity.icon,
    entity.iconUrl,
    entity.image,
    entity.imageUrl,
    entity.thumbnail,
    entity.thumbnailUrl,
    entity.iconPath,
    entity.asset,
    entity.assetUrl
  );
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  try { return `${CDN_BASE}${raw.startsWith("/") ? raw : `/${raw}`}`; } catch { return ""; }
}

function normalizeItem(entity) {
  const id = firstString(entity.id, entity.key, entity.slug, entity.template, entity.assetName, entity.name);
  const name = firstString(entity.name, entity.displayName, entity.title, id);
  const category = gearItemCategory(entity);
  const subtype = gearItemSubtype(entity);
  const type = subtype || firstString(entity.type, entity.itemType, entity.subCategoryName, entity.subCategoryId);
  const tierValue = firstString(entity.tier, entity.itemTier, entity.level);
  const tier = tierValue && !/^tier\b/i.test(tierValue) ? `Tier ${tierValue}` : tierValue;
  const rarity = firstString(entity.rarity, entity.quality);
  const grade = normalizeGrade(entity.grade, rarity, entity.quality, tier, entity.itemGrade, entity.itemRarity);
  const detailUrl = id ? `https://dune.gaming.tools/items/${encodeURIComponent(id)}` : "";
  const imageUrl = resolveImageUrl(entity);
  return {
    id,
    name,
    category,
    type,
    subtype,
    tier,
    rarity,
    grade,
    detail: gearItemDetail(entity),
    detailUrl,
    imageUrl,
    imageLocalPath: "",
    maxStack: String(entity.maxStack || entity.stackSize || ""),
    hasDisplayName: Boolean(name && name !== id),
    spawnable: entity.spawnable !== false
  };
}

async function mapWithConcurrency(items, limit, worker) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }));
  return results;
}

async function attachImage(item) {
  if (!item.imageUrl) return { ...item, imageStatus: "missing" };
  const stem = safeName(`${item.id}-${Buffer.from(item.imageUrl).toString("hex").slice(0, 12)}`);
  const existing = fs.existsSync(IMAGE_DIR) ? fs.readdirSync(IMAGE_DIR).find((file) => file.startsWith(`${stem}.`)) : "";
  if (existing) return { ...item, imageLocalPath: `data/gear-images/${existing}`, imageStatus: "reused" };
  try {
    const result = await requestBuffer(item.imageUrl, 20000);
    const ext = imageExt(item.imageUrl, result.contentType);
    const fileName = `${stem}${ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, fileName), result.body);
    return { ...item, imageLocalPath: `data/gear-images/${fileName}`, imageStatus: "downloaded" };
  } catch (error) {
    return { ...item, imageStatus: "failed", imageError: error.message };
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const entityResponse = await requestBuffer(ENTITY_URL, 45000);
  const entities = parseEntityFeed(entityResponse, ENTITY_URL);
  const entityObjects = Array.isArray(entities) ? entities : collectEntityObjects(entities);
  const items = entityObjects
    .filter(isLikelyItemEntity)
    .map(normalizeItem)
    .filter((item) => item.id && item.name);
  if (!items.length && !ALLOW_EMPTY) {
    throw new Error(`No item entities were found in ${ENTITY_URL}. Refusing to overwrite the bundled catalog with an empty item list.`);
  }
  const withImages = await mapWithConcurrency(items, 4, attachImage);
  const catalog = {
    ok: true,
    generatedAt: new Date().toISOString(),
    version: require(path.join(ROOT, "package.json")).version,
    source: "build-time-catalog",
    items: withImages,
    report: {
      catalogPath: CATALOG_PATH,
      imageCacheDir: IMAGE_DIR,
      totalItemsFound: withImages.length,
      itemsWithDisplayNames: withImages.filter((item) => item.hasDisplayName).length,
      unknownOrUnclassifiedItems: withImages.filter((item) => !item.hasDisplayName || !item.category).length,
      totalImagesDownloaded: withImages.filter((item) => item.imageStatus === "downloaded").length,
      totalImagesReused: withImages.filter((item) => item.imageStatus === "reused").length,
      failedImageDownloads: withImages.filter((item) => item.imageStatus === "failed").length,
      missingImages: withImages.filter((item) => item.imageStatus === "missing").length,
      gradeCounts: gradeCounts(withImages)
    }
  };
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf8");
  console.log(JSON.stringify(catalog.report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
