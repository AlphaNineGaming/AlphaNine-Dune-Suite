const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const SERVER_UPDATE_TIMEOUTS = Object.freeze({
  metadataCommandMs: 30000,
  steamWebMs: 12000,
  steamFallbackMs: 60000,
  backendCheckMs: 105000,
  updateCommandMs: 30 * 60 * 1000,
  uiCheckMs: 120000,
  uiStartMs: 30000,
  uiPollMs: 8000
});
const SERVER_MANAGEMENT_TIMEOUTS = Object.freeze({
  status: 30000,
  start: 15 * 60 * 1000,
  stop: 5 * 60 * 1000,
  restart: 15 * 60 * 1000,
  update: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
  backup: 15 * 60 * 1000,
  "logs-export": 4 * 60 * 1000,
  "operator-logs-export": 4 * 60 * 1000
});
const SERVER_MANAGEMENT_UI_TIMEOUTS = Object.freeze(
  Object.fromEntries(Object.entries(SERVER_MANAGEMENT_TIMEOUTS).map(([action, timeoutMs]) => [action, timeoutMs + 60000]))
);

function cleanUpdateLine(value) {
  return String(value || "").replace(ANSI_PATTERN, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
}

function parseServerUpdateMetadata(output) {
  const values = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^__ALPHANINE_([A-Z_]+)__=(.*)$/);
    if (match) values[match[1]] = cleanUpdateLine(match[2]);
  }
  const deployedRevisions = String(values.DEPLOYED_REVISIONS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return {
    steamBuildId: values.STEAM_BUILD_ID || "",
    downloadedRevision: values.DOWNLOADED_REVISION || "",
    deployedRevision: deployedRevisions[0] || "",
    deployedRevisions,
    battlegroup: values.BATTLEGROUP || "",
    namespace: values.NAMESPACE || ""
  };
}

function classifyServerUpdate(metadata = {}, steamResponse = {}) {
  const response = steamResponse?.response || steamResponse || {};
  const steamKnown = typeof response.up_to_date === "boolean";
  const steamUpdateAvailable = steamKnown && response.up_to_date === false;
  const downloadedPending = Boolean(
    metadata.downloadedRevision
    && metadata.deployedRevision
    && !metadata.deployedRevisions.includes(metadata.downloadedRevision)
  );
  const updateAvailable = steamUpdateAvailable || downloadedPending;
  let reason = "Server is current.";
  if (steamUpdateAvailable) reason = `Funcom published Steam build ${response.required_version || "newer"}; downloaded build is ${metadata.steamBuildId || "unknown"}.`;
  else if (downloadedPending) reason = `Downloaded server revision ${metadata.downloadedRevision} has not been applied; deployed revision is ${metadata.deployedRevision}.`;
  else if (!steamKnown) reason = "Valve did not return an authoritative update result.";
  return {
    updateAvailable,
    steamUpdateAvailable,
    downloadedPending,
    steamKnown,
    currentBuildId: metadata.steamBuildId || "",
    requiredBuildId: String(response.required_version || metadata.steamBuildId || ""),
    downloadedRevision: metadata.downloadedRevision || "",
    deployedRevision: metadata.deployedRevision || "",
    deployedRevisions: metadata.deployedRevisions || [],
    reason
  };
}

function serverUpdateProgress(lineValue, previous = 0) {
  const line = cleanUpdateLine(lineValue);
  let progress = Math.max(0, Math.min(100, Number(previous) || 0));
  let stage = "Updating Dune server";
  const steamPercent = line.match(/\[\s*(\d{1,3})%\]/)?.[1];
  if (/checking for new versions/i.test(line)) { progress = Math.max(progress, 3); stage = "Checking Funcom build"; }
  else if (/connecting anonymously|waiting for client config|loading steam api/i.test(line)) { progress = Math.max(progress, 7); stage = "Connecting to Steam"; }
  else if (steamPercent !== undefined) { progress = Math.max(progress, 8 + Math.min(100, Number(steamPercent)) * 0.32); stage = "Downloading and verifying"; }
  else if (/already up to date|success! app/i.test(line)) { progress = Math.max(progress, 40); stage = "Steam files ready"; }
  else if (/applying operator patches|current operator version|downloaded operator version/i.test(line)) { progress = Math.max(progress, 46); stage = "Updating Funcom operators"; }
  else if (/loading battlegroup images/i.test(line)) { progress = Math.max(progress, 55); stage = "Loading server images"; }
  else if (/loading rmq/i.test(line)) { progress = Math.max(progress, 60); stage = "Loading messaging image"; }
  else if (/loading text router/i.test(line)) { progress = Math.max(progress, 66); stage = "Loading text router"; }
  else if (/loading director/i.test(line)) { progress = Math.max(progress, 72); stage = "Loading director"; }
  else if (/loading server gateway/i.test(line)) { progress = Math.max(progress, 78); stage = "Loading gateway"; }
  else if (/loading db utils/i.test(line)) { progress = Math.max(progress, 83); stage = "Loading database tools"; }
  else if (/loading game server/i.test(line)) { progress = Math.max(progress, 87); stage = "Loading game server"; }
  else if (/finished loading battlegroup images/i.test(line)) { progress = Math.max(progress, 94); stage = "Applying battlegroup revision"; }
  else if (/battlegroup:.*updated to/i.test(line)) { progress = Math.max(progress, 97); stage = "Battlegroup revision applied"; }
  else if (/finished updating battlegroup/i.test(line)) { progress = 100; stage = "Dune server updated"; }
  return { line, stage, progress: Math.round(progress) };
}

function serverManagementTimeoutMs(action) {
  return SERVER_MANAGEMENT_TIMEOUTS[String(action || "").trim()] || 2 * 60 * 1000;
}

function compactServerUpdateCommand(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function serverUpdateFailureDetails(options = {}) {
  const result = options.result || {};
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const startedAtMs = Number(options.startedAtMs ?? now);
  const elapsedMs = Math.max(0, Number(result.elapsedMs ?? (now - startedAtMs)) || 0);
  const timeoutMs = Math.max(0, Number(result.timeoutMs ?? options.timeoutMs) || 0);
  const underlyingError = cleanUpdateLine(
    result.underlyingError
    || result.error
    || result.stderr
    || options.error?.message
    || options.error
    || "Funcom server update failed."
  );
  const nestedTimeout = underlyingError.match(/\bserver timeout(?:\s+of|\s+after)?\s+(\d+)\s*ms\b/i);
  const timedOut = Boolean(result.timedOut || nestedTimeout || /\btimed out\b|\btimeout\b/i.test(underlyingError));
  const timeoutSource = nestedTimeout
    ? "server-management-command"
    : result.timedOut
      ? "suite-backend"
      : "";
  const stage = cleanUpdateLine(result.stage || options.stage || "Running server management update command");
  const command = compactServerUpdateCommand(result.command || options.command || "/home/dune/.dune/bin/battlegroup update");
  const nestedTimeoutMs = nestedTimeout ? Number(nestedTimeout[1]) : 0;
  const timeoutContext = nestedTimeoutMs
    ? ` The ${nestedTimeoutMs} ms deadline was reported by the installed server-management command, not the Suite backend (${timeoutMs} ms bound).`
    : "";
  const normalizedError = underlyingError.replace(/[.\s]+$/, "");
  const message = `Stage: ${stage}. Command: ${command}. Elapsed: ${elapsedMs} ms. Underlying error: ${normalizedError}.${timeoutContext}`;
  return {
    stage,
    command,
    elapsedMs,
    timeoutMs,
    timedOut,
    timeoutSource,
    nestedTimeoutMs,
    underlyingError,
    message
  };
}

async function reconcileServerUpdateResult(result, selection, readMetadata) {
  const steamFailure = [result?.stdout, result?.stderr].filter(Boolean).join("\n")
    .split(/\r?\n/).map(cleanUpdateLine)
    .find(line => /^Error!\s+App\s+'4754530'\s+state is\s+0x[0-9a-f]+\s+after update job\b/i.test(line));
  // Vendor wrappers may continue with existing images and even exit zero.
  // Keep Steam's explicit download failure authoritative in that case.
  if (steamFailure) return { ...result, ok: false, error: steamFailure, underlyingError: steamFailure };
  // A vendor post-update link refresh can exit 1 after applying the revision.
  // Never infer success from progress, a matching old revision, or stderr alone.
  if (result?.ok || result?.code !== 1 || result.timedOut || result.signal) return result;
  if (!selection?.namespace || !selection?.battlegroup) return result;
  const lines = String(result.stderr || "").split(/\r?\n/).map(cleanUpdateLine).filter(Boolean);
  const existingLink = /^ln: \/home\/dune\/\.dune\/bin\/(?:battlegroup|bg-util): File exists$/;
  if (!lines.some(line => existingLink.test(line)) || !lines.every(line =>
    existingLink.test(line)
    || /^ln: \/home\/dune\/\.steam\/(?:root|steam): No such file or directory$/.test(line)
    || /^steamcmd\.sh\[\d+\]: Starting\s+\/home\/dune\/\.local\/share\/Steam\/steamcmd\/linux32\/steamcmd$/.test(line)
  )) return result;
  const output = String(result.stdout || "").split(/\r?\n/).map(cleanUpdateLine);
  if (output.some(line => /^(?:Error[!:]|Fatal\b)/i.test(line))) return result;
  const completion = output.map(line => line.match(/^Finished updating battlegroup to version ([0-9]+-0-[A-Za-z0-9_-]+)$/)).filter(Boolean).pop();
  if (!completion) return result;
  const revision = completion[1];
  if (!output.includes(`Battlegroup: ${selection.battlegroup} updated to ${revision}`)) return result;
  try {
    const metadata = await readMetadata();
    if (metadata?.namespace !== selection.namespace || metadata.battlegroup !== selection.battlegroup
      || metadata.downloadedRevision !== revision || !metadata.deployedRevisions?.length
      || !metadata.deployedRevisions.every(value => value === revision)) return result;
    return { ...result, ok: true, error: "", underlyingError: "", metadata,
      warning: `Revision ${revision} was applied and verified. The updater's management-link refresh reported existing links (exit ${result.code}).`,
      originalError: result.underlyingError || result.error || result.stderr };
  } catch {
    return result;
  }
}

async function runServerUpdateLifecycle(options = {}) {
  const startedAtMs = typeof options.now === "function" ? options.now() : Date.now();
  let result = null;
  let failure = null;
  try {
    result = await options.execute();
    if (!result?.ok) {
      failure = serverUpdateFailureDetails({ ...options, result, startedAtMs });
      await options.onFailure?.(failure, result);
      return { ok: false, result, failure };
    }
    await options.onSuccess?.(result);
    return { ok: true, result, failure: null };
  } catch (error) {
    failure = serverUpdateFailureDetails({ ...options, result: error?.result || result, error, startedAtMs });
    try {
      await options.onFailure?.(failure, result);
    } catch (reportingError) {
      failure.reportingError = cleanUpdateLine(reportingError.message || reportingError);
    }
    return { ok: false, result, failure };
  } finally {
    await options.onFinally?.({ result, failure });
  }
}

function createServerUpdateCheckCoordinator(load, options = {}) {
  const ttlMs = Number(options.ttlMs || 10 * 60 * 1000);
  const now = typeof options.now === "function" ? options.now : Date.now;
  let checkedAt = 0;
  let data = null;
  let promise = null;
  const reset = () => {
    checkedAt = 0;
    data = null;
  };
  const check = ({ force = false } = {}) => {
    if (!force && data?.ok && now() - checkedAt < ttlMs) return Promise.resolve({ ...data, cached: true });
    if (promise) return promise;
    const pending = Promise.resolve()
      .then(() => load())
      .then((next) => {
        if (next?.ok) {
          checkedAt = now();
          data = next;
        } else {
          reset();
        }
        return next;
      })
      .catch((error) => {
        reset();
        return { ok: false, updateAvailable: false, checkedAt: new Date(now()).toISOString(), error: cleanUpdateLine(error.message || error) };
      })
      .finally(() => {
        if (promise === pending) promise = null;
      });
    promise = pending;
    return pending;
  };
  return {
    check,
    reset,
    state: () => ({ checkedAt, data, busy: Boolean(promise) })
  };
}

module.exports = {
  SERVER_UPDATE_TIMEOUTS,
  SERVER_MANAGEMENT_TIMEOUTS,
  SERVER_MANAGEMENT_UI_TIMEOUTS,
  cleanUpdateLine,
  parseServerUpdateMetadata,
  classifyServerUpdate,
  serverUpdateProgress,
  serverManagementTimeoutMs,
  serverUpdateFailureDetails,
  reconcileServerUpdateResult,
  runServerUpdateLifecycle,
  createServerUpdateCheckCoordinator
};
