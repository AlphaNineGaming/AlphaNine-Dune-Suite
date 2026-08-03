const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const DISTRIBUTION_BOUNDS = Object.freeze({ minX: -457200, maxX: 355600, minY: -457200, maxY: 355600, sizeCm: 812800, centreX: -50800, centreY: -50800 });
const HAGGA_BASIN_RASTER_BOUNDS = Object.freeze({ minX: -456752.21, maxX: 354547.46, minY: -450630.14, maxY: 353821.95 });
const OUTPUT_SIZE = 1024;
const CACHE_SCHEMA_VERSION = 3;
const OPEN_SOURCE_DECOMPRESSOR_SHA256 = "5ac5e474887a110bcee8ec454df99c2f0133102cd54f74bb309868fdd7253db3";
const DISPLAY_GAMMA = 0.5;
const DUNE_STEAM_APP_ID = "1172710";
const ORIENTATIONS = Object.freeze([Object.freeze({ key: "source-top-max-y", label: "Source top = world maximum Y" })]);
const PROVENANCE = Object.freeze({
  localSource: "User-installed Dune Awakening server Tools.pak",
  boundsSource: "Authoritative IgwLevelBounds",
  orientationEvidence: "Icehunter was consulted only as independent evidence that source image top equals world maximum Y.",
  nonIncorporation: "No Icehunter project code, resource markers, CDN files, map tiles, icons, heatmap PNGs, or other external project assets were incorporated."
});
const RESOURCES = Object.freeze([
  Object.freeze({ key: "bauxite", name: "Bauxite", color: "#f0b98f", assetDir: "A_Survival_Aluminum", asset: "BP_A_Survival_Aluminum_HeatMap" }),
  Object.freeze({ key: "magnetite", name: "Magnetite", color: "#9aaabd", assetDir: "A_Survival_Iron", asset: "BP_A_Survival_Iron_HeatMap" }),
  Object.freeze({ key: "azurite", name: "Azurite", color: "#2f83ff", assetDir: "A_Survival_Copper", asset: "BP_A_Survival_Copper_HeatMap" }),
  Object.freeze({ key: "dolomite", name: "Dolomite", color: "#d7dda8", assetDir: "A_Survival_Carbon", asset: "BP_A_Survival_Carbon_HeatMap" }),
  Object.freeze({ key: "erythrite", name: "Erythrite", color: "#df5e78", assetDir: "A_Survival_Erythrite", asset: "BP_A_Survival_Erythrite_HeatMap" }),
  Object.freeze({ key: "jasmium", name: "Jasmium", color: "#a66bdd", assetDir: "A_Survival_Jasmium", asset: "BP_A_Survival_Jasmium_HeatMap" }),
  Object.freeze({ key: "basalt", name: "Basalt", color: "#77818f", assetDir: "A_Survival_Basalt", asset: "BP_A_Survival_Basalt_HeatMap" }),
  Object.freeze({ key: "cistanche", name: "Cistanche", color: "#e2b43e", assetDir: "A_Survival_Cistanche", asset: "BP_A_Survival_Cistanche_HeatMap" }),
  Object.freeze({ key: "primrose-field", name: "Primrose Field", color: "#ef7eb1", assetDir: "A_Survival_PrimroseField", asset: "BP_A_Survival_PrimroseField_HeatMap" }),
  Object.freeze({ key: "saguaro", name: "Saguaro", color: "#61b76d", assetDir: "A_Survival_Saguaro", asset: "BP_A_Survival_Saguaro_HeatMap" })
]);

function existingFile(candidate) {
  try { return candidate && fs.statSync(candidate).isFile() ? path.resolve(candidate) : ""; }
  catch { return ""; }
}

function existingDirectory(candidate) {
  try { return candidate && fs.statSync(candidate).isDirectory() ? path.resolve(candidate) : ""; }
  catch { return ""; }
}

function resolvePaksDirectory(candidate) {
  const selected = String(candidate || "").trim();
  if (!selected) return "";
  const root = path.resolve(selected);
  const candidates = [
    root,
    path.join(root, "DuneSandbox", "Content", "Paks"),
    path.join(root, "steamapps", "common", "DuneAwakening", "DuneSandbox", "Content", "Paks")
  ];
  for (const directory of candidates) {
    const resolved = existingDirectory(directory);
    if (resolved && existingFile(path.join(resolved, "Tools.pak"))) return resolved;
  }
  return "";
}

function validateSupportedPak(pakPath) {
  let handle;
  try {
    const size = fs.statSync(pakPath).size;
    if (size < 204) throw new Error("Tools.pak is too small to contain a supported footer.");
    handle = fs.openSync(pakPath, "r");
    const footer = Buffer.alloc(204);
    fs.readSync(handle, footer, 0, footer.length, size - footer.length);
    if (footer.readUInt32LE(0) !== 0x5a6f12e1 || footer.readInt32LE(4) !== 11) throw new Error("Tools.pak footer is not the supported Dune build format.");
  } catch (error) {
    if (/supported|too small/i.test(String(error.message || error))) throw error;
    throw new Error(`Tools.pak is unreadable: ${error.message || error}`);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function parseSteamLibraries(vdfPath) {
  const libraries = [];
  try {
    const text = fs.readFileSync(vdfPath, "utf8");
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) libraries.push(match[1].replace(/\\\\/g, "\\"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[resource-areas] Steam library metadata was unreadable: ${vdfPath}. ${error.message || error}`);
  }
  return libraries;
}

function findPaksDirectory(preferred = "") {
  const configured = String(preferred || process.env.ALPHANINE_DUNE_PAKS_DIR || "").trim();
  if (configured) {
    const direct = resolvePaksDirectory(configured);
    if (direct) return direct;
    throw new Error(`Tools.pak was not found under the selected game path: ${path.resolve(configured)}`);
  }
  const steamRoots = [
    process.env.PROGRAMFILES_X86 ? path.join(process.env.PROGRAMFILES_X86, "Steam") : "",
    "C:\\Program Files (x86)\\Steam",
    "D:\\SteamLibrary"
  ].filter(Boolean);
  const libraries = new Set(steamRoots);
  for (const root of steamRoots) for (const library of parseSteamLibraries(path.join(root, "steamapps", "libraryfolders.vdf"))) libraries.add(library);
  for (const library of libraries) {
    const candidate = path.join(library, "steamapps", "common", "DuneAwakening", "DuneSandbox", "Content", "Paks");
    if (existingFile(path.join(candidate, "Tools.pak"))) return path.resolve(candidate);
  }
  throw new Error("Dune Tools.pak was not found. Set ALPHANINE_DUNE_PAKS_DIR to the installed server or game Content/Paks directory.");
}

function findInstalledBuildId(paksDir, preferred = "") {
  const explicit = String(preferred || process.env.ALPHANINE_DUNE_BUILD_ID || "").trim();
  if (explicit) return explicit;
  let cursor = path.resolve(paksDir);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = path.join(cursor, `appmanifest_${DUNE_STEAM_APP_ID}.acf`);
    if (existingFile(manifest)) {
      const match = /"buildid"\s+"([^"]+)"/i.exec(fs.readFileSync(manifest, "utf8"));
      if (match && match[1].trim()) return match[1].trim();
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Installed Dune build ID was not found beside Tools.pak. Set ALPHANINE_DUNE_BUILD_ID or keep Steam appmanifest_${DUNE_STEAM_APP_ID}.acf with the installation.`);
}

function safeCacheSegment(value) {
  const normalized = String(value || "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Installed Dune build ID is empty or unsupported.");
  return normalized.slice(0, 80);
}

function cacheKeyForIdentity(identity) {
  const pakSha256 = String(identity?.pakSha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(pakSha256)) throw new Error("Tools.pak SHA-256 is missing or invalid.");
  return `build-${safeCacheSegment(identity.buildId)}-tools-${pakSha256}`;
}

function sourceIdentity(options = {}) {
  const paksDir = findPaksDirectory(options.paksDir);
  const sourcePak = path.join(paksDir, "Tools.pak");
  validateSupportedPak(sourcePak);
  const identity = {
    buildId: findInstalledBuildId(paksDir, options.buildId),
    pakSha256: fileSha256(sourcePak),
    pakPath: sourcePak,
    paksDir
  };
  identity.cacheKey = cacheKeyForIdentity(identity);
  return identity;
}

function cacheDirectory(cacheRoot, cacheKey) {
  if (!/^build-[a-z0-9._-]+-tools-[a-f0-9]{64}$/i.test(String(cacheKey || ""))) return "";
  return path.join(path.resolve(cacheRoot), cacheKey);
}

function findRepakExecutable(preferred = "", appDir = process.cwd()) {
  const resolvedAppDir = path.resolve(appDir);
  const unpackedAppDir = /app\.asar(?:[\\/]|$)/i.test(resolvedAppDir)
    ? resolvedAppDir.replace(/app\.asar(?=[\\/]|$)/i, "app.asar.unpacked")
    : "";
  const candidates = [
    preferred,
    process.env.ALPHANINE_REPAK_EXE,
    unpackedAppDir ? path.join(unpackedAppDir, "tools", "repak", "repak.exe") : "",
    path.join(resolvedAppDir, "tools", "repak", "repak.exe"),
    path.join(path.dirname(resolvedAppDir), "tools", "repak", "repak.exe")
  ];
  for (const candidate of candidates) {
    const resolved = existingFile(candidate);
    if (resolved) {
      const version = spawnSync(resolved, ["--version"], { encoding: "utf8", windowsHide: true });
      const match = /(?:repak_cli\s+)?(\d+)\.(\d+)\.(\d+)/.exec(String(version.stdout || version.stderr || ""));
      if (version.status === 0 && match && (Number(match[1]) > 0 || Number(match[2]) > 2 || (Number(match[2]) === 2 && Number(match[3]) >= 3))) return resolved;
    }
  }
  throw new Error("The packaged resource-area extraction helper was not found or is unsupported. Reinstall AlphaNine Dune Suite 1.0.83 or set ALPHANINE_REPAK_EXE to repak 0.2.3+. No Funcom assets are downloaded or bundled.");
}

function verifyOfflineDecompressor(repakExe) {
  const decompressor = path.join(path.dirname(path.resolve(repakExe)), "oo2core_9_win64.dll");
  if (!existingFile(decompressor)) {
    throw new Error("The packaged offline resource-area decompressor is missing. Reinstall AlphaNine Dune Suite 1.0.83. The Suite will not download a decompressor at runtime.");
  }
  if (fileSha256(decompressor).toLowerCase() !== OPEN_SOURCE_DECOMPRESSOR_SHA256) {
    throw new Error("The packaged offline resource-area decompressor failed its integrity check. Reinstall AlphaNine Dune Suite 1.0.83.");
  }
  return decompressor;
}

function compatiblePakCopy(source, destination, mountPoint) {
  const sourceSize = fs.statSync(source).size;
  const footerStart = sourceSize - 204;
  const sourceHandle = fs.openSync(source, "r");
  try {
    const footer = Buffer.alloc(204);
    fs.readSync(sourceHandle, footer, 0, footer.length, footerStart);
    if (footer.readUInt32LE(0) !== 0x5a6f12e1 || footer.readInt32LE(4) !== 11) throw new Error("Tools.pak footer is not the supported Dune build format.");
    const oldIndexOffset = Number(footer.readBigInt64LE(8));
    const oldIndexSize = Number(footer.readBigInt64LE(16));
    const indexEnd = oldIndexOffset + oldIndexSize;
    const mountBytes = Buffer.from(`${mountPoint}\0`, "utf8");
    const needle = Buffer.alloc(4 + mountBytes.length);
    needle.writeInt32LE(mountBytes.length, 0);
    mountBytes.copy(needle, 4);
    const scanStart = Math.max(0, oldIndexOffset - 1024 * 1024);
    const scan = Buffer.alloc(indexEnd - scanStart);
    fs.readSync(sourceHandle, scan, 0, scan.length, scanStart);
    const relative = scan.indexOf(needle);
    if (relative < 0) throw new Error("Tools.pak primary index could not be located.");
    const indexOffset = scanStart + relative;
    const indexSize = indexEnd - indexOffset;
    const sha1 = crypto.createHash("sha1");
    const chunk = Buffer.alloc(1024 * 1024);
    for (let position = indexOffset; position < indexEnd;) {
      const length = Math.min(chunk.length, indexEnd - position);
      fs.readSync(sourceHandle, chunk, 0, length, position);
      sha1.update(chunk.subarray(0, length));
      position += length;
    }
    fs.copyFileSync(source, destination);
    const output = fs.openSync(destination, "r+");
    try {
      fs.ftruncateSync(output, sourceSize + 17);
      const standardFooter = Buffer.concat([Buffer.alloc(17), footer]);
      standardFooter.writeBigInt64LE(BigInt(indexOffset), 25);
      standardFooter.writeBigInt64LE(BigInt(indexSize), 33);
      sha1.digest().copy(standardFooter, 41);
      fs.writeSync(output, standardFooter, 0, standardFooter.length, footerStart);
    } finally { fs.closeSync(output); }
  } finally { fs.closeSync(sourceHandle); }
}

function repakGet(repakExe, pakPath, entry) {
  const result = spawnSync(repakExe, ["get", pakPath, entry], { encoding: null, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not read ${entry}: ${Buffer.from(result.stderr || "").toString("utf8").trim() || `repak exited ${result.status}`}`);
  return Buffer.from(result.stdout || []);
}

function packageNames(asset) {
  let cursor = 0;
  const i32 = () => { const value = asset.readInt32LE(cursor); cursor += 4; return value; };
  const u32 = () => { const value = asset.readUInt32LE(cursor); cursor += 4; return value; };
  const skip = size => { cursor += size; };
  const string = () => {
    const length = i32();
    if (!length) return "";
    if (length > 0) { const value = asset.subarray(cursor, cursor + length - 1).toString("utf8"); cursor += length; return value; }
    const characters = -length;
    const value = asset.subarray(cursor, cursor + (characters - 1) * 2).toString("utf16le");
    cursor += characters * 2;
    return value;
  };
  if (u32() !== 0x9e2a83c1 || i32() !== -8) throw new Error("Heatmap asset has an unsupported Unreal package header.");
  skip(12); i32(); const customVersions = i32(); skip(customVersions * 20); i32(); string();
  const packageFlags = u32(); const nameCount = i32(); const nameOffset = i32();
  skip(8); if ((packageFlags & 0x80000000) === 0) string(); skip(8); i32(); i32(); i32(); i32();
  cursor = nameOffset;
  const names = [];
  for (let index = 0; index < nameCount; index += 1) { names.push(string()); skip(4); }
  return names;
}

function decodeHeatmap(asset, exportData) {
  const names = packageNames(asset);
  let cursor = 0;
  const i32 = () => { const value = exportData.readInt32LE(cursor); cursor += 4; return value; };
  const fname = () => { const index = i32(); const number = i32(); const base = names[index]; return number ? `${base}_${number - 1}` : base; };
  const decoded = {};
  while (cursor < exportData.length) {
    const name = fname();
    if (name === "None") break;
    const type = fname(); const size = i32(); i32();
    let innerType = "";
    if (type === "StructProperty") { fname(); cursor += 16; }
    else if (type === "ArrayProperty") innerType = fname();
    else if (type === "MapProperty") { fname(); fname(); }
    else if (type === "SetProperty") fname();
    else if (type === "ByteProperty" || type === "EnumProperty") fname();
    else if (type === "BoolProperty") cursor += 1;
    if (exportData[cursor++]) cursor += 16;
    const value = exportData.subarray(cursor, cursor + size);
    cursor += size;
    if ((name === "m_SizeX" || name === "m_SizeY") && type === "IntProperty" && size === 4) decoded[name] = value.readInt32LE(0);
    if (name === "m_Format" && (type === "ByteProperty" || type === "EnumProperty") && size === 8) decoded[name] = names[value.readInt32LE(0)];
    if (name === "m_Data" && type === "ArrayProperty" && innerType === "ByteProperty") {
      const count = value.readInt32LE(0);
      decoded[name] = Buffer.from(value.subarray(4, 4 + count));
    }
  }
  if (decoded.m_SizeX !== 1024 || decoded.m_SizeY !== 1024 || decoded.m_Format !== "PF_G8" || decoded.m_Data?.length !== 1024 * 1024) {
    throw new Error(`Heatmap validation failed: ${decoded.m_SizeX || "?"}x${decoded.m_SizeY || "?"} ${decoded.m_Format || "?"} ${decoded.m_Data?.length || 0} bytes.`);
  }
  return { width: decoded.m_SizeX, height: decoded.m_SizeY, pixels: decoded.m_Data };
}

function hexColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`Invalid resource colour ${value}.`);
  return [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16));
}

function sampleBilinear(source, width, height, x, y) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX); const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
  const dx = clampedX - x0; const dy = clampedY - y0;
  const top = source[y0 * width + x0] * (1 - dx) + source[y0 * width + x1] * dx;
  const bottom = source[y1 * width + x0] * (1 - dx) + source[y1 * width + x1] * dx;
  return Math.round(top * (1 - dy) + bottom * dy);
}

function displayAlphaForIntensity(intensity) {
  const normalized = Math.max(0, Math.min(255, Number(intensity) || 0)) / 255;
  return Math.round(Math.pow(normalized, DISPLAY_GAMMA) * 255);
}

function resampleToRaster(heatmap, color) {
  const [red, green, blue] = hexColor(color);
  const output = Buffer.alloc(OUTPUT_SIZE * OUTPUT_SIZE * 4);
  const targetWidth = HAGGA_BASIN_RASTER_BOUNDS.maxX - HAGGA_BASIN_RASTER_BOUNDS.minX;
  const targetHeight = HAGGA_BASIN_RASTER_BOUNDS.maxY - HAGGA_BASIN_RASTER_BOUNDS.minY;
  for (let row = 0; row < OUTPUT_SIZE; row += 1) {
    const topDown = (row + 0.5) / OUTPUT_SIZE;
    const worldY = HAGGA_BASIN_RASTER_BOUNDS.maxY - topDown * targetHeight;
    const worldYUnit = (worldY - DISTRIBUTION_BOUNDS.minY) / DISTRIBUTION_BOUNDS.sizeCm;
    const sourceYUnit = 1 - worldYUnit;
    const sourceY = sourceYUnit * heatmap.height - 0.5;
    for (let column = 0; column < OUTPUT_SIZE; column += 1) {
      const leftRight = (column + 0.5) / OUTPUT_SIZE;
      const worldX = HAGGA_BASIN_RASTER_BOUNDS.minX + leftRight * targetWidth;
      const sourceX = ((worldX - DISTRIBUTION_BOUNDS.minX) / DISTRIBUTION_BOUNDS.sizeCm) * heatmap.width - 0.5;
      const intensity = sampleBilinear(heatmap.pixels, heatmap.width, heatmap.height, sourceX, sourceY);
      const offset = (row * OUTPUT_SIZE + column) * 4;
      output[offset] = red; output[offset + 1] = green; output[offset + 2] = blue; output[offset + 3] = displayAlphaForIntensity(intensity);
    }
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodeRgbaPng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) rgba.copy(scanlines, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

function assetPath(resource, extension) {
  return `DuneSandbox/Content/Dune/Tools/HeatmapTool/Baking/${resource.assetDir}/${resource.asset}.${extension}`;
}

function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) { const length = fs.readSync(handle, chunk, 0, chunk.length, null); if (!length) break; hash.update(chunk.subarray(0, length)); }
  } finally { fs.closeSync(handle); }
  return hash.digest("hex");
}

function calibrationMetadata() {
  return { orientation: "source-top-max-y", orientationLabel: "Source top = world maximum Y", boundsAuthority: "IgwLevelBounds", distributionBounds: DISTRIBUTION_BOUNDS, rasterBounds: HAGGA_BASIN_RASTER_BOUNDS, outputSize: { width: OUTPUT_SIZE, height: OUTPUT_SIZE }, intensityLabel: "Heatmap intensity", displayTransfer: { type: "gamma", gamma: DISPLAY_GAMMA, zeroTransparent: true } };
}

function removeAlternateOrientationArtifacts(cacheRoot) {
  const root = path.resolve(cacheRoot);
  if (!existingDirectory(root)) return;
  const directories = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith(".")) directories.push(path.join(root, entry.name));
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".source-top-min-y.png")) fs.rmSync(path.join(directory, entry.name));
    }
  }
}

function statusForIdentity(cacheRoot, identity) {
  const activeCacheDir = cacheDirectory(cacheRoot, identity.cacheKey);
  let metadata = null;
  let metadataError = "";
  try { metadata = JSON.parse(fs.readFileSync(path.join(activeCacheDir, "metadata.json"), "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") metadataError = String(error?.message || error); }
  const missing = [];
  for (const resource of RESOURCES) for (const orientation of ORIENTATIONS) if (!existingFile(path.join(activeCacheDir, `${resource.key}.${orientation.key}.png`))) missing.push(`${resource.key}.${orientation.key}`);
  const metadataMatches = Boolean(
    metadata
    && metadata.schemaVersion === CACHE_SCHEMA_VERSION
    && metadata.cacheKey === identity.cacheKey
    && metadata.source?.gameBuildId === identity.buildId
    && metadata.source?.pakSha256 === identity.pakSha256
    && Array.isArray(metadata.resources)
    && metadata.resources.length === RESOURCES.length
  );
  return {
    ok: true,
    feature: "Experimental Resource Areas",
    available: metadataMatches && missing.length === 0,
    needsGeneration: !metadataMatches || missing.length > 0,
    cacheKey: identity.cacheKey,
    generatedAt: metadataMatches ? metadata.generatedAt || "" : "",
    source: { status: "ready", gameBuildId: identity.buildId, pak: "Tools.pak", pakPath: identity.pakPath, pakExists: existingFile(identity.pakPath) !== "", pakSha256: identity.pakSha256 },
    cache: { directory: path.resolve(cacheRoot), activeDirectory: activeCacheDir, schema: CACHE_SCHEMA_VERSION, hit: metadataMatches && missing.length === 0, missing: missing.length, metadataError },
    resources: RESOURCES,
    orientations: ORIENTATIONS,
    calibration: metadataMatches ? metadata.calibration : calibrationMetadata(),
    provenance: metadataMatches ? metadata.provenance : PROVENANCE,
    missing
  };
}

function unavailableStatus(error, cacheRoot, options = {}) {
  const selectedPath = String(options.paksDir || process.env.ALPHANINE_DUNE_PAKS_DIR || "").trim();
  const detectedGamePath = selectedPath ? path.resolve(selectedPath) : "";
  const possiblePakPath = detectedGamePath ? path.join(detectedGamePath, "Tools.pak") : "";
  return {
    ok: true,
    feature: "Experimental Resource Areas",
    available: false,
    needsGeneration: false,
    cacheKey: "",
    generatedAt: "",
    source: { status: "unavailable", error: String(error?.message || error || "Installed Tools.pak is unavailable."), detectedGamePath, pakPath: possiblePakPath, pakExists: existingFile(possiblePakPath) !== "" },
    cache: { directory: path.resolve(cacheRoot), activeDirectory: "", schema: CACHE_SCHEMA_VERSION, hit: false, missing: RESOURCES.length },
    resources: RESOURCES,
    orientations: ORIENTATIONS,
    calibration: calibrationMetadata(),
    provenance: PROVENANCE,
    missing: RESOURCES.map(resource => `${resource.key}.source-top-max-y`)
  };
}

function status(cacheRoot, options = {}) {
  try {
    const identity = options.identity || sourceIdentity(options);
    if (!identity.cacheKey) identity.cacheKey = cacheKeyForIdentity(identity);
    return statusForIdentity(cacheRoot, identity);
  } catch (error) {
    return unavailableStatus(error, cacheRoot, options);
  }
}

function prepareWritableCacheRoot(cacheRoot) {
  const root = path.resolve(cacheRoot);
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok", { encoding: "utf8", flag: "wx" });
    fs.rmSync(probe, { force: true });
    return root;
  } catch (error) {
    throw new Error(`Resource-area cache directory is not writable: ${root}. ${error.message || error}`);
  }
}

function generate(options = {}) {
  const cacheRoot = path.resolve(options.cacheDir || path.join(process.cwd(), "data", "experimental-resource-areas"));
  const identity = options.identity || sourceIdentity(options);
  if (!identity.cacheKey) identity.cacheKey = cacheKeyForIdentity(identity);
  const currentStatus = statusForIdentity(cacheRoot, identity);
  if (currentStatus.available) return { ok: true, reused: true, cacheDir: cacheDirectory(cacheRoot, identity.cacheKey), metadata: JSON.parse(fs.readFileSync(path.join(cacheDirectory(cacheRoot, identity.cacheKey), "metadata.json"), "utf8")) };
  const repakExe = findRepakExecutable(options.repakExe, options.appDir);
  verifyOfflineDecompressor(repakExe);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-resource-areas-"));
  const compatiblePak = path.join(tempDir, "Tools.pak");
  prepareWritableCacheRoot(cacheRoot);
  removeAlternateOrientationArtifacts(cacheRoot);
  const stagingDir = fs.mkdtempSync(path.join(cacheRoot, `.staging-${identity.cacheKey}-`));
  const targetDir = cacheDirectory(cacheRoot, identity.cacheKey);
  try {
    compatiblePakCopy(identity.pakPath, compatiblePak, "../../../DuneSandbox/Content/Dune/Tools/");
    for (const resource of RESOURCES) {
      const asset = repakGet(repakExe, compatiblePak, assetPath(resource, "uasset"));
      const exportData = repakGet(repakExe, compatiblePak, assetPath(resource, "uexp"));
      const heatmap = decodeHeatmap(asset, exportData);
      const rgba = resampleToRaster(heatmap, resource.color);
      fs.writeFileSync(path.join(stagingDir, `${resource.key}.source-top-max-y.png`), encodeRgbaPng(OUTPUT_SIZE, OUTPUT_SIZE, rgba));
    }
    const metadata = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      feature: "Experimental Resource Areas",
      cacheKey: identity.cacheKey,
      generatedAt: new Date().toISOString(),
      source: { gameBuildId: identity.buildId, pak: "Tools.pak", pakSha256: identity.pakSha256, buildRelationship: "DA_Survival_Period1DistributionGroup1.m_ResourceDistributionHeatMapData" },
      calibration: calibrationMetadata(),
      provenance: PROVENANCE,
      orientations: ORIENTATIONS,
      resources: RESOURCES.map(resource => ({ key: resource.key, name: resource.name, color: resource.color, sourceAsset: `/Game/Dune/Tools/HeatmapTool/Baking/${resource.assetDir}/${resource.asset}`, format: "1024x1024 PF_G8" }))
    };
    fs.writeFileSync(path.join(stagingDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    if (existingDirectory(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);
    return { ok: true, reused: false, cacheDir: targetDir, metadata };
  } finally {
    if (existingDirectory(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function overlayFile(cacheRoot, resourceKey, orientationKey, cacheKey) {
  if (!RESOURCES.some(resource => resource.key === resourceKey) || !ORIENTATIONS.some(orientation => orientation.key === orientationKey)) return "";
  const activeCacheDir = cacheDirectory(cacheRoot, cacheKey);
  return activeCacheDir ? existingFile(path.join(activeCacheDir, `${resourceKey}.${orientationKey}.png`)) : "";
}

module.exports = { DISTRIBUTION_BOUNDS, HAGGA_BASIN_RASTER_BOUNDS, OUTPUT_SIZE, ORIENTATIONS, RESOURCES, PROVENANCE, findPaksDirectory, findRepakExecutable, generate, status, overlayFile, _test: { CACHE_SCHEMA_VERSION, DISPLAY_GAMMA, DUNE_STEAM_APP_ID, OPEN_SOURCE_DECOMPRESSOR_SHA256, decodeHeatmap, displayAlphaForIntensity, resampleToRaster, encodeRgbaPng, validateSupportedPak, findInstalledBuildId, cacheKeyForIdentity, cacheDirectory, sourceIdentity, resolvePaksDirectory, prepareWritableCacheRoot, removeAlternateOrientationArtifacts, compatiblePakCopy, verifyOfflineDecompressor } };
