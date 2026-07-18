const fs = require("fs");
const path = require("path");

const PACK_MANIFEST_NAMES = ["blueprint-model-pack.json", "manifest.json", "models.json"];
const MAX_MODEL_FILES = 10000;

function normalizePieceKey(value) {
  return String(value || "")
    .replace(/\.glb$/i, "")
    .replace(/^SM[_-]Env[_-]PB[_-]/i, "")
    .replace(/atreides/ig, "atre")
    .replace(/harkonnen/ig, "hark")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function safeRelativePath(value) {
  const relative = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative || relative.includes("\0") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Model manifest contains an invalid file path.");
  }
  if (!/\.glb$/i.test(relative)) throw new Error(`Model file must use the .glb extension: ${relative}`);
  return relative;
}

function modelRowsFromManifest(manifest) {
  const rows = [];
  for (const source of [manifest?.models, manifest?.pieces, manifest?.mappings]) {
    if (!source) continue;
    if (Array.isArray(source)) {
      for (const row of source) {
        const type = row?.type || row?.building_type || row?.buildingType || row?.name || row?.id;
        const file = row?.file || row?.path || row?.model || row?.url;
        if (type && file) rows.push({ type: String(type), file: safeRelativePath(file) });
      }
    } else if (typeof source === "object") {
      for (const [type, value] of Object.entries(source)) {
        const file = typeof value === "string" ? value : value?.file || value?.path || value?.model || value?.url;
        if (file) rows.push({ type, file: safeRelativePath(file) });
      }
    }
  }
  return rows;
}

function walkGlbFiles(rootDir) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && /\.glb$/i.test(entry.name)) {
        files.push({
          fullPath,
          relative: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
          size: fs.statSync(fullPath).size
        });
        if (files.length > MAX_MODEL_FILES) throw new Error(`Model pack exceeds ${MAX_MODEL_FILES.toLocaleString()} GLB files.`);
      }
    }
  };
  visit(rootDir);
  return files;
}

function readSourceManifest(sourceDir) {
  const name = PACK_MANIFEST_NAMES.find((candidate) => fs.existsSync(path.join(sourceDir, candidate)));
  if (!name) return { name: "", manifest: null };
  try {
    return { name, manifest: JSON.parse(fs.readFileSync(path.join(sourceDir, name), "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    throw new Error(`Could not read ${name}: ${error.message}`);
  }
}

function buildRegistry(packDir, manifest) {
  const files = walkGlbFiles(packDir);
  const available = new Map(files.map((row) => [row.relative.toLowerCase(), row.relative]));
  const registry = new Map();
  const register = (type, file) => {
    const key = normalizePieceKey(type);
    const relative = available.get(safeRelativePath(file).toLowerCase());
    if (!relative) throw new Error(`Model manifest references a missing GLB file: ${file}`);
    if (key && !registry.has(key)) registry.set(key, relative);
  };
  for (const row of modelRowsFromManifest(manifest || {})) register(row.type, row.file);
  for (const row of files) {
    const base = path.basename(row.relative, path.extname(row.relative));
    const aliases = [base, base.replace(/^SM[_-]Env[_-]PB[_-]/i, "")];
    for (const alias of aliases) {
      const key = normalizePieceKey(alias);
      if (key && !registry.has(key)) registry.set(key, row.relative);
    }
  }
  return { files, registry };
}

function createBlueprintModelPack(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.cwd());
  const packDir = path.join(dataDir, "blueprint-model-pack");
  const installedManifestPath = path.join(packDir, "blueprint-model-pack.json");
  const bundledDir = path.resolve(options.bundledDir || path.join(__dirname, "..", "assets", "blueprint-models"));
  const bundledManifestPath = path.join(bundledDir, "manifest.json");
  let bundledCache = null;

  function loadBundled() {
    if (bundledCache) return bundledCache;
    if (!fs.existsSync(bundledManifestPath)) return { manifest: null, files: [], registry: new Map() };
    const manifest = JSON.parse(fs.readFileSync(bundledManifestPath, "utf8").replace(/^\uFEFF/, ""));
    bundledCache = { manifest, ...buildRegistry(bundledDir, manifest) };
    return bundledCache;
  }

  function loadInstalled() {
    if (!fs.existsSync(packDir)) return { manifest: null, files: [], registry: new Map() };
    let manifest = null;
    if (fs.existsSync(installedManifestPath)) {
      manifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8").replace(/^\uFEFF/, ""));
    }
    return { manifest, ...buildRegistry(packDir, manifest) };
  }

  function status() {
    try {
      const installed = loadInstalled();
      const bundled = loadBundled();
      return {
        ok: true,
        installed: installed.files.length > 0 || bundled.files.length > 0,
        exactBundled: bundled.files.length > 0,
        modelCount: bundled.files.length + installed.files.length,
        mappingCount: Object.keys(bundled.manifest?.mappings || bundled.manifest?.models || {}).length + Object.keys(installed.manifest?.models || {}).length,
        totalBytes: [...bundled.files, ...installed.files].reduce((sum, row) => sum + row.size, 0),
        installedAt: installed.manifest?.installedAt || "",
        packName: bundled.files.length ? "Exact Offline Blueprint Models" : (installed.manifest?.name || "Offline Blueprint Models"),
        packDir
      };
    } catch (error) {
      return { ok: false, installed: false, modelCount: 0, mappingCount: 0, totalBytes: 0, packDir, error: error.message };
    }
  }

  function importFromDirectory(sourceValue) {
    const sourceDir = path.resolve(String(sourceValue || "").trim());
    if (!sourceValue || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error("Choose a valid model-pack folder.");
    }
    if (sourceDir === packDir || sourceDir.startsWith(`${packDir}${path.sep}`)) throw new Error("Choose the source model-pack folder, not the Suite storage folder.");
    const sourceFiles = walkGlbFiles(sourceDir);
    if (!sourceFiles.length) throw new Error("The selected folder contains no .glb model files.");
    const sourceManifest = readSourceManifest(sourceDir);
    const stagingDir = path.join(dataDir, `blueprint-model-pack-staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const backupDir = `${packDir}-backup-${Date.now()}`;
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      for (const row of sourceFiles) {
        const destination = path.join(stagingDir, ...row.relative.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(row.fullPath, destination);
      }
      const manifest = {
        version: 1,
        name: String(sourceManifest.manifest?.name || path.basename(sourceDir) || "Offline Blueprint Models"),
        installedAt: new Date().toISOString(),
        models: Object.fromEntries(modelRowsFromManifest(sourceManifest.manifest || {}).map((row) => [row.type, row.file]))
      };
      fs.writeFileSync(path.join(stagingDir, "blueprint-model-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      buildRegistry(stagingDir, manifest);
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(packDir)) fs.renameSync(packDir, backupDir);
      fs.renameSync(stagingDir, packDir);
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      return status();
    } catch (error) {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      if (!fs.existsSync(packDir) && fs.existsSync(backupDir)) fs.renameSync(backupDir, packDir);
      throw error;
    }
  }

  function resolveTypes(types) {
    const installed = loadInstalled();
    const bundled = loadBundled();
    const models = {};
    for (const value of [...new Set((Array.isArray(types) ? types : []).map((type) => String(type || "")).filter(Boolean))].slice(0, 5000)) {
      const key = normalizePieceKey(value);
      const customRelative = installed.registry.get(key);
      const bundledRelative = bundled.registry.get(key);
      if (customRelative) models[value] = `/api/blueprint-models/files/${customRelative.split("/").map(encodeURIComponent).join("/")}`;
      else if (bundledRelative) models[value] = `/assets/blueprint-models/${bundledRelative.split("/").map(encodeURIComponent).join("/")}`;
    }
    return { ok: true, installed: installed.files.length > 0 || bundled.files.length > 0, exactBundled: bundled.files.length > 0, models, requestedCount: Array.isArray(types) ? types.length : 0, matchedCount: Object.keys(models).length };
  }

  function resolveFile(requestPath) {
    if (!fs.existsSync(packDir)) return null;
    let relative = "";
    try {
      relative = decodeURIComponent(String(requestPath || "")).replace(/^\/+/, "").replace(/\\/g, "/");
    } catch {
      return null;
    }
    if (!/\.glb$/i.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
    const fullPath = path.resolve(packDir, ...relative.split("/"));
    if (!fullPath.startsWith(`${path.resolve(packDir)}${path.sep}`) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
    return fullPath;
  }

  return { packDir, status, importFromDirectory, resolveTypes, resolveFile };
}

module.exports = { createBlueprintModelPack, normalizePieceKey, modelRowsFromManifest };
