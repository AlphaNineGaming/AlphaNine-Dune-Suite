"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
  CRON_BEGIN,
  CRON_END,
  defaultSchedulerConfig,
  normalizeSchedulerConfig,
  saveSchedulerConfig,
  readSchedulerConfig,
  buildInstallCommand,
  buildStatusCommand,
  buildActionCommand,
  buildRemoveCommand,
  parseJsonOutput
} = require("../lib/vm-scheduler");

const battlegroup = "sh-bc2164ff4412d2d4-ykybyv";
const scriptPath = path.join(__dirname, "..", "assets", "scheduler", "alphanine-scheduler.sh");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

const config = normalizeSchedulerConfig({
  ...defaultSchedulerConfig(battlegroup),
  timezone: "Asia/Jerusalem",
  backup: { enabled: true, time: "04:00", retention: 10, timeoutMinutes: 20 },
  restart: { enabled: true, time: "05:00", backupFirst: true, backupFreshMinutes: 90, playersOnlinePolicy: "skip", maxDeferralMinutes: 180, healthTimeoutMinutes: 15 }
}, battlegroup);

assert.equal(config.battlegroup, battlegroup);
assert.equal(config.restart.playersOnlinePolicy, "skip");
assert.equal(config.restart.backupFirst, true);
assert.throws(() => normalizeSchedulerConfig({ ...config, timezone: "../../etc/passwd" }), /Timezone/);
assert.throws(() => normalizeSchedulerConfig({ ...config, battlegroup: "bad;rm" }), /battlegroup/);
assert.throws(() => normalizeSchedulerConfig({ ...config, backup: { ...config.backup, time: "25:00" } }), /Backup time/);
assert.throws(() => normalizeSchedulerConfig({ ...config, restart: { ...config.restart, playersOnlinePolicy: "maybe" } }), /policy/);
assert.throws(() => normalizeSchedulerConfig({ ...config, restart: { ...config.restart, backupFirst: false } }), /verified safety backup/);
assert.throws(() => normalizeSchedulerConfig({ ...config, restart: { ...config.restart, time: config.backup.time } }), /must differ/);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-scheduler-test-"));
const configPath = path.join(tempDir, "scheduler.json");
const saved = saveSchedulerConfig(configPath, config, battlegroup);
assert.deepEqual(readSchedulerConfig(configPath, battlegroup), saved);
assert.equal(fs.statSync(configPath).size > 100, true);

const install = buildInstallCommand({ config, scriptSource, appVersion: "test" });
assert(install.includes("apk add --no-cache bash jq util-linux tzdata"));
assert(install.includes("bash -n /tmp/alphanine-scheduler.sh"));
assert(install.includes("/etc/crontabs/dune"));
assert(install.includes("rc-service crond restart"));
assert(install.includes("alphanine-scheduler.sh' initialize"));
assert(install.includes("alphanine-scheduler.sh' self-test"));
assert(!install.includes("battlegroup backup"), "Installer must not execute a backup.");
assert(!install.includes("battlegroup restart"), "Installer must not execute a restart.");

const crlfInstall = buildInstallCommand({
  config,
  scriptSource: "#!/bin/bash\r\nlog_line() {\r\n  printf '%s\\n' ok\r\n}\r\n",
  appVersion: "line-ending-test"
});
const runtimePayload = crlfInstall.match(/printf %s '([^']+)' \| base64 -d \| gzip -d > \/tmp\/alphanine-scheduler\.sh/)?.[1];
assert(runtimePayload, "Installer runtime payload was not found.");
const decodedRuntime = zlib.gunzipSync(Buffer.from(runtimePayload, "base64")).toString("utf8");
assert.equal(decodedRuntime, "#!/bin/bash\nlog_line() {\n  printf '%s\\n' ok\n}\n");
assert.equal(decodedRuntime.includes("\r"), false, "VM scheduler payload must use Unix LF line endings.");

assert(buildStatusCommand().includes("alphanine-scheduler.sh"));
assert(buildStatusCommand().includes("base64 -d"));
assert(buildActionCommand("backup-now").includes("backup-now"));
assert(buildActionCommand("restart-now").includes("restart-now"));
assert.throws(() => buildActionCommand("update"), /Unknown/);
assert(buildRemoveCommand().includes("rm -rf '/home/dune/.dune/alphanine-scheduler'"));
assert(buildRemoveCommand().includes(CRON_BEGIN));
assert(buildRemoveCommand().includes(CRON_END));
assert.deepEqual(parseJsonOutput('noise\n{"ok":true,"installed":true}'), { ok: true, installed: true });

for (const required of [
  "DatabaseOperation",
  "alphanine-scheduled-",
  "app.kubernetes.io/managed-by: alphanine-dune-suite",
  "active_database_operation_count",
  "update_process_running",
  "player_count",
  "backup_is_fresh",
  "wait_for_health",
  "health was not fully ready before restart",
  "playersOnlinePolicy",
  "lastSuccessfulBackupEpoch",
  "scheduler.lock",
  "Funcom reported success but the backup artifact is missing or empty",
  "recovery manifest",
  "configured force policy",
  "Daily restart was skipped"
]) assert(scriptSource.includes(required), `Scheduler runtime is missing safety behavior: ${required}`);

assert(!scriptSource.includes("/home/dune/.dune/bin/battlegroup backup"), "Runtime must not use interactive backup CLI.");
assert(!scriptSource.includes("/home/dune/.dune/bin/battlegroup restart"), "Runtime must not use interactive restart CLI.");
assert.match(scriptSource, /case "\$file" in[\s\S]*alphanine-scheduled-\*\.backup/);
assert.match(scriptSource, /player_count[\s\S]*restart postponed because players are online/i);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("VM scheduler validation, installer, exact targeting, safety gates, retention scope, and command tests passed.");
