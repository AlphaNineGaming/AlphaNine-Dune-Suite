const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  cleanUpdateLine,
  parseServerUpdateMetadata,
  classifyServerUpdate,
  serverUpdateProgress
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

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
for (const required of [
  'hostname: "api.steampowered.com"',
  "+app_info_print ${DUNE_SERVER_STEAM_APP_ID}",
  '"/api/server-update/check"',
  '"/api/server-update/start"',
  'operationRegistry.begin("battlegroup:update"',
  'id="serverUpdatePanel"',
  "initializeServerUpdateMonitor",
  "serverUpdateProgress(line, progress)"
]) assert(server.includes(required), `Missing server update integration: ${required}`);
assert(!/battlegroup update --help/.test(server), "Detection must never invoke the destructive Funcom update command.");

console.log("Server update detection and live progress regression checks passed.");
