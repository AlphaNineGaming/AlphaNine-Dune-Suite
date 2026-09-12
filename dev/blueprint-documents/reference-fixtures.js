"use strict";
const crypto = require("node:crypto");
// Mathematical test data only. This is not a game layout or a building catalog.
function fixtureBytes(count = 36) {
  const width = count === 36 ? 3 : 50, depth = count === 36 ? 4 : 50;
  const instances = Array.from({ length: count }, (_, i) => ({
    instance_id: i, building_type: "Synthetic reference " + (i % 4),
    x: (i % width) * 8, y: Math.floor(i / (width * depth)) * 8, z: Math.floor(i / width) % depth * 8,
    rotation: 0, fixtureMetadata: "not game geometry"
  }));
  return Buffer.from(JSON.stringify({ name: `${count} synthetic reference points`, instances, placeables: [], pentashields: [] }) + "\n");
}
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
let verified;
function positionEvidence(bytes) {
  // Trust is external to the opened file. A file cannot self-assert its axes.
  if (!verified) verified = new Map([36, 1000, 10000, 25000].map(count => [hash(fixtureBytes(count)), Object.freeze({
    id: `synthetic-cartesian-${count}-v1`, label: "Synthetic fixture basis: X / Y / Z; Y is display vertical",
    source: "AlphaNine reference-fixtures.js; exact generated-byte SHA-256 match", synthetic: true,
    groups: ["instances"], positionKeys: ["x", "y", "z"], matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  })]));
  return verified.get(hash(bytes)) || null;
}
module.exports = { fixtureBytes, positionEvidence };
