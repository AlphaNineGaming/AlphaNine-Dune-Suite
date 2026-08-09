"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROFILE_FLAG = "--profile-dir";
const MIGRATION_FLAG = "--migration-startup-suppressed";

function canonicalPath(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+$/, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function findProfileArgument(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== PROFILE_FLAG) continue;
    values.push(argv[index + 1]);
    index += 1;
  }
  if (values.length > 1) throw new Error(`${PROFILE_FLAG} may be supplied exactly once.`);
  if (values.length === 1 && (!values[0] || String(values[0]).startsWith("--"))) throw new Error(`${PROFILE_FLAG} requires an absolute Suite profile directory.`);
  return values[0] || "";
}

function readBoundConfig(profileDir) {
  const configPath = path.join(profileDir, "config.json");
  let raw;
  try { raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""); }
  catch { throw new Error("The explicitly selected Suite profile does not contain a readable config.json."); }
  let config;
  try { config = JSON.parse(raw); }
  catch { throw new Error("The explicitly selected Suite profile config.json is malformed."); }
  const vmName = String(config?.vmName || "").trim();
  if (!vmName) throw new Error("The explicitly selected Suite profile has no VM identity.");
  return { configPath, config, vmName };
}

function bindingDigest({ profileDir, configPath, vmName }) {
  return sha256(JSON.stringify({ profileDir: canonicalPath(profileDir).toLowerCase(), configPath: canonicalPath(configPath).toLowerCase(), vmName: String(vmName) }));
}

function resolveProfileBinding({ argv = process.argv } = {}) {
  const args = argv.map(String);
  const migrationSuppressed = args.includes(MIGRATION_FLAG);
  const selected = findProfileArgument(args);
  if (migrationSuppressed && !selected) throw new Error(`Startup-suppressed migration mode requires an explicit ${PROFILE_FLAG} selection in the elevated terminal.`);
  if (!selected) return null;
  if (!path.isAbsolute(selected)) throw new Error(`${PROFILE_FLAG} must be an absolute Suite profile directory.`);
  const profileDir = canonicalPath(selected);
  const { configPath, vmName } = readBoundConfig(profileDir);
  return Object.freeze({
    source: "command-line",
    profileDir,
    configPath,
    profileName: path.basename(profileDir),
    vmName,
    digest: bindingDigest({ profileDir, configPath, vmName })
  });
}

function verifyProfileBinding(binding) {
  if (!binding) throw new Error("An explicit Suite profile binding is required for migration admission.");
  const current = readBoundConfig(binding.profileDir);
  const digest = bindingDigest({ profileDir: binding.profileDir, configPath: current.configPath, vmName: current.vmName });
  if (digest !== binding.digest || current.vmName !== binding.vmName || canonicalPath(current.configPath) !== canonicalPath(binding.configPath)) {
    throw new Error("The selected Suite profile or VM identity changed after startup; migration remains blocked.");
  }
  return binding;
}

function publicProfileBinding(binding) {
  if (!binding) return null;
  return Object.freeze({ source: binding.source, profileName: binding.profileName, vmName: binding.vmName, digest: binding.digest });
}

function assertCapturedDestinationBinding(binding, captured) {
  const selected = publicProfileBinding(verifyProfileBinding(binding));
  if (!captured || captured.source !== "command-line" || captured.digest !== selected.digest || captured.vmName !== selected.vmName || captured.profileName !== selected.profileName) {
    throw new Error("The selected Suite profile or VM differs from the destination identity captured by import preflight.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(captured.vmIdentityFingerprint || "")) || captured.state !== "Running") {
    throw new Error("The import-preflight destination VM identity is missing, malformed, or no longer admissible.");
  }
  return selected;
}

module.exports = { PROFILE_FLAG, MIGRATION_FLAG, assertCapturedDestinationBinding, bindingDigest, publicProfileBinding, resolveProfileBinding, verifyProfileBinding };
