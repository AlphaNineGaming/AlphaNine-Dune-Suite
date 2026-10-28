"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const { providerId } = require("./foundation");
const TARGET_KEYS = Object.freeze(["vmName", "vmIp", "sshHost", "sshUser", "sshKey", "sshPort", "sshKnownHostsPath", "remoteRuntimeRoot", "remoteDeployment", "remoteDatabaseEnabled", "remoteDatabaseHost", "remoteDatabasePort", "remoteDatabaseName", "remoteDatabaseUser", "remoteDatabasePassword", "remoteDatabaseCaPath", "databaseHost", "databasePort", "databaseName", "databaseUser", "databasePassword", "serverInstallPath", "awakeningServerPath", "selectedBattlegroup", "receiverHost", "receiverPort", "receiverSshHost", "receiverSshUser", "receiverSshKey", "receiverToken", "adminGiveItemToken", "teleportEndpointPath", "teleportCommandTemplate", "teleportPayloadTemplate"]);
function targetIdentity(config) {
  let provider; try { provider = providerId(config); } catch { provider = "unsupported:" + String(config?.serverType); }
  return crypto.createHash("sha256").update(JSON.stringify([provider, ...TARGET_KEYS.map(key => key === "selectedBattlegroup" ? [config?.[key]?.namespace ?? null, config?.[key]?.name ?? null] : config?.[key] ?? null)])).digest("hex");
}
const clone = value => JSON.parse(JSON.stringify(value));
function createTargetBindings({ activeOperations = () => 0 } = {}) {
  const storage = new AsyncLocalStorage(), leases = new Set();
  return Object.freeze({
    current: () => storage.getStore(),
    assertCurrent(config) { const pinned = storage.getStore(); if (pinned && targetIdentity(pinned) !== targetIdentity(config)) throw new Error("operation_target_changed"); },
    assertChange(current, next) { if (targetIdentity(current) !== targetIdentity(next) && (leases.size || activeOperations())) throw new Error("Finish active provider reads and Suite operations before changing provider, target, credentials or runtime scope."); },
    async run(config, callback) {
      const pinned = clone(config), lease = Symbol("target"); leases.add(lease);
      try { return await storage.run(pinned, callback); } finally { leases.delete(lease); }
    },
    activeCount: () => leases.size
  });
}
module.exports = { TARGET_KEYS, targetIdentity, createTargetBindings };
