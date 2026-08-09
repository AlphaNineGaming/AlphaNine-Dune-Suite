"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const VM_SCHEDULER_DIR = "/home/dune/.dune/alphanine-scheduler";
const VM_SCHEDULER_SCRIPT = `${VM_SCHEDULER_DIR}/alphanine-scheduler.sh`;
const VM_SCHEDULER_CONFIG = `${VM_SCHEDULER_DIR}/config.json`;
const VM_SCHEDULER_CRON_FILE = "/etc/crontabs/dune";
const CRON_BEGIN = "# BEGIN ALPHANINE DUNE SCHEDULER";
const CRON_END = "# END ALPHANINE DUNE SCHEDULER";

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function bool(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function integer(value, fallback, min, max, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) throw new Error(`${label} must be from ${min} to ${max}.`);
  return parsed;
}

function timeValue(value, fallback, label) {
  const result = String(value || fallback).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error(`${label} must use 24-hour HH:MM format.`);
  return result;
}

function timezoneValue(value) {
  const timezone = String(value || "UTC").trim();
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/.test(timezone)) {
    throw new Error("Timezone must be a valid IANA name such as UTC, Asia/Jerusalem, or America/New_York.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Timezone ${timezone} is not supported by this Suite runtime.`);
  }
  return timezone;
}

function battlegroupValue(value) {
  const battlegroup = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(battlegroup)) throw new Error("Choose a valid battlegroup before installing the scheduler.");
  return battlegroup;
}

function defaultTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function defaultSchedulerConfig(battlegroup = "") {
  return {
    version: 1,
    enabled: true,
    battlegroup: String(battlegroup || "").trim(),
    timezone: defaultTimezone(),
    catchUpWindowMinutes: 120,
    backup: {
      enabled: true,
      time: "04:00",
      retention: 7,
      timeoutMinutes: 15
    },
    restart: {
      enabled: true,
      time: "05:00",
      backupFirst: true,
      backupFreshMinutes: 90,
      playersOnlinePolicy: "skip",
      maxDeferralMinutes: 180,
      healthTimeoutMinutes: 15
    }
  };
}

function normalizeSchedulerConfig(input = {}, battlegroupFallback = "") {
  const base = defaultSchedulerConfig(battlegroupFallback);
  const backup = input.backup && typeof input.backup === "object" ? input.backup : {};
  const restart = input.restart && typeof input.restart === "object" ? input.restart : {};
  const policy = String(restart.playersOnlinePolicy || base.restart.playersOnlinePolicy).trim().toLowerCase();
  if (!new Set(["skip", "force"]).has(policy)) throw new Error("Players-online policy must be skip or force.");
  const normalized = {
    version: 1,
    enabled: bool(input.enabled, base.enabled),
    battlegroup: battlegroupValue(input.battlegroup || battlegroupFallback),
    timezone: timezoneValue(input.timezone || base.timezone),
    catchUpWindowMinutes: integer(input.catchUpWindowMinutes, base.catchUpWindowMinutes, 0, 720, "Catch-up window"),
    backup: {
      enabled: bool(backup.enabled, base.backup.enabled),
      time: timeValue(backup.time, base.backup.time, "Backup time"),
      retention: integer(backup.retention, base.backup.retention, 1, 90, "Backup retention"),
      timeoutMinutes: integer(backup.timeoutMinutes, base.backup.timeoutMinutes, 5, 60, "Backup timeout")
    },
    restart: {
      enabled: bool(restart.enabled, base.restart.enabled),
      time: timeValue(restart.time, base.restart.time, "Restart time"),
      backupFirst: bool(restart.backupFirst, base.restart.backupFirst),
      backupFreshMinutes: integer(restart.backupFreshMinutes, base.restart.backupFreshMinutes, 5, 720, "Backup freshness"),
      playersOnlinePolicy: policy,
      maxDeferralMinutes: integer(restart.maxDeferralMinutes, base.restart.maxDeferralMinutes, 0, 720, "Maximum restart deferral"),
      healthTimeoutMinutes: integer(restart.healthTimeoutMinutes, base.restart.healthTimeoutMinutes, 5, 60, "Restart health timeout")
    }
  };
  if (normalized.restart.enabled && !normalized.restart.backupFirst) {
    throw new Error("A verified safety backup is required before every scheduled restart.");
  }
  if (normalized.backup.enabled && normalized.restart.enabled && normalized.backup.time === normalized.restart.time) {
    throw new Error("Backup and restart times must differ. The restart can reuse a recent verified scheduler backup.");
  }
  return normalized;
}

function readSchedulerConfig(filePath, battlegroupFallback = "") {
  if (!fs.existsSync(filePath)) return defaultSchedulerConfig(battlegroupFallback);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  return normalizeSchedulerConfig(raw, battlegroupFallback);
}

function saveSchedulerConfig(filePath, input, battlegroupFallback = "") {
  const config = normalizeSchedulerConfig(input, battlegroupFallback);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  return config;
}

function cronBlock() {
  return `${CRON_BEGIN}\n* * * * * ${VM_SCHEDULER_SCRIPT} tick >/dev/null 2>&1\n${CRON_END}\n`;
}

function gzipBase64(value) {
  return zlib.gzipSync(Buffer.from(String(value), "utf8"), { level: 9 }).toString("base64");
}

function normalizeShellSource(value) {
  return String(value || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function base64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

const STATUS_COUNT_FIELDS = Object.freeze([
  "beginCount",
  "endCount",
  "pathRefs",
  "alternateCronRefs",
  "kubernetesCronJobRefs",
  "helperProcessRefs",
  "openRcRestartRefs"
]);
const STATUS_VALIDITY_FIELDS = Object.freeze([
  "filesystemEvidenceValid",
  "cronEvidenceValid",
  "alternateCronEvidenceValid",
  "kubernetesEvidenceValid",
  "processEvidenceValid",
  "openRcEvidenceValid"
]);

function schedulerStatusPayload(mode) {
  if (mode === "absent") return { ok: true, installed: false, schedulerMode: "absent", cronRegistered: false, ambiguousRegistration: false, config: null, state: null, lastStatus: null, history: [] };
  return { ok: false, installed: false, schedulerMode: "ambiguous", cronRegistered: false, ambiguousRegistration: true, config: null, state: null, lastStatus: null, history: [], error: "The VM scheduler is partial, stale, conflicting, or could not be inspected unambiguously." };
}

function classifyStatusInventory(evidence = {}) {
  const ambiguous = schedulerStatusPayload("ambiguous");
  if (evidence.evidenceValid !== true) return ambiguous;
  if (STATUS_VALIDITY_FIELDS.some((field) => evidence[field] !== true)) return ambiguous;
  if (!new Set(["absent", "file"]).has(evidence.cronFileState)) return ambiguous;
  for (const field of ["directoryExists", "scriptExists", "configExists"]) {
    if (typeof evidence[field] !== "boolean") return ambiguous;
  }
  const counts = {};
  for (const field of STATUS_COUNT_FIELDS) {
    const value = String(evidence[field] ?? "");
    if (!/^(?:0|[1-9]\d*)$/.test(value)) return ambiguous;
    counts[field] = value;
  }
  if (evidence.cronFileState === "absent" && (counts.beginCount !== "0" || counts.endCount !== "0" || counts.pathRefs !== "0")) return ambiguous;
  const noConflicts = counts.alternateCronRefs === "0"
    && counts.kubernetesCronJobRefs === "0"
    && counts.helperProcessRefs === "0"
    && counts.openRcRestartRefs === "0";
  const installed = evidence.directoryExists === true
    && evidence.scriptExists === true
    && evidence.configExists === true
    && evidence.cronFileState === "file"
    && counts.beginCount === "1"
    && counts.endCount === "1"
    && counts.pathRefs === "1"
    && noConflicts;
  if (installed) return { schedulerMode: "installed", cronRegistrationCount: "1", ambiguousRegistration: false };
  const absent = evidence.directoryExists === false
    && evidence.scriptExists === false
    && evidence.configExists === false
    && counts.beginCount === "0"
    && counts.endCount === "0"
    && counts.pathRefs === "0"
    && noConflicts;
  return absent ? schedulerStatusPayload("absent") : ambiguous;
}

function countSchedulerProcessArguments(processes = [], schedulerPath = VM_SCHEDULER_SCRIPT) {
  const schedulerActions = new Set(["tick", "initialize", "self-test", "backup-now", "restart-now"]);
  const battlegroupActions = new Set(["start", "restart", "update"]);
  let count = 0;
  for (const process of Array.isArray(processes) ? processes : []) {
    const argv = Array.isArray(process?.argv) ? process.argv.map((value) => String(value)) : [];
    let matched = false;
    for (let index = 0; index + 1 < argv.length; index += 1) {
      const executable = argv[index];
      const action = argv[index + 1];
      if (executable === schedulerPath && schedulerActions.has(action)) matched = true;
      if ((executable === "battlegroup" || executable.endsWith("/battlegroup")) && battlegroupActions.has(action)) matched = true;
    }
    if (matched) count += 1;
  }
  return String(count);
}

function buildInstallCommand({ config, scriptSource, appVersion }) {
  const normalized = normalizeSchedulerConfig(config);
  if (!String(scriptSource || "").trim()) throw new Error("Bundled scheduler runtime is missing.");
  const scriptPayload = gzipBase64(normalizeShellSource(scriptSource));
  const remoteConfig = { ...normalized, generatedBy: `AlphaNine Dune Suite ${appVersion || "development"}`, installedAt: new Date().toISOString() };
  const configPayload = base64(`${JSON.stringify(remoteConfig, null, 2)}\n`);
  const cronPayload = base64(cronBlock());
  const timezonePath = `/usr/share/zoneinfo/${normalized.timezone}`;
  const steps = [
    ["dependencies", `if [ ! -e ${shellQuote(timezonePath)} ] || ! command -v jq >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then sudo -n apk add --no-cache bash jq util-linux tzdata >/dev/null; fi`],
    ["requirements", "command -v bash >/dev/null && command -v jq >/dev/null && command -v flock >/dev/null && command -v timeout >/dev/null && command -v kubectl >/dev/null && command -v crond >/dev/null"],
    ["timezone", `test -e ${shellQuote(timezonePath)}`],
    ["directory", `sudo -n install -d -o dune -g dune -m 0750 ${shellQuote(VM_SCHEDULER_DIR)}`],
    ["runtime", `printf %s ${shellQuote(scriptPayload)} | base64 -d | gzip -d > /tmp/alphanine-scheduler.sh && bash -n /tmp/alphanine-scheduler.sh && sudo -n install -o dune -g dune -m 0750 /tmp/alphanine-scheduler.sh ${shellQuote(VM_SCHEDULER_SCRIPT)} && rm -f /tmp/alphanine-scheduler.sh`],
    ["configuration", `printf %s ${shellQuote(configPayload)} | base64 -d > /tmp/alphanine-scheduler-config.json && jq -e . /tmp/alphanine-scheduler-config.json >/dev/null && sudo -n install -o dune -g dune -m 0640 /tmp/alphanine-scheduler-config.json ${shellQuote(VM_SCHEDULER_CONFIG)} && rm -f /tmp/alphanine-scheduler-config.json`],
    ["cron", `cron_stage=/tmp/alphanine-scheduler-cron.$$; cron_next=${shellQuote(`${VM_SCHEDULER_CRON_FILE}.next-`)}$$; cleanup_scheduler_cron() { rm -f "$cron_stage" 2>/dev/null || true; sudo -n rm -f "$cron_next" 2>/dev/null || true; }; trap cleanup_scheduler_cron EXIT HUP INT TERM; sudo -n touch ${shellQuote(VM_SCHEDULER_CRON_FILE)}; begin_count=$(sudo -n grep -Fxc ${shellQuote(CRON_BEGIN)} ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null || true); end_count=$(sudo -n grep -Fxc ${shellQuote(CRON_END)} ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null || true); test "$begin_count" = "$end_count" && test "$begin_count" -le 1; sudo -n cat ${shellQuote(VM_SCHEDULER_CRON_FILE)} | sed ${shellQuote(`/^${CRON_BEGIN}$/,/^${CRON_END}$/d`)} > "$cron_stage"; printf %s ${shellQuote(cronPayload)} | base64 -d >> "$cron_stage"; sudo -n install -o root -g root -m 0600 "$cron_stage" "$cron_next"; sudo -n mv -f "$cron_next" ${shellQuote(VM_SCHEDULER_CRON_FILE)}; rm -f "$cron_stage"`],
    ["cron-runtime", "sudo -n ps -eo comm= 2>/dev/null | grep -Eq '^crond$'"],
    ["initialize", `${shellQuote(VM_SCHEDULER_SCRIPT)} initialize >/dev/null`],
    ["self-test", `${shellQuote(VM_SCHEDULER_SCRIPT)} self-test`]
  ];
  return [
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...steps.map(([label, command]) => `printf '%s\\n' ${shellQuote(`[scheduler-install] ${label}`)}; ${command}`)
  ].join("\n");
}

function buildStatusCommand() {
  const missing = base64(JSON.stringify(schedulerStatusPayload("absent")));
  const ambiguous = base64(JSON.stringify(schedulerStatusPayload("ambiguous")));
  const restartReferencePattern = `${VM_SCHEDULER_SCRIPT.replace(/\./g, "\\.")}|battlegroup[[:space:]]+(start|restart|update)`;
  return [
    "filesystem_evidence_ok=true; cron_evidence_ok=true; alternate_cron_evidence_ok=true; kubernetes_evidence_ok=true; process_evidence_ok=true; openrc_evidence_ok=true",
    "count_file_matches() { count_value=$(sudo -n grep \"$1\" \"$2\" \"$3\" 2>/dev/null); count_rc=$?; case \"$count_rc\" in 0|1) ;; *) return 1;; esac; case \"$count_value\" in ''|*[!0-9]*) return 1;; esac; printf %s \"$count_value\"; }",
    "count_text_matches() { count_value=$(printf '%s\\n' \"$1\" | grep -Eic \"$2\"); count_rc=$?; case \"$count_rc\" in 0|1) ;; *) return 1;; esac; case \"$count_value\" in ''|*[!0-9]*) return 1;; esac; printf %s \"$count_value\"; }",
    "scan_tree_refs() { scan_root=$1; scan_pattern=$2; if sudo -n test -e \"$scan_root\" 2>/dev/null; then if ! sudo -n test -d \"$scan_root\" 2>/dev/null; then return 1; fi; scan_output=$(sudo -n grep -RlE \"$scan_pattern\" \"$scan_root\" 2>/dev/null); scan_rc=$?; case \"$scan_rc\" in 0|1) ;; *) return 1;; esac; if [ -z \"$scan_output\" ]; then printf 0; else printf '%s\\n' \"$scan_output\" | awk 'NF { count += 1 } END { print count + 0 }'; fi; elif sudo -n test ! -e \"$scan_root\" 2>/dev/null; then printf 0; else return 1; fi; }",
    `directory_exists=false; if sudo -n test -d ${shellQuote(VM_SCHEDULER_DIR)} 2>/dev/null; then directory_exists=true; elif ! sudo -n test ! -e ${shellQuote(VM_SCHEDULER_DIR)} 2>/dev/null; then filesystem_evidence_ok=false; fi`,
    `script_exists=false; if sudo -n test -x ${shellQuote(VM_SCHEDULER_SCRIPT)} 2>/dev/null; then script_exists=true; elif ! sudo -n test ! -e ${shellQuote(VM_SCHEDULER_SCRIPT)} 2>/dev/null; then filesystem_evidence_ok=false; fi`,
    `config_exists=false; if sudo -n test -s ${shellQuote(VM_SCHEDULER_CONFIG)} 2>/dev/null; then config_exists=true; elif ! sudo -n test ! -e ${shellQuote(VM_SCHEDULER_CONFIG)} 2>/dev/null; then filesystem_evidence_ok=false; fi`,
    "begin_count=invalid; end_count=invalid; path_refs=invalid",
    `if sudo -n test -e ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null; then`,
    `  if sudo -n test -f ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null; then`,
    `    begin_count=$(count_file_matches -Fxc ${shellQuote(CRON_BEGIN)} ${shellQuote(VM_SCHEDULER_CRON_FILE)}) || cron_evidence_ok=false`,
    `    end_count=$(count_file_matches -Fxc ${shellQuote(CRON_END)} ${shellQuote(VM_SCHEDULER_CRON_FILE)}) || cron_evidence_ok=false`,
    `    path_refs=$(count_file_matches -Fc ${shellQuote(VM_SCHEDULER_SCRIPT)} ${shellQuote(VM_SCHEDULER_CRON_FILE)}) || cron_evidence_ok=false`,
    "  else cron_evidence_ok=false; fi",
    `elif sudo -n test ! -e ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null; then begin_count=0; end_count=0; path_refs=0`,
    "else cron_evidence_ok=false; fi",
    "alternate_cron_refs=0",
    `for scan_root in /etc/cron.d /etc/periodic; do scan_count=$(scan_tree_refs \"$scan_root\" ${shellQuote(restartReferencePattern)}) || { alternate_cron_evidence_ok=false; continue; }; case \"$scan_count\" in ''|*[!0-9]*) alternate_cron_evidence_ok=false;; *) alternate_cron_refs=$((alternate_cron_refs + scan_count));; esac; done`,
    "kubernetes_cronjob_refs=invalid",
    `cronjobs=$(sudo -n kubectl get cronjobs -A -o json --request-timeout=10s 2>/dev/null); kubernetes_query_rc=$?; if [ \"$kubernetes_query_rc\" = 0 ] && printf %s \"$cronjobs\" | jq -e '.items | type == \"array\"' >/dev/null 2>&1; then kubernetes_cronjob_refs=$(count_text_matches \"$cronjobs\" ${shellQuote(restartReferencePattern)}) || kubernetes_evidence_ok=false; else kubernetes_evidence_ok=false; fi`,
    "helper_process_refs=invalid",
    `process_output=$(sudo -n ps -eo pid=,comm=,args= 2>/dev/null); process_query_rc=$?; if [ \"$process_query_rc\" = 0 ]; then helper_process_refs=$(printf '%s\\n' \"$process_output\" | awk -v self=\"$$\" -v scheduler=${shellQuote(VM_SCHEDULER_SCRIPT)} '$1 != self { matched=0; for (field=3; field<NF; field += 1) { if ($field == scheduler && $(field + 1) ~ /^(tick|initialize|self-test|backup-now|restart-now)$/) matched=1; if (($field == \"battlegroup\" || $field ~ /\\/battlegroup$/) && $(field + 1) ~ /^(start|restart|update)$/) matched=1 } if (matched) count += 1 } END { print count + 0 }') || process_evidence_ok=false; case \"$helper_process_refs\" in ''|*[!0-9]*) process_evidence_ok=false;; esac; else process_evidence_ok=false; fi`,
    "openrc_restart_refs=invalid",
    `openrc_output=$(sudo -n rc-update show -v 2>/dev/null); openrc_query_rc=$?; if [ \"$openrc_query_rc\" = 0 ]; then openrc_restart_refs=$(count_text_matches \"$openrc_output\" ${shellQuote("alphanine.*scheduler|battlegroup|dune.*restart|restart.*dune")}) || openrc_evidence_ok=false; else openrc_evidence_ok=false; fi`,
    `if [ \"$filesystem_evidence_ok\" = true ] && [ \"$cron_evidence_ok\" = true ] && [ \"$alternate_cron_evidence_ok\" = true ] && [ \"$kubernetes_evidence_ok\" = true ] && [ \"$process_evidence_ok\" = true ] && [ \"$openrc_evidence_ok\" = true ] && [ \"$alternate_cron_refs\" = 0 ] && [ \"$kubernetes_cronjob_refs\" = 0 ] && [ \"$helper_process_refs\" = 0 ] && [ \"$openrc_restart_refs\" = 0 ]; then`,
    `  if [ \"$directory_exists\" = true ] && [ \"$script_exists\" = true ] && [ \"$config_exists\" = true ] && [ \"$begin_count\" = 1 ] && [ \"$end_count\" = 1 ] && [ \"$path_refs\" = 1 ]; then ${shellQuote(VM_SCHEDULER_SCRIPT)} status`,
    `  elif [ \"$directory_exists\" = false ] && [ \"$script_exists\" = false ] && [ \"$config_exists\" = false ] && [ \"$begin_count\" = 0 ] && [ \"$end_count\" = 0 ] && [ \"$path_refs\" = 0 ]; then printf %s ${shellQuote(missing)} | base64 -d`,
    `  else printf %s ${shellQuote(ambiguous)} | base64 -d; fi`,
    `else printf %s ${shellQuote(ambiguous)} | base64 -d; fi`
  ].join("\n");
}

function buildActionCommand(action) {
  const allowed = new Set(["self-test", "backup-now", "restart-now"]);
  if (!allowed.has(action)) throw new Error("Unknown scheduler action.");
  return `test -x ${shellQuote(VM_SCHEDULER_SCRIPT)} && { if ${shellQuote(VM_SCHEDULER_SCRIPT)} ${shellQuote(action)}; then result=0; else result=$?; fi; ${shellQuote(VM_SCHEDULER_SCRIPT)} status; exit $result; }`;
}

function buildRemoveCommand() {
  return [
    "set -eu",
    `sudo -n touch ${shellQuote(VM_SCHEDULER_CRON_FILE)}`,
    `begin_count=$(sudo -n grep -Fxc ${shellQuote(CRON_BEGIN)} ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null || true); end_count=$(sudo -n grep -Fxc ${shellQuote(CRON_END)} ${shellQuote(VM_SCHEDULER_CRON_FILE)} 2>/dev/null || true); test "$begin_count" = "$end_count" && test "$begin_count" -le 1`,
    `cron_stage=/tmp/alphanine-scheduler-remove.$$; cron_next=${shellQuote(`${VM_SCHEDULER_CRON_FILE}.next-`)}$$; cleanup_scheduler_remove() { rm -f "$cron_stage" 2>/dev/null || true; sudo -n rm -f "$cron_next" 2>/dev/null || true; }; trap cleanup_scheduler_remove EXIT HUP INT TERM`,
    `sudo -n cat ${shellQuote(VM_SCHEDULER_CRON_FILE)} | sed ${shellQuote(`/^${CRON_BEGIN}$/,/^${CRON_END}$/d`)} > "$cron_stage"`,
    `sudo -n install -o root -g root -m 0600 "$cron_stage" "$cron_next" && sudo -n mv -f "$cron_next" ${shellQuote(VM_SCHEDULER_CRON_FILE)}`,
    `sudo -n rm -rf ${shellQuote(VM_SCHEDULER_DIR)}`,
    `printf %s ${shellQuote(base64(JSON.stringify({ ok: true, installed: false, removed: true })))} | base64 -d`
  ].join("\n");
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("Scheduler command returned no JSON output.");
  try { return JSON.parse(text); }
  catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]); } catch {}
    }
    throw new Error(`Scheduler returned invalid output: ${text.slice(-1000)}`);
  }
}

module.exports = {
  VM_SCHEDULER_DIR,
  VM_SCHEDULER_SCRIPT,
  VM_SCHEDULER_CONFIG,
  VM_SCHEDULER_CRON_FILE,
  CRON_BEGIN,
  CRON_END,
  defaultSchedulerConfig,
  normalizeSchedulerConfig,
  readSchedulerConfig,
  saveSchedulerConfig,
  classifyStatusInventory,
  countSchedulerProcessArguments,
  buildInstallCommand,
  buildStatusCommand,
  buildActionCommand,
  buildRemoveCommand,
  parseJsonOutput,
  shellQuote,
  normalizeShellSource
};
