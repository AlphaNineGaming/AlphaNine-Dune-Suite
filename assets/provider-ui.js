"use strict";
let providerUiStatus = null;
let providerPreviewReport = null;
function providerIsRemoteSetup() { return getValue("setupServerType") === "remote-linux"; }
function providerRemotePayload() {
  const kind = getValue("setupDeploymentKind") || "auto";
  const remoteDeployment = { kind };
  if (kind === "systemd") Object.assign(remoteDeployment, { unit: getValue("setupServiceUnit").trim(), userService: document.getElementById("setupUserService")?.checked === true });
  if (kind === "docker") Object.assign(remoteDeployment, { container: getValue("setupContainerId").trim(), socket: getValue("setupDockerSocket").trim() });
  if (kind === "kubernetes") Object.assign(remoteDeployment, { kubeConfig: getValue("setupKubeConfig").trim(), context: getValue("setupKubeContext").trim(), namespace: getValue("setupKubeNamespace").trim(), pod: getValue("setupKubePod").trim() });
  const payload = { serverType: "remote-linux", sshHost: getValue("setupSshHost").trim(), sshUser: getValue("setupSshUser").trim(), sshKey: getValue("setupSshKey").trim(), sshPort: Number(getValue("setupSshPort")), sshKnownHostsPath: getValue("setupSshKnownHostsPath").trim(), remoteRuntimeRoot: getValue("setupRemoteRuntimeRoot").trim(), ...(getValue("setupRemoteRuntimeRoot").trim() ? { remoteDeployment } : {}), remoteDatabaseEnabled: document.getElementById("setupRemoteDatabaseEnabled")?.checked === true };
  if (payload.remoteDatabaseEnabled) {
    Object.assign(payload, { remoteDatabaseHost: getValue("setupRemoteDatabaseHost").trim(), remoteDatabasePort: Number(getValue("setupRemoteDatabasePort")), remoteDatabaseName: getValue("setupRemoteDatabaseName").trim(), remoteDatabaseUser: getValue("setupRemoteDatabaseUser").trim(), remoteDatabaseCaPath: getValue("setupRemoteDatabaseCaPath").trim() });
    const password = getValue("setupRemoteDatabasePassword");
    if (password && !isMaskedSecretPlaceholder(password)) payload.remoteDatabasePassword = password;
  }
  return payload;
}
function providerSelectorFields() {
  const kind = getValue("setupDeploymentKind") || "auto";
  for (const selected of ["systemd", "docker", "kubernetes"]) document.getElementById("providerSelector-" + selected)?.classList.toggle("hidden", kind !== selected);
  document.getElementById("providerDatabaseFields")?.classList.toggle("hidden", document.getElementById("setupRemoteDatabaseEnabled")?.checked !== true);
}
function providerChooseWelcome() {
  setValue("setupServerType", getValue("setupWelcomeServerType"));
  providerSetupChanged();
  if (providerIsRemoteSetup()) { setupWizardMode = "advanced"; setupStep = 1; applySetupMode(); }
}
function providerSetupChanged() {
  const remote = providerIsRemoteSetup();
  setValue("setupWelcomeServerType", getValue("setupServerType"));
  document.getElementById("providerRemoteSetup")?.classList.toggle("hidden", !remote);
  for (const id of ["setupServerInstallPath", "setupAwakeningServerPath", "setupPythonPath", "setupVmName", "setupVmIp"]) {
    const node = document.getElementById(id);
    const group = node?.closest(".path-picker-row") || node?.closest("label");
    if (group) group.classList.toggle("hidden", remote);
  }
  for (const id of ["setupServerInstallPathWarning", "setupAwakeningServerPathWarning", "setupDiscoveryLog", "setupNavActions"]) document.getElementById(id)?.classList.toggle("hidden", remote);
  document.querySelectorAll(".setup-step").forEach((node, index) => node.classList.toggle("hidden", remote && index > 1));
  if (remote) setText("setupSshKeyWarning", getValue("setupSshKey") ? "SSH key selected. Readability is checked before diagnostics." : "Select an absolute path to your SSH key.");
  const auto = document.getElementById("setupAutoRunButton"); if (auto) auto.disabled = remote;
  const save = document.getElementById("providerSaveRemote");
  if (save) save.disabled = providerUiStatus?.isolatedSetup === false && providerUiStatus?.provider !== "remote-linux";
  if (remote && providerUiStatus?.isolatedSetup === false && providerUiStatus?.provider !== "remote-linux") setText("providerSetupResult", "You can inspect a remote endpoint here. Saving a different provider requires a separate diagnostic profile or isolated setup session, preserving the current installation.");
}
function providerShowReport(report, target) {
  providerPreviewReport = report;
  setText(target, JSON.stringify(report, null, 2));
  if (target === "providerReport") {
    setText("providerCapabilitySummary", "OS: " + report.environment.os + " · Architecture: " + report.environment.architecture + " · Deployment: " + (report.deployment?.layout || "unknown") + " · Runtime: " + (report.deployment?.runtime?.state || "unknown") + ". Application health and real-server compatibility remain unverified.");
  }
}
async function providerDiagnose(preview = false) {
  const target = preview ? "providerSetupResult" : "providerReport";
  setText(target, "Running bounded read-only SSH probes...");
  try {
    const data = await getJson("/api/providers/diagnose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preview ? providerRemotePayload() : {}), timeoutMs: 60000 });
    providerShowReport(data.report, target);
    if (!preview) { providerAcceptStatus(await getJson("/api/providers/status")); providerApplyAvailability(); }
  } catch (error) { setText(target, error.message || "Read-only diagnostics failed."); }
}
function providerDownloadPreview() {
  if (!providerPreviewReport) { setText("providerSetupResult", "Run read-only diagnostics before exporting a report."); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(providerPreviewReport, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "alphanine-compatibility.json"; link.click(); URL.revokeObjectURL(url);
}
async function providerSaveSetup() {
  try {
    const data = await getJson("/api/setup/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(providerRemotePayload()) });
    if (!data.verified) throw new Error("Read-only setup did not verify.");
    fillSetup(data.config); appConfig = data.config;
    setText("providerSetupResult", "Read-only setup saved. No game, VM or database services were started. Reopen the Suite to use the saved profile.");
    await providerInitialize(false);
  } catch (error) { setText("providerSetupResult", error.message); }
}
function providerAvailable(capability) { return providerUiStatus?.capabilities?.[capability]?.available === true; }
function providerInvalidateTargetUi() {
  adminPlayers = []; selectedPlayerId = ""; playerDirectoryLoadedAt = 0; playerDirectoryLastError = ""; playerDirectoryRequest = null;
  liveUserGameState = null; serverHealthData = null;
  databaseExplorerState.schemas = []; databaseExplorerState.tables = []; databaseExplorerState.rows = []; databaseExplorerState.metadata = null; databaseExplorerState.result = null; databaseExplorerState.selectedTable = "";
  for (const id of ["playerCards", "playerDetails", "playerInventoryRows", "databaseExplorerGrid", "databaseExplorerRelations", "databaseExplorerDetails", "userGameSettingsGrid", "userGameRawPreview", "serverHealthServices"]) {
    const node = document.getElementById(id); if (node) node.textContent = "Target changed. Refresh validated read-only data.";
  }
}
function providerAcceptStatus(status) {
  if (providerUiStatus?.targetRevision && providerUiStatus.targetRevision !== status.targetRevision) providerInvalidateTargetUi();
  providerUiStatus = status; window.suiteProviderReadOnly = status.diagnosticOnly;
}
function providerApplyAvailability() {
  if (!window.suiteProviderReadOnly) return;
  document.body.classList.add("provider-read-only");
  document.querySelectorAll(".view").forEach(view => {
    let notice = view.querySelector(".provider-feature-notice");
    if (!notice) { notice = document.createElement("p"); notice.className = "warning provider-feature-notice"; view.prepend(notice); }
    const routes = (providerUiStatus?.featureRoutes || []).filter(route => route.page === view.id);
    const enabled = routes.filter(route => providerAvailable(route.capability));
    notice.textContent = "Experimental — " + (enabled.length ? "Validated read adapters available. " : "No validated adapter is available for this feature. ") + "Mutations, uncollected health and game compatibility remain unavailable or unverified.";
    if (view.id === "database-explorer") notice.textContent += " This adapter exposes only the validated player table; filters and custom sorting are unavailable.";
    view.querySelectorAll("button,input,select,textarea").forEach(control => {
      const action = control.getAttribute("onclick") || "";
      const capability = action.includes("refreshPlayersPage") || control.hasAttribute("data-player-id") || control.id === "playerSearch" ? "players.read"
        : action.includes("refreshDatabaseExplorer") || action.includes("exportDatabaseExplorer") || control.hasAttribute("data-database-explorer-table") || ["databaseExplorerSchema", "databaseExplorerSearch", "databaseExplorerPageSize", "databaseExplorerPrevious", "databaseExplorerNext"].includes(control.id) ? "database.explorer"
        : action.includes("refreshServerHealth") || control.id === "serverHealthAuto" ? "runtime.health"
        : action.includes("loadLiveUserGameSettings") ? "configuration.inspect"
        : action.includes("refreshDatabaseStatus") ? "database.inspect"
        : action.includes("checkServerUpdateAvailability") ? "server.version"
        : action === "refresh()" || action.includes("refreshStatusPoll") ? "server.status" : null;
      const diagnostics = action.includes("providerDiagnose") || action.includes("providerDownloadPreview") || action.includes("openSetupWizard") || action.includes("openBlueprintDesigner") || control.hasAttribute("data-open") || action.startsWith("setView(") || control.id === "dashboardHeroToggle";
      if (!capability && !diagnostics) control.disabled = true;
      else if (capability && !providerAvailable(capability)) control.disabled = true;
      else if (capability && !["databaseExplorerPrevious", "databaseExplorerNext"].includes(control.id)) control.disabled = false;
    });
  });
  for (const id of ["startupProgressOverlay", "startupProgress"]) document.getElementById(id)?.classList.add("hidden");
  document.querySelector(".suite-action-center")?.classList.add("hidden");
  badge("topPlayers", adminPlayers.length ? "Player rows " + adminPlayers.length : "Player count unknown");
  document.querySelectorAll("#databaseExplorerPageSize option").forEach(option => { option.disabled = Number(option.value) > 100; });
  setText("providerAvailability", "Experimental provider. Shared Suite pages use only implemented read adapters; all mutations are unavailable.");
  if (providerUiStatus?.report) providerShowReport(providerUiStatus.report, "providerReport");
}
async function providerActivateView(name) {
  providerApplyAvailability();
  setText("viewSubtitle", "Selected provider: Experimental. Supported reads use the shared Suite pages; unvalidated operations remain unavailable.");
  const routes = (providerUiStatus?.featureRoutes || []).filter(route => route.page === name);
  if (!routes.some(route => providerAvailable(route.capability))) return;
  if (name === "dashboard" || name === "server") await refreshStatusPoll();
  if (name === "dashboard" && providerAvailable("players.read")) await refreshPlayerFeed();
  if (name === "server" && providerAvailable("server.version")) await checkServerUpdateAvailability({ prompt: false });
  if (name === "server-health") await refreshServerHealth();
  if (name === "players") await refreshPlayersPage(true);
  if (name === "usergame-settings") await loadLiveUserGameSettings(true);
  if (name === "database") await refreshDatabaseStatus();
  if (name === "database-explorer") await refreshDatabaseExplorer();
  providerApplyAvailability();
}
async function providerInitialize(automatic = true) {
  try {
    providerAcceptStatus(await getJson("/api/providers/status"));
    providerApplyAvailability(); providerSetupChanged();
    if (automatic && providerUiStatus.provider === "remote-linux") { await providerDiagnose(); await providerActivateView(document.querySelector(".view.active")?.id || "dashboard"); }
  } catch { /* Backend gates remain authoritative if the UI cannot load status. */ }
}
function providerInstallUi() {
  const originalJson = getJson;
  getJson = (url, options = {}) => {
    const revision = providerUiStatus?.targetRevision;
    const featureRead = (providerUiStatus?.featureRoutes || []).some(route => route.path === String(url).split("?")[0] && route.method === (options.method || "GET"));
    if (window.suiteProviderReadOnly && String(url).startsWith("/api/")) {
      const endpoint = new URL(url, location.origin).pathname, method = options.method || "GET";
      const infrastructure = endpoint.startsWith("/api/providers/") || ["/api/config", "/api/setup/status", "/api/setup/save"].includes(endpoint);
      const registered = (providerUiStatus?.featureRoutes || []).some(route => route.path === endpoint && route.method === method);
      if (!infrastructure && !registered) return Promise.reject(new Error("No validated provider adapter is available for this operation."));
    }
    return originalJson(url, options).then(async data => {
      if (featureRead && revision && providerUiStatus?.targetRevision !== revision) throw new Error("Target changed before this read could be displayed.");
      if (options.method === "POST" && ["/api/config", "/api/setup/save", "/api/battlegroups/select"].includes(url)) {
        try { providerAcceptStatus(await originalJson("/api/providers/status")); } catch { /* Server target locks remain authoritative on remote portals. */ }
      }
      return data;
    });
  };
  for (const name of ["renderPlayers", "renderPlayerDetails", "syncCharacterRecoveryControls", "renderLiveUserGameSettings", "renderDatabaseStatus", "renderDatabaseExplorerGrid", "renderDatabaseExplorerTables"]) {
    const original = window[name]; if (typeof original === "function") window[name] = (...args) => { const result = original(...args); providerApplyAvailability(); return result; };
  }
  const originalRefresh = refresh;
  let sharedRefresh = null;
  refresh = (...args) => {
    if (!window.suiteProviderReadOnly) return originalRefresh(...args);
    if (sharedRefresh) return sharedRefresh;
    sharedRefresh = (async () => { providerAcceptStatus(await getJson("/api/providers/status")); if (!providerUiStatus.report && providerUiStatus.provider === "remote-linux") await providerDiagnose(); return providerActivateView(document.querySelector(".view.active")?.id || "dashboard"); })().finally(() => { sharedRefresh = null; });
    return sharedRefresh;
  };

  const originalLocks = syncConnectionHostLocks;
  syncConnectionHostLocks = prefix => { originalLocks(prefix); if (prefix === "setup") providerSetupChanged(); };
  const originalFill = fillSetup;
  fillSetup = config => {
    originalFill(config); setValue("setupSshPort", config.sshPort ?? 22); setValue("setupSshKnownHostsPath", config.sshKnownHostsPath || ""); setValue("setupRemoteRuntimeRoot", config.remoteRuntimeRoot || ""); providerSetupChanged();
    const deployment = config.remoteDeployment || {};
    setValue("setupDeploymentKind", deployment.kind || "auto");
    for (const [field, key] of [["ServiceUnit", "unit"], ["ContainerId", "container"], ["DockerSocket", "socket"], ["KubeConfig", "kubeConfig"], ["KubeContext", "context"], ["KubeNamespace", "namespace"], ["KubePod", "pod"]]) setValue("setup" + field, deployment[key] || (key === "socket" ? "/var/run/docker.sock" : ""));
    setChecked("setupUserService", deployment.userService === true); setChecked("setupRemoteDatabaseEnabled", config.remoteDatabaseEnabled === true);
    for (const key of ["Host", "Name", "User", "CaPath"]) setValue("setupRemoteDatabase" + key, config["remoteDatabase" + key] || "");
    setValue("setupRemoteDatabasePort", config.remoteDatabasePort ?? 5432); fillSecretInput("setupRemoteDatabasePassword", config.remoteDatabasePasswordSet);
    providerSelectorFields();
  };
  const originalInit = initSetup;
  initSetup = async () => {
    const status = await getJson("/api/providers/status"); providerAcceptStatus(status);
    if (!status.diagnosticOnly && !status.isolatedSetup) return originalInit();
    const setup = await getJson("/api/setup/status"); appConfig = setup.config; fillSetup(setup.config || {});
    if (!setup.setupComplete) openSetupWizard(false);
    providerApplyAvailability();
  };
  const originalOpen = openSetupWizard;
  openSetupWizard = (...args) => { originalOpen(...args); if (providerIsRemoteSetup()) { setupWizardMode = "advanced"; setupStep = 1; applySetupMode(); } providerSetupChanged(); };
  const originalFinish = finishSetup;
  finishSetup = async (...args) => {
    if (providerIsRemoteSetup()) return providerSaveSetup();
    await originalFinish(...args);
    if (providerUiStatus?.isolatedSetup && appConfig?.setupComplete) showToast("New setup saved. Reopen the Suite to start configured services.", "success");
  };
  const originalSimple = runSimpleSetup;
  runSimpleSetup = async (...args) => {
    if (providerIsRemoteSetup()) return providerDiagnose(true);
    await originalSimple(...args);
    if (providerUiStatus?.isolatedSetup && appConfig?.setupComplete) showToast("New setup saved. Reopen the Suite to start configured services.", "success");
  };
  const originalDiscovery = runDiscovery;
  runDiscovery = (...args) => providerIsRemoteSetup() ? providerDiagnose(true) : originalDiscovery(...args);
  const originalSettings = saveSettings;
  saveSettings = (...args) => {
    if (window.suiteProviderReadOnly) { setText("settingsSaveStatus", "Edit Remote Linux connection settings in the Setup Wizard."); return; }
    return originalSettings(...args);
  };
  // Unadapted background loaders are suppressed; shared read pages keep their
  // existing renderers. Backend gates independently reject unvalidated actions.
  for (const name of ["refreshAll", "refreshVmMonitor", "refreshOperations", "refreshReceiverStatus", "refreshMaps", "refreshLiveMap", "refreshTeleportReadiness", "refreshRepairQueue", "runStartupProgress", "checkVmIpChangeOnStartup", "checkUpdatesOnStartup", "initializeServerUpdateMonitor"]) {
    const original = window[name];
    if (typeof original === "function") window[name] = (...args) => window.suiteProviderReadOnly ? Promise.resolve() : original(...args);
  }
}
