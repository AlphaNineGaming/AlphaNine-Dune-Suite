"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");
const asar = require("@electron/asar");
const resourceAreas = require("../lib/experimental-resource-areas");

const root = path.resolve(__dirname, "..");
const outputDir = process.env.ALPHANINE_BUILD_OUTPUT_DIR || path.join(root, "installer-output");
const resourcesDir = path.join(outputDir, "win-unpacked", "resources");
const archive = path.join(resourcesDir, "app.asar");
const unpackedRepakDir = path.join(resourcesDir, "app.asar.unpacked", "tools", "repak");
const configuredPaks = process.env.ALPHANINE_TEST_DUNE_PAKS_DIR || process.env.ALPHANINE_DUNE_PAKS_DIR || "D:\\SteamLibrary\\steamapps\\common\\DuneAwakening\\DuneSandbox\\Content\\Paks";
const toolsPak = path.join(configuredPaks, "Tools.pak");

if (!fs.existsSync(archive)) throw new Error(`Packaged archive was not found: ${archive}`);
if (!fs.existsSync(toolsPak)) throw new Error(`The authorized local Tools.pak test source was not found: ${toolsPak}`);
for (const filename of ["repak.exe", "LICENSE-MIT", "LICENSE-APACHE", "README.md", "oo2core_9_win64.dll", "ooz-source/COPYING", "ooz-source/BUILD.md", "ooz-source/alphanine-oodle-abi-shim.cpp"]) {
  assert(fs.existsSync(path.join(unpackedRepakDir, filename)), `Packaged runtime is missing tools/repak/${filename} outside app.asar.`);
}
const packagedDecompressor = path.join(unpackedRepakDir, "oo2core_9_win64.dll");
const packagedDecompressorHash = crypto.createHash("sha256").update(fs.readFileSync(packagedDecompressor)).digest("hex");
assert.equal(packagedDecompressorHash, resourceAreas._test.OPEN_SOURCE_DECOMPRESSOR_SHA256, "The package is missing the approved open-source offline decompressor.");
assert.notEqual(packagedDecompressorHash, "6f5d41a7892ea6b2db420f2458dad2f84a63901c9a93ce9497337b16c195f457", "The package contains the proprietary downloader-provided Oodle DLL.");
const repakVersion = spawnSync(path.join(unpackedRepakDir, "repak.exe"), ["--version"], { encoding: "utf8", windowsHide: true });
assert.equal(repakVersion.status, 0, `Packaged repak helper failed: ${repakVersion.stderr || repakVersion.stdout}`);
assert.match(repakVersion.stdout || repakVersion.stderr, /0\.2\.3/);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-packaged-resource-areas-"));
const extracted = path.join(scratch, "app");
const dataDir = path.join(scratch, "app-data");
const cacheDir = path.join(dataDir, "experimental-resource-areas");
const port = 19500 + Math.floor(Math.random() * 300);
const httpsPort = port + 500;
asar.extractAll(archive, extracted);
fs.cpSync(unpackedRepakDir, path.join(extracted, "tools", "repak"), { recursive: true });

const packagedModule = require(path.join(extracted, "lib", "experimental-resource-areas.js"));
assert.equal(
  packagedModule.findRepakExecutable("", path.join(resourcesDir, "app.asar")),
  path.join(unpackedRepakDir, "repak.exe"),
  "The true packaged app.asar path must resolve repak.exe from app.asar.unpacked."
);

const child = spawn(process.execPath, [path.join(extracted, "server.js")], {
  cwd: extracted,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(httpsPort),
    ALPHANINE_DATA_DIR: dataDir,
    ALPHANINE_RESOURCE_AREA_CACHE: cacheDir,
    ALPHANINE_DUNE_PAKS_DIR: configuredPaks,
    ALPHANINE_REPAK_EXE: "",
    ALPHANINE_SKIP_MANAGER: "1",
    ALPHANINE_SKIP_STARTUP_SERVICES: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let stdout = "";
let stderr = "";
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited with ${child.exitCode}.\n${stdout}\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live-map/resource-areas/status`);
      if (response.ok) return response.json();
    } catch (error) {
      if (attempt === 149) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Packaged server did not become reachable.\n${stdout}\n${stderr}`);
}

function pngHasVisiblePixel(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const scanlines = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  assert.equal(scanlines.length, stride * height);
  for (let row = 0; row < height; row += 1) {
    assert.equal(scanlines[row * stride], 0, "Generated PNG unexpectedly uses a filtered scanline.");
    for (let alpha = row * stride + 4; alpha < (row + 1) * stride; alpha += 4) if (scanlines[alpha] > 0) return true;
  }
  return false;
}

(async () => {
  try {
    const initial = await waitForServer();
    assert.equal(initial.source?.pakPath, toolsPak, "Packaged runtime detected the wrong Tools.pak path.");
    assert.equal(initial.source?.pakExists, true);
    assert.equal(initial.cache?.directory, cacheDir, "Packaged runtime did not use the writable application-data cache.");
    assert.equal(initial.cache?.schema, 3);
    assert.equal(initial.cache?.hit, false, "A clean cache must begin with a cache miss.");
    assert.equal(initial.needsGeneration, true);

    const generatedResponse = await fetch(`http://127.0.0.1:${port}/api/live-map/resource-areas/generate`, { method: "POST" });
    const generated = await generatedResponse.json();
    assert.equal(generatedResponse.status, 200, `Packaged generation failed: ${JSON.stringify(generated)}`);
    assert.equal(generated.available, true);
    assert.equal(generated.cache?.schema, 3);
    assert.equal(generated.cache?.hit, true);
    assert.equal(generated.resources?.length, 10);
    assert.deepStrictEqual(generated.calibration?.distributionBounds, { minX: -457200, maxX: 355600, minY: -457200, maxY: 355600, sizeCm: 812800, centreX: -50800, centreY: -50800 });
    assert.equal(generated.calibration?.orientation, "source-top-max-y");
    assert(generated.cache?.activeDirectory.startsWith(cacheDir), "Generated cache escaped the writable cache root.");
    assert.equal(generated.cache?.activeDirectory.includes("app.asar"), false, "Packaged runtime attempted to write inside app.asar.");

    let visibleFiles = 0;
    for (const resource of generated.resources) {
      const file = path.join(generated.cache.activeDirectory, `${resource.key}.source-top-max-y.png`);
      assert(fs.existsSync(file), `Generated cache is missing ${resource.key}.`);
      const route = `/api/live-map/resource-areas/overlay/${encodeURIComponent(generated.cacheKey)}/source-top-max-y/${encodeURIComponent(resource.key)}.png`;
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, `Overlay route failed for ${resource.key}.`);
      assert.match(response.headers.get("content-type") || "", /image\/png/);
      const png = Buffer.from(await response.arrayBuffer());
      if (pngHasVisiblePixel(png)) visibleFiles += 1;
    }
    assert(visibleFiles > 0, "All ten generated overlays were fully transparent.");

    const cachedResponse = await fetch(`http://127.0.0.1:${port}/api/live-map/resource-areas/status`);
    const cached = await cachedResponse.json();
    assert.equal(cachedResponse.status, 200);
    assert.equal(cached.available, true);
    assert.equal(cached.cache?.hit, true, "A second packaged request must load the schema 3 cache.");
    assert.equal(cached.cache?.missing, 0);
    console.log(`Packaged Resource Areas cache miss/generation/cache hit and ten overlay routes passed on port ${port}; ${visibleFiles} overlays contain visible pixels.`);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
