"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { serverDownloadRepairCommand, classifyDownloadRepairResult, downloadRepairProgress, runDownloadRepair } = require("../lib/server-download-repair");
const { OperationRegistry } = require("../lib/operations");
const { runServerUpdateLifecycle } = require("../lib/server-update");

(async () => {
  const success = { ok: true, code: 0, stdout: "Success! App '4754530' fully installed.\n", stderr: "" };
  assert.equal(classifyDownloadRepairResult(success), success);
  assert.equal(downloadRepairProgress("Update state (0x61) downloading, progress: 100.00", 1), 70);
  assert.equal(downloadRepairProgress("Update state (0x81) verifying update, progress: 20.00", 70), 75);
  assert.equal(downloadRepairProgress("Update state (0x101) committing, progress: 100.00", 75), 95);
  for (const change of [
    { ok: false, code: 1, error: "Disk full" },
    { stdout: "" }, { stdout: "Success! App '123' fully installed." },
    { timedOut: true }, { signal: "SIGTERM" },
    { stdout: success.stdout + "Error! App '4754530' state is 0x2A6 after update job\n" },
    { stderr: "Error! App '4754530' state is 0x2A6 after update job\n" }
  ]) assert.equal(classifyDownloadRepairResult({ ...success, ...change }).ok, false);
  const command = serverDownloadRepairCommand();
  assert(command.includes('+force_install_dir "$download" +login anonymous +app_update 4754530 validate +quit'));
  assert(command.includes('flock -n 9'));
  assert(command.includes('pgrep -x steamcmd'));
  assert(!/\brm\s|\bchown\s|\bkill\s|battlegroup update/.test(command));
  let lines = [];
  const result = await runDownloadRepair(async (actual, options) => {
    assert.equal(actual, command);
    assert.equal(options.timeout, 30 * 60 * 1000);
    options.onLine("Validating Dune server download");
    return success;
  }, line => lines.push(line));
  assert.equal(result.ok, true);
  assert.equal(lines.length, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-download-repair-'));
  try {
    const registry = new OperationRegistry(path.join(dir, 'operations.json'));
    const operation = registry.begin('battlegroup:update:validate', 'Repair Server Download');
    for (const key of ['battlegroup:update', 'battlegroup:update:validate', 'database:backup']) {
      assert.throws(() => registry.begin(key, key), /already running/);
    }
    await runServerUpdateLifecycle({
      execute: () => runDownloadRepair(async () => ({ ok: false, error: 'Permission denied' })),
      onFailure: failure => registry.finish(operation, 'failed', failure.message)
    });
    assert.equal(registry.snapshot().active.length, 0);
    assert.equal(operation.status, 'failed');
    registry.begin('battlegroup:update', 'Update');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('Download validation, explicit Steam failures, operation conflicts and cleanup passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
