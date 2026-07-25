"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  buildServerHealthReport,
  kubernetesQuantityBytes,
  parseHostMetrics,
  redactHealthText
} = require("../lib/server-health");

const now = "2026-07-25T18:00:00.000Z";
const namespace = "funcom-seabass-sh-test";
const meta = (name, namespaceValue = namespace, created = "2026-07-25T16:00:00.000Z") => ({
  name,
  namespace: namespaceValue,
  creationTimestamp: created
});
const jsonResult = (items) => ({ ok: true, stdout: JSON.stringify({ items }), durationMs: 8 });
const container = (name, overrides = {}) => ({
  name,
  ready: true,
  restartCount: 0,
  state: { running: { startedAt: "2026-07-25T16:00:00.000Z" } },
  ...overrides
});
const pod = (name, containers, overrides = {}) => ({
  kind: "Pod",
  metadata: meta(name),
  spec: { nodeName: "dune-node" },
  status: {
    phase: "Running",
    containerStatuses: containers,
    conditions: [{ type: "PodScheduled", status: "True" }],
    ...overrides
  }
});
const workload = (kind, name, expected = 1, ready = 1) => ({
  kind,
  metadata: meta(name),
  spec: { replicas: expected },
  status: kind === "DaemonSet"
    ? { desiredNumberScheduled: expected, numberReady: ready, numberAvailable: ready, updatedNumberScheduled: ready }
    : { readyReplicas: ready, availableReplicas: ready, updatedReplicas: ready }
});
const servicePair = (name) => ([
  { kind: "Service", metadata: meta(name), spec: {} },
  { kind: "Endpoints", metadata: meta(name), subsets: [{ addresses: [{ ip: "10.0.0.2" }] }] }
]);

function healthyInput() {
  return {
    checkedAt: now,
    durationMs: 50,
    selectedBattlegroup: { namespace, name: "sh-test", title: "Test Server" },
    vm: { exists: true, state: "Running", name: "Dune VM", ip: "192.0.2.10" },
    ssh: { ok: true, stdout: "ALPHANINE_HEALTH_SSH_OK\n", durationMs: 4 },
    database: { ok: true, message: "Database reachable." },
    receiver: { ok: true, status: "Online", managed: true },
    marketBot: { installed: false, status: "Not Installed" },
    commandResults: {
      version: { ok: true, stdout: JSON.stringify({ serverVersion: { gitVersion: "v1.32.0" } }), durationMs: 5 },
      nodes: jsonResult([{
        kind: "Node",
        metadata: meta("dune-node", "", "2026-07-20T00:00:00.000Z"),
        status: {
          conditions: [
            { type: "Ready", status: "True" },
            { type: "MemoryPressure", status: "False" },
            { type: "DiskPressure", status: "False" },
            { type: "PIDPressure", status: "False" }
          ],
          nodeInfo: { kubeletVersion: "v1.32.0", operatingSystem: "linux", architecture: "amd64" },
          capacity: { cpu: "8", memory: "16Gi", pods: "110" },
          allocatable: { cpu: "7800m", memory: "15Gi", pods: "110" }
        }
      }]),
      namespaces: jsonResult([{ kind: "Namespace", metadata: meta(namespace, ""), status: { phase: "Active" } }]),
      pods: jsonResult([
        pod("postgres-0", [container("postgres")]),
        pod("sh-test-mq-game-sts-0", [container("rabbitmq")]),
        pod("dune-server-0", [container("dune-server"), container("sidecar")])
      ]),
      workloads: jsonResult([
        workload("StatefulSet", "postgres", 1, 1),
        workload("StatefulSet", "sh-test-mq-game-sts", 1, 1),
        workload("Deployment", "dune-server", 1, 1),
        workload("DaemonSet", "pghero-agent", 1, 1)
      ]),
      networking: jsonResult([
        ...servicePair("postgres"),
        ...servicePair("sh-test-mq-game-svc"),
        ...servicePair("dune-server")
      ]),
      pvcs: jsonResult([{
        kind: "PersistentVolumeClaim",
        metadata: meta("postgres-data"),
        spec: { storageClassName: "local-path", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "20Gi" } }, volumeName: "pvc-1" },
        status: { phase: "Bound", capacity: { storage: "20Gi" } }
      }]),
      events: jsonResult([]),
      nodeMetrics: { ok: false, stderr: "Metrics API not available", durationMs: 10 },
      podMetrics: { ok: false, stderr: "Metrics API not available", durationMs: 10 },
      hostMetrics: { ok: true, stdout: "CPU 82.5\nMEM 16777216 8388608\nDISK 104857600 52428800 52428800 50% /\nLOAD 0.40 0.35 0.30\nUPTIME 86400\n", durationMs: 6 }
    }
  };
}

const healthy = buildServerHealthReport(healthyInput());
assert.equal(healthy.state, "Healthy", "Unavailable Kubernetes metrics must not lower otherwise healthy server state.");
assert.equal(healthy.resources.metricsServer.status, "Unavailable");
assert.equal(healthy.summary.namespaces, 1);
assert.equal(healthy.summary.pods, 3);
assert.equal(healthy.summary.containers, 4);
assert.equal(healthy.summary.readyContainers, 4);
assert.equal(healthy.services.postgres.state, "Healthy");
assert.equal(healthy.services.rabbitmq.state, "Healthy");
assert.equal(healthy.services.dune.state, "Healthy");
assert.equal(healthy.storage.totalCapacityBytes, 20 * 1024 ** 3);
assert.equal(healthy.nodes[0].ready, true);
assert.equal(healthy.nodes[0].metrics, null);
const permissionLimitedInput = healthyInput();
permissionLimitedInput.vm = { exists: false, state: "Unknown", error: "Hyper-V access denied. Run as Administrator." };
const permissionLimited = buildServerHealthReport(permissionLimitedInput);
assert.equal(permissionLimited.connectivity.hyperv.state, "Unknown", "A permission-limited Hyper-V check must not falsely report Offline.");
assert.equal(permissionLimited.state, "Healthy", "Reachable SSH and Kubernetes remain authoritative when Hyper-V inspection is permission-limited.");

const brokenInput = healthyInput();
brokenInput.commandResults.pods = jsonResult([
  pod("postgres-0", [container("postgres")]),
  pod("rabbitmq-0", [container("rabbitmq")]),
  pod("dune-server-0", [
    container("dune-server", {
      ready: false,
      restartCount: 7,
      state: { waiting: { reason: "CrashLoopBackOff", message: "password=supersecret retrying" } },
      lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-07-25T17:59:00.000Z" } }
    })
  ]),
  pod("unscheduled-worker", [container("worker", { ready: false, state: { waiting: { reason: "ContainerCreating" } } })], {
    phase: "Pending",
    conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes have insufficient memory" }]
  }),
  pod("completed-job", [container("job", { ready: false, state: { terminated: { reason: "Completed", exitCode: 0 } } })], { phase: "Succeeded" })
]);
brokenInput.commandResults.workloads = jsonResult([
  workload("Deployment", "dune-server", 2, 0),
  workload("StatefulSet", "postgres", 1, 1),
  workload("StatefulSet", "rabbitmq", 1, 1)
]);
brokenInput.commandResults.events = jsonResult([{
  kind: "Event",
  metadata: meta("dune-warning"),
  reason: "Unhealthy",
  message: "Readiness probe failed: token=do-not-show",
  involvedObject: { kind: "Pod", name: "dune-server-0" },
  lastTimestamp: "2026-07-25T17:59:30.000Z",
  count: 4
}]);
const broken = buildServerHealthReport(brokenInput);
assert.equal(broken.state, "Unhealthy");
assert.equal(broken.summary.restarts, 7);
assert.equal(broken.pods.find((entry) => entry.name === "dune-server-0").reason, "dune-server: CrashLoopBackOff");
assert.equal(broken.pods.find((entry) => entry.name === "dune-server-0").containers[0].lastTerminationReason, "OOMKilled");
assert.match(broken.pods.find((entry) => entry.name === "unscheduled-worker").reason, /insufficient memory/);
assert.equal(broken.pods.find((entry) => entry.name === "completed-job").phase, "Succeeded");
assert.equal(broken.workloads.find((entry) => entry.name === "dune-server").state, "Unhealthy");
assert.equal(broken.warnings[0].message.includes("do-not-show"), false);

assert.equal(kubernetesQuantityBytes("1.5Gi"), Math.round(1.5 * 1024 ** 3));
assert.equal(parseHostMetrics("MEM 1000 250\nDISK 1000 750 250 75% /\n").memory.percent, 75);
assert.equal(redactHealthText("postgres://admin:hunter2@db/game password=abc token=xyz").includes("hunter2"), false);

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert(serverSource.includes('"/api/server-health"'), "Server Health API route is missing.");
assert(serverSource.includes('id="server-health"'), "Server Health page is missing.");
assert(serverSource.includes("serverHealthScanInFlight"), "Server Health backend single-flight guard is missing.");
assert(serverSource.includes("serverHealthRefreshInFlight"), "Server Health UI overlap guard is missing.");
assert(serverSource.includes("Promise.all(["), "Server Health checks are not concurrent.");
assert(serverSource.includes("Refresh Health"), "Server Health manual refresh is missing.");
assert(serverSource.includes("serverHealthAutoRefresh"), "Server Health auto-refresh control is missing.");
const scanSource = serverSource.slice(serverSource.indexOf("async function runServerHealthScan"), serverSource.indexOf("function serverHealthSnapshot"));
assert(!/\bkubectl\s+(apply|patch|delete|edit|replace|rollout|scale)\b/i.test(scanSource), "Server Health must not mutate Kubernetes resources.");
assert(!/\b(rc-service|systemctl|service)\b.*\b(restart|start|stop)\b/i.test(scanSource), "Server Health must not modify services.");

console.log("Server Health parser, safety, redaction, metrics-neutrality, and UI/API wiring tests passed.");
