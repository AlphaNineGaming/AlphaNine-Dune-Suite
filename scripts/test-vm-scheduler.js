"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
  CRON_BEGIN,
  CRON_END,
  VM_SCHEDULER_CRON_FILE,
  defaultSchedulerConfig,
  normalizeSchedulerConfig,
  saveSchedulerConfig,
  readSchedulerConfig,
  classifyStatusInventory,
  countSchedulerProcessArguments,
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
assert(install.includes(VM_SCHEDULER_CRON_FILE));
assert(install.includes("command -v crond"));
assert(install.includes("alphanine-scheduler-cron.$$"));
assert(install.includes("/etc/crontabs/dune.next-"));
assert(install.includes('test "$begin_count" = "$end_count"'));
assert(install.includes('mv -f "$cron_next"'));
assert(!install.includes("sed -i"), "Schedule updates must preserve unrelated entries through a staged file.");
assert(!/rc-service|systemctl|service crond/.test(install), "The scheduler installer must not require or restart a service manager.");
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

const statusCommand = buildStatusCommand();
assert(statusCommand.includes("alphanine-scheduler.sh"));
assert(statusCommand.includes("base64 -d"));
assert(statusCommand.includes("path_refs"), "Scheduler absence must reject stale cron registrations.");
assert(statusCommand.includes("elif sudo -n test ! -e '/etc/crontabs/dune'"), "A positively absent cron file must have a dedicated branch.");
assert(statusCommand.includes("then begin_count=0; end_count=0; path_refs=0"), "The absent-file branch must set exact decimal zero counts without grep.");
assert(statusCommand.includes('case "$count_rc" in 0|1)'), "An existing empty cron file must accept grep's valid no-match status.");
assert(statusCommand.includes("*) return 1"), "Permission, I/O, and command failures must remain ambiguous.");
assert(statusCommand.includes("case \"$count_value\" in ''|*[!0-9]*"), "Malformed count output must remain ambiguous.");
assert(!statusCommand.includes("grep -Fxc '# BEGIN ALPHANINE DUNE SCHEDULER' '/etc/crontabs/dune' 2>/dev/null || true"), "Status inspection must not erase cron read failures.");
assert(statusCommand.includes("/etc/cron.d /etc/periodic"), "Alternate cron locations must remain in the fail-closed inventory.");
assert(statusCommand.includes("kubectl get cronjobs -A -o json"), "Kubernetes CronJobs must remain in the fail-closed inventory.");
assert(statusCommand.includes("sudo -n kubectl get cronjobs"), "Kubernetes evidence must use the Suite's configured non-interactive privileged path.");
assert(!statusCommand.includes("command -v kubectl"), "Kubernetes evidence must not depend on the unprivileged SSH user's PATH.");
assert(statusCommand.includes("kubernetes_query_rc"), "Privileged Kubernetes failure must be captured explicitly.");
assert(statusCommand.includes("ps -eo pid=,comm=,args="), "Running scheduler and restart helpers must remain in the fail-closed inventory.");
assert(statusCommand.includes("$field == scheduler") && statusCommand.includes("$(field + 1)"), "Helper detection must use exact argument boundaries rather than shell-source substrings.");
assert(!statusCommand.includes("for (index="), "BusyBox awk built-ins must not be reused as loop-variable names.");
assert(statusCommand.includes("rc-update show -v"), "OpenRC restart registrations must remain in the fail-closed inventory.");
assert(statusCommand.includes("process_query_rc") && statusCommand.includes("openrc_query_rc"), "Process and OpenRC evidence must be evaluated independently of Kubernetes evidence.");
assert(!statusCommand.includes("$evidence_ok") && !/(?:^|\n)evidence_ok=/.test(statusCommand), "One failed scheduler probe must not suppress later independent probes.");
for (const validity of ["filesystem_evidence_ok", "cron_evidence_ok", "alternate_cron_evidence_ok", "kubernetes_evidence_ok", "process_evidence_ok", "openrc_evidence_ok"]) {
  assert(statusCommand.includes(`[ \"$${validity}\" = true ]`), `${validity} must participate in the final fail-closed decision.`);
}
assert(!statusCommand.includes("crond_process"), "A generic crond process must not be classified as an AlphaNine restart schedule.");
const statusPayloads = [...statusCommand.matchAll(/printf %s '([^']+)' \| base64 -d/g)].map((match) => JSON.parse(Buffer.from(match[1], "base64").toString("utf8")));
assert(statusPayloads.some((payload) => payload.schedulerMode === "absent" && payload.ambiguousRegistration === false));
assert(statusPayloads.some((payload) => payload.schedulerMode === "ambiguous" && payload.ambiguousRegistration === true));

const noExternalScheduler = {
  evidenceValid: true,
  filesystemEvidenceValid: true,
  cronEvidenceValid: true,
  alternateCronEvidenceValid: true,
  kubernetesEvidenceValid: true,
  processEvidenceValid: true,
  openRcEvidenceValid: true,
  directoryExists: false,
  scriptExists: false,
  configExists: false,
  beginCount: "0",
  endCount: "0",
  pathRefs: "0",
  alternateCronRefs: "0",
  kubernetesCronJobRefs: "0",
  helperProcessRefs: "0",
  openRcRestartRefs: "0",
  unprivilegedKubectlAvailable: false,
  genericCrondRunning: true
};
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "absent" }).schedulerMode, "absent", "A positively absent dune crontab is safe when every independent registration check is empty.");
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "absent", unprivilegedKubectlAvailable: false, kubernetesEvidenceValid: true }).schedulerMode, "absent", "Missing unprivileged kubectl must not block a successful privileged zero-CronJob inspection.");
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "file" }).schedulerMode, "absent", "An existing empty dune crontab is safe.");
assert.equal(classifyStatusInventory({
  ...noExternalScheduler,
  cronFileState: "file",
  directoryExists: true,
  scriptExists: true,
  configExists: true,
  beginCount: "1",
  endCount: "1",
  pathRefs: "1"
}).schedulerMode, "installed", "One exact managed registration is installed.");
for (const partial of [
  { beginCount: "1", endCount: "0", pathRefs: "1" },
  { beginCount: "0", endCount: "1", pathRefs: "0" },
  { beginCount: "0", endCount: "0", pathRefs: "1" }
]) assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "file", ...partial }).schedulerMode, "ambiguous", "Partial markers and stale path references must fail closed.");
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "file", evidenceValid: false }).schedulerMode, "ambiguous", "Cron permission or I/O failure must fail closed.");
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "absent", kubernetesEvidenceValid: false, kubernetesFailure: "sudo_denied" }).schedulerMode, "ambiguous", "Non-interactive sudo denial must fail closed.");
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "absent", kubernetesEvidenceValid: false, kubernetesFailure: "malformed_json" }).schedulerMode, "ambiguous", "Malformed CronJob JSON must fail closed.");
assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "absent", kubernetesCronJobRefs: "1" }).schedulerMode, "ambiguous", "A nonzero AlphaNine CronJob count must fail closed.");
for (const malformed of ["", "-1", "1x", " 0", "0\n0"]) {
  assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "file", beginCount: malformed }).schedulerMode, "ambiguous", "Malformed count output must fail closed.");
}
for (const conflict of ["alternateCronRefs", "kubernetesCronJobRefs", "helperProcessRefs", "openRcRestartRefs"]) {
  assert.equal(classifyStatusInventory({ ...noExternalScheduler, cronFileState: "absent", [conflict]: "1" }).schedulerMode, "ambiguous", `${conflict} must fail closed.`);
}
assert.equal(countSchedulerProcessArguments([{ argv: ["bash", "-c", statusCommand] }]), "0", "The read-only status probe must not classify its own shell source as a scheduler process.");
assert.equal(countSchedulerProcessArguments([{ argv: ["/bin/bash", "/home/dune/.dune/alphanine-scheduler/alphanine-scheduler.sh", "tick"] }]), "1", "A real scheduler tick must remain blocking.");
assert.equal(countSchedulerProcessArguments([{ argv: ["/home/dune/.dune/bin/battlegroup", "restart"] }]), "1", "A real battlegroup restart helper must remain blocking.");
assert.equal(countSchedulerProcessArguments([{ argv: ["bash", "-c", "printf battlegroup restart"] }]), "0", "Presentation text containing a restart phrase is not an executable argument pair.");
assert(buildActionCommand("backup-now").includes("backup-now"));
assert(buildActionCommand("restart-now").includes("restart-now"));
assert.throws(() => buildActionCommand("update"), /Unknown/);
assert(buildRemoveCommand().includes("rm -rf '/home/dune/.dune/alphanine-scheduler'"));
assert(buildRemoveCommand().includes(CRON_BEGIN));
assert(buildRemoveCommand().includes(CRON_END));
assert(buildRemoveCommand().includes("alphanine-scheduler-remove.$$"));
assert(buildRemoveCommand().includes('mv -f "$cron_next"'));
assert(!buildRemoveCommand().includes("sed -i"), "Scheduler removal must atomically preserve unrelated schedules.");
assert(!/rc-service|systemctl|service crond/.test(buildRemoveCommand()), "Scheduler removal must not restart cron.");
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

assert(scriptSource.includes('add_check "cron-runtime"'), "Self-test must validate the BusyBox crond runtime without controlling it.");
assert(!/rc-service|systemctl|service crond/.test(scriptSource), "Scheduler runtime must not control a service manager.");

assert(!scriptSource.includes("/home/dune/.dune/bin/battlegroup backup"), "Runtime must not use interactive backup CLI.");
assert(!scriptSource.includes("/home/dune/.dune/bin/battlegroup restart"), "Runtime must not use interactive restart CLI.");
assert.match(scriptSource, /case "\$file" in[\s\S]*alphanine-scheduled-\*\.backup/);
assert.match(scriptSource, /player_count[\s\S]*restart postponed because players are online/i);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("VM scheduler validation, installer, exact targeting, safety gates, retention scope, and command tests passed.");
