const fs = require("fs");
const https = require("https");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CATALOG_PATH = path.join(DATA_DIR, "dune-skills-catalog.json");
const ENTITY_URL = "https://cdn-hosted.gaming.tools/dune/data/en/entities.d.json";

function requestText(url, timeoutMs = 30000, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        "User-Agent": "AlphaNine-Dune-Suite skill catalog builder",
        "Accept": "*/*"
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        requestText(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1).then(resolve, reject);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.end();
  });
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
    if (!value || typeof value !== "object") hydrated[index] = value;
    else if (Array.isArray(value)) {
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
        } else if (type === "Object") hydrated[index] = Object(value[1]);
        else hydrated[index] = value;
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
      for (const key of Object.keys(value)) if (key !== "__proto__") object[key] = hydrate(value[key]);
    }
    return hydrated[index];
  }
  return hydrate(0);
}

function collectEntityObjects(root, out = [], seen = new Set()) {
  if (!root || typeof root !== "object" || seen.has(root)) return out;
  seen.add(root);
  if (Array.isArray(root)) {
    for (const entry of root) collectEntityObjects(entry, out, seen);
    return out;
  }
  if (Object.values(root).some((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")) out.push(root);
  for (const child of Object.values(root)) collectEntityObjects(child, out, seen);
  return out;
}

function stripTags(value = "") {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function titleCase(value = "") {
  return String(value || "")
    .replace(/^skills\//i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function normalizeSkill(entity) {
  const categories = Array.isArray(entity.categories) ? entity.categories.filter(Boolean) : [];
  const tree = String(entity.skillTree || titleCase(categories.find((entry) => /^skills\//i.test(entry)) || "") || "Unknown").trim();
  const type = String(entity.skillType || "").trim() || (/attribute/i.test(entity.tag || entity.id || "") ? "Attribute" : "Skill");
  const stats = Array.isArray(entity.stats)
    ? entity.stats.map((stat) => ({
      level: Number(stat.level) || 0,
      key: String(stat.key || ""),
      name: String(stat.name || stat.key || ""),
      type: String(stat.type || ""),
      value: stat.value,
      operation: String(stat.operation || ""),
      format: String(stat.format || "")
    })).filter((stat) => stat.name || stat.key)
    : [];
  return {
    id: String(entity.id || "").trim(),
    tag: String(entity.tag || "").trim(),
    name: String(entity.name || entity.displayName || entity.title || entity.id || "").trim(),
    tree,
    type,
    category: tree,
    categories,
    gridX: Number.isFinite(Number(entity.gridX)) ? Number(entity.gridX) : null,
    gridY: Number.isFinite(Number(entity.gridY)) ? Number(entity.gridY) : null,
    maxLevel: Math.max(1, Number(entity.maxLevel) || 1),
    costPerLevel: Array.isArray(entity.costPerLevel) ? entity.costPerLevel.map((value) => Number(value) || 0) : [],
    prerequisites: Array.isArray(entity.prerequisites) ? entity.prerequisites.map(String).filter(Boolean) : [],
    description: stripTags(entity.description || entity.detail || ""),
    stats,
    iconPath: String(entity.iconPath || ""),
    source: "gaming-tools-entities"
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = await requestText(ENTITY_URL);
  const parsed = parseSvelteDevalueJson(text);
  const entities = Array.isArray(parsed) ? parsed : collectEntityObjects(parsed);
  const skills = entities
    .filter((entity) => String(entity.mainCategoryId || entity.mainCategory || "").toLowerCase() === "skills")
    .map(normalizeSkill)
    .filter((skill) => skill.id && skill.name)
    .sort((a, b) => a.tree.localeCompare(b.tree) || a.gridY - b.gridY || a.gridX - b.gridX || a.name.localeCompare(b.name));
  const treeCounts = {};
  const typeCounts = {};
  for (const skill of skills) {
    treeCounts[skill.tree] = (treeCounts[skill.tree] || 0) + 1;
    typeCounts[skill.type] = (typeCounts[skill.type] || 0) + 1;
  }
  fs.writeFileSync(CATALOG_PATH, JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    sourceUrl: ENTITY_URL,
    totalSkills: skills.length,
    treeCounts,
    typeCounts,
    skills
  }, null, 2));
  console.log(`Wrote ${skills.length} skills to ${CATALOG_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
