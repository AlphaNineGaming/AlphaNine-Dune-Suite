"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Tests use mocks, source inspection and disposable local files. Backend tests
// must use the safe fixture preloads; never contact a VM or a real database.
const cases = [
  ["test-provider-foundation.cjs", ["--test"]],
  ["test-provider-integration.cjs", ["--test"]],
  ["test-provider-deployment.cjs", ["--test"]],
  ["test-provider-database.cjs", ["--test"]],
  ["test-provider-ui.cjs", ["--test"]],
  ["test-provider-routing.cjs", ["--test"]],
  ...["test-database-browser.js", "test-player-directory.js", "test-user-game-settings.js"].map(name => [name, []]),
  ...["test-vm-disk-compaction.js", "test-vm-connection-cache.cjs", "test-vm-status-view.cjs", "test-health-check-runner.cjs", "test-operations.js", "test-battlegroup-control.js", "test-battlegroup-control-paths.js", "test-read-only-ssh-retry.cjs", "test-recovery-archive-transport.js", "test-vendor-backup-path.js", "test-vm-scheduler.js", "test-server-health.js", "test-database-ownership-repair.js", "test-migration-schema-restore.js", "test-user-game-recovery.js", "test-blueprint-designer-startup.js"].map(name => [name, []]),
  ...["test-database-backup.js", "test-battlegroup-import-promotion.js", "test-setup-path-persistence.js", "test-secret-config-persistence.js", "test-setup-database-auth.js", "test-rendered-ui-syntax.js"].map(name => [name, ["--require", path.join(__dirname, "provider-lab/safe-regression-entry.cjs")]])
];
const root = path.resolve(__dirname, "..");
const tempParent = path.join(root, "work", "provider-tests");
fs.mkdirSync(tempParent, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempParent, "run-"));
const results = [];
try {
  for (const [name, flags] of cases) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [...flags, path.join(__dirname, name)], { cwd: root, env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }, timeout: 45000, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const passed = result.status === 0 && !result.error;
    results.push({ script: name, passed, exitCode: result.status, durationMs: Date.now() - started, stdout: result.stdout || "", stderr: result.stderr || "" });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
    if (!passed) console.error(result.stderr || "Test did not complete successfully.");
  }
  fs.writeFileSync(path.join(tempParent, "results.json"), JSON.stringify({ environment: "local-mocks-and-subprocesses", node: process.version, results }, null, 2) + "\n");
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
