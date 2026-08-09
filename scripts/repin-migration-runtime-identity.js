"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { REQUIRED_FILES, canonicalJson, identityInput, sha256File } = require("../lib/migration-runtime-identity");

const root = path.join(__dirname, "..");
const manifestPath = path.join(root, "migration-runtime-identity.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.files = Object.fromEntries(REQUIRED_FILES.map((name) => [name, sha256File(path.join(root, ...name.split("/")))]));
manifest.sourceBuildFingerprint = crypto.createHash("sha256").update(Buffer.from(canonicalJson(identityInput(manifest)), "utf8")).digest("hex");
const nextPath = `${manifestPath}.next`;
fs.writeFileSync(nextPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
fs.renameSync(nextPath, manifestPath);
process.stdout.write(`${manifest.sourceBuildFingerprint}\n`);
