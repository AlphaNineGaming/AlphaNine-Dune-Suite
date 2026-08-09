"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const IDENTITY_SCHEMA_VERSION = 1;
const REQUIRED_FILES = Object.freeze([
  "server.js",
  "lib/battlegroup-control.js",
  "lib/database-backup.js",
  "lib/server-migration-export.js",
  "lib/server-migration-import.js",
  "lib/migration-destination-worker.js",
  "lib/migration-worker-plan.js",
  "lib/migration-worker-transport.js",
  "lib/migration-schema-restore.js",
  "lib/migration-remote-args.js",
  "lib/stdin-process.js",
  "lib/migration-job-progress.js",
  "lib/migration-package.js",
  "lib/recovery-archive-transport.js",
  "lib/migration-ssh-retry.js",
  "lib/migration-startup-suppressed-routes.js",
  "lib/profile-binding.js",
  "lib/migration-vm-ip-reconciliation.js",
  "lib/server-migration.js",
  "lib/vm-scheduler.js",
  "assets/scheduler/alphanine-scheduler.sh",
  "manager/manager-server.py",
  "lib/migration-runtime-identity.js",
  "assets/migration-worker/linux-amd64/alphanine-migration-worker",
  "assets/migration-worker/linux-amd64/alphanine-migration-worker.sha256"
]);

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  throw new Error("Migration runtime identity contains an unsupported value.");
}

function canonicalJson(value) { return `${JSON.stringify(canonical(value))}\n`; }
function sha256Buffer(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256File(filePath) { return sha256Buffer(fs.readFileSync(filePath)); }

function identityInput(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    packageFormatVersion: manifest.packageFormatVersion,
    exportTransportVersion: manifest.exportTransportVersion,
    progressApiVersion: manifest.progressApiVersion,
    migrationWorkerTransportVersion: manifest.migrationWorkerTransportVersion,
    files: manifest.files
  };
}

function verifyMigrationRuntimeIdentity(options = {}) {
  const rootDir = fs.realpathSync(String(options.rootDir || ""));
  const manifestPath = path.resolve(String(options.manifestPath || path.join(rootDir, "migration-runtime-identity.json")));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== IDENTITY_SCHEMA_VERSION) throw new Error("Migration runtime identity schema version is unsupported.");
  if (Number(manifest.packageFormatVersion) !== Number(options.packageFormatVersion)) throw new Error("Migration package format identity does not match this runtime.");
  if (manifest.exportTransportVersion !== options.exportTransportVersion) throw new Error("Migration export transport identity does not match this runtime.");
  if (manifest.progressApiVersion !== options.progressApiVersion) throw new Error("Migration progress API identity does not match this runtime.");
  if (manifest.migrationWorkerTransportVersion !== options.migrationWorkerTransportVersion) throw new Error("Migration destination-worker transport identity does not match this runtime.");
  const names = Object.keys(manifest.files || {}).sort();
  if (JSON.stringify(names) !== JSON.stringify([...REQUIRED_FILES].sort())) throw new Error("Migration runtime identity file boundary is invalid.");
  for (const name of REQUIRED_FILES) {
    if (!/^[a-z0-9./-]+$/i.test(name) || name.includes("..")) throw new Error("Migration runtime identity contains an unsafe source path.");
    const resolved = fs.realpathSync(path.join(rootDir, ...name.split("/")));
    if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) throw new Error("Migration runtime identity escaped its source root.");
    const expected = String(manifest.files[name] || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256File(resolved) !== expected) throw new Error(`Migration runtime source file ${name} does not match the pinned build.`);
  }
  const fingerprint = sha256Buffer(Buffer.from(canonicalJson(identityInput(manifest)), "utf8"));
  if (fingerprint !== String(manifest.sourceBuildFingerprint || "").toLowerCase()) throw new Error("Migration runtime source/build fingerprint is invalid.");
  return Object.freeze({
    verified: true,
    sourceBuildFingerprint: fingerprint,
    packageFormatVersion: String(manifest.packageFormatVersion),
    exportTransportVersion: manifest.exportTransportVersion,
    progressApiVersion: manifest.progressApiVersion,
    migrationWorkerTransportVersion: manifest.migrationWorkerTransportVersion
  });
}

module.exports = { IDENTITY_SCHEMA_VERSION, REQUIRED_FILES, canonicalJson, identityInput, sha256File, verifyMigrationRuntimeIdentity };
