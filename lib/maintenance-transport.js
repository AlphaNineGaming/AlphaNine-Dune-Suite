"use strict";

const crypto = require("crypto");
const path = require("path");

const BUNDLE_VERSION = 1;
const FILE_NAMES = Object.freeze([
  "install.sh",
  "scheduler.sh",
  "sentinel.json",
  "scheduler.size",
  "scheduler.sha256",
  "sentinel.size",
  "sentinel.sha256",
  "generation",
  "hold-digest"
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decimal(value, label, { positive = false } = {}) {
  const text = String(value ?? "").trim();
  const pattern = positive ? /^[1-9]\d*$/ : /^(?:0|[1-9]\d*)$/;
  if (!pattern.test(text)) throw new Error(`${label} must be a canonical decimal string.`);
  return text;
}

function digest(value, label) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return text;
}

function tarOctal(value, width) {
  const octal = Number(value).toString(8);
  if (octal.length > width - 1) throw new Error("Maintenance transport entry exceeds tar numeric limits.");
  return `${octal.padStart(width - 1, "0")}\0`;
}

function tarEntry(name, input) {
  if (!FILE_NAMES.includes(name) || !/^[a-z0-9.-]+$/.test(name)) throw new Error("Maintenance transport archive contains an unsafe entry name.");
  const body = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(String(input), "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "ascii");
  header.write(tarOctal(0o600, 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(body.length, 12), 124, 12, "ascii");
  header.write(tarOctal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

function createTar(entries) {
  const names = Object.keys(entries);
  if (names.length !== FILE_NAMES.length || [...names].sort().some((name, index) => name !== [...FILE_NAMES].sort()[index])) {
    throw new Error("Maintenance transport archive has missing or unexpected entries.");
  }
  return Buffer.concat([...names.map((name) => tarEntry(name, entries[name])), Buffer.alloc(1024, 0)]);
}

function sentinelBytes(generationInput, holdDigestInput) {
  const generation = decimal(generationInput, "Maintenance generation", { positive: true });
  const holdDigest = digest(holdDigestInput, "Maintenance hold digest");
  return Buffer.from(`${JSON.stringify({ version: BUNDLE_VERSION, active: true, generation, holdDigest })}\n`, "utf8");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function count(value, label) {
  return decimal(value, label);
}

function classifySchedulerInventory(input = {}) {
  const architecture = String(input.architecture || "");
  if (architecture !== "alpine-busybox-crond") throw new Error("The VM scheduler architecture is unsupported or ambiguous.");
  if (input.persistentTarget !== true) throw new Error("The maintenance sentinel target is not on a verified persistent filesystem.");
  if (count(input.conflictingRegistrations, "Conflicting scheduler registrations") !== "0") throw new Error("An unexpected scheduler registration can start or restart the battlegroup.");
  if (count(input.activeSchedulerProcesses, "Active scheduler processes") !== "0") throw new Error("An AlphaNine scheduler process is active during maintenance guard publication.");
  const begin = count(input.cronBeginCount, "Scheduler cron begin marker count");
  const end = count(input.cronEndCount, "Scheduler cron end marker count");
  const refs = count(input.cronPathReferences, "Scheduler cron path reference count");
  const installed = input.directoryExists === true && input.scriptExists === true && input.configExists === true
    && input.schedulerPersistent === true && begin === "1" && end === "1" && refs === "1";
  const absent = input.directoryExists !== true && input.scriptExists !== true && input.configExists !== true
    && begin === "0" && end === "0" && refs === "0";
  if (installed) return { mode: "installed", cronRegistrationCount: "1" };
  if (absent) return { mode: "absent", cronRegistrationCount: "0" };
  throw new Error("The AlphaNine scheduler installation is partial, stale, or ambiguous.");
}

function inventoryShell(options = {}) {
  const schedulerPath = String(options.schedulerPath || "");
  const schedulerConfigPath = String(options.schedulerConfigPath || "");
  const schedulerDir = String(options.schedulerDir || "");
  const sentinelPath = String(options.sentinelPath || "");
  const cronPath = String(options.cronPath || "");
  const cronBegin = String(options.cronBegin || "");
  const cronEnd = String(options.cronEnd || "");
  if (![schedulerPath, schedulerConfigPath, schedulerDir, sentinelPath, cronPath, cronBegin, cronEnd].every(Boolean)) {
    throw new Error("Maintenance transport scheduler inventory constants are incomplete.");
  }
  return [
    "classify_scheduler_inventory() {",
    "  architecture=unknown",
    "  os_id=$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '\"')",
    "  if [ \"$os_id\" = alpine ] && command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx crond && command -v crond >/dev/null 2>&1; then architecture=alpine-busybox-crond; fi",
    `  sentinel_parent=${shellQuote(path.posix.dirname(sentinelPath))}; if [ -e ${shellQuote(sentinelPath)} ]; then sentinel_probe=${shellQuote(sentinelPath)}; elif [ -d "$sentinel_parent" ]; then sentinel_probe="$sentinel_parent"; else sentinel_probe=${shellQuote(path.posix.dirname(path.posix.dirname(sentinelPath)))}; fi`,
    "  persistent_target=false",
    "  sentinel_fs=$(findmnt -n -o FSTYPE -T \"$sentinel_probe\" 2>/dev/null | head -n 1)",
    "  case \"$sentinel_fs\" in ''|tmpfs|overlay|ramfs) ;; *) persistent_target=true;; esac",
    `  [ -d ${shellQuote(schedulerDir)} ] && directory_exists=true || directory_exists=false`,
    "  scheduler_persistent=false",
    `  if [ "$directory_exists" = true ]; then scheduler_fs=$(findmnt -n -o FSTYPE -T ${shellQuote(schedulerDir)} 2>/dev/null | head -n 1); case "$scheduler_fs" in ''|tmpfs|overlay|ramfs) ;; *) scheduler_persistent=true;; esac; fi`,
    `  [ -x ${shellQuote(schedulerPath)} ] && script_exists=true || script_exists=false`,
    `  [ -s ${shellQuote(schedulerConfigPath)} ] && config_exists=true || config_exists=false`,
    "  cron_begin_count=0; cron_end_count=0; cron_path_refs=0",
    `  if sudo -n test -f ${shellQuote(cronPath)} 2>/dev/null; then`,
    `    cron_begin_count=$(sudo -n grep -Fxc ${shellQuote(cronBegin)} ${shellQuote(cronPath)} 2>/dev/null || true)`,
    `    cron_end_count=$(sudo -n grep -Fxc ${shellQuote(cronEnd)} ${shellQuote(cronPath)} 2>/dev/null || true)`,
    `    cron_path_refs=$(sudo -n grep -Fc ${shellQuote(schedulerPath)} ${shellQuote(cronPath)} 2>/dev/null || true)`,
    "  fi",
    "  conflicting_refs=0",
    `  for root in /etc/cron.d /etc/periodic; do if sudo -n test -d "$root" 2>/dev/null && sudo -n grep -RIEq ${shellQuote(`${schedulerPath}|battlegroup[[:space:]]+(start|restart|update)`)} "$root" 2>/dev/null; then conflicting_refs=$((conflicting_refs + 1)); fi; done`,
    "  if command -v kubectl >/dev/null 2>&1; then",
    "    cronjobs=$(sudo -n kubectl get cronjobs -A -o yaml 2>/dev/null) || return 61",
    `    if printf %s "$cronjobs" | grep -Eq ${shellQuote(`${schedulerPath}|battlegroup[[:space:]]+(start|restart|update)`)}; then conflicting_refs=$((conflicting_refs + 1)); fi`,
    "  fi",
    `  active_scheduler_processes=$(sudo -n ps -eo args= 2>/dev/null | grep -F ${shellQuote(schedulerPath)} | grep -v grep | wc -l | tr -d ' ')`,
    "  scheduler_mode=ambiguous; cron_registration_count=0",
    "  if [ \"$architecture\" = alpine-busybox-crond ] && [ \"$persistent_target\" = true ] && [ \"$conflicting_refs\" = 0 ]; then",
    "    if [ \"$directory_exists\" = true ] && [ \"$scheduler_persistent\" = true ] && [ \"$script_exists\" = true ] && [ \"$config_exists\" = true ] && [ \"$cron_begin_count\" = 1 ] && [ \"$cron_end_count\" = 1 ] && [ \"$cron_path_refs\" = 1 ]; then scheduler_mode=installed; cron_registration_count=1; fi",
    "    if [ \"$directory_exists\" = false ] && [ \"$script_exists\" = false ] && [ \"$config_exists\" = false ] && [ \"$cron_begin_count\" = 0 ] && [ \"$cron_end_count\" = 0 ] && [ \"$cron_path_refs\" = 0 ]; then scheduler_mode=absent; cron_registration_count=0; fi",
    "  fi",
    "}"
  ].join("\n");
}

function buildInstallScript(options = {}) {
  const schedulerPath = String(options.schedulerPath || "");
  const sentinelPath = String(options.sentinelPath || "");
  const sentinelParent = path.posix.dirname(sentinelPath);
  return [
    "#!/bin/sh",
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "umask 077",
    inventoryShell(options),
    "files=$1",
    "read_one() { test \"$(wc -l < \"$1\" | tr -d ' ')\" = 1; IFS= read -r value < \"$1\"; printf %s \"$value\"; }",
    "scheduler_size=$(read_one \"$files/scheduler.size\")",
    "scheduler_sha=$(read_one \"$files/scheduler.sha256\")",
    "sentinel_size=$(read_one \"$files/sentinel.size\")",
    "sentinel_sha=$(read_one \"$files/sentinel.sha256\")",
    "generation=$(read_one \"$files/generation\")",
    "hold_digest=$(read_one \"$files/hold-digest\")",
    "for value in \"$scheduler_size\" \"$sentinel_size\" \"$generation\"; do case \"$value\" in ''|0|*[!0-9]*) exit 41;; esac; done",
    "for value in \"$scheduler_sha\" \"$sentinel_sha\" \"$hold_digest\"; do test \"${#value}\" = 64; case \"$value\" in *[!0-9a-f]*) exit 42;; esac; done",
    "test \"$(wc -c < \"$files/scheduler.sh\" | tr -d ' ')\" = \"$scheduler_size\"",
    "test \"$(sha256sum \"$files/scheduler.sh\" | awk '{print $1}')\" = \"$scheduler_sha\"",
    "test \"$(wc -c < \"$files/sentinel.json\" | tr -d ' ')\" = \"$sentinel_size\"",
    "test \"$(sha256sum \"$files/sentinel.json\" | awk '{print $1}')\" = \"$sentinel_sha\"",
    "bash -n \"$files/scheduler.sh\"",
    "classify_scheduler_inventory",
    "test \"$scheduler_mode\" != ambiguous",
    "test \"$active_scheduler_processes\" = 0",
    `if [ ! -d ${shellQuote(sentinelParent)} ]; then parent_probe=${shellQuote(path.posix.dirname(sentinelParent))}; parent_fs=$(findmnt -n -o FSTYPE -T "$parent_probe" 2>/dev/null | head -n 1); case "$parent_fs" in ''|tmpfs|overlay|ramfs) exit 62;; esac; sudo -n install -d -o dune -g dune -m 0750 ${shellQuote(sentinelParent)}; fi`,
    `sentinel_next=${shellQuote(`${sentinelPath}.next-`)}$$`,
    `scheduler_next=${shellQuote(`${schedulerPath}.next-`)}$$`,
    "cleanup_install() { sudo -n rm -f \"$sentinel_next\" \"$scheduler_next\" 2>/dev/null || true; }",
    "trap cleanup_install EXIT HUP INT TERM",
    `sudo -n install -o dune -g dune -m 0640 "$files/sentinel.json" "$sentinel_next"`,
    `sudo -n mv -f "$sentinel_next" ${shellQuote(sentinelPath)}`,
    "if [ \"$scheduler_mode\" = installed ]; then",
    `  sudo -n install -o dune -g dune -m 0750 "$files/scheduler.sh" "$scheduler_next"`,
    `  sudo -n mv -f "$scheduler_next" ${shellQuote(schedulerPath)}`,
    "fi",
    "sync",
    "printf '{\"ok\":true,\"status\":\"guarded\",\"schedulerMode\":\"%s\"}\\n' \"$scheduler_mode\""
  ].join("\n");
}

function buildRemoteInstallCommand(options = {}) {
  const expectedListing = [...FILE_NAMES].sort().join("\n");
  return [
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "umask 077",
    "stage=$(mktemp -d /tmp/alphanine-maintenance-guard.XXXXXX)",
    "cleanup_maintenance_transport() { rm -f \"$stage/files/\"* \"$stage/payload.tar\" 2>/dev/null || true; rmdir \"$stage/files\" 2>/dev/null || true; rmdir \"$stage\" 2>/dev/null || true; }",
    "trap cleanup_maintenance_transport EXIT HUP INT TERM",
    "cat > \"$stage/payload.tar\"",
    `test "$(tar -tf "$stage/payload.tar" | LC_ALL=C sort)" = ${shellQuote(expectedListing)}`,
    "mkdir \"$stage/files\"",
    "tar -xf \"$stage/payload.tar\" -C \"$stage/files\"",
    "sh \"$stage/files/install.sh\" \"$stage/files\""
  ].join("\n");
}

function buildRemoteVerifyCommand(options = {}) {
  const schedulerPath = String(options.schedulerPath || "");
  const sentinelPath = String(options.sentinelPath || "");
  if (!schedulerPath || !sentinelPath) throw new Error("Maintenance verification remote constants are incomplete.");
  return [
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    inventoryShell(options),
    "classify_scheduler_inventory",
    "test \"$scheduler_mode\" != ambiguous",
    `test -s ${shellQuote(sentinelPath)}`,
    "scheduler_size=0; scheduler_sha=''",
    `if [ "$scheduler_mode" = installed ]; then scheduler_size=$(wc -c < ${shellQuote(schedulerPath)} | tr -d ' '); scheduler_sha=$(sha256sum ${shellQuote(schedulerPath)} | awk '{print $1}'); fi`,
    `sentinel_size=$(wc -c < ${shellQuote(sentinelPath)} | tr -d ' ')`,
    `sentinel_sha=$(sha256sum ${shellQuote(sentinelPath)} | awk '{print $1}')`,
    `sentinel_base64=$(base64 -w 0 ${shellQuote(sentinelPath)})`,
    `temporary_files=$(find /tmp -maxdepth 1 -type d -name 'alphanine-maintenance-guard.*' -print 2>/dev/null | wc -l | tr -d ' '); temporary_files=$((temporary_files + $(find ${shellQuote(path.posix.dirname(schedulerPath))} -maxdepth 1 -type f -name ${shellQuote(`${path.posix.basename(schedulerPath)}.next-*`)} -print 2>/dev/null | wc -l | tr -d ' ') + $(find ${shellQuote(path.posix.dirname(sentinelPath))} -maxdepth 1 -type f -name ${shellQuote(`${path.posix.basename(sentinelPath)}.next-*`)} -print 2>/dev/null | wc -l | tr -d ' ')))`,
    "printf '{\"version\":1,\"architecture\":\"%s\",\"schedulerMode\":\"%s\",\"schedulerSize\":\"%s\",\"schedulerSha256\":\"%s\",\"sentinelSize\":\"%s\",\"sentinelSha256\":\"%s\",\"sentinelBase64\":\"%s\",\"cronRegistrationCount\":\"%s\",\"conflictingRegistrationCount\":\"%s\",\"temporaryFileCount\":\"%s\"}\\n' \"$architecture\" \"$scheduler_mode\" \"$scheduler_size\" \"$scheduler_sha\" \"$sentinel_size\" \"$sentinel_sha\" \"$sentinel_base64\" \"$cron_registration_count\" \"$conflicting_refs\" \"$temporary_files\""
  ].join("\n");
}

function buildMaintenanceTransport(options = {}) {
  const scheduler = Buffer.isBuffer(options.scheduler) ? Buffer.from(options.scheduler) : Buffer.from(String(options.scheduler || ""), "utf8");
  if (!scheduler.length) throw new Error("Bundled scheduler bytes are missing.");
  const generation = decimal(options.generation, "Maintenance generation", { positive: true });
  const holdDigest = digest(options.holdDigest, "Maintenance hold digest");
  const sentinel = sentinelBytes(generation, holdDigest);
  const expected = {
    generation,
    holdDigest,
    schedulerSize: String(scheduler.length),
    schedulerSha256: sha256(scheduler),
    sentinelSize: String(sentinel.length),
    sentinelSha256: sha256(sentinel)
  };
  const installScript = Buffer.from(`${buildInstallScript(options)}\n`, "utf8");
  const line = (value) => Buffer.from(`${value}\n`, "ascii");
  const stdin = createTar({
    "install.sh": installScript,
    "scheduler.sh": scheduler,
    "sentinel.json": sentinel,
    "scheduler.size": line(expected.schedulerSize),
    "scheduler.sha256": line(expected.schedulerSha256),
    "sentinel.size": line(expected.sentinelSize),
    "sentinel.sha256": line(expected.sentinelSha256),
    generation: line(generation),
    "hold-digest": line(holdDigest)
  });
  return {
    command: buildRemoteInstallCommand(options),
    stdin,
    verifyStdin: Buffer.from(`${buildRemoteVerifyCommand(options)}\n`, "utf8"),
    verifyCommand: "sh -s",
    expected
  };
}

function validateRemoteEvidence(input, expected) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Remote maintenance artifact evidence is malformed.");
  const keys = Object.keys(input).sort();
  const wanted = ["version", "architecture", "schedulerMode", "schedulerSize", "schedulerSha256", "sentinelSize", "sentinelSha256", "sentinelBase64", "cronRegistrationCount", "conflictingRegistrationCount", "temporaryFileCount"].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index]) || input.version !== BUNDLE_VERSION) throw new Error("Remote maintenance artifact evidence has missing or unknown fields.");
  if (input.architecture !== "alpine-busybox-crond") throw new Error("Remote scheduler architecture is unsupported or ambiguous.");
  if (!new Set(["installed", "absent"]).has(input.schedulerMode)) throw new Error("Remote scheduler installation state is ambiguous.");
  const schedulerSize = decimal(input.schedulerSize, "Installed scheduler size", { positive: input.schedulerMode === "installed" });
  const schedulerSha256 = input.schedulerMode === "installed" ? digest(input.schedulerSha256, "Installed scheduler SHA-256") : String(input.schedulerSha256 || "");
  if (input.schedulerMode === "absent" && (schedulerSize !== "0" || schedulerSha256 !== "")) throw new Error("Absent scheduler evidence includes an unexpected scheduler artifact.");
  const sentinelSize = decimal(input.sentinelSize, "Installed sentinel size", { positive: true });
  const sentinelSha256 = digest(input.sentinelSha256, "Installed sentinel SHA-256");
  const encoded = String(input.sentinelBase64 || "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Installed sentinel evidence is not canonical Base64.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || String(bytes.length) !== sentinelSize || sha256(bytes) !== sentinelSha256) throw new Error("Installed sentinel evidence size or hash is invalid.");
  let sentinel;
  try { sentinel = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Installed sentinel JSON is malformed."); }
  const sentinelKeys = Object.keys(sentinel || {}).sort();
  const wantedSentinel = ["version", "active", "generation", "holdDigest"].sort();
  if (sentinelKeys.length !== wantedSentinel.length || sentinelKeys.some((key, index) => key !== wantedSentinel[index])
    || sentinel.version !== BUNDLE_VERSION || sentinel.active !== true) throw new Error("Installed sentinel fields are malformed.");
  const generation = decimal(sentinel.generation, "Installed maintenance generation", { positive: true });
  const holdDigest = digest(sentinel.holdDigest, "Installed maintenance digest");
  const cronRegistrationCount = count(input.cronRegistrationCount, "Remote scheduler registration count");
  const conflictingRegistrationCount = count(input.conflictingRegistrationCount, "Conflicting scheduler registration count");
  const temporaryFileCount = count(input.temporaryFileCount, "Maintenance transport temporary file count");
  if (conflictingRegistrationCount !== "0" || temporaryFileCount !== "0") throw new Error("Remote scheduler evidence contains a conflicting registration or leftover temporary file.");
  if ((input.schedulerMode === "installed" && cronRegistrationCount !== "1") || (input.schedulerMode === "absent" && cronRegistrationCount !== "0")) throw new Error("Remote scheduler registration does not match its installation state.");
  const actual = { architecture: input.architecture, schedulerMode: input.schedulerMode, schedulerSize, schedulerSha256, sentinelSize, sentinelSha256, generation, holdDigest, cronRegistrationCount, conflictingRegistrationCount, temporaryFileCount };
  for (const [key, value] of Object.entries(expected || {})) {
    if (key === "schedulerSize" || key === "schedulerSha256") {
      if (input.schedulerMode === "installed" && actual[key] !== String(value)) throw new Error(`Installed maintenance ${key} does not match the requested artifact.`);
    } else if (Object.prototype.hasOwnProperty.call(actual, key) && actual[key] !== String(value)) throw new Error(`Installed maintenance ${key} does not match the requested artifact.`);
  }
  return { ok: true, ...actual };
}

module.exports = {
  BUNDLE_VERSION,
  FILE_NAMES,
  buildMaintenanceTransport,
  buildInstallScript,
  buildRemoteInstallCommand,
  buildRemoteVerifyCommand,
  classifySchedulerInventory,
  validateRemoteEvidence
};
