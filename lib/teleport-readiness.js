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

function assertTeleportConsumerReady(text) {
  let queues;
  try { queues = JSON.parse(String(text)); }
  catch { throw new Error("Could not verify teleport transport: RabbitMQ returned invalid queue status."); }
  if (!Array.isArray(queues)) throw new Error("Could not verify teleport transport: RabbitMQ queue status is missing.");
  const queue = queues.find(row => row.name === "notifications");
  if (!queue || !Number.isInteger(queue.consumers) || queue.consumers < 1) {
    throw new Error("Teleport command queue has no active game consumer. The game command transport is not ready.");
  }
}

module.exports = { assertTeleportPodReady, assertTeleportConsumerReady };
