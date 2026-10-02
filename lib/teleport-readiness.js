"use strict";

// Read-only evidence from the same Kubernetes target used for dispatch.
function assertTeleportPodReady(pod, target, battlegroup) {
  if (target.namespace !== battlegroup.namespace || !target.pod.startsWith(`${battlegroup.name}-`)) {
    throw new Error("Teleport messaging target does not belong to the selected battlegroup.");
  }
  if (pod?.metadata?.name !== target.pod || pod?.metadata?.namespace !== target.namespace) {
    throw new Error("Could not verify the selected teleport messaging pod.");
  }
  if (pod.metadata.deletionTimestamp || pod.status?.phase !== "Running" ||
      !pod.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True")) {
    throw new Error("Teleport messaging pod is not ready. Check its current Kubernetes status.");
  }
}

function readRows(text, label) {
  let rows;
  try { rows = JSON.parse(String(text)); }
  catch { throw new Error(`Could not verify teleport transport: RabbitMQ returned invalid ${label}.`); }
  if (!Array.isArray(rows)) throw new Error(`Could not verify teleport transport: RabbitMQ ${label} is missing.`);
  return rows;
}

function topicMatches(pattern, key) {
  const words = String(pattern).split("."), parts = String(key).split(".");
  const memo = new Map();
  function match(i, j) {
    const id = `${i}:${j}`;
    if (memo.has(id)) return memo.get(id);
    const result = i === words.length ? j === parts.length
      : words[i] === "#" ? match(i + 1, j) || (j < parts.length && match(i, j + 1))
      : j < parts.length && (words[i] === "*" || words[i] === parts[j]) && match(i + 1, j + 1);
    memo.set(id, result);
    return result;
  }
  return match(0, 0);
}

function assertTeleportConsumerReady(queueText, bindingText, exchangeText) {
  const queues = readRows(queueText, "queue status");
  const bindings = readRows(bindingText, "binding status");
  const exchanges = new Map(readRows(exchangeText, "exchange status").map(row => [row.name, row.type]));
  const pending = ["heartbeats"], visited = new Set(), destinations = new Set();
  while (pending.length) {
    const source = pending.pop();
    if (visited.has(source)) continue;
    visited.add(source);
    const type = exchanges.get(source);
    if (!["direct", "topic", "fanout"].includes(type)) {
      throw new Error(`Could not verify teleport route: exchange ${source} is missing or has unsupported type ${type || "unknown"}.`);
    }
    for (const binding of bindings.filter(row => row.source_name === source)) {
      const matches = type === "fanout" || (type === "direct" ? binding.routing_key === "notifications" : topicMatches(binding.routing_key, "notifications"));
      if (!matches) continue;
      if (binding.destination_kind === "queue") destinations.add(binding.destination_name);
      else if (binding.destination_kind === "exchange") pending.push(binding.destination_name);
    }
  }
  if (!destinations.size) throw new Error("Teleport route heartbeats / notifications has no bound destination queue.");
  const active = queues.filter(row => destinations.has(row.name) && Number.isInteger(row.consumers) && row.consumers > 0);
  if (!active.length) throw new Error("Teleport route heartbeats / notifications has no active consumer on its bound destination queues.");
  return { exchange: "heartbeats", routingKey: "notifications", queues: active.map(row => row.name) };
}

module.exports = { assertTeleportPodReady, assertTeleportConsumerReady, topicMatches };
