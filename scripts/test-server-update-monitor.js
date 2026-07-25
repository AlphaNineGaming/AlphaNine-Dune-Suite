"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SERVER_UPDATE_TIMEOUTS,
  SERVER_MANAGEMENT_TIMEOUTS,
  SERVER_MANAGEMENT_UI_TIMEOUTS,
  cleanUpdateLine,
  parseServerUpdateMetadata,
  classifyServerUpdate,
  serverUpdateProgress,
  serverManagementTimeoutMs,
  serverUpdateFailureDetails,
  runServerUpdateLifecycle,
  createServerUpdateCheckCoordinator
} = require("../lib/server-update");

const metadata = parseServerUpdateMetadata(`
__ALPHANINE_STEAM_BUILD_ID__=24204075
__ALPHANINE_DOWNLOADED_REVISION__=2036754-0-shipping
__ALPHANINE_DEPLOYED_REVISIONS__=2036000-0-shipping
__ALPHANINE_BATTLEGROUP__=example
__ALPHANINE_NAMESPACE__=funcom-seabass-example
`);
assert.equal(metadata.steamBuildId, "24204075");
assert.equal(metadata.downloadedRevision, "2036754-0-shipping");
assert.equal(metadata.deployedRevision, "2036000-0-shipping");

const steamUpdate = classifyServerUpdate(metadata, { response: { up_to_date: false, required_version: 24205000 } });
assert.equal(steamUpdate.updateAvailable, true);
assert.equal(steamUpdate.steamUpdateAvailable, true);
assert.equal(steamUpdate.downloadedPending, true);

const currentMetadata = { ...metadata, deployedRevision: metadata.downloadedRevision, deployedRevisions: [metadata.downloadedRevision] };
const current = classifyServerUpdate(currentMetadata, { response: { up_to_date: true, required_version: 24204075 } });
assert.equal(current.updateAvailable, false);

let progress = 0;
for (const line of [
  "Checking for new versions",
  "[ 50%] Downloading update",
  "Applying operator patches",
  "Loading Game Server, this may take a while",
  "Finished updating battlegroup to version 2036754-0-shipping"
]) {
  const next = serverUpdateProgress(line, progress);
  assert(next.progress >= progress, "Progress must not move backwards.");
  progress = next.progress;
}
assert.equal(progress, 100);
assert.equal(cleanUpdateLine("\u001b[0mSuccess\u001b[0m"), "Success");

assert.equal(serverManagementTimeoutMs("status"), 30000, "Quick status checks need a short bounded timeout.");
assert.equal(serverManagementTimeoutMs("update"), 30 * 60 * 1000, "Server updates need a bounded long-operation timeout.");
assert(SERVER_MANAGEMENT_TIMEOUTS.start > SERVER_MANAGEMENT_TIMEOUTS.status);
assert(SERVER_MANAGEMENT_TIMEOUTS.restart > SERVER_MANAGEMENT_TIMEOUTS.status);
for (const action of ["status", "start", "stop", "restart", "update", "backup"]) {
  assert(
    SERVER_MANAGEMENT_UI_TIMEOUTS[action] > SERVER_MANAGEMENT_TIMEOUTS[action],
    `UI timeout must exceed backend timeout for ${action}.`
  );
}
assert(SERVER_UPDATE_TIMEOUTS.uiCheckMs > SERVER_UPDATE_TIMEOUTS.backendCheckMs, "Updater check UI timeout must exceed the bounded backend check.");
assert(SERVER_UPDATE_TIMEOUTS.uiStartMs > SERVER_UPDATE_TIMEOUTS.steamWebMs, "Updater start request must allow the backend to register the operation.");

async function run() {
  let fakeNow = 0;
  let releaseSlowResponse;
  const slowCoordinator = createServerUpdateCheckCoordinator(
    () => new Promise((resolve) => { releaseSlowResponse = resolve; }),
    { now: () => fakeNow, ttlMs: 60000 }
  );
  const slowRequest = slowCoordinator.check();
  await Promise.resolve();
  fakeNow = 9501;
  releaseSlowResponse({ ok: true, updateAvailable: false, checkedAt: new Date(fakeNow).toISOString() });
  const slowResult = await slowRequest;
  assert.equal(slowResult.ok, true, "A valid response taking longer than 9000 ms must succeed.");
  assert.equal(slowCoordinator.state().busy, false, "Slow responses must release the in-flight state.");

  const backendTimeout = serverUpdateFailureDetails({
    stage: "Loading game server",
    command: "/home/dune/.dune/bin/battlegroup update",
    timeoutMs: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
    startedAtMs: 1000,
    now: () => 1000 + SERVER_UPDATE_TIMEOUTS.updateCommandMs,
    result: {
      ok: false,
      timedOut: true,
      stage: "Loading game server",
      command: "/home/dune/.dune/bin/battlegroup update",
      elapsedMs: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
      timeoutMs: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
      error: "Suite backend timed out while running the server-management update command."
    }
  });
  assert.equal(backendTimeout.timedOut, true);
  assert.equal(backendTimeout.timeoutSource, "suite-backend");
  assert.equal(backendTimeout.stage, "Loading game server");
  assert.equal(backendTimeout.command, "/home/dune/.dune/bin/battlegroup update");
  assert.equal(backendTimeout.elapsedMs, SERVER_UPDATE_TIMEOUTS.updateCommandMs);
  assert.match(backendTimeout.message, /Underlying error:/);

  const nestedTimeout = serverUpdateFailureDetails({
    stage: "Applying battlegroup revision",
    command: "/home/dune/.dune/bin/battlegroup update",
    timeoutMs: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
    startedAtMs: 0,
    now: () => 11000,
    result: { ok: false, error: "server timeout of 9000 ms" }
  });
  assert.equal(nestedTimeout.nestedTimeoutMs, 9000);
  assert.equal(nestedTimeout.timeoutSource, "server-management-command");
  assert.match(nestedTimeout.message, /reported by the installed server-management command, not the Suite backend/);

  let busy = true;
  let recordedFailure = null;
  const failedLifecycle = await runServerUpdateLifecycle({
    stage: "Downloading and verifying",
    command: "/home/dune/.dune/bin/battlegroup update",
    timeoutMs: SERVER_UPDATE_TIMEOUTS.updateCommandMs,
    execute: async () => ({ ok: false, error: "simulated update failure", elapsedMs: 12000 }),
    onFailure: (failure) => { recordedFailure = failure; },
    onFinally: () => { busy = false; }
  });
  assert.equal(failedLifecycle.ok, false);
  assert.equal(busy, false, "Updater busy state must clear after failure.");
  assert.equal(recordedFailure.underlyingError, "simulated update failure");

  let refreshCalls = 0;
  const recoveringCoordinator = createServerUpdateCheckCoordinator(async () => {
    refreshCalls += 1;
    if (refreshCalls === 1) return { ok: false, updateAvailable: false, error: "status backend timed out" };
    return { ok: true, updateAvailable: false, currentBuildId: "24204075" };
  });
  const timedOutRefresh = await recoveringCoordinator.check();
  assert.equal(timedOutRefresh.ok, false);
  assert.equal(recoveringCoordinator.state().busy, false, "Timeout must not leave status refresh busy.");
  const recoveredRefresh = await recoveringCoordinator.check();
  assert.equal(recoveredRefresh.ok, true, "A status refresh after timeout must be allowed to succeed.");
  assert.equal(refreshCalls, 2, "Failed updater checks must not be cached.");

  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const required of [
    'hostname: "api.steampowered.com"',
    "+app_info_print ${DUNE_SERVER_STEAM_APP_ID}",
    '"/api/server-update/check"',
    '"/api/server-update/start"',
    'operationRegistry.begin("battlegroup:update"',
    'id="serverUpdatePanel"',
    "initializeServerUpdateMonitor",
    "serverUpdateProgress(line, progress)",
    "runServerUpdateLifecycle",
    "serverManagementTimeoutMs(action)",
    'getJson("/api/action/start",{method:"POST",timeoutMs:${SERVER_MANAGEMENT_UI_TIMEOUTS.start}})',
    "serverUpdateCheckCoordinator?.reset()",
    "diagnostics: failureDetails"
  ]) assert(server.includes(required), `Missing server update integration: ${required}`);
  assert(!/battlegroup update --help/.test(server), "Detection must never invoke the destructive Funcom update command.");

  console.log("Server Updater slow-response, bounded timeout, diagnostics, busy cleanup, and status recovery checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
