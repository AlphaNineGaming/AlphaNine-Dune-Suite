"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ADDRESS_FIELDS, CONFIRMATION, approvalDigest, atomicReplacePair, buildReboundFiles, parsePinnedEd25519 } = require("../lib/migration-vm-ip-reconciliation");

assert.equal(CONFIRMATION, "REBIND VERIFIED MIGRATION VM ADDRESS");
const oldAddress = "192.0.2.10";
const newAddress = "192.0.2.44";
const keyBlob = "A".repeat(68);
const config = { setupComplete: true, vmName: "dune-awakening-migration-test", sshHost: oldAddress, vmIp: oldAddress, receiverSshHost: oldAddress, databasePassword: "must-remain-byte-identical", selectedBattlegroup: { namespace: "test-only", name: "destination" } };
const configText = `${JSON.stringify(config, null, 2)}\n`;
const knownHostsText = `${oldAddress} ssh-ed25519 ${keyBlob}\n`;
const built = buildReboundFiles({ configText, knownHostsText, detectedIp: newAddress });
const after = JSON.parse(built.nextConfigText);
for (const field of ADDRESS_FIELDS) assert.equal(after[field], newAddress);
for (const key of Object.keys(config).filter((name) => !ADDRESS_FIELDS.includes(name))) assert.deepEqual(after[key], config[key]);
assert.equal(parsePinnedEd25519(built.nextKnownHostsText).address, newAddress);
assert.equal(parsePinnedEd25519(built.nextKnownHostsText).keyBlob, keyBlob);
assert.throws(() => buildReboundFiles({ configText: configText.replace('"sshHost"', '"missingSshHost"'), knownHostsText, detectedIp: newAddress }), /must occur exactly once/);
assert.throws(() => parsePinnedEd25519(`${knownHostsText}${oldAddress} ssh-ed25519 ${keyBlob}\n`), /Exactly one/);
assert.match(approvalDigest({ vmId: "vm-identity", mac: "001122334455", vmName: config.vmName, detectedIp: newAddress, savedIp: oldAddress, pinnedKeySha256: built.pinnedKeySha256 }), /^[a-f0-9]{64}$/);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-migration-vm-ip-"));
try {
  const configPath = path.join(scratch, "config.json");
  const keys = path.join(scratch, "keys");
  const knownHostsPath = path.join(keys, "known_hosts-test");
  const journalPath = path.join(scratch, "reconcile.json");
  fs.mkdirSync(keys);
  fs.writeFileSync(configPath, configText);
  fs.writeFileSync(knownHostsPath, knownHostsText);
  atomicReplacePair({ configPath, knownHostsPath, nextConfigText: built.nextConfigText, nextKnownHostsText: built.nextKnownHostsText, journalPath });
  assert.equal(fs.readFileSync(configPath, "utf8"), built.nextConfigText);
  assert.equal(fs.readFileSync(knownHostsPath, "utf8"), built.nextKnownHostsText);
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(fs.readdirSync(scratch).filter((name) => /\.next-|\.previous-/.test(name)), []);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.match(server, /StrictHostKeyChecking=yes/);
const connectionSource = server.slice(server.indexOf("async function migrationSshConnection"), server.indexOf("async function migrationSshCommand"));
assert.doesNotMatch(connectionSource, /StrictHostKeyChecking=accept-new/);
assert.match(server, /migration_vm_ip_rebind_required/);
assert.match(server, /\/api\/server-migration\/vm-ip-reconciliation/);

console.log("Migration-safe Hyper-V DHCP reconciliation, exact field boundary, pinned-key preservation, and atomic publication tests passed.");
