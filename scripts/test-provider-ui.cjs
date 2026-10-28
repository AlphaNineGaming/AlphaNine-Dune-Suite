"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
function ui() {
  const fields = { setupDeploymentKind: "systemd", setupServiceUnit: "dune.service", setupRemoteRuntimeRoot: "/srv/dune", setupSshHost: "fixture.example", setupSshUser: "diagnostic", setupSshKey: "fixture-key", setupSshPort: "22", setupSshKnownHostsPath: "fixture-trust", setupRemoteDatabaseHost: "db.example", setupRemoteDatabasePort: "5432", setupRemoteDatabaseName: "dune", setupRemoteDatabaseUser: "reader", setupRemoteDatabasePassword: "********", setupRemoteDatabaseCaPath: "" };
  const nodes = Object.fromEntries(["setupUserService", "setupRemoteDatabaseEnabled", ...["status", "health", "configuration", "version", "database", "players"].map(k => "providerRead-" + k)].map(key => [key, { checked: true, disabled: true }]));
  let displayed, sent;
  const context = vm.createContext({ getValue: id => fields[id] || "", document: { getElementById: id => nodes[id] }, isMaskedSecretPlaceholder: value => value === "********", setText: (id, value) => { displayed = { id, value }; }, getJson: async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return { data: { players: [{ name: "<img src=x onerror=alert(1)>" }] } }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/provider-ui.js"), "utf8"), context);
  return { context, fields, nodes, displayed: () => displayed, sent: () => sent };
}
test("wizard builds typed scopes and never submits the masked password as credentials", () => {
  const f = ui(), payload = vm.runInContext("providerRemotePayload()", f.context);
  assert.equal(payload.remoteDeployment.unit, "dune.service"); assert.equal(payload.remoteDatabasePort, 5432); assert.equal(payload.remoteDatabasePassword, undefined);
  f.fields.setupRemoteDatabasePassword = "replacement";
  assert.equal(vm.runInContext("providerRemotePayload().remoteDatabasePassword", f.context), "replacement");
});
test("shared page policy follows capabilities and the separate provider dashboard is removed", () => {
  const f = ui();
  vm.runInContext('providerUiStatus={capabilities:{"server.status":{available:true}}}', f.context);
  assert.equal(vm.runInContext('providerAvailable("server.status")', f.context), true);
  assert.equal(vm.runInContext('providerAvailable("players.read")', f.context), false);
  const source = fs.readFileSync(path.join(__dirname, "../assets/provider-ui.js"), "utf8");
  assert(!source.includes("providerDashboard")); assert(!source.includes("providerReadOperation")); assert(source.includes("await refreshPlayersPage(true)")); assert(source.includes("await refreshDatabaseExplorer()"));
});
