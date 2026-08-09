"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertCapturedDestinationBinding, publicProfileBinding, resolveProfileBinding, verifyProfileBinding } = require("../lib/profile-binding");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-profile-binding-"));
const profile = path.join(scratch, "AlphaNineMigrationTestProfile");
const configPath = path.join(profile, "config.json");
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify({ setupComplete: true, vmName: "dune-awakening-migration-test", secret: "not-public" })}\n`);

try {
  assert.throws(() => resolveProfileBinding({ argv: ["node", "server.js", "--migration-startup-suppressed"] }), /requires an explicit --profile-dir/);
  assert.throws(() => resolveProfileBinding({ argv: ["node", "server.js", "--migration-startup-suppressed", "--profile-dir", "relative"] }), /must be an absolute/);
  assert.throws(() => resolveProfileBinding({ argv: ["node", "server.js", "--migration-startup-suppressed", "--profile-dir", profile, "--profile-dir", profile] }), /exactly once/);
  const binding = resolveProfileBinding({ argv: ["node", "server.js", "--migration-startup-suppressed", "--profile-dir", profile] });
  assert.equal(binding.source, "command-line");
  assert.equal(binding.vmName, "dune-awakening-migration-test");
  assert.equal(binding.configPath, configPath);
  assert.match(binding.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyProfileBinding(binding), binding);
  const publicValue = publicProfileBinding(binding);
  assert.deepEqual(Object.keys(publicValue).sort(), ["digest", "profileName", "source", "vmName"]);
  assert.equal(JSON.stringify(publicValue).includes("not-public"), false);
  assert.equal(JSON.stringify(publicValue).includes(scratch), false);
  const captured = { ...publicValue, vmIdentityFingerprint: "a".repeat(64), state: "Running" };
  assert.deepEqual(assertCapturedDestinationBinding(binding, captured), publicValue);
  assert.throws(() => assertCapturedDestinationBinding(binding, { ...captured, vmName: "dune-awakening" }), /differs from the destination identity/);
  assert.throws(() => assertCapturedDestinationBinding(binding, { ...captured, vmIdentityFingerprint: "bad" }), /missing, malformed/);
  fs.writeFileSync(configPath, `${JSON.stringify({ setupComplete: true, vmName: "dune-awakening" })}\n`);
  assert.throws(() => verifyProfileBinding(binding), /profile or VM identity changed/);
  console.log("Explicit elevated-terminal profile binding, drift rejection, and public redaction tests passed.");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
