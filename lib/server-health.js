"use strict";

const HEALTH_STATES = Object.freeze(["Healthy", "Degraded", "Unhealthy", "Offline", "Unknown"]);
const SEVERE_CONTAINER_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "OOMKilled"
]);
const RELEVANT_WARNING_REASONS = new Set([
  "BackOff",
  "Failed",
  "FailedAttachVolume",
  "FailedCreate",
  "FailedMount",
  "FailedScheduling",
  "FailedToRetrieveImagePullSecret",
  "ImagePullBackOff",
  "NodeNotReady",
  "OOMKilling",
  "ProbeWarning",
  "Unhealthy",
  "VolumeResizeFailed"
]);

function healthState(value) {
  const text = String(value || "").trim();
  return HEALTH_STATES.includes(text) ? text : "Unknown";
}

function redactHealthText(value, maxLength = 360) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1<redacted>@")
    .replace(/\b(password|passwd|token|secret|authorization|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\bPGPASSWORD=[^\s]+/gi, "PGPASSWORD=<redacted>");
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

function safeDate(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function ageLabel(value, nowMs = Date.now()) {
  const timestamp = safeDate(value);
  if (!timestamp) return "Unknown";
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function parseJsonResult(result, label) {
  if (!result || result.ok !== true) {
    return {
      ok: false,
      data: null,
      error: redactHealthText(result?.stderr || result?.error || `${label} check failed.`)
    };
  }
  try {
    return { ok: true, data: JSON.parse(String(result.stdout || "{}")), error: "" };
  } catch {
    return { ok: false, data: null, error: `${label} returned invalid JSON.` };
  }
}

function listItems(parsed) {
  return Array.isArray(parsed?.data?.items) ? parsed.data.items : [];
}

function objectName(item) {
  return String(item?.metadata?.name || "");
}

function objectNamespace(item) {
  return String(item?.metadata?.namespace || "");
}

function objectSearchText(item) {
  return [
    item?.kind,
    objectNamespace(item),
    objectName(item),
    ...Object.entries(item?.metadata?.labels || {}).flatMap(([key, value]) => [key, value])
  ].join(" ").toLowerCase();
}

function conditionByType(item, type) {
  return (item?.status?.conditions || []).find((condition) => condition.type === type) || null;
}

function parseNodes(items, metricsByNode, nowMs) {
  return items.map((item) => {
    const readyCondition = conditionByType(item, "Ready");
    const pressures = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"]
      .map((type) => conditionByType(item, type))
      .filter((condition) => condition?.status === "True")
      .map((condition) => condition.type);
    const ready = readyCondition?.status === "True";
    const state = ready ? (pressures.length ? "Degraded" : "Healthy") : "Unhealthy";
    const labels = item?.metadata?.labels || {};
    const roles = Object.keys(labels)
      .filter((key) => key.startsWith("node-role.kubernetes.io/"))
      .map((key) => key.replace("node-role.kubernetes.io/", ""))
      .filter(Boolean);
    const name = objectName(item);
    return {
      name,
      state,
      ready,
      status: ready ? "Ready" : "NotReady",
      roles,
      age: ageLabel(item?.metadata?.creationTimestamp, nowMs),
      kubeletVersion: String(item?.status?.nodeInfo?.kubeletVersion || ""),
      operatingSystem: String(item?.status?.nodeInfo?.operatingSystem || ""),
      architecture: String(item?.status?.nodeInfo?.architecture || ""),
      capacity: {
        cpu: String(item?.status?.capacity?.cpu || ""),
        memory: String(item?.status?.capacity?.memory || ""),
        pods: String(item?.status?.capacity?.pods || ""),
        ephemeralStorage: String(item?.status?.capacity?.["ephemeral-storage"] || "")
      },
      allocatable: {
        cpu: String(item?.status?.allocatable?.cpu || ""),
        memory: String(item?.status?.allocatable?.memory || ""),
        pods: String(item?.status?.allocatable?.pods || ""),
        ephemeralStorage: String(item?.status?.allocatable?.["ephemeral-storage"] || "")
      },
      pressures,
      reason: ready
        ? (pressures.length ? `${pressures.join(", ")} reported.` : "")
        : redactHealthText(readyCondition?.message || readyCondition?.reason || "Node is not ready."),
      metrics: metricsByNode.get(name) || null
    };
  });
}

function parseMetricsLines(text, kind) {
  const rows = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (kind === "nodes") {
    return rows.map((line) => {
      const parts = line.split(/\s+/);
      return parts.length >= 5
        ? { name: parts[0], cpu: parts[1], cpuPercent: parts[2], memory: parts[3], memoryPercent: parts[4] }
        : null;
    }).filter(Boolean);
  }
  return rows.map((line) => {
    const parts = line.split(/\s+/);
    return parts.length >= 5
      ? { namespace: parts[0], pod: parts[1], container: parts[2], cpu: parts[3], memory: parts[4] }
      : null;
  }).filter(Boolean);
}

function parseHostMetrics(text) {
  const result = {
    available: false,
    status: "Unavailable",
    cpuPercent: null,
    loadAverage: "",
    memory: null,
    disk: null,
    uptimeSeconds: null
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const [key, ...parts] = line.trim().split(/\s+/);
    if (key === "CPU") {
      const idle = Number(parts[0]);
      if (Number.isFinite(idle)) result.cpuPercent = Math.max(0, Math.min(100, Math.round((100 - idle) * 10) / 10));
    }
    if (key === "LOAD") result.loadAverage = parts.slice(0, 3).join(" ");
    if (key === "MEM") {
      const totalKb = Number(parts[0]);
      const availableKb = Number(parts[1]);
      if (Number.isFinite(totalKb) && totalKb > 0 && Number.isFinite(availableKb)) {
        const usedKb = Math.max(0, totalKb - availableKb);
        result.memory = {
          totalBytes: totalKb * 1024,
          usedBytes: usedKb * 1024,
          availableBytes: availableKb * 1024,
          percent: Math.round((usedKb / totalKb) * 1000) / 10
        };
      }
    }
    if (key === "DISK") {
      const totalKb = Number(parts[0]);
      const usedKb = Number(parts[1]);
      const availableKb = Number(parts[2]);
      const percent = Number(String(parts[3] || "").replace("%", ""));
      if ([totalKb, usedKb, availableKb].every(Number.isFinite)) {
        result.disk = {
          totalBytes: totalKb * 1024,
          usedBytes: usedKb * 1024,
          availableBytes: availableKb * 1024,
          percent: Number.isFinite(percent) ? percent : null,
          mount: parts[4] || "/"
        };
      }
    }
    if (key === "UPTIME") {
      const seconds = Number(parts[0]);
      if (Number.isFinite(seconds)) result.uptimeSeconds = Math.floor(seconds);
    }
  }
  result.available = Boolean(result.memory || result.disk || result.cpuPercent !== null || result.loadAverage);
  result.status = result.available ? "Available" : "Unavailable";
  return result;
}

function containerDetails(status, type) {
  const waiting = status?.state?.waiting || null;
  const running = status?.state?.running || null;
  const terminated = status?.state?.terminated || null;
  const lastTerminated = status?.lastState?.terminated || null;
  let state = "Unknown";
  let reason = "";
  let message = "";
  if (waiting) {
    state = "Waiting";
    reason = String(waiting.reason || "Waiting");
    message = redactHealthText(waiting.message || "");
  } else if (running) {
    state = "Running";
  } else if (terminated) {
    state = "Terminated";
    reason = String(terminated.reason || "Terminated");
    message = redactHealthText(terminated.message || "");
  }
  return {
    name: String(status?.name || ""),
    type,
    ready: Boolean(status?.ready),
    state,
    reason,
    message,
    restartCount: Number(status?.restartCount || 0),
    lastTerminationReason: String(lastTerminated?.reason || terminated?.reason || ""),
    lastExitCode: lastTerminated?.exitCode ?? terminated?.exitCode ?? null,
    lastFinishedAt: String(lastTerminated?.finishedAt || terminated?.finishedAt || "")
  };
}

function podEventKey(namespace, name) {
  return `${namespace}/${name}`;
}

function parseWarningEvents(items, nowMs) {
  return items.map((item) => {
    const lastSeen = item?.eventTime || item?.lastTimestamp || item?.series?.lastObservedTime || item?.metadata?.creationTimestamp || "";
    return {
      namespace: objectNamespace(item) || "cluster",
      reason: String(item?.reason || "Warning"),
      message: redactHealthText(item?.message || ""),
      objectKind: String(item?.involvedObject?.kind || ""),
      objectName: String(item?.involvedObject?.name || ""),
      count: Number(item?.series?.count || item?.count || 1),
      firstSeen: String(item?.firstTimestamp || item?.metadata?.creationTimestamp || ""),
      lastSeen: String(lastSeen),
      age: ageLabel(lastSeen, nowMs),
      recent: Boolean(safeDate(lastSeen) && nowMs - safeDate(lastSeen) <= 24 * 60 * 60 * 1000)
    };
  }).filter((event) => RELEVANT_WARNING_REASONS.has(event.reason) || /fail|backoff|unhealthy|oom|pull|schedul|mount|pressure/i.test(`${event.reason} ${event.message}`))
    .sort((a, b) => safeDate(b.lastSeen) - safeDate(a.lastSeen))
    .slice(0, 60);
}

function concisePodReason(item, containers, podWarnings) {
  const severe = containers.find((container) => SEVERE_CONTAINER_REASONS.has(container.reason));
  if (severe) return `${severe.name}: ${severe.reason || severe.lastTerminationReason}`;
  const scheduled = conditionByType(item, "PodScheduled");
  if (scheduled?.status === "False") return redactHealthText(scheduled.message || scheduled.reason || "Pod is not scheduled.");
  const initialized = conditionByType(item, "Initialized");
  if (initialized?.status === "False") return redactHealthText(initialized.message || initialized.reason || "Pod initialization failed.");
  if (item?.status?.reason) return redactHealthText(`${item.status.reason}: ${item.status.message || ""}`);
  const notReady = containers.find((container) => !container.ready && container.state !== "Terminated");
  if (notReady) {
    const relevantEvent = podWarnings.find((event) => event.recent);
    return relevantEvent
      ? `${relevantEvent.reason}: ${relevantEvent.message}`
      : `${notReady.name}: ${notReady.reason || notReady.state}`;
  }
  return "";
}

function parsePods(items, warnings, podMetrics, nowMs) {
  const warningsByPod = new Map();
  for (const event of warnings) {
    if (event.objectKind !== "Pod") continue;
    const key = podEventKey(event.namespace, event.objectName);
    if (!warningsByPod.has(key)) warningsByPod.set(key, []);
    warningsByPod.get(key).push(event);
  }
  const metricsByPod = new Map();
  for (const metric of podMetrics) {
    const key = podEventKey(metric.namespace, metric.pod);
    if (!metricsByPod.has(key)) metricsByPod.set(key, []);
    metricsByPod.get(key).push(metric);
  }
  return items.map((item) => {
    const namespace = objectNamespace(item);
    const name = objectName(item);
    const containers = [
      ...(item?.status?.initContainerStatuses || []).map((status) => containerDetails(status, "init")),
      ...(item?.status?.containerStatuses || []).map((status) => containerDetails(status, "container")),
      ...(item?.status?.ephemeralContainerStatuses || []).map((status) => containerDetails(status, "ephemeral"))
    ];
    const regularContainers = containers.filter((container) => container.type === "container");
    const readyContainers = regularContainers.filter((container) => container.ready).length;
    const totalContainers = regularContainers.length;
    const phase = ["Running", "Pending", "Failed", "Succeeded", "Unknown"].includes(item?.status?.phase)
      ? item.status.phase
      : "Unknown";
    const podWarnings = warningsByPod.get(podEventKey(namespace, name)) || [];
    const reason = concisePodReason(item, containers, podWarnings);
    const activeSevere = containers.some((container) => SEVERE_CONTAINER_REASONS.has(container.reason));
    const schedulingFailed = conditionByType(item, "PodScheduled")?.status === "False";
    const fullyReady = totalContainers > 0 && readyContainers === totalContainers;
    let state = "Unknown";
    if (phase === "Succeeded") state = "Healthy";
    else if (phase === "Failed") state = "Unhealthy";
    else if (phase === "Unknown") state = "Unknown";
    else if (phase === "Pending") state = schedulingFailed || activeSevere ? "Unhealthy" : "Degraded";
    else if (phase === "Running" && fullyReady) state = "Healthy";
    else if (phase === "Running" && activeSevere) state = "Unhealthy";
    else if (phase === "Running") state = "Degraded";
    const newestTermination = Math.max(0, ...containers.map((container) => safeDate(container.lastFinishedAt)));
    const recentFailure = state === "Unhealthy" && (
      phase !== "Failed"
      || nowMs - safeDate(item?.metadata?.creationTimestamp) <= 24 * 60 * 60 * 1000
      || (newestTermination && nowMs - newestTermination <= 24 * 60 * 60 * 1000)
    );
    return {
      namespace,
      name,
      state,
      phase,
      readiness: `${readyContainers}/${totalContainers}`,
      readyContainers,
      totalContainers,
      restarts: containers.reduce((sum, container) => sum + container.restartCount, 0),
      age: ageLabel(item?.metadata?.creationTimestamp, nowMs),
      createdAt: String(item?.metadata?.creationTimestamp || ""),
      node: String(item?.spec?.nodeName || "Unscheduled"),
      reason,
      recentFailure,
      warningCount: podWarnings.length,
      recentWarningCount: podWarnings.filter((event) => event.recent).length,
      containers,
      metrics: metricsByPod.get(podEventKey(namespace, name)) || []
    };
  }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

function parseWorkloads(items, nowMs) {
  return items.map((item) => {
    const kind = String(item?.kind || "Workload");
    let expected = 0;
    let ready = 0;
    let available = 0;
    let updated = 0;
    if (kind === "DaemonSet") {
      expected = Number(item?.status?.desiredNumberScheduled || 0);
      ready = Number(item?.status?.numberReady || 0);
      available = Number(item?.status?.numberAvailable || 0);
      updated = Number(item?.status?.updatedNumberScheduled || 0);
    } else {
      expected = Number(item?.spec?.replicas ?? 1);
      ready = Number(item?.status?.readyReplicas || 0);
      available = Number(item?.status?.availableReplicas || 0);
      updated = Number(item?.status?.updatedReplicas || item?.status?.currentReplicas || 0);
    }
    let state = "Healthy";
    let reason = "";
    if (expected > 0 && ready === 0) {
      state = "Unhealthy";
      reason = `0 of ${expected} replicas are ready.`;
    } else if (ready < expected || available < expected) {
      state = "Degraded";
      reason = `${ready} of ${expected} replicas are ready.`;
    }
    const progressing = conditionByType(item, "Progressing");
    const availableCondition = conditionByType(item, "Available") || conditionByType(item, "Ready");
    if (availableCondition?.status === "False" && expected > 0) {
      reason = redactHealthText(availableCondition.message || availableCondition.reason || reason);
    } else if (progressing?.status === "False" && expected > 0) {
      reason = redactHealthText(progressing.message || progressing.reason || reason);
    }
    return {
      kind,
      namespace: objectNamespace(item),
      name: objectName(item),
      state,
      expected,
      ready,
      available,
      updated,
      age: ageLabel(item?.metadata?.creationTimestamp, nowMs),
      reason
    };
  }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

const QUANTITY_MULTIPLIERS = Object.freeze({
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4
});

function kubernetesQuantityBytes(value) {
  const text = String(value || "").trim();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier = match[2] ? QUANTITY_MULTIPLIERS[match[2]] : 1;
  return Number.isFinite(amount) && multiplier ? Math.round(amount * multiplier) : 0;
}

function parsePvcs(items, nowMs) {
  return items.map((item) => {
    const phase = String(item?.status?.phase || "Unknown");
    return {
      namespace: objectNamespace(item),
      name: objectName(item),
      state: phase === "Bound" ? "Healthy" : (phase === "Lost" ? "Unhealthy" : "Degraded"),
      phase,
      storageClass: String(item?.spec?.storageClassName || ""),
      accessModes: Array.isArray(item?.spec?.accessModes) ? item.spec.accessModes.map(String) : [],
      requested: String(item?.spec?.resources?.requests?.storage || ""),
      capacity: String(item?.status?.capacity?.storage || item?.spec?.resources?.requests?.storage || ""),
      capacityBytes: kubernetesQuantityBytes(item?.status?.capacity?.storage || item?.spec?.resources?.requests?.storage),
      volume: String(item?.spec?.volumeName || ""),
      age: ageLabel(item?.metadata?.creationTimestamp, nowMs)
    };
  }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

function endpointReadyCount(item) {
  return (item?.subsets || []).reduce((sum, subset) => sum + (subset?.addresses || []).length, 0);
}

function serviceGroup({ label, namespace, podPattern, servicePattern, pods, services, endpoints, workloads, database, optional = false }) {
  const scopedPods = pods.filter((pod) => (!namespace || pod.namespace === namespace) && podPattern.test(pod.name));
  const scopedServices = services.filter((service) => (!namespace || objectNamespace(service) === namespace) && servicePattern.test(objectName(service)));
  const serviceNames = new Set(scopedServices.map(objectName));
  const readyEndpoints = endpoints
    .filter((endpoint) => (!namespace || objectNamespace(endpoint) === namespace) && serviceNames.has(objectName(endpoint)))
    .reduce((sum, endpoint) => sum + endpointReadyCount(endpoint), 0);
  const scopedWorkloads = workloads.filter((workload) => (!namespace || workload.namespace === namespace) && podPattern.test(workload.name));
  const runningPods = scopedPods.filter((pod) => pod.phase === "Running" && pod.readyContainers === pod.totalContainers);
  const failedPods = scopedPods.filter((pod) => pod.state === "Unhealthy" && pod.recentFailure);
  const expectedReplicas = scopedWorkloads.reduce((sum, workload) => sum + workload.expected, 0);
  let state = "Healthy";
  let message = `${runningPods.length} ready pod(s), ${scopedServices.length} service(s), ${readyEndpoints} ready endpoint(s).`;
  if (database && database.ok !== true) {
    state = "Unhealthy";
    message = redactHealthText(database.message || database.error || "Database connectivity failed.");
  } else if (failedPods.length) {
    state = "Unhealthy";
    message = failedPods[0].reason || `${failedPods.length} pod(s) are unhealthy.`;
  } else if (!scopedPods.length && !scopedServices.length && !scopedWorkloads.length) {
    state = optional ? "Unknown" : "Unhealthy";
    message = optional ? `${label} is not installed or was not detected.` : `${label} workload was not detected.`;
  } else if (expectedReplicas === 0 && scopedWorkloads.length) {
    state = "Healthy";
    message = `${label} workloads are intentionally scaled to zero.`;
  } else if (!runningPods.length || (scopedServices.length && readyEndpoints === 0)) {
    state = "Degraded";
    message = `${label} is present but not fully ready.`;
  }
  return {
    label,
    state,
    message,
    podCount: scopedPods.length,
    readyPodCount: runningPods.length,
    serviceCount: scopedServices.length,
    readyEndpoints,
    pods: scopedPods.map((pod) => `${pod.namespace}/${pod.name}`),
    services: scopedServices.map((service) => `${objectNamespace(service)}/${objectName(service)}`)
  };
}

function parseNamespaces(items, pods, nowMs) {
  const known = new Map(items.map((item) => [objectName(item), item]));
  for (const pod of pods) if (!known.has(pod.namespace)) known.set(pod.namespace, null);
  return [...known.entries()].map(([name, item]) => {
    const namespacePods = pods.filter((pod) => pod.namespace === name);
    const phaseCounts = {};
    for (const pod of namespacePods) phaseCounts[pod.phase] = (phaseCounts[pod.phase] || 0) + 1;
    const unhealthy = namespacePods.filter((pod) => pod.state === "Unhealthy" && pod.recentFailure).length;
    const activeUnhealthy = namespacePods.filter((pod) => pod.state === "Unhealthy" && pod.recentFailure && !["Failed", "Succeeded"].includes(pod.phase)).length;
    const completedFailures = namespacePods.filter((pod) => pod.phase === "Failed" && pod.recentFailure).length;
    const degraded = namespacePods.filter((pod) => pod.state === "Degraded").length;
    return {
      name,
      state: activeUnhealthy ? "Unhealthy" : (degraded ? "Degraded" : "Healthy"),
      phase: String(item?.status?.phase || "Active"),
      age: ageLabel(item?.metadata?.creationTimestamp, nowMs),
      podCount: namespacePods.length,
      phaseCounts,
      unhealthyPods: unhealthy,
      activeUnhealthyPods: activeUnhealthy,
      completedFailures,
      degradedPods: degraded
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function checkSummary(label, result, optional = false) {
  if (!result) return { label, ok: false, optional, durationMs: null, error: `${label} was not run.` };
  return {
    label,
    ok: Boolean(result.ok),
    optional,
    durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null,
    error: result.ok ? "" : redactHealthText(result.stderr || result.error || `${label} failed.`)
  };
}

function buildServerHealthReport(input = {}) {
  const nowMs = safeDate(input.checkedAt) || Date.now();
  const commandResults = input.commandResults || {};
  const parsed = {
    version: parseJsonResult(commandResults.version, "Kubernetes version"),
    nodes: parseJsonResult(commandResults.nodes, "Kubernetes nodes"),
    namespaces: parseJsonResult(commandResults.namespaces, "Kubernetes namespaces"),
    pods: parseJsonResult(commandResults.pods, "Kubernetes pods"),
    workloads: parseJsonResult(commandResults.workloads, "Kubernetes workloads"),
    networking: parseJsonResult(commandResults.networking, "Kubernetes services"),
    pvcs: parseJsonResult(commandResults.pvcs, "Persistent volume claims"),
    events: parseJsonResult(commandResults.events, "Kubernetes warning events")
  };
  const kubernetesConnected = parsed.nodes.ok;
  const nodeMetrics = commandResults.nodeMetrics?.ok ? parseMetricsLines(commandResults.nodeMetrics.stdout, "nodes") : [];
  const podMetrics = commandResults.podMetrics?.ok ? parseMetricsLines(commandResults.podMetrics.stdout, "pods") : [];
  const metricsByNode = new Map(nodeMetrics.map((metric) => [metric.name, metric]));
  const warnings = parsed.events.ok ? parseWarningEvents(listItems(parsed.events), nowMs) : [];
  const pods = parsed.pods.ok ? parsePods(listItems(parsed.pods), warnings, podMetrics, nowMs) : [];
  const podsByKey = new Map(pods.map((pod) => [podEventKey(pod.namespace, pod.name), pod]));
  for (const event of warnings) {
    if (event.objectKind !== "Pod") {
      event.active = null;
      event.currentState = "Unknown";
      continue;
    }
    const affectedPod = podsByKey.get(podEventKey(event.namespace, event.objectName));
    event.currentState = affectedPod?.state || "Unknown";
    event.active = affectedPod
      ? !["Healthy"].includes(affectedPod.state) && !["Failed", "Succeeded"].includes(affectedPod.phase)
      : null;
  }
  const nodes = parsed.nodes.ok ? parseNodes(listItems(parsed.nodes), metricsByNode, nowMs) : [];
  const workloads = parsed.workloads.ok ? parseWorkloads(listItems(parsed.workloads), nowMs) : [];
  const networkItems = parsed.networking.ok ? listItems(parsed.networking) : [];
  const services = networkItems.filter((item) => item.kind === "Service");
  const endpoints = networkItems.filter((item) => item.kind === "Endpoints");
  const pvcs = parsed.pvcs.ok ? parsePvcs(listItems(parsed.pvcs), nowMs) : [];
  const namespaces = parsed.namespaces.ok ? parseNamespaces(listItems(parsed.namespaces), pods, nowMs) : parseNamespaces([], pods, nowMs);
  const selected = input.selectedBattlegroup || null;
  const selectedNamespace = String(selected?.namespace || "");
  const postgres = serviceGroup({
    label: "PostgreSQL",
    namespace: selectedNamespace,
    podPattern: /(?:^|-)db-dbdepl|postgres/i,
    servicePattern: /(?:^|-)db-dbdepl|postgres/i,
    pods,
    services,
    endpoints,
    workloads,
    database: input.database
  });
  const rabbitmq = serviceGroup({
    label: "RabbitMQ",
    namespace: selectedNamespace,
    podPattern: /rabbit|broker|(?:^|-)mq(?:-|$)/i,
    servicePattern: /rabbit|broker|(?:^|-)mq(?:-|$)/i,
    pods,
    services,
    endpoints,
    workloads
  });
  const duneExclude = /(?:^|[-])(db|rabbit|broker|mq|pghero|util|filebrowser|fb|dump|import)(?:[-]|$)/i;
  const dunePods = pods.filter((pod) => pod.namespace === selectedNamespace && !duneExclude.test(pod.name));
  const duneWorkloads = workloads.filter((workload) => workload.namespace === selectedNamespace && !duneExclude.test(workload.name));
  const duneServices = services.filter((service) => objectNamespace(service) === selectedNamespace && !duneExclude.test(objectName(service)));
  const duneReady = dunePods.filter((pod) => pod.phase === "Running" && pod.readyContainers === pod.totalContainers).length;
  const duneExpected = duneWorkloads.reduce((sum, workload) => sum + workload.expected, 0);
  let duneState = "Healthy";
  let duneMessage = `${duneReady} ready server pod(s), ${duneServices.length} service(s).`;
  if (!selectedNamespace) {
    duneState = "Unknown";
    duneMessage = "No selected battlegroup.";
  } else if (dunePods.some((pod) => pod.state === "Unhealthy" && pod.recentFailure)) {
    duneState = "Unhealthy";
    duneMessage = dunePods.find((pod) => pod.state === "Unhealthy" && pod.recentFailure)?.reason || "A Dune server pod is unhealthy.";
  } else if (duneExpected === 0 && duneWorkloads.length) {
    duneState = "Healthy";
    duneMessage = "Dune server workloads are intentionally scaled to zero.";
  } else if (duneExpected > 0 && duneReady === 0) {
    duneState = "Unhealthy";
    duneMessage = `0 of ${duneExpected} expected Dune server replicas are ready.`;
  } else if (!dunePods.length && !duneWorkloads.length && !duneServices.length) {
    duneState = "Unknown";
    duneMessage = "Dune server workloads were not detected in the selected namespace.";
  } else if (duneExpected > duneReady) {
    duneState = "Degraded";
    duneMessage = `${duneReady} of ${duneExpected} expected Dune server replicas are ready.`;
  }
  const receiver = {
    label: "Receiver",
    state: input.receiver?.ok ? "Healthy" : "Degraded",
    message: input.receiver?.ok ? "Receiver health endpoint is reachable." : redactHealthText(input.receiver?.lastError || input.receiver?.health?.error || "Receiver is offline."),
    status: String(input.receiver?.status || (input.receiver?.ok ? "Online" : "Offline")),
    managed: Boolean(input.receiver?.managed)
  };
  const marketInstalled = Boolean(input.marketBot?.installed);
  const marketStatus = String(input.marketBot?.status || (marketInstalled ? "Unknown" : "Not Installed"));
  const marketBot = {
    label: "Market Bot",
    state: !marketInstalled ? "Unknown" : (/error|failed/i.test(marketStatus) ? "Unhealthy" : (input.marketBot?.reachable === false ? "Degraded" : "Healthy")),
    message: redactHealthText(input.marketBot?.message || (marketInstalled ? `Market Bot is ${marketStatus}.` : "Market Bot is not installed.")),
    status: marketStatus,
    installed: marketInstalled,
    updateRequired: Boolean(input.marketBot?.updateRequired)
  };
  const vmStateText = String(input.vm?.state || input.vm?.status || "Unknown");
  const vmRunning = /^running$/i.test(vmStateText);
  const vmOffline = /stopped|off|saved|paused/i.test(vmStateText);
  const vmCheckUnavailable = Boolean(input.vm?.error) && /access denied|administrator|permission|hyper-v/i.test(String(input.vm.error));
  const sshOk = Boolean(input.ssh?.ok && /ALPHANINE_HEALTH_SSH_OK/.test(String(input.ssh?.stdout || "")));
  const connectivity = {
    hyperv: {
      state: vmOffline ? "Offline" : (vmRunning ? "Healthy" : (input.vm?.exists === false && !vmCheckUnavailable ? "Offline" : "Unknown")),
      status: vmStateText,
      message: redactHealthText(input.vm?.error || (vmRunning ? "Hyper-V VM is running." : `Hyper-V VM state: ${vmStateText}.`)),
      name: String(input.vm?.name || ""),
      address: String(input.vm?.ip || input.vm?.address || "")
    },
    ssh: {
      state: sshOk ? "Healthy" : (vmOffline ? "Offline" : "Offline"),
      status: sshOk ? "Connected" : "Offline",
      message: sshOk ? "SSH connection succeeded." : redactHealthText(input.ssh?.stderr || input.ssh?.error || "SSH connection failed."),
      durationMs: Number(input.ssh?.durationMs || 0) || null
    },
    kubernetes: {
      state: kubernetesConnected ? (nodes.every((node) => node.ready) ? "Healthy" : "Unhealthy") : (sshOk ? "Unhealthy" : "Offline"),
      status: kubernetesConnected ? "Connected" : "Unavailable",
      message: kubernetesConnected ? `${nodes.length} node(s) discovered.` : parsed.nodes.error,
      serverVersion: String(parsed.version?.data?.serverVersion?.gitVersion || "")
    }
  };
  const hostMetrics = commandResults.hostMetrics?.ok ? parseHostMetrics(commandResults.hostMetrics.stdout) : parseHostMetrics("");
  const resources = {
    status: nodeMetrics.length || podMetrics.length || hostMetrics.available ? "Available" : "Unavailable",
    metricsServer: {
      status: nodeMetrics.length || podMetrics.length ? "Available" : "Unavailable",
      nodeMetrics,
      podContainerMetrics: podMetrics,
      message: nodeMetrics.length || podMetrics.length ? "Kubernetes metrics are available." : "Kubernetes Metrics API is unavailable; this does not affect health."
    },
    host: hostMetrics,
    pressures: nodes.flatMap((node) => node.pressures.map((pressure) => ({ node: node.name, pressure })))
  };
  const storageState = pvcs.some((pvc) => pvc.state === "Unhealthy")
    ? "Unhealthy"
    : (pvcs.some((pvc) => pvc.state === "Degraded") ? "Degraded" : (pvcs.length ? "Healthy" : "Unknown"));
  const storage = {
    state: storageState,
    pvcs,
    totalCapacityBytes: pvcs.reduce((sum, pvc) => sum + pvc.capacityBytes, 0),
    message: pvcs.length ? `${pvcs.filter((pvc) => pvc.phase === "Bound").length} of ${pvcs.length} PVCs are bound.` : "No persistent volume claims were detected."
  };
  const recentWarnings = warnings.filter((event) => event.recent);
  const recentUnhealthyPods = pods.filter((pod) => pod.state === "Unhealthy" && pod.recentFailure);
  const activeUnhealthyPods = recentUnhealthyPods.filter((pod) => !["Failed", "Succeeded"].includes(pod.phase));
  const unhealthyWorkloads = workloads.filter((workload) => workload.state === "Unhealthy");
  const degradedWorkloads = workloads.filter((workload) => workload.state === "Degraded");
  let overallState = "Healthy";
  const reasons = [];
  if (vmOffline || (!sshOk && connectivity.hyperv.state === "Offline")) {
    overallState = "Offline";
    reasons.push(vmOffline ? `VM is ${vmStateText}.` : "SSH is offline.");
  } else if (!kubernetesConnected) {
    overallState = sshOk ? "Unhealthy" : "Offline";
    reasons.push(sshOk ? "Kubernetes API is unavailable." : "SSH and Kubernetes are unavailable.");
  } else {
    const criticalUnhealthy = [
      ...nodes.filter((node) => node.state === "Unhealthy").map((node) => `Node ${node.name} is not ready.`),
      ...(postgres.state === "Unhealthy" ? [postgres.message] : []),
      ...(rabbitmq.state === "Unhealthy" ? [rabbitmq.message] : []),
      ...(duneState === "Unhealthy" ? [duneMessage] : []),
      ...activeUnhealthyPods.slice(0, 3).map((pod) => `${pod.namespace}/${pod.name}: ${pod.reason || pod.phase}`),
      ...unhealthyWorkloads.slice(0, 3).map((workload) => `${workload.kind} ${workload.namespace}/${workload.name}: ${workload.reason}`),
      ...(storage.state === "Unhealthy" ? [storage.message] : [])
    ].filter(Boolean);
    if (criticalUnhealthy.length) {
      overallState = "Unhealthy";
      reasons.push(...criticalUnhealthy);
    } else {
      const degradedReasons = [
        ...nodes.filter((node) => node.state === "Degraded").map((node) => `Node ${node.name}: ${node.reason}`),
        ...(postgres.state === "Degraded" ? [postgres.message] : []),
        ...(rabbitmq.state === "Degraded" ? [rabbitmq.message] : []),
        ...(duneState === "Degraded" ? [duneMessage] : []),
        ...(receiver.state === "Degraded" ? [receiver.message] : []),
        ...(marketBot.state === "Degraded" || marketBot.state === "Unhealthy" ? [marketBot.message] : []),
        ...degradedWorkloads.slice(0, 3).map((workload) => `${workload.kind} ${workload.namespace}/${workload.name}: ${workload.reason}`),
        ...(storage.state === "Degraded" ? [storage.message] : [])
      ].filter(Boolean);
      if (degradedReasons.length) {
        overallState = "Degraded";
        reasons.push(...degradedReasons);
      }
    }
  }
  if (!input.vm && !input.ssh && !kubernetesConnected) overallState = "Unknown";
  const checks = [
    checkSummary("Kubernetes version", commandResults.version),
    checkSummary("Kubernetes nodes", commandResults.nodes),
    checkSummary("Namespaces", commandResults.namespaces),
    checkSummary("Pods and containers", commandResults.pods),
    checkSummary("Workload replicas", commandResults.workloads),
    checkSummary("Services and endpoints", commandResults.networking),
    checkSummary("Persistent volume claims", commandResults.pvcs),
    checkSummary("Warning events", commandResults.events),
    checkSummary("Node metrics", commandResults.nodeMetrics, true),
    checkSummary("Pod metrics", commandResults.podMetrics, true),
    checkSummary("Host metrics", commandResults.hostMetrics, true)
  ];
  return {
    ok: overallState === "Healthy" || overallState === "Degraded",
    readOnly: true,
    state: healthState(overallState),
    checkedAt: new Date(nowMs).toISOString(),
    durationMs: Number(input.durationMs || 0),
    selectedServer: selected ? {
      namespace: String(selected.namespace || ""),
      name: String(selected.name || ""),
      title: String(selected.title || "")
    } : null,
    summary: {
      namespaces: namespaces.length,
      nodes: nodes.length,
      pods: pods.length,
      containers: pods.reduce((sum, pod) => sum + pod.containers.length, 0),
      readyContainers: pods.reduce((sum, pod) => sum + pod.readyContainers, 0),
      restarts: pods.reduce((sum, pod) => sum + pod.restarts, 0),
      workloads: workloads.length,
      unhealthyWorkloads: unhealthyWorkloads.length,
      pvcs: pvcs.length,
      recentWarnings: recentWarnings.length
    },
    reasons: reasons.slice(0, 8),
    connectivity,
    nodes,
    namespaces,
    pods,
    workloads,
    warnings,
    services: {
      postgres,
      rabbitmq,
      dune: {
        label: "Dune Server",
        state: duneState,
        message: duneMessage,
        podCount: dunePods.length,
        readyPodCount: duneReady,
        serviceCount: duneServices.length,
        expectedReplicas: duneExpected,
        pods: dunePods.map((pod) => `${pod.namespace}/${pod.name}`),
        services: duneServices.map((service) => `${objectNamespace(service)}/${objectName(service)}`)
      },
      receiver,
      marketBot
    },
    storage,
    resources,
    checks
  };
}

module.exports = {
  HEALTH_STATES,
  ageLabel,
  buildServerHealthReport,
  kubernetesQuantityBytes,
  parseHostMetrics,
  parseMetricsLines,
  redactHealthText
};
