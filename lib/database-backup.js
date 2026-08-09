"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FULL_BACKUP_ALPHA_TABLES = Object.freeze([
  "alphanine_market_bot_audit",
  "alphanine_market_bot_cycle_evidence",
  "alphanine_market_bot_cycles",
  "alphanine_market_bot_listings"
]);
const BACKUP_INVENTORY_PROFILES = Object.freeze({
  MIGRATION_PACKAGE: "migration-package-dune-only",
  DESTINATION_ROLLBACK: "destination-rollback-full-database"
});
const REQUIRED_ROLLBACK_EXTENSIONS = Object.freeze(["pgcrypto", "pg_trgm"]);

const TOC_DESCRIPTORS = Object.freeze([
  "MATERIALIZED VIEW DATA", "SEQUENCE OWNED BY", "DATABASE PROPERTIES",
  "PUBLICATION TABLE IN SCHEMA", "PUBLICATION TABLE", "DEFAULT ACL",
  "FK CONSTRAINT", "INDEX ATTACH", "TABLE ATTACH", "TABLE DATA",
  "SEQUENCE SET", "MATERIALIZED VIEW", "FOREIGN TABLE", "ROW SECURITY",
  "PROCEDURE", "AGGREGATE", "FUNCTION", "TRIGGER", "CONSTRAINT", "INDEX",
  "SEQUENCE", "VIEW", "TABLE", "TYPE", "DOMAIN", "SCHEMA", "EXTENSION",
  "COLLATION", "CONVERSION", "CAST", "DEFAULT", "POLICY", "COMMENT", "ACL",
  "ENCODING", "STDSTRINGS", "SEARCHPATH", "DATABASE"
].sort((left, right) => right.length - left.length));
const DATA_DESCRIPTORS = new Set(["TABLE DATA", "SEQUENCE SET", "MATERIALIZED VIEW DATA", "BLOB", "BLOBS"]);
const NON_SCHEMA_DESCRIPTORS = new Set(["ENCODING", "STDSTRINGS", "SEARCHPATH", "DATABASE", "DATABASE PROPERTIES"]);
// pg_restore --list omits the owner column for these archive metadata entries.
// Treating their final semantic token as an owner collapses distinct extensions
// and comments (for example pgcrypto and pg_trgm) into false duplicates.
const OWNERLESS_TOC_DESCRIPTORS = new Set(["ENCODING", "STDSTRINGS", "SEARCHPATH", "EXTENSION", "COMMENT"]);

function decimalString(value, label = "value") {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(`${label} must be an unsigned decimal string.`);
  return BigInt(text).toString(10);
}

function operationPhase(operation) {
  return String(operation?.status?.phase || operation?.status?.state || "").trim();
}

function validateVendorTerminalOperation(operation, expectedName = "") {
  if (!operation || typeof operation !== "object") throw new Error("Vendor DatabaseOperation was not found.");
  if (expectedName && String(operation.metadata?.name || "") !== String(expectedName)) throw new Error("Vendor DatabaseOperation identity does not match the requested backup.");
  const phase = operationPhase(operation);
  if (phase !== "Succeeded") throw new Error(`Vendor DatabaseOperation is not in an unambiguous successful terminal state (${phase || "missing"}).`);
  const conditions = Array.isArray(operation.status?.conditions) ? operation.status.conditions : [];
  if (conditions.some((condition) => String(condition.status || "").toLowerCase() === "true" && /fail|error|cancel/i.test(String(condition.type || condition.reason || "")))) throw new Error("Vendor DatabaseOperation reports a failing terminal condition.");
  return { phase, name: String(operation.metadata?.name || "") };
}

function artifactReferences(operation) {
  const values = [];
  const visit = (value, key = "") => {
    if (typeof value === "string" && /backup|artifact|dump|path|file/i.test(key) && value.trim()) values.push(value.trim());
    else if (value && typeof value === "object") {
      if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
      else Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(operation?.spec || {});
  visit(operation?.status || {});
  return [...new Set(values)];
}

function resolveVendorArtifactIdentity(operation, reportedPath) {
  const candidate = String(reportedPath || "").trim();
  if (!candidate || !path.posix.isAbsolute(candidate)) throw new Error("Vendor backup did not report one absolute artifact path.");
  const candidateName = path.posix.basename(candidate);
  const matching = artifactReferences(operation).filter((reference) => {
    const normalized = String(reference).replace(/\\/g, "/");
    return normalized === candidate || path.posix.basename(normalized) === candidateName;
  });
  if (matching.length !== 1) throw new Error("Artifact identity could not be resolved unambiguously from the successful DatabaseOperation.");
  return { path: candidate, fileName: candidateName, operationReference: matching[0] };
}

function validateStableSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error("At least two independent artifact-size samples are required.");
  const normalized = samples.map((sample) => ({ size: decimalString(sample?.size, "artifact size"), modified: String(sample?.modified ?? ""), identity: String(sample?.identity ?? "") }));
  if (normalized[0].size === "0") throw new Error("Backup artifact is empty.");
  const first = normalized[0];
  if (normalized.some((sample) => sample.size !== first.size || sample.modified !== first.modified || (first.identity && sample.identity !== first.identity))) throw new Error("Backup artifact is still changing or its identity changed between checks.");
  return first;
}

function validatePgDumpHeader(header) {
  const bytes = Buffer.isBuffer(header) ? header : Buffer.from(header || "");
  if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("PGDMP", "ascii"))) throw new Error("Backup artifact does not begin with the PostgreSQL custom-archive PGDMP signature.");
  return true;
}

function tocTokens(value) {
  const tokens = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const character of String(value || "")) {
    if (escaped) { token += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (/\s/.test(character) && !quoted) {
      if (token) { tokens.push(token); token = ""; }
    } else token += character;
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function parsePgRestoreToc(tocText) {
  const entries = [];
  for (const line of String(tocText || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+);\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const body = match[4];
    const descriptor = TOC_DESCRIPTORS.find((candidate) => body === candidate || body.startsWith(`${candidate} `));
    if (!descriptor) throw new Error("PostgreSQL archive TOC contains an unsupported entry descriptor.");
    const fields = tocTokens(body.slice(descriptor.length).trim());
    if (!fields.length) throw new Error("PostgreSQL archive TOC entry is malformed.");
    const owner = OWNERLESS_TOC_DESCRIPTORS.has(descriptor) ? "" : fields.pop();
    const schema = descriptor === "SCHEMA" ? fields[1] : fields[0];
    entries.push({ descriptor, fields, owner, schema, definition: `${descriptor}\u0000${JSON.stringify(fields)}` });
  }
  if (!entries.length) throw new Error("PostgreSQL archive TOC is empty or unreadable.");
  return entries;
}

function multiset(entries) {
  const result = new Map();
  for (const entry of entries) result.set(entry.definition, (result.get(entry.definition) || 0n) + 1n);
  return result;
}

function entryDefinition(descriptor, schema, name) {
  return `${descriptor}\u0000${JSON.stringify([String(schema), String(name)])}`;
}

function descriptorCounts(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(String(entry.descriptor || "UNKNOWN"), (counts.get(String(entry.descriptor || "UNKNOWN")) || 0n) + 1n);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([descriptor, count]) => [descriptor, count.toString(10)]));
}

function descriptorCountText(entries) {
  const counts = descriptorCounts(entries);
  return Object.entries(counts).map(([descriptor, count]) => `${descriptor}=${count}`).join(", ") || "none";
}

function duplicateDefinitions(entries) {
  return [...multiset(entries).entries()]
    .filter(([, count]) => count > 1n)
    .map(([definition, count]) => ({ descriptor: definitionDescriptor(definition), count }));
}

function rejectDuplicateEntries(entries, label) {
  const duplicates = duplicateDefinitions(entries);
  if (!duplicates.length) return;
  const counts = new Map();
  for (const entry of duplicates) incrementDescriptorCount(counts, entry.descriptor, entry.count - 1n);
  throw new Error(`${label} contains duplicate TOC entries (${descriptorDifferenceText(counts)}).`);
}

function validateSchemaOnlyBackupToc(tocText, options = {}) {
  const profile = String(options.validationProfile || "");
  if (!Object.values(BACKUP_INVENTORY_PROFILES).includes(profile)) throw new Error("An explicit backup inventory validation profile is required.");
  const entries = parsePgRestoreToc(tocText);
  const dataEntries = entries.filter((entry) => DATA_DESCRIPTORS.has(entry.descriptor));
  if (dataEntries.length) throw new Error(`Schema-only PostgreSQL archive unexpectedly contains data entries (${descriptorCountText(dataEntries)}).`);
  rejectDuplicateEntries(entries, "Schema-only PostgreSQL archive");
  if (entries.some((entry) => /^(?:pg_catalog|information_schema|pg_toast(?:_temp_\d+)?)$/i.test(String(entry.schema || "")))) throw new Error("Schema-only PostgreSQL archive contains an unexpected system-schema object.");
  if (!entries.some((entry) => entry.descriptor === "SCHEMA" && entry.fields[1] === "dune")) throw new Error("Schema-only PostgreSQL archive is missing the dune schema.");

  if (profile === BACKUP_INVENTORY_PROFILES.MIGRATION_PACKAGE) {
    const sessionDescriptors = new Set(["ENCODING", "STDSTRINGS", "SEARCHPATH"]);
    const outside = entries.filter((entry) => !sessionDescriptors.has(entry.descriptor) && String(entry.schema || "") !== "dune");
    if (outside.length) throw new Error(`Schema-only migration archive contains an object outside dune (${descriptorCountText(outside)}).`);
    return { profile, entries, requiredExtensions: [] };
  }

  const requiredExtensions = [...new Set((options.requiredExtensions || REQUIRED_ROLLBACK_EXTENSIONS).map((value) => String(value || "").trim()).filter(Boolean))];
  const extensionEntries = entries.filter((entry) => entry.descriptor === "EXTENSION");
  const extensionNames = extensionEntries.map((entry) => String(entry.fields[1] || "")).filter(Boolean);
  const missingExtensions = requiredExtensions.filter((name) => !extensionNames.includes(name));
  if (missingExtensions.length) throw new Error(`Schema-only full-database archive is missing required extension objects: ${missingExtensions.join(", ")}.`);
  return { profile, entries, requiredExtensions };
}

function excludedRelationSet(options = {}) {
  return new Set((options.excludedRelations || []).map((entry) => `${String(entry.schema || "")}\u0000${String(entry.name || "")}`));
}

function includedSchemaSet(options = {}) {
  const values = Array.isArray(options.includedSchemas) ? options.includedSchemas.map((value) => String(value || "")).filter(Boolean) : [];
  return values.length ? new Set(values) : null;
}

function buildExpectedBackupInventory(schemaOnlyToc, catalog = {}, options = {}) {
  const validatedSchema = validateSchemaOnlyBackupToc(schemaOnlyToc, options);
  const parsedSchema = validatedSchema.entries;
  const schemaEntries = parsedSchema.filter((entry) => !DATA_DESCRIPTORS.has(entry.descriptor));
  const excluded = excludedRelationSet(options);
  const includedSchemas = includedSchemaSet(options);
  const excludedSchemaEntries = schemaEntries.filter((entry) => entry.fields.some((field) => excluded.has(`${String(entry.schema || "")}\u0000${String(field)}`)));
  if (excludedSchemaEntries.length) throw new Error(`Schema-only PostgreSQL archive contains an excluded schema object (${descriptorCountText(excludedSchemaEntries)}).`);
  const dataEntries = (Array.isArray(catalog.dataEntries) ? catalog.dataEntries : [])
    .map((entry) => ({ descriptor: String(entry.descriptor || ""), schema: String(entry.schema || ""), name: String(entry.name || "") }))
    .filter((entry) => !includedSchemas || includedSchemas.has(entry.schema))
    .filter((entry) => !excluded.has(`${entry.schema}\u0000${entry.name}`));
  for (const entry of dataEntries) {
    if (!DATA_DESCRIPTORS.has(entry.descriptor) || !entry.schema || !entry.name) throw new Error("Catalog data inventory contains an unsupported entry.");
  }
  const duplicateData = duplicateDefinitions(dataEntries.map((entry) => ({ definition: entryDefinition(entry.descriptor, entry.schema, entry.name) })));
  if (duplicateData.length) throw new Error("Catalog data inventory contains duplicate entries.");
  return {
    validationProfile: validatedSchema.profile,
    requiredExtensions: validatedSchema.requiredExtensions,
    schemaDefinitions: [...multiset(schemaEntries).entries()].map(([definition, count]) => ({ definition, count: decimalString(count) })),
    dataDefinitions: dataEntries.map((entry) => entryDefinition(entry.descriptor, entry.schema, entry.name)),
    schemaEntryCount: decimalString(schemaEntries.length),
    dataEntryCount: decimalString(dataEntries.length)
  };
}

function definitionDescriptor(definition) { return String(definition || "").split("\u0000", 1)[0] || "UNKNOWN"; }

function incrementDescriptorCount(counts, descriptor, amount) {
  counts.set(descriptor, (counts.get(descriptor) || 0n) + amount);
}

function descriptorDifferenceText(counts) {
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([descriptor, count]) => `${descriptor}=${count}`).join(", ") || "none";
}

function definitionCountDifferences(actual, expected) {
  const missing = new Map();
  const unexpected = new Map();
  for (const [definition, count] of expected) {
    const difference = count - (actual.get(definition) || 0n);
    if (difference > 0n) incrementDescriptorCount(missing, definitionDescriptor(definition), difference);
  }
  for (const [definition, count] of actual) {
    const difference = count - (expected.get(definition) || 0n);
    if (difference > 0n) incrementDescriptorCount(unexpected, definitionDescriptor(definition), difference);
  }
  return { missing, unexpected };
}

function requireDefinitionCounts(actual, required, label) {
  const differences = definitionCountDifferences(actual, required);
  if (differences.missing.size) throw new Error(`PostgreSQL archive TOC is missing a required ${label} entry (${descriptorDifferenceText(differences.missing)}).`);
  return differences;
}

function validateFullBackupToc(tocText, expectedInventory, options = {}) {
  if (!expectedInventory || !Object.values(BACKUP_INVENTORY_PROFILES).includes(expectedInventory.validationProfile) || !Array.isArray(expectedInventory.schemaDefinitions) || !Array.isArray(expectedInventory.dataDefinitions)) throw new Error("Expected backup inventory is missing or invalid.");
  const entries = parsePgRestoreToc(tocText);
  rejectDuplicateEntries(entries, "PostgreSQL archive TOC");
  const actual = multiset(entries);
  const requiredSchema = new Map(expectedInventory.schemaDefinitions.map((entry) => [String(entry.definition), BigInt(decimalString(entry.count, "schema entry count"))]));
  const requiredData = new Map();
  for (const definition of expectedInventory.dataDefinitions) requiredData.set(String(definition), (requiredData.get(String(definition)) || 0n) + 1n);
  requireDefinitionCounts(actual, requiredSchema, "schema");
  const actualData = multiset(entries.filter((entry) => DATA_DESCRIPTORS.has(entry.descriptor)));
  const dataDifferences = requireDefinitionCounts(actualData, requiredData, "data");
  if (dataDifferences.unexpected.size) throw new Error(`PostgreSQL archive TOC contains an unexpected data entry (${descriptorDifferenceText(dataDifferences.unexpected)}).`);
  if (entries.some((entry) => /^(?:pg_catalog|information_schema|pg_toast(?:_temp_\d+)?)$/i.test(String(entry.schema || "")))) throw new Error("PostgreSQL archive TOC contains an unexpected excluded-schema object.");
  const expectedSchemaKeys = new Set(requiredSchema.keys());
  const unexpectedSchema = entries.filter((entry) => !DATA_DESCRIPTORS.has(entry.descriptor) && !expectedSchemaKeys.has(entry.definition));
  if (unexpectedSchema.length) throw new Error("PostgreSQL archive TOC contains an unexpected schema object.");
  const tableDefinitions = new Set(entries.filter((entry) => entry.descriptor === "TABLE").map((entry) => entry.definition));
  const requiredAlphaTables = Array.isArray(options.requiredAlphaTables) ? [...options.requiredAlphaTables] : [...FULL_BACKUP_ALPHA_TABLES];
  for (const table of requiredAlphaTables) {
    if (!tableDefinitions.has(entryDefinition("TABLE", "public", table))) throw new Error(`PostgreSQL archive TOC is missing required public.${table}.`);
    if (!actual.has(entryDefinition("TABLE DATA", "public", table))) throw new Error(`PostgreSQL archive TOC is missing required data for public.${table}.`);
  }
  if (!entries.some((entry) => entry.descriptor === "SCHEMA" && entry.fields[1] === "dune")) throw new Error("PostgreSQL archive TOC is missing the dune schema.");
  return { valid: true, validationProfile: expectedInventory.validationProfile, duneSchema: true, requiredAlphaTables, requiredExtensions: expectedInventory.requiredExtensions || [], schemaEntryCount: decimalString(expectedInventory.schemaEntryCount, "schema entry count"), dataEntryCount: decimalString(expectedInventory.dataEntryCount, "data entry count") };
}

async function verifyMatchingArchive(options) {
  if (typeof options?.listArchive !== "function" || typeof options?.readArchive !== "function") throw new Error("Matching-version archive validators are required.");
  const toc = await options.listArchive();
  await options.readArchive();
  return { toc: String(toc || ""), archiveReadVerified: true };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let bytes = 0n;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) { bytes += BigInt(chunk.length); hash.update(chunk); }
  return { size: bytes.toString(10), sha256: hash.digest("hex") };
}

async function readHeader(filePath, length = 8) {
  const handle = await fs.promises.open(filePath, "r");
  try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

async function writeJsonAtomic(filePath, value) {
  const finalPath = path.resolve(filePath);
  const partialPath = `${finalPath}.partial-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(partialPath, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const handle = await fs.promises.open(partialPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(partialPath, finalPath);
  } catch (error) { await fs.promises.rm(partialPath, { force: true }).catch(() => {}); throw error; }
  return finalPath;
}

module.exports = {
  BACKUP_INVENTORY_PROFILES,
  DATA_DESCRIPTORS,
  FULL_BACKUP_ALPHA_TABLES,
  artifactReferences,
  buildExpectedBackupInventory,
  descriptorCounts,
  decimalString,
  hashFile,
  operationPhase,
  parsePgRestoreToc,
  readHeader,
  resolveVendorArtifactIdentity,
  validateFullBackupToc,
  validatePgDumpHeader,
  validateStableSamples,
  validateSchemaOnlyBackupToc,
  validateVendorTerminalOperation,
  verifyMatchingArchive,
  writeJsonAtomic
};
