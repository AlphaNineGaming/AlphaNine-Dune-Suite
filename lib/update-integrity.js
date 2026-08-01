"use strict";

const crypto = require("crypto");
const fs = require("fs");

const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

function normalizeSha256Digest(value) {
  const match = String(value || "").trim().match(/^sha256:([a-f0-9]{64})$/i);
  return match ? `sha256:${match[1].toLowerCase()}` : "";
}

function normalizeExpectedSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_UPDATE_BYTES ? size : 0;
}

function updateVerificationMetadata(input = {}) {
  const digest = normalizeSha256Digest(input.digest);
  const size = normalizeExpectedSize(input.size);
  if (!digest) throw new Error("The update is missing a valid GitHub SHA-256 digest.");
  if (!size) throw new Error("The update is missing a valid expected file size.");
  return { digest, size };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyUpdateFile(filePath, expected = {}) {
  const metadata = updateVerificationMetadata(expected);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("The downloaded update is not a regular file.");
  if (stat.size !== metadata.size) {
    throw new Error(`Update size verification failed: expected ${metadata.size} bytes, received ${stat.size}.`);
  }
  const actualHex = await sha256File(filePath);
  const expectedHex = metadata.digest.slice("sha256:".length);
  const matches = crypto.timingSafeEqual(Buffer.from(actualHex, "hex"), Buffer.from(expectedHex, "hex"));
  if (!matches) throw new Error("Update SHA-256 verification failed. The installer will not be launched.");
  return { size: stat.size, digest: `sha256:${actualHex}` };
}

module.exports = {
  MAX_UPDATE_BYTES,
  normalizeSha256Digest,
  normalizeExpectedSize,
  updateVerificationMetadata,
  sha256File,
  verifyUpdateFile
};
