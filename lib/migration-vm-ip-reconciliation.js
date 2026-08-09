"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIRMATION = "REBIND VERIFIED MIGRATION VM ADDRESS";
const ADDRESS_FIELDS = Object.freeze(["sshHost", "vmIp", "receiverSshHost"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeIpv4(value) {
  const text = String(value || "").trim();
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return "";
  return parts.map((part) => String(Number(part))).join(".");
}

function parsePinnedEd25519(knownHostsText) {
  const rows = String(knownHostsText || "").split(/\r?\n/);
  const matches = rows.map((line, index) => ({ line, index, parts: line.trim().split(/\s+/) }))
    .filter(({ parts }) => parts.length >= 3 && parts[1] === "ssh-ed25519");
  if (matches.length !== 1) throw new Error("Exactly one pinned ED25519 migration host-key entry is required.");
  const match = matches[0];
  if (!match.parts[0] || /[,|]/.test(match.parts[0])) throw new Error("The pinned migration host-key address is not a single explicit host.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(match.parts[2])) throw new Error("The pinned ED25519 migration host key is malformed.");
  return { address: match.parts[0], keyType: match.parts[1], keyBlob: match.parts[2], lineIndex: match.index, rows };
}

function replaceJsonStringFieldOnce(text, field, value) {
  const pattern = new RegExp(`(\\"${field}\\"\\s*:\\s*)\\"(?:[^\\"\\\\]|\\\\.)*\\"`, "g");
  const matches = [...String(text).matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Configuration field ${field} must occur exactly once.`);
  return String(text).replace(pattern, `$1${JSON.stringify(value)}`);
}

function buildReboundFiles({ configText, knownHostsText, detectedIp }) {
  const address = normalizeIpv4(detectedIp);
  if (!address) throw new Error("The authoritative Hyper-V IPv4 address is invalid.");
  const before = JSON.parse(String(configText || ""));
  let nextConfigText = String(configText);
  for (const field of ADDRESS_FIELDS) nextConfigText = replaceJsonStringFieldOnce(nextConfigText, field, address);
  const after = JSON.parse(nextConfigText);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const differences = [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (differences.length !== ADDRESS_FIELDS.length || ADDRESS_FIELDS.some((field) => !differences.includes(field))) {
    throw new Error("Migration VM address reconciliation attempted to change unrelated configuration fields.");
  }
  if (ADDRESS_FIELDS.some((field) => after[field] !== address)) throw new Error("Migration VM address reconciliation did not update all required fields.");

  const pinned = parsePinnedEd25519(knownHostsText);
  const rows = [...pinned.rows];
  const original = rows[pinned.lineIndex];
  rows[pinned.lineIndex] = original.replace(/^\s*\S+/, address);
  const trailingNewline = /\r?\n$/.test(String(knownHostsText || ""));
  const newline = String(knownHostsText || "").includes("\r\n") ? "\r\n" : "\n";
  const nextKnownHostsText = rows.join(newline).replace(new RegExp(`${newline}$`), "") + (trailingNewline ? newline : "");
  const rebound = parsePinnedEd25519(nextKnownHostsText);
  if (rebound.address !== address || rebound.keyBlob !== pinned.keyBlob) throw new Error("Pinned migration host-key identity changed during address reconciliation.");
  return { address, before, after, nextConfigText, nextKnownHostsText, pinnedKeySha256: sha256(Buffer.from(pinned.keyBlob, "utf8")) };
}

function fsyncPath(filePath) {
  const descriptor = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeExclusive(filePath, data, mode) {
  const descriptor = fs.openSync(filePath, "wx", mode);
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeRemove(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch {}
}

function atomicReplacePair({ configPath, knownHostsPath, nextConfigText, nextKnownHostsText, journalPath }) {
  const configOriginal = fs.readFileSync(configPath);
  const hostsOriginal = fs.readFileSync(knownHostsPath);
  const configMode = fs.statSync(configPath).mode & 0o777;
  const hostsMode = fs.statSync(knownHostsPath).mode & 0o777;
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const configNext = `${configPath}.next-${suffix}`;
  const hostsNext = `${knownHostsPath}.next-${suffix}`;
  const configPrevious = `${configPath}.previous-${suffix}`;
  const hostsPrevious = `${knownHostsPath}.previous-${suffix}`;
  const journalNext = `${journalPath}.next-${suffix}`;
  const journal = { version: 1, active: true, phase: "prepared", createdAt: new Date().toISOString(), configSha256: sha256(configOriginal), knownHostsSha256: sha256(hostsOriginal) };
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    writeExclusive(configNext, Buffer.from(nextConfigText, "utf8"), configMode);
    writeExclusive(hostsNext, Buffer.from(nextKnownHostsText, "utf8"), hostsMode);
    writeExclusive(journalNext, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"), 0o600);
    fs.renameSync(journalNext, journalPath);
    fsyncPath(journalPath);
    fs.renameSync(configPath, configPrevious);
    fs.renameSync(configNext, configPath);
    fs.renameSync(knownHostsPath, hostsPrevious);
    fs.renameSync(hostsNext, knownHostsPath);
    fsyncPath(configPath);
    fsyncPath(knownHostsPath);
    const verifiedConfig = fs.readFileSync(configPath, "utf8");
    const verifiedHosts = fs.readFileSync(knownHostsPath, "utf8");
    if (verifiedConfig !== nextConfigText || verifiedHosts !== nextKnownHostsText) throw new Error("Migration VM address files failed read-back verification.");
    safeRemove(configPrevious);
    safeRemove(hostsPrevious);
    safeRemove(journalPath);
    return { configSha256: sha256(Buffer.from(verifiedConfig)), knownHostsSha256: sha256(Buffer.from(verifiedHosts)) };
  } catch (error) {
    try {
      if (fs.existsSync(configPrevious)) {
        safeRemove(configPath);
        fs.renameSync(configPrevious, configPath);
      } else if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, configOriginal, { mode: configMode });
      if (fs.existsSync(hostsPrevious)) {
        safeRemove(knownHostsPath);
        fs.renameSync(hostsPrevious, knownHostsPath);
      } else if (!fs.existsSync(knownHostsPath)) fs.writeFileSync(knownHostsPath, hostsOriginal, { mode: hostsMode });
    } catch {}
    throw error;
  } finally {
    for (const temporary of [configNext, hostsNext, configPrevious, hostsPrevious, journalNext]) safeRemove(temporary);
  }
}

function approvalDigest({ vmId, mac, vmName, detectedIp, savedIp, pinnedKeySha256 }) {
  const value = { version: 1, vmId: String(vmId || "").toLowerCase(), mac: String(mac || "").toLowerCase(), vmName: String(vmName || ""), detectedIp: normalizeIpv4(detectedIp), savedIp: normalizeIpv4(savedIp), pinnedKeySha256: String(pinnedKeySha256 || "").toLowerCase() };
  if (!value.vmId || !value.mac || !value.vmName || !value.detectedIp || !value.savedIp || !/^[a-f0-9]{64}$/.test(value.pinnedKeySha256)) throw new Error("Migration VM identity evidence is incomplete.");
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

module.exports = { ADDRESS_FIELDS, CONFIRMATION, approvalDigest, atomicReplacePair, buildReboundFiles, normalizeIpv4, parsePinnedEd25519, sha256 };
