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
const encode = JSON.stringify;
const exchange = [{ name: "heartbeats", type: "direct" }];
const binding = { source_name: "heartbeats", destination_name: "amq.gen-player-session", destination_kind: "queue", routing_key: "notifications" };
const activeQueues = [{ name: binding.destination_name, consumers: 1 }];
const check = (queues = activeQueues, bindings = [binding], exchanges = exchange) =>
  assertTeleportConsumerReady(encode(queues), encode(bindings), encode(exchanges));
assert.deepEqual(check().queues, [binding.destination_name], "Routing key is not the queue name");
assert.throws(() => check([{ name: "notifications", consumers: 2 }]), /no active consumer/, "Unbound same-name queues cannot make the route ready");
assert.throws(() => check([{ name: binding.destination_name, consumers: 0 }]), /no active consumer/);
assert.throws(() => check(activeQueues, []), /no bound destination/);
assert.throws(() => check(activeQueues, [{ ...binding, source_name: "other" }]), /no bound destination/);
assert.throws(() => check(activeQueues, [{ ...binding, routing_key: "other" }]), /no bound destination/);
assert.doesNotThrow(() => check(activeQueues, [{ ...binding, routing_key: "ignored" }], [{ name: "heartbeats", type: "fanout" }]));
for (const pattern of ["notifications", "*", "#", "#.notifications", "notifications.#"]) {
  assert.doesNotThrow(() => check(activeQueues, [{ ...binding, routing_key: pattern }], [{ name: "heartbeats", type: "topic" }]));
}
assert.throws(() => check(activeQueues, [{ ...binding, routing_key: "notifications.*" }], [{ name: "heartbeats", type: "topic" }]), /no bound destination/);
assert.doesNotThrow(() => check(activeQueues, [
  { ...binding, destination_kind: "exchange", destination_name: "forward" },
  { ...binding, source_name: "forward" },
  { ...binding, source_name: "forward", destination_kind: "exchange", destination_name: "heartbeats" }
], [...exchange, { name: "forward", type: "direct" }]));
assert.throws(() => check(activeQueues, [binding], []), /missing or has unsupported type/);
assert.throws(() => assertTeleportConsumerReady("connection refused", "[]", "[]"), /invalid queue status/);
assert.throws(() => assertTeleportConsumerReady("[]", "bad", "[]"), /invalid binding status/);

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const receiver = fs.readFileSync(path.join(root, "receivers/dune-live-give-receiver.js"), "utf8");
function extract(source, name, nextName) {
  return source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`\n${nextName}`, source.indexOf(`async function ${name}(`)));
}

async function main() {
  let reachable = true;
  let capability = 2;
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
  assert.equal((await context.liveMapTeleportStatus()).canTeleport, false, "1.3.14 receivers need restart before using corrected routing checks");
  capability = 2;
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
