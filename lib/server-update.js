const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

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

module.exports = { cleanUpdateLine, parseServerUpdateMetadata, classifyServerUpdate, serverUpdateProgress };
