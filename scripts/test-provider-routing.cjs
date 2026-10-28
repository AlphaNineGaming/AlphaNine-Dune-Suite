"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { ROUTES, resolveFeatureRoute, createFeatureRouter, adaptFeatureResult } = require("../lib/providers/feature-router");
const { selection, startupPermissions } = require("../lib/providers/suite-provider");
const { createTargetBindings, TARGET_KEYS } = require("../lib/providers/target-binding");
test("every adapted operation resolves exactly and never accepts an alternate method or provider", async () => {
  const calls = [], providers = { async read(operation, options) { calls.push({ operation, options }); return { data: operation.startsWith("explorer.") ? { ok: true } : operation === "players" ? { players: [] } : operation === "health" ? { runtime: { state: "running" } } : operation === "configuration" ? { settings: {} } : {}, limitations: [] }; } };
  const router = createFeatureRouter({ providers, selection });
  for (const route of ROUTES) {
    assert.equal(resolveFeatureRoute(route.path, route.method), route);
    assert.equal(resolveFeatureRoute(route.path, "DELETE"), null);
    assert.equal((await router.dispatch({ serverType: "local-hyperv" }, route)).handled, false);
    assert.equal(calls.length, ROUTES.indexOf(route));
    assert.equal((await router.dispatch({ serverType: "remote-linux" }, route)).handled, true);
    assert.equal(calls.at(-1).operation, route.operation);
    for (const type of ["docker", "proxmox", "managed-hosting", "typo"]) await assert.rejects(router.dispatch({ serverType: type }, route));
  }
  await assert.rejects(router.dispatch({ serverType: "remote-linux" }, { method: "GET", path: "/api/action/start", operation: "status" }));
});
test("common response contracts preserve unknown health, metadata-only versions and scoped player identity", () => {
  const version = adaptFeatureResult("version", { data: { steamBuild: "123" } }); assert.equal(version.updateAvailable, null);
  const status = adaptFeatureResult("status", { data: { state: "running", kind: "native" } }); assert.equal(status.topServerStatus.online, false);
  const player = adaptFeatureResult("players", { data: { players: [{ id: "1", name: "fixture", status: "1" }] } }).players[0];
  assert.equal(player.account_id, null); assert.equal(player.player_state_row_id, null); assert.equal(player.mutationsAvailable, false);
  const config = adaptFeatureResult("configuration", { data: { settings: { m_GlobalXPMultiplier: 2, unknown: 3 } } }); assert.equal(config.schema.length, 1); assert.equal(config.readOnly, true);
});
test("disconnects or missing permissions fail every adapted route without a legacy fallback", async () => {
  let calls = 0;
  const router = createFeatureRouter({ selection, providers: { async read() { calls++; throw new Error("feature_unavailable"); } } });
  for (const route of ROUTES) await assert.rejects(router.dispatch({ serverType: "remote-linux" }, route));
  assert.equal(calls, ROUTES.length);
});
test("all target fields are locked during reads and registered jobs; UI preferences remain changeable", async () => {
  let jobs = 0;
  const bindings = createTargetBindings({ activeOperations: () => jobs }), config = { serverType: "remote-linux", sshHost: "first", vmName: "vm" };
  await bindings.run(config, async () => {
    assert.equal(bindings.current().sshHost, "first"); config.sshHost = "outside-change"; assert.equal(bindings.current().sshHost, "first");
    for (const key of TARGET_KEYS) assert.throws(() => bindings.assertChange(config, { ...config, [key]: key === "selectedBattlegroup" ? { namespace: "new", name: "new" } : "changed" }));
    assert.doesNotThrow(() => bindings.assertChange(config, { ...config, uiMode: "advanced" }));
    assert.throws(() => bindings.assertCurrent(config), /target_changed/);
    await assert.rejects(bindings.run(config, async () => { throw new Error("disconnect"); }));
    assert.equal(bindings.activeCount(), 1);
  });
  assert.equal(bindings.activeCount(), 0); assert.doesNotThrow(() => bindings.assertChange(config, { ...config, sshHost: "next" }));
  jobs = 1; assert.throws(() => bindings.assertChange(config, { ...config, serverType: "docker" }));
});
test("Electron main-process handlers reject nonlegacy script/path launches before side effects", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  for (const channel of ["open-path", "open-battlegroup-batch"]) {
    const begin = source.indexOf('ipcMain.handle("' + channel + '"'), end = source.indexOf('ipcMain.handle("', begin + 1);
    let callback, calls = 0, config = { serverType: "remote-linux" };
    const context = vm.createContext({ ipcMain: { handle(name, handler) { callback = handler; } }, providerSelection: selection, providerStartupPermissions: startupPermissions, readAppConfig: () => config, battlegroupBatchPath() { calls++; return null; }, shell: { openPath() { calls++; } }, fs: { existsSync() { calls++; return false; } }, path });
    vm.runInContext(source.slice(begin, end), context);
    for (const type of ["remote-linux", "docker", "proxmox", "managed-hosting", "typo"]) { config = { serverType: type }; assert.equal((await callback({}, {})).ok, false); }
    config = { setupComplete: false }; assert.equal((await callback({}, {})).ok, false);
    assert.equal(calls, 0);
  }
});
test("Electron profile read failures do not default malformed profiles to Hyper-V", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8"), begin = source.indexOf("function readAppConfig()"), end = source.indexOf("function battlegroupBatchPath", begin);
  let code = "EINVAL";
  const context = vm.createContext({ fs: { readFileSync() { throw Object.assign(new Error("fixture"), { code }); } }, userPath: value => value });
  vm.runInContext(source.slice(begin, end), context);
  assert.equal(selection(vm.runInContext("readAppConfig()", context)), "unsupported"); code = "ENOENT";
  assert.equal(vm.runInContext("readAppConfig().setupComplete", context), false);
});
