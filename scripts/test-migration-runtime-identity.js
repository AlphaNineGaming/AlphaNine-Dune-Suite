"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REQUIRED_FILES, verifyMigrationRuntimeIdentity } = require("../lib/migration-runtime-identity");
const { FORMAT_VERSION } = require("../lib/migration-package");
const { EXPORT_TRANSPORT_VERSION } = require("../lib/server-migration-export");
const { PROGRESS_API_VERSION } = require("../lib/migration-job-progress");
const { WORKER_TRANSPORT_VERSION } = require("../lib/migration-destination-worker");

const root = path.join(__dirname, "..");
const options = {
  rootDir: root,
  manifestPath: path.join(root, "migration-runtime-identity.json"),
  packageFormatVersion: FORMAT_VERSION,
  exportTransportVersion: EXPORT_TRANSPORT_VERSION,
  progressApiVersion: PROGRESS_API_VERSION,
  migrationWorkerTransportVersion: WORKER_TRANSPORT_VERSION
};

const verified = verifyMigrationRuntimeIdentity(options);
assert.equal(verified.verified, true);
assert.match(verified.sourceBuildFingerprint, /^[a-f0-9]{64}$/);
assert.equal(verified.exportTransportVersion, "pod-native-direct-pgpass-v3");
assert.equal(verified.progressApiVersion, "migration-progress-v1");
assert.equal(verified.migrationWorkerTransportVersion, "destination-durable-worker-v1");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-runtime-identity-"));
try {
  for (const name of REQUIRED_FILES) {
    const destination = path.join(scratch, ...name.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, ...name.split("/")), destination);
  }
  fs.copyFileSync(options.manifestPath, path.join(scratch, "migration-runtime-identity.json"));
  assert.equal(verifyMigrationRuntimeIdentity({ ...options, rootDir: scratch, manifestPath: path.join(scratch, "migration-runtime-identity.json") }).verified, true);
  fs.appendFileSync(path.join(scratch, "lib", "migration-job-progress.js"), "\n// simulated stale runtime\n");
  assert.throws(() => verifyMigrationRuntimeIdentity({ ...options, rootDir: scratch, manifestPath: path.join(scratch, "migration-runtime-identity.json") }), /does not match the pinned build/);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("Migration runtime source/build identity, tamper rejection, and version-pin tests passed.");
