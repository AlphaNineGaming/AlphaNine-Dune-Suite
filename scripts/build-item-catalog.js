"use strict";

// The item catalog is intentionally maintained as a bundled, offline artifact.
// This command validates it for development and packaging; it never refreshes it
// from a website or mutates catalog/image content.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { catalogIntegrity, GENERIC_ICON_PATHS } = require("../lib/item-catalog-provider");

const root = path.resolve(__dirname, "..");
const catalogPath = path.join(root, "data", "dune-items-catalog.json");
const installedCatalogPath = path.join(root, "data", "dune-installed-items-catalog.json");
const imageDir = path.join(root, "data", "gear-images");
const report = catalogIntegrity(catalogPath, { required: true, imageDir });
const installedReport = catalogIntegrity(installedCatalogPath, { required: true });

assert.equal(report.present, true, "Bundled item catalog is missing.");
assert.equal(report.valid, true, report.errors.join("\n"));
assert.ok(report.items.length > 0, "Bundled item catalog is empty.");
assert.equal(report.missingImages, 0, `${report.missingImages} bundled item images are missing.`);
assert.equal(installedReport.valid, true, installedReport.errors.join("\n"));
assert.ok(installedReport.items.length > 0, "Installed-game item catalog is empty.");

for (const iconPath of Object.values(GENERIC_ICON_PATHS)) {
  const localPath = path.join(root, ...iconPath.replace(/^\//, "").split("/"));
  assert.equal(fs.existsSync(localPath), true, `Generic local icon is missing: ${iconPath}`);
}

for (const item of report.items) {
  assert.ok(!/^https?:\/\//i.test(String(item.icon || "")), `Remote runtime icon remains for ${item.id}`);
}

console.log(JSON.stringify({
  ok: true,
  mode: "offline-validation-only",
  catalogPath,
  items: report.items.length,
  installedGameItems: installedReport.items.length,
  installedGameSchematics: installedReport.items.filter((item) => item.category === "Schematics").length,
  imageReferences: report.imageReferences,
  missingImages: report.missingImages,
  duplicateIdentifiers: report.duplicateIdentifiers,
  sha256: report.sha256
}, null, 2));
