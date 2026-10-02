const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { assertTeleportPodReady, assertTeleportConsumerReady } = require("../lib/teleport-readiness");

const bg = { namespace: "selected", name: "sh-test" };
const target = { namespace: bg.namespace, pod: "sh-test-mq-game-sts-0" };
const pod = { metadata: { namespace: target.namespace, name: target.pod }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
assert.doesNotThrow(() => assertTeleportPodReady(pod, target, bg));
assert.throws(() => assertTeleportPodReady(pod, target, { ...bg, namespace: "other" }), /selected battlegroup/);
assert.throws(() => assertTeleportPodReady({ ...pod, metadata: { ...pod.metadata, deletionTimestamp: "now" } }, target, bg), /not ready/);
assert.throws(() => assertTeleportPodReady({ ...pod, status: { phase: "Running", conditions: [] } }, target, bg), /not ready/);
assert.doesNotThrow(() => assertTeleportConsumerReady('[{"name":"notifications","consumers":1}]'));
for (const value of ['[]', '[{"name":"notifications","consumers":0}]', '[{"name":"other","consumers":2}]']) {
  assert.throws(() => assertTeleportConsumerReady(value), /no active game consumer/);
}
assert.throws(() => assertTeleportConsumerReady("connection refused"), /invalid queue status/);

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const receiver = fs.readFileSync(path.join(root, "receivers/dune-live-give-receiver.js"), "utf8");
function extract(source, name, nextName) {
  return source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`\n${nextName}`, source.indexOf(`async function ${name}(`)));
}

async function main() {
  let reachable = true;
  let capability = 1;
  const context = {
    loadConfig: () => ({ liveTeleportEnabled: true, teleportEndpointPath: "/teleport", teleportPayloadTemplate: "{}" }),
    liveGiveServerAvailability: () => { throw new Error("CLI must not be invoked"); },
    receiverStatus: async () => ({ ok: reachable, healthUrl: "local", health: {} }),
    receiverHealthJson: async () => ({ data: { ok: true, config: { teleport: { dispatchReadinessVersion: capability } } } }),
    teleportReceiverUrl: () => "local"
  };
  vm.createContext(context);
  vm.runInContext(extract(server, "liveMapTeleportStatus", "async function liveMapTeleportExecute"), context);
  assert.equal((await context.liveMapTeleportStatus()).canTeleport, true);
  capability = undefined;
  assert.equal((await context.liveMapTeleportStatus()).canTeleport, false, "Old receivers must not bypass readiness checks");
  capability = 1;
  reachable = false;
  assert.equal((await context.liveMapTeleportStatus()).canTeleport, false);

  let dbCalls = 0, mqCalls = 0, failMq = false;
  const dispatch = {
    isExplicitOfflinePlayerStatus: value => value === "offline",
    logReceiver: () => {},
    updateOfflinePlayerPosition: async () => { dbCalls++; return { partitionId: 1 }; },
    publishTeleport: async () => { mqCalls++; if (failMq) throw new Error("no active game consumer"); return {}; }
  };
  vm.createContext(dispatch);
  vm.runInContext(extract(receiver, "processTeleportCoords", "function isExplicitOfflinePlayerStatus"), dispatch);
  assert.equal((await dispatch.processTeleportCoords({ playerOnlineStatus: "offline" })).path, "db");
  assert.equal(mqCalls, 0);
  assert.equal((await dispatch.processTeleportCoords({ playerOnlineStatus: "online" })).path, "rmq");
  failMq = true;
  await assert.rejects(dispatch.processTeleportCoords({ playerOnlineStatus: "online" }), /no active game consumer/);
  await assert.rejects(dispatch.processTeleportCoords({ playerOnlineStatus: "unknown" }), /no active game consumer/);
  assert.equal(dbCalls, 1, "Transport failures must not write offline player data");

  let publishes = 0;
  const online = {
    resolveBattlegroup: async () => bg,
    resolveMqTarget: async () => target,
    verifyTeleportTransport: async () => { throw new Error("messaging pod is not ready"); },
    buildTeleportServerCommand: () => { publishes++; return {}; }
  };
  vm.createContext(online);
  vm.runInContext(extract(receiver, "publishTeleport", "async function verifyTeleportTransport"), online);
  await assert.rejects(online.publishTeleport({}), /messaging pod is not ready/);
  assert.equal(publishes, 0, "Readiness failure must block publishing");
  console.log("Teleport readiness regression tests passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
