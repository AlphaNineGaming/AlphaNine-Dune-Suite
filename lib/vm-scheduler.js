"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const VM_SCHEDULER_DIR = "/home/dune/.dune/alphanine-scheduler";
const VM_SCHEDULER_SCRIPT = `${VM_SCHEDULER_DIR}/alphanine-scheduler.sh`;
const VM_SCHEDULER_CONFIG = `${VM_SCHEDULER_DIR}/config.json`;
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
    ["requirements", "command -v bash >/dev/null && command -v jq >/dev/null && command -v flock >/dev/null && command -v timeout >/dev/null && command -v kubectl >/dev/null"],
    ["timezone", `test -e ${shellQuote(timezonePath)}`],
    ["directory", `sudo -n install -d -o dune -g dune -m 0750 ${shellQuote(VM_SCHEDULER_DIR)}`],
    ["runtime", `printf %s ${shellQuote(scriptPayload)} | base64 -d | gzip -d > /tmp/alphanine-scheduler.sh && bash -n /tmp/alphanine-scheduler.sh && sudo -n install -o dune -g dune -m 0750 /tmp/alphanine-scheduler.sh ${shellQuote(VM_SCHEDULER_SCRIPT)} && rm -f /tmp/alphanine-scheduler.sh`],
    ["configuration", `printf %s ${shellQuote(configPayload)} | base64 -d > /tmp/alphanine-scheduler-config.json && jq -e . /tmp/alphanine-scheduler-config.json >/dev/null && sudo -n install -o dune -g dune -m 0640 /tmp/alphanine-scheduler-config.json ${shellQuote(VM_SCHEDULER_CONFIG)} && rm -f /tmp/alphanine-scheduler-config.json`],
    ["cron", `sudo -n touch /etc/crontabs/dune && sudo -n sed -i ${shellQuote(`/^${CRON_BEGIN}$/,/^${CRON_END}$/d`)} /etc/crontabs/dune && printf %s ${shellQuote(cronPayload)} | base64 -d | sudo -n tee -a /etc/crontabs/dune >/dev/null && sudo -n chown root:root /etc/crontabs/dune && sudo -n chmod 0600 /etc/crontabs/dune`],
    ["cron-service", "sudo -n rc-service crond restart >/dev/null"],
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
  const missing = base64(JSON.stringify({ ok: true, installed: false, cronRegistered: false, config: null, state: null, lastStatus: null, history: [] }));
  return `if [ -x ${shellQuote(VM_SCHEDULER_SCRIPT)} ] && [ -s ${shellQuote(VM_SCHEDULER_CONFIG)} ]; then ${shellQuote(VM_SCHEDULER_SCRIPT)} status; else printf %s ${shellQuote(missing)} | base64 -d; fi`;
}

function buildActionCommand(action) {
  const allowed = new Set(["self-test", "backup-now", "restart-now"]);
  if (!allowed.has(action)) throw new Error("Unknown scheduler action.");
  return `test -x ${shellQuote(VM_SCHEDULER_SCRIPT)} && { if ${shellQuote(VM_SCHEDULER_SCRIPT)} ${shellQuote(action)}; then result=0; else result=$?; fi; ${shellQuote(VM_SCHEDULER_SCRIPT)} status; exit $result; }`;
}

function buildRemoveCommand() {
  return [
    "set -eu",
    "sudo -n touch /etc/crontabs/dune",
    `sudo -n sed -i ${shellQuote(`/^${CRON_BEGIN}$/,/^${CRON_END}$/d`)} /etc/crontabs/dune`,
    "sudo -n chmod 0600 /etc/crontabs/dune",
    `sudo -n rm -rf ${shellQuote(VM_SCHEDULER_DIR)}`,
    "sudo -n rc-service crond restart >/dev/null",
    `printf %s ${shellQuote(base64(JSON.stringify({ ok: true, installed: false, removed: true })))} | base64 -d`
  ].join(" && ");
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
  CRON_BEGIN,
  CRON_END,
  defaultSchedulerConfig,
  normalizeSchedulerConfig,
  readSchedulerConfig,
  saveSchedulerConfig,
  buildInstallCommand,
  buildStatusCommand,
  buildActionCommand,
  buildRemoveCommand,
  parseJsonOutput,
  shellQuote,
  normalizeShellSource
};
