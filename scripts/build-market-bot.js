"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const source = path.join(root, "market-bot");
const outputDir = path.join(root, "assets", "market-bot", "linux-amd64");
const output = path.join(outputDir, "alphanine-market-bot");
const version = require(path.join(root, "package.json")).version;

fs.mkdirSync(outputDir, { recursive: true });
const result = spawnSync("go", [
  "build",
  "-trimpath",
  "-ldflags",
  `-s -w -X main.runtimeVersion=${version}`,
  "-o",
  output,
  "."
], {
  cwd: source,
  env: {
    ...process.env,
    GOOS: "linux",
    GOARCH: "amd64",
    CGO_ENABLED: "0"
  },
  encoding: "utf8"
});

if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || `Go build failed with exit code ${result.status}.`);
}

const binary = fs.readFileSync(output);
assert(binary.length > 100000, "Market Bot binary is unexpectedly small.");
assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46", "Market Bot output is not an ELF binary.");
assert.equal(binary[4], 2, "Market Bot output is not ELF64.");
assert.equal(binary.readUInt16LE(18), 62, "Market Bot output is not amd64.");

console.log(`Built Linux/amd64 AlphaNine Market Bot ${version}: ${output} (${binary.length} bytes).`);
