#!/usr/bin/env node
const path = require("path");
const ExperimentalResourceAreas = require("../lib/experimental-resource-areas");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

try {
  const result = ExperimentalResourceAreas.generate({
    cacheDir: argument("--cache") || process.env.ALPHANINE_RESOURCE_AREA_CACHE || path.join(process.env.APPDATA || path.resolve(__dirname, ".."), "AlphaNine Dune Suite", "data", "experimental-resource-areas"),
    paksDir: argument("--paks"),
    buildId: argument("--build-id"),
    repakExe: argument("--repak"),
    appDir: path.resolve(__dirname, "..")
  });
  console.log(JSON.stringify({ ok: true, reused: result.reused, cacheDir: result.cacheDir, cacheKey: result.metadata.cacheKey, gameBuildId: result.metadata.source.gameBuildId, pakSha256: result.metadata.source.pakSha256, generatedAt: result.metadata.generatedAt, resources: result.metadata.resources.length, orientations: result.metadata.orientations.length }, null, 2));
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
