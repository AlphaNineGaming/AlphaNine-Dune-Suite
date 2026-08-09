"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PACKAGE_MAGIC = Buffer.from("A9MIG001", "ascii");
const ENTRY_MAGIC = Buffer.from("ENTR", "ascii");
const INDEX_MAGIC = Buffer.from("INDX", "ascii");
const TRAILER_MAGIC = Buffer.from("A9MEND1!", "ascii");
const FORMAT_VERSION = 4;
const REQUIRED_PATHS = Object.freeze(["manifest.json", "world.dump", "verification.json"]);
const JSON_ENTRY_LIMIT = 16n * 1024n * 1024n;
const DEFAULT_ENTRY_LIMIT = 4n * 1024n * 1024n * 1024n * 1024n;
const DEFAULT_ARCHIVE_LIMIT = (DEFAULT_ENTRY_LIMIT * 2n) + (64n * 1024n * 1024n);

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain a non-finite number.");
    return value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath, options = {}) {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error("Migration component is not a regular file.");
  const hash = crypto.createHash("sha256");
  let bytes = 0n;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    bytes += BigInt(chunk.length);
    options.onProgress?.({ bytes: bytes.toString(10), totalBytes: stat.size.toString(10), progress: stat.size === 0n ? 100 : Number((bytes * 10000n) / stat.size) / 100 });
  }
  return { size: stat.size.toString(10), sha256: hash.digest("hex") };
}

function assertSafeEntryPath(value) {
  const name = String(value || "");
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error("Migration archive contains an unsafe entry path.");
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Migration archive contains a traversal path.");
  if (path.posix.normalize(name) !== name) throw new Error("Migration archive contains a non-canonical entry path.");
  return name;
}

function parseDecimalSize(value, label = "size") {
  const text = String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`Migration ${label} is not an exact decimal integer.`);
  return BigInt(text);
}

function assertDigest(value, label = "SHA-256") {
  const text = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`Migration ${label} is invalid.`);
  return text;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!result.bytesWritten) throw new Error("Migration archive write stopped unexpectedly.");
    offset += result.bytesWritten;
  }
}

function entryHeader(entry, size) {
  const metadata = Buffer.from(canonicalJson({
    compression: "none",
    mediaType: String(entry.mediaType || "application/octet-stream"),
    path: assertSafeEntryPath(entry.path)
  }), "utf8");
  if (metadata.length > 65536) throw new Error("Migration entry header is too large.");
  const header = Buffer.alloc(16);
  ENTRY_MAGIC.copy(header, 0);
  header.writeUInt32LE(metadata.length, 4);
  header.writeBigUInt64LE(size, 8);
  return { header, metadata };
}

async function writeMigrationArchive(outputPath, entries, options = {}) {
  if (!Array.isArray(entries) || entries.length !== REQUIRED_PATHS.length) throw new Error("Migration archive requires exactly three entries.");
  const names = entries.map((entry) => assertSafeEntryPath(entry.path));
  if (new Set(names).size !== names.length) throw new Error("Migration archive contains duplicate paths.");
  if (REQUIRED_PATHS.some((name) => !names.includes(name))) throw new Error("Migration archive is missing a required entry.");
  const prepared = await Promise.all(entries.map(async (entry) => {
    const sourceBuffer = Object.prototype.hasOwnProperty.call(entry, "content")
      ? (Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ""), "utf8"))
      : null;
    const sourcePath = sourceBuffer ? "" : String(entry.sourcePath || "");
    const size = sourceBuffer ? BigInt(sourceBuffer.length) : (await fs.promises.stat(sourcePath, { bigint: true })).size;
    return { entry, sourceBuffer, sourcePath, size };
  }));
  const totalPayloadBytes = prepared.reduce((sum, row) => sum + row.size, 0n);
  let payloadBytes = 0n;
  const publish = () => options.onProgress?.({ bytes: payloadBytes.toString(10), totalBytes: totalPayloadBytes.toString(10), progress: totalPayloadBytes === 0n ? 100 : Number((payloadBytes * 10000n) / totalPayloadBytes) / 100 });
  let handle;
  try {
    handle = await fs.promises.open(outputPath, "wx", 0o600);
    await writeAll(handle, PACKAGE_MAGIC);
    let position = BigInt(PACKAGE_MAGIC.length);
    const indexEntries = [];
    publish();
    for (const preparedEntry of prepared) {
      const { entry, sourceBuffer, sourcePath, size } = preparedEntry;
      const { header, metadata } = entryHeader(entry, size);
      const recordOffset = position;
      await writeAll(handle, header);
      await writeAll(handle, metadata);
      position += BigInt(header.length + metadata.length);
      const dataOffset = position;
      const hash = crypto.createHash("sha256");
      let written = 0n;
      if (sourceBuffer) {
        await writeAll(handle, sourceBuffer);
        hash.update(sourceBuffer);
        written = BigInt(sourceBuffer.length);
        payloadBytes += written;
        publish();
      } else {
        for await (const chunk of fs.createReadStream(sourcePath)) {
          await writeAll(handle, chunk);
          hash.update(chunk);
          written += BigInt(chunk.length);
          payloadBytes += BigInt(chunk.length);
          publish();
        }
      }
      if (written !== size) throw new Error("Migration component changed while the package was being written.");
      position += written;
      indexEntries.push({
        dataOffset: dataOffset.toString(10),
        mediaType: String(entry.mediaType || "application/octet-stream"),
        path: entry.path,
        recordOffset: recordOffset.toString(10),
        sha256: hash.digest("hex"),
        size: size.toString(10)
      });
    }
    const indexOffset = position;
    const index = Buffer.from(canonicalJson({ entries: indexEntries, formatVersion: FORMAT_VERSION }), "utf8");
    const indexHeader = Buffer.alloc(8);
    INDEX_MAGIC.copy(indexHeader, 0);
    indexHeader.writeUInt32LE(index.length, 4);
    await writeAll(handle, indexHeader);
    await writeAll(handle, index);
    const trailer = Buffer.alloc(16);
    TRAILER_MAGIC.copy(trailer, 0);
    trailer.writeBigUInt64LE(indexOffset, 8);
    await writeAll(handle, trailer);
    await handle.sync();
    await handle.close();
    handle = null;
    return { entries: indexEntries, indexOffset: indexOffset.toString(10) };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readExact(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Migration archive requested an unsafe read length.");
  if (position > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Migration archive offset exceeds the supported filesystem range.");
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, Number(position) + read);
    if (!result.bytesRead) throw new Error("Migration archive is truncated.");
    read += result.bytesRead;
  }
  return buffer;
}

function parseJsonBuffer(buffer, label) {
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw new Error(`Migration ${label} is malformed JSON.`); }
}

async function hashRegion(filePath, start, length, options = {}) {
  if (start > BigInt(Number.MAX_SAFE_INTEGER) || length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Migration entry exceeds the supported filesystem range.");
  const hash = crypto.createHash("sha256");
  let bytes = 0n;
  if (length > 0n) {
    const stream = fs.createReadStream(filePath, { start: Number(start), end: Number(start + length - 1n) });
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += BigInt(chunk.length);
      options.onProgress?.(bytes);
    }
  }
  if (bytes !== length) throw new Error("Migration archive entry is truncated.");
  return hash.digest("hex");
}

async function readJsonEntry(handle, entry, label) {
  const size = parseDecimalSize(entry.size, `${label} size`);
  if (size > JSON_ENTRY_LIMIT) throw new Error(`Migration ${label} exceeds the JSON safety limit.`);
  return parseJsonBuffer(await readExact(handle, Number(size), parseDecimalSize(entry.dataOffset, `${label} offset`)), label);
}

async function inspectMigrationPackage(filePath, options = {}) {
  const maxEntryBytes = parseDecimalSize(options.maxEntryBytes ?? DEFAULT_ENTRY_LIMIT, "entry limit");
  const maxArchiveBytes = parseDecimalSize(options.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMIT, "archive limit");
  const stat = await fs.promises.stat(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error("Migration package is not a regular file.");
  if (stat.size > maxArchiveBytes) throw new Error("Migration package exceeds the inspection size limit.");
  if (stat.size < BigInt(PACKAGE_MAGIC.length + 16)) throw new Error("Migration package is truncated.");
  const handle = await fs.promises.open(filePath, "r");
  try {
    const magic = await readExact(handle, PACKAGE_MAGIC.length, 0n);
    if (!magic.equals(PACKAGE_MAGIC)) throw new Error("Migration package magic or format version is unsupported.");
    const trailerOffset = stat.size - 16n;
    const trailer = await readExact(handle, 16, trailerOffset);
    if (!trailer.subarray(0, 8).equals(TRAILER_MAGIC)) throw new Error("Migration package footer is missing or corrupt.");
    const expectedIndexOffset = trailer.readBigUInt64LE(8);
    let position = BigInt(PACKAGE_MAGIC.length);
    const entries = [];
    const seen = new Set();
    while (position < expectedIndexOffset) {
      const fixed = await readExact(handle, 16, position);
      if (!fixed.subarray(0, 4).equals(ENTRY_MAGIC)) throw new Error("Migration package contains an unknown record.");
      const headerLength = fixed.readUInt32LE(4);
      const dataLength = fixed.readBigUInt64LE(8);
      if (!headerLength || headerLength > 65536) throw new Error("Migration entry header length is invalid.");
      if (dataLength > maxEntryBytes) throw new Error("Migration entry exceeds the inspection size limit.");
      const metadata = parseJsonBuffer(await readExact(handle, headerLength, position + 16n), "entry header");
      const entryPath = assertSafeEntryPath(metadata.path);
      if (metadata.compression !== "none") throw new Error("Compressed migration entries are unsupported and rejected to prevent decompression bombs.");
      if (seen.has(entryPath)) throw new Error("Migration package contains duplicate entries.");
      seen.add(entryPath);
      const dataOffset = position + 16n + BigInt(headerLength);
      const next = dataOffset + dataLength;
      if (next > expectedIndexOffset) throw new Error("Migration package entry is truncated or overlaps the index.");
      entries.push({
        dataOffset: dataOffset.toString(10),
        mediaType: String(metadata.mediaType || ""),
        path: entryPath,
        recordOffset: position.toString(10),
        size: dataLength.toString(10)
      });
      position = next;
    }
    if (position !== expectedIndexOffset) throw new Error("Migration package index offset is invalid.");
    const indexHeader = await readExact(handle, 8, position);
    if (!indexHeader.subarray(0, 4).equals(INDEX_MAGIC)) throw new Error("Migration package index is missing.");
    const indexLength = indexHeader.readUInt32LE(4);
    if (!indexLength || BigInt(indexLength) > JSON_ENTRY_LIMIT) throw new Error("Migration package index length is invalid.");
    const indexEnd = position + 8n + BigInt(indexLength);
    if (indexEnd !== trailerOffset) throw new Error("Migration package has trailing or truncated data.");
    const index = parseJsonBuffer(await readExact(handle, indexLength, position + 8n), "index");
    if (index.formatVersion !== FORMAT_VERSION || !Array.isArray(index.entries)) throw new Error("Migration package index version is unsupported.");
    if (entries.length !== REQUIRED_PATHS.length || REQUIRED_PATHS.some((name) => !seen.has(name))) throw new Error("Migration package does not contain exactly the required entries.");
    if (index.entries.length !== entries.length) throw new Error("Migration package index does not match its entries.");
    const totalVerificationBytes = entries.reduce((sum, entry) => sum + parseDecimalSize(entry.size, "entry size"), 0n);
    let verifiedBytes = 0n;
    options.onProgress?.({ bytes: "0", totalBytes: totalVerificationBytes.toString(10), progress: totalVerificationBytes === 0n ? 100 : 0 });
    for (let itemIndex = 0; itemIndex < entries.length; itemIndex += 1) {
      const entry = entries[itemIndex];
      const indexed = index.entries[itemIndex] || {};
      for (const field of ["path", "mediaType", "size", "dataOffset", "recordOffset"]) {
        if (String(indexed[field] ?? "") !== String(entry[field])) throw new Error("Migration package index metadata does not match its entries.");
      }
      let prior = 0n;
      const actualHash = await hashRegion(filePath, parseDecimalSize(entry.dataOffset, "entry offset"), parseDecimalSize(entry.size, "entry size"), { onProgress: (regionBytes) => {
        const delta = regionBytes - prior;
        prior = regionBytes;
        verifiedBytes += delta;
        options.onProgress?.({ bytes: verifiedBytes.toString(10), totalBytes: totalVerificationBytes.toString(10), progress: totalVerificationBytes === 0n ? 100 : Number((verifiedBytes * 10000n) / totalVerificationBytes) / 100 });
      } });
      entry.sha256 = actualHash;
      if (assertDigest(indexed.sha256, "index SHA-256") !== actualHash) throw new Error(`Migration component ${entry.path} failed SHA-256 verification.`);
    }
    const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
    const manifest = await readJsonEntry(handle, byPath["manifest.json"], "manifest");
    const verification = await readJsonEntry(handle, byPath["verification.json"], "verification evidence");
    return { ok: true, formatVersion: FORMAT_VERSION, size: stat.size.toString(10), entries, manifest, verification };
  } finally {
    await handle.close();
  }
}

async function streamMigrationEntry(filePath, inspection, entryPath, writable, options = {}) {
  const entry = inspection.entries.find((row) => row.path === entryPath);
  if (!entry) throw new Error(`Migration entry ${entryPath} is missing.`);
  const start = parseDecimalSize(entry.dataOffset, "entry offset");
  const size = parseDecimalSize(entry.size, "entry size");
  if (start > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Migration entry exceeds the supported filesystem range.");
  if (size === 0n) {
    writable.end();
    return;
  }
  let bytes = 0n;
  options.onProgress?.({ bytes: "0", totalBytes: size.toString(10), progress: 0 });
  const stream = fs.createReadStream(filePath, { start: Number(start), end: Number(start + size - 1n) });
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      writable.destroy();
      reject(error);
    };
    stream.on("error", fail);
    writable.on("error", fail);
    writable.on("finish", () => { if (!settled) { settled = true; resolve(); } });
    stream.on("data", (chunk) => {
      bytes += BigInt(chunk.length);
      try {
        options.onProgress?.({ bytes: bytes.toString(10), totalBytes: size.toString(10), progress: Number((bytes * 10000n) / size) / 100 });
      } catch (error) {
        const wrapped = new Error(`Migration progress reporting failed: ${String(error?.message || error || "unknown callback error")}`);
        wrapped.code = "migration_progress_reporting_failed";
        fail(wrapped);
      }
    });
    stream.pipe(writable);
  });
}

async function extractMigrationEntry(filePath, inspection, entryPath, destination, options = {}) {
  const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    await streamMigrationEntry(filePath, inspection, entryPath, output, options);
    const handle = await fs.promises.open(destination, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    return hashFile(destination);
  } catch (error) {
    output.destroy(); await fs.promises.rm(destination, { force: true }).catch(() => {}); throw error;
  }
}

async function writeMigrationPackage({ partialPath, worldDumpPath, manifest, verification, onHashProgress, onWriteProgress, onVerifyProgress }) {
  const verificationBuffer = Buffer.from(canonicalJson(verification), "utf8");
  const world = await hashFile(worldDumpPath, { onProgress: onHashProgress });
  const expectedComponents = [
    { mediaType: "application/vnd.postgresql.custom-dump", path: "world.dump", ...world },
    { mediaType: "application/json", path: "verification.json", size: String(verificationBuffer.length), sha256: sha256Buffer(verificationBuffer) }
  ];
  const manifestBuffer = Buffer.from(canonicalJson(manifest), "utf8");
  const actualComponents = Array.isArray(manifest?.components) ? manifest.components : [];
  if (actualComponents.length !== 3 || canonicalJson(actualComponents.slice(1)) !== canonicalJson(expectedComponents)) throw new Error("Migration manifest component metadata does not match the payload.");
  const selfInput = JSON.parse(JSON.stringify(manifest));
  selfInput.components[0].sha256 = "0".repeat(64);
  const expectedSelf = {
    path: "manifest.json",
    mediaType: "application/json",
    size: String(manifestBuffer.length),
    sha256: sha256Buffer(Buffer.from(canonicalJson(selfInput), "utf8"))
  };
  if (canonicalJson(actualComponents[0]) !== canonicalJson(expectedSelf)) throw new Error("Migration manifest self-digest is invalid.");
  await writeMigrationArchive(partialPath, [
    { path: "manifest.json", mediaType: "application/json", content: manifestBuffer },
    { path: "world.dump", mediaType: "application/vnd.postgresql.custom-dump", sourcePath: worldDumpPath },
    { path: "verification.json", mediaType: "application/json", content: verificationBuffer }
  ], { onProgress: onWriteProgress });
  return inspectMigrationPackage(partialPath, { onProgress: onVerifyProgress });
}

module.exports = {
  DEFAULT_ARCHIVE_LIMIT,
  DEFAULT_ENTRY_LIMIT,
  FORMAT_VERSION,
  PACKAGE_MAGIC,
  REQUIRED_PATHS,
  assertDigest,
  assertSafeEntryPath,
  canonicalJson,
  entryHeader,
  extractMigrationEntry,
  hashFile,
  inspectMigrationPackage,
  parseDecimalSize,
  sha256Buffer,
  streamMigrationEntry,
  writeMigrationArchive,
  writeMigrationPackage
};
