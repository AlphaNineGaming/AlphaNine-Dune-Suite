"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const source = path.join(root, "migration-worker");
const outputDir = path.join(root, "assets", "migration-worker", "linux-amd64");
const output = path.join(outputDir, "alphanine-migration-worker");
const pinPath = path.join(outputDir, "alphanine-migration-worker.sha256");

fs.mkdirSync(outputDir, { recursive: true });
const result = spawnSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", output, "."], {
  cwd: source,
  env: { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0", GOCACHE: path.join(root, "work", "go-cache-worker") },
  encoding: "utf8"
});
if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Go build failed with exit code ${result.status}.`);
const bytes = fs.readFileSync(output);
assert(bytes.length > 500000, "Migration worker binary is unexpectedly small.");
assert.equal(bytes.subarray(0, 4).toString("hex"), "7f454c46", "Migration worker is not ELF.");
assert.equal(bytes[4], 2, "Migration worker is not ELF64.");
assert.equal(bytes.readUInt16LE(18), 62, "Migration worker is not amd64.");
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(pinPath, `${sha256}  alphanine-migration-worker\n`, { encoding: "utf8", mode: 0o644 });
console.log(`Built pinned Linux/amd64 migration worker: ${bytes.length} bytes ${sha256}.`);
