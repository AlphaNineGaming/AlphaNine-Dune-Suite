"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { hashFile } = require("./migration-package");
const { assertSafeRemoteArguments } = require("./migration-remote-args");

const EXPORT_TRANSPORT_VERSION = "pod-native-direct-pgpass-v3";

const ARCHIVE_INSPECTION_MARKER = "A9ARCHIVE1";
const PGPASS_PREPARATION_MARKER = "A9PGPASS1";
const POD_ARCHIVE_PATHS = Object.freeze({
  schemaInventory: "/tmp/alphanine-migration-schema-only.backup",
  world: "/tmp/alphanine-migration-world.backup",
  rollback: "/tmp/alphanine-migration-destination-rollback.backup",
  legacyRecovery: "/tmp/alphanine-recovery-archive.backup",
  dropSql: "/tmp/alphanine-migration-dune-reset.sql",
  restoreSql: "/tmp/alphanine-migration-dune-restore.sql",
  runtimeRoleVerifySql: "/tmp/alphanine-migration-dune-runtime-role-verify.sql",
  credential: "/tmp/alphanine-migration.pgpass",
  credentialNext: "/tmp/alphanine-migration.pgpass.next"
});
const POD_ARCHIVE_KINDS = Object.freeze(["schemaInventory", "world", "rollback"]);
const POD_PGPASS_INSTALL_SCRIPT = [
  "set -eu",
  'target="$2"',
  'next="$3"',
  'cleanup() { rm -f -- "$next"; }',
  "trap cleanup EXIT HUP INT TERM",
  'test -n "${POSTGRES_PASSWORD:-}" || exit 42',
  "umask 077",
  "{",
  '  printf \'%s:15432:dune:postgres:\' "$1"',
  '  printf \'%s\' "$POSTGRES_PASSWORD" | sed -e \'s/\\\\/\\\\\\\\/g\' -e \'s/:/\\\\:/g\'',
  "  printf '\\n'",
  '} > "$next"',
  'chmod 0600 "$next"',
  'mv -f -- "$next" "$target"',
  "trap - EXIT HUP INT TERM",
  `printf '%s\\n' '${PGPASS_PREPARATION_MARKER}'`,
  ""
].join("\n");
const SAFE_KUBERNETES_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function boundedText(value, limit = 4096) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return text.length > limit ? text.slice(-limit) : text;
}

function progressReportingError(error) {
  const wrapped = new Error(`Migration progress reporting failed: ${boundedText(error?.message || error || "unknown callback error", 512)}`);
  wrapped.code = "migration_progress_reporting_failed";
  return wrapped;
}

function partialPaths(finalPath, id = crypto.randomUUID()) {
  const resolved = path.resolve(finalPath);
  return {
    packagePartialPath: `${resolved}.partial-${id}`,
    dumpPartialPath: `${resolved}.partial-${id}.world.dump`
  };
}

function exactComponent(value, label = "migration component") {
  const size = String(value?.size ?? "");
  const sha256 = String(value?.sha256 || "").toLowerCase();
  if (!/^(0|[1-9][0-9]*)$/.test(size)) throw new Error(`${label} size is not an exact decimal integer.`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} SHA-256 is invalid.`);
  return { size, sha256 };
}

async function hashStableFile(filePath, label = "migration component") {
  const before = await fs.promises.stat(filePath, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} is not a regular file.`);
  const digest = exactComponent(await hashFile(filePath), label);
  const after = await fs.promises.stat(filePath, { bigint: true });
  if (!after.isFile() || before.size !== after.size || before.mtimeNs !== after.mtimeNs || digest.size !== after.size.toString(10)) {
    throw new Error(`${label} changed while it was being hashed.`);
  }
  return digest;
}

function parseArchiveInspectionOutput(stdout) {
  const text = String(stdout || "");
  const newline = text.indexOf("\n");
  if (newline < 0) throw new Error("Matching-version archive inspection did not return its transfer evidence.");
  const header = text.slice(0, newline).replace(/\r$/, "");
  const fields = header.split("\t");
  if (fields.length !== 3 || fields[0] !== ARCHIVE_INSPECTION_MARKER) throw new Error("Matching-version archive inspection returned malformed transfer evidence.");
  const component = exactComponent({ size: fields[1], sha256: fields[2] }, "staged migration component");
  const toc = text.slice(newline + 1);
  if (!toc.trim()) throw new Error("Matching-version pg_restore returned an empty archive TOC.");
  return { component, toc };
}

async function inspectClosedArchive(options) {
  if (typeof options?.runInspection !== "function" || typeof options?.validateToc !== "function") throw new Error("Closed archive inspection dependencies are incomplete.");
  const filePath = path.resolve(options.filePath);
  const label = String(options.label || path.basename(filePath) || "migration component");
  const component = await hashStableFile(filePath, label);
  const result = await options.runInspection({ filePath, component, scope: options.scope });
  if (!result || result.ok !== true || result.inputComplete !== true) {
    const diagnostic = boundedText(result?.stderr || result?.error || "archive inspection failed");
    throw new Error(`Matching-version pg_restore rejected or could not fully read ${label}: ${diagnostic}`);
  }
  const parsed = parseArchiveInspectionOutput(result.stdout);
  if (parsed.component.size !== component.size || parsed.component.sha256 !== component.sha256) {
    throw new Error(`Matching-version inspection received different bytes for ${label}.`);
  }
  const toc = options.validateToc(parsed.toc, { scope: options.scope });
  const after = await hashStableFile(filePath, label);
  if (after.size !== component.size || after.sha256 !== component.sha256) throw new Error(`${label} changed during archive inspection.`);
  return { ...toc, archiveReadVerified: true, component };
}

function verifyPackagedComponents(inspection, validatedComponents) {
  const wanted = {
    "world.dump": exactComponent(validatedComponents?.["world.dump"], "validated world.dump")
  };
  const entries = new Map((inspection?.entries || []).map((entry) => [entry.path, entry]));
  const manifestComponents = new Map((inspection?.manifest?.components || []).map((entry) => [entry.path, entry]));
  for (const [name, expected] of Object.entries(wanted)) {
    const stored = exactComponent(entries.get(name), `stored ${name}`);
    const declared = exactComponent(manifestComponents.get(name), `manifest ${name}`);
    if (stored.size !== expected.size || stored.sha256 !== expected.sha256) throw new Error(`Stored ${name} does not match the already-validated component file.`);
    if (declared.size !== expected.size || declared.sha256 !== expected.sha256) throw new Error(`Manifest ${name} does not match the already-validated component file.`);
  }
  return wanted;
}

async function safeRemove(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    await fs.promises.rm(candidate, { force: true }).catch(() => {});
  }
}

async function streamCommandToFile(options) {
  const spawnImpl = options.spawnImpl || spawn;
  const outputPath = path.resolve(options.outputPath);
  const child = spawnImpl(options.command, options.args || [], {
    windowsHide: true,
    stdio: [options.stdin || "ignore", "pipe", "pipe"],
    env: options.env || process.env
  });
  const output = (options.createWriteStreamImpl || fs.createWriteStream)(outputPath, { flags: "wx", mode: 0o600 });
  const hash = crypto.createHash("sha256");
  const timeoutMs = Number(options.timeoutMs || 60 * 60 * 1000);
  const expectedBytes = BigInt(String(options.expectedBytes || "0"));
  let bytes = 0n;
  let stderr = "";
  let settled = false;
  let progressRejected = false;
  let childExited = false;
  let outputClosed = false;
  let timer;
  let rejectProgressFailure;
  const progressFailure = new Promise((_, reject) => { rejectProgressFailure = reject; });
  const closed = new Promise((resolve) => {
    const check = () => { if (childExited && outputClosed) resolve(); };
    child.once("exit", () => { childExited = true; check(); });
    output.once("close", () => { outputClosed = true; check(); });
  });
  const fail = async (error) => {
    const wasSettled = settled;
    settled = true;
    clearTimeout(timer);
    if (!wasSettled && !childExited) child.kill("SIGKILL");
    if (!output.destroyed) output.destroy();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  };
  try {
    child.stderr.on("data", (chunk) => { stderr = boundedText(`${stderr}${chunk}`); });
    child.stdout.on("data", (chunk) => {
      bytes += BigInt(chunk.length);
      hash.update(chunk);
      const percent = expectedBytes > 0n ? Math.min(80, Number((bytes * 80n) / expectedBytes)) : null;
      try {
        options.onProgress?.({ bytes: bytes.toString(10), totalBytes: expectedBytes.toString(10), progress: percent });
      } catch (error) {
        if (!settled && !progressRejected) {
          progressRejected = true;
          rejectProgressFailure(progressReportingError(error));
        }
      }
    });
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Database dump stream ended unexpectedly (${signal || `exit ${code}`}). ${boundedText(stderr)}`.trim())));
    });
    const fileFinished = new Promise((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
      child.stdout.once("error", reject);
    });
    child.stdout.pipe(output);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      output.destroy(new Error("Database dump stream timed out."));
    }, timeoutMs);
    await Promise.race([Promise.all([exit, fileFinished]), progressFailure]);
    clearTimeout(timer);
    settled = true;
    const handle = await fs.promises.open(outputPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    if (bytes === 0n) throw new Error("Database dump stream produced an empty file.");
    return { size: bytes.toString(10), sha256: hash.digest("hex") };
  } catch (error) {
    return fail(error);
  }
}

function podExecArgs(target, commandArgs) {
  const namespace = String(target?.namespace || "");
  const dbPod = String(target?.dbPod || "");
  const args = assertSafeRemoteArguments((commandArgs || []).map(String), "migration pod argument");
  if (!SAFE_KUBERNETES_NAME.test(namespace) || !SAFE_KUBERNETES_NAME.test(dbPod)) throw new Error("The migration database-pod target is invalid.");
  return ["sudo", "kubectl", "exec", "-n", namespace, dbPod, "--", ...args];
}

function podCredentialPreparationArgs(target, commandArgs) {
  const args = podExecArgs(target, commandArgs);
  return [...args.slice(0, 3), "-i", ...args.slice(3)];
}

function exactPodExecutable(value, label) {
  const executable = String(value || "");
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(executable) || executable.includes("/../")) throw new Error(`${label} executable path is invalid.`);
  return executable;
}

async function requirePodCommand(options, commandArgs, stage, commandOptions = {}) {
  const result = await options.runCommand("ssh", [...options.sshArgs, ...podExecArgs(options.target, commandArgs)], {
    timeout: commandOptions.timeoutMs || options.timeoutMs || 10 * 60 * 1000,
    maxBuffer: commandOptions.maxBuffer || 64 * 1024 * 1024
  });
  if (!result || result.ok !== true) {
    const diagnostic = boundedText(result?.stderr || result?.error || "command failed", 512)
      .replace(/\b(?:PGPASSWORD|password)\s*[=:]\s*[^\s;]+/gi, (match) => `${match.split(/[=:]/, 1)[0]}=[redacted]`);
    const error = new Error(`Migration pod archive ${stage} failed: ${diagnostic}`);
    error.code = `migration_pod_archive_${stage.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    error.details = {
      stage,
      exitCode: Number.isInteger(result?.code) ? result.code : null,
      signal: result?.signal || null,
      timedOut: result?.timedOut === true,
      stdout: boundedText(result?.stdout || "", 1024),
      stderr: diagnostic
    };
    throw error;
  }
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: result.code };
}

async function installPodPgpass(options, shared) {
  const incomplete = (details = {}) => {
    const error = new Error("Migration database credential preparation did not complete its authenticated stdin handshake.");
    error.code = "credential_preparation_incomplete";
    error.details = details;
    return error;
  };
  if (typeof options.runCredentialScript !== "function") {
    throw incomplete({ reason: "credential_runner_missing" });
  }
  const args = [...shared.sshArgs, ...podCredentialPreparationArgs(shared.target, ["sh", "-s", "--", String(options.dbSvc), POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext])];
  try {
    const result = await options.runCredentialScript({ command: "ssh", args, script: POD_PGPASS_INSTALL_SCRIPT, timeoutMs: 30000 });
    const exitCode = Number.isInteger(result?.code) ? result.code : null;
    const markerValid = String(result?.stdout || "") === `${PGPASS_PREPARATION_MARKER}\n`;
    if (!result || result.ok !== true || exitCode !== 0 || result.inputComplete !== true || !markerValid) {
      throw incomplete({ exitCode, inputComplete: result?.inputComplete === true, markerValid });
    }
    let permission;
    let size;
    try {
      permission = await requirePodCommand(shared, ["stat", "-c", "%a", POD_ARCHIVE_PATHS.credential], "credential_permission", { timeoutMs: 30000, maxBuffer: 64 * 1024 });
      size = await requirePodCommand(shared, ["stat", "-c", "%s", POD_ARCHIVE_PATHS.credential], "credential_size", { timeoutMs: 30000, maxBuffer: 64 * 1024 });
    } catch (error) {
      throw incomplete({ reason: "published_passfile_missing", causeCode: error.code || "" });
    }
    if (permission.stdout.trim() !== "600" || !/^[1-9][0-9]*$/.test(size.stdout.trim())) {
      throw incomplete({ reason: "published_passfile_invalid", modeValid: permission.stdout.trim() === "600", sizeValid: /^[1-9][0-9]*$/.test(size.stdout.trim()) });
    }
    return { path: POD_ARCHIVE_PATHS.credential, source: "database-pod-environment", permissions: "600", cleanupOwner: "archive-finalizer" };
  } catch (error) {
    try { await cleanupPodArchivePaths(shared, [POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext]); }
    catch { error.details = { ...(error.details || {}), immediateCredentialCleanupFailed: true }; }
    throw error;
  }
}

async function runPodStage(options, commandArgs, stage, commandOptions = {}) {
  const timeoutMs = commandOptions.timeoutMs || options.timeoutMs || 10 * 60 * 1000;
  const started = Date.now();
  let callbackError = null;
  const publish = () => {
    if (callbackError) return;
    try {
      options.onHeartbeat?.({
        stage,
        startedAt: new Date(started).toISOString(),
        lastProgressAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        timeoutMs,
        remainingMs: Math.max(0, timeoutMs - (Date.now() - started))
      });
    } catch (error) { callbackError = progressReportingError(error); }
  };
  publish();
  if (callbackError) throw callbackError;
  const timer = setInterval(publish, Math.max(250, Number(options.heartbeatIntervalMs || 1000)));
  let result;
  let commandError = null;
  try { result = await requirePodCommand(options, commandArgs, stage, { ...commandOptions, timeoutMs }); }
  catch (error) { commandError = error; }
  finally { clearInterval(timer); publish(); }
  if (commandError) throw commandError;
  if (callbackError) throw callbackError;
  return result;
}

async function cleanupPodArchivePaths(options, paths = Object.values(POD_ARCHIVE_PATHS)) {
  if (typeof options?.runCommand !== "function") throw new TypeError("A direct process runner is required for migration pod cleanup.");
  const unique = [...new Set(paths.map(String))];
  let removed = 0;
  for (const remotePath of unique) {
    if (!Object.values(POD_ARCHIVE_PATHS).includes(remotePath)) throw new Error("An unapproved migration pod archive path was requested.");
    const name = path.posix.basename(remotePath);
    const before = await requirePodCommand(options, ["find", "/tmp", "-maxdepth", "1", "-name", name, "-print"], "stale_check", { timeoutMs: 30000, maxBuffer: 64 * 1024 });
    if (before.stdout.trim()) removed += 1;
    await requirePodCommand(options, ["rm", "-f", "--", remotePath], "cleanup", { timeoutMs: 30000, maxBuffer: 64 * 1024 });
    const after = await requirePodCommand(options, ["find", "/tmp", "-maxdepth", "1", "-name", name, "-print"], "cleanup_verification", { timeoutMs: 30000, maxBuffer: 64 * 1024 });
    if (after.stdout.trim()) throw new Error("A fixed-name migration pod archive remains after cleanup.");
  }
  return { removedCount: String(removed), cleanupVerified: true };
}

async function generateValidatedPodArchive(options = {}) {
  if (typeof options.runCommand !== "function" || typeof options.validateToc !== "function") throw new TypeError("Migration pod archive dependencies are incomplete.");
  const streamToFile = options.streamToFile || streamCommandToFile;
  const remotePath = POD_ARCHIVE_PATHS[options.kind];
  if (!remotePath || !POD_ARCHIVE_KINDS.includes(options.kind)) throw new Error("The migration pod archive kind is unsupported.");
  const outputPath = path.resolve(String(options.outputPath || ""));
  const dbSvc = String(options.dbSvc || "");
  if (!SAFE_KUBERNETES_NAME.test(dbSvc)) throw new Error("The migration PostgreSQL service target is invalid.");
  const dumpFlags = (options.dumpFlags || []).map(String);
  if (dumpFlags.some((value) => !value || value.length > 512 || /[\r\n\0]/.test(value))) throw new Error("A PostgreSQL dump argument is invalid or unbounded.");
  const shared = { runCommand: options.runCommand, sshArgs: (options.sshArgs || []).map(String), target: options.target, timeoutMs: options.timeoutMs || 60 * 60 * 1000 };
  const dumpExecutable = exactPodExecutable(options.dumpExecutable, "pg_dump");
  const restoreExecutable = exactPodExecutable(options.restoreExecutable, "pg_restore");
  shared.onHeartbeat = options.onHeartbeat;
  shared.heartbeatIntervalMs = options.heartbeatIntervalMs;
  let primaryError = null;
  try {
    await cleanupPodArchivePaths(shared, [remotePath, POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext]);
    await installPodPgpass(options, shared);
    await requirePodCommand(shared, ["install", "-m", "0600", "/dev/null", remotePath], "prepare");
    await requirePodCommand(shared, ["chmod", "0600", remotePath], "permission_prepare");
    const dumpArgs = ["env", `PGPASSFILE=${POD_ARCHIVE_PATHS.credential}`, dumpExecutable, "--no-password", "-h", dbSvc, "-p", "15432", "-U", "postgres", "-d", "dune", ...dumpFlags, `--file=${remotePath}`];
    await runPodStage(shared, dumpArgs, "dump", { timeoutMs: shared.timeoutMs });
    await requirePodCommand(shared, ["chmod", "0600", remotePath], "permission_finalize");
    const permission = await requirePodCommand(shared, ["stat", "-c", "%a", remotePath], "permission");
    const stat = await requirePodCommand(shared, ["stat", "-c", "%s", remotePath], "stat");
    const mode = permission.stdout.trim();
    const size = stat.stdout.trim();
    if (mode !== "600" || !/^[1-9][0-9]*$/.test(size || "")) throw new Error("The migration pod archive permissions or size are invalid.");
    const hash = await requirePodCommand(shared, ["sha256sum", remotePath], "hash", { timeoutMs: shared.timeoutMs });
    const sha256 = hash.stdout.trim().match(/^([a-f0-9]{64})\b/i)?.[1]?.toLowerCase() || "";
    if (!sha256) throw new Error("The migration pod archive SHA-256 is invalid.");
    const signature = await requirePodCommand(shared, ["head", "-c", "5", remotePath], "signature", { maxBuffer: 64 });
    if (signature.stdout !== "PGDMP") throw new Error("The migration pod archive does not have a PGDMP signature.");
    const listed = await runPodStage(shared, [restoreExecutable, "--list", remotePath], "toc", { timeoutMs: shared.timeoutMs });
    if (!listed.stdout.trim()) throw new Error("Matching-version pg_restore returned an empty archive TOC.");
    const boundary = options.validateToc(listed.stdout);
    await runPodStage(shared, [restoreExecutable, "--file=/dev/null", remotePath], "complete_read", { timeoutMs: shared.timeoutMs });
    const downloaded = await streamToFile({
      command: "ssh", args: [...shared.sshArgs, ...podExecArgs(shared.target, ["cat", remotePath])],
      outputPath, expectedBytes: size, timeoutMs: shared.timeoutMs, onProgress: options.onProgress
    });
    const remoteComponent = exactComponent({ size, sha256 }, "remote migration archive");
    const localComponent = exactComponent(downloaded, "downloaded migration archive");
    if (localComponent.size !== remoteComponent.size || localComponent.sha256 !== remoteComponent.sha256) throw new Error("The downloaded migration archive size or SHA-256 differs from the validated pod file.");
    const independentLocal = await hashStableFile(outputPath, "downloaded migration archive");
    if (independentLocal.size !== remoteComponent.size || independentLocal.sha256 !== remoteComponent.sha256) throw new Error("Independent local migration archive verification does not match the pod evidence.");
    return { component: remoteComponent, toc: listed.stdout, boundary, archiveReadVerified: true, downloadedOnce: true, remoteCleanupVerified: true };
  } catch (error) {
    primaryError = error;
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    try { await cleanupPodArchivePaths(shared, [remotePath, POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext]); }
    catch (cleanupError) {
      await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      if (!primaryError) throw cleanupError;
      const combined = new Error(`${primaryError.message} Remote migration archive cleanup could not be verified.`);
      combined.code = "migration_pod_archive_cleanup_unverified";
      combined.details = { primaryCode: primaryError.code || "migration_pod_archive_failed", cleanupCode: cleanupError.code || "migration_pod_archive_cleanup" };
      throw combined;
    }
  }
}

async function publishVerifiedPackage(partialPath, finalPath) {
  const source = path.resolve(partialPath);
  const destination = path.resolve(finalPath);
  if (path.dirname(source) !== path.dirname(destination)) throw new Error("Migration partial and final files must be siblings for atomic publication.");
  try {
    await fs.promises.access(destination, fs.constants.F_OK);
    throw new Error("The selected migration package filename already exists. Choose a new filename.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.promises.rename(source, destination);
  return { fileName: path.basename(destination) };
}

module.exports = {
  ARCHIVE_INSPECTION_MARKER,
  PGPASS_PREPARATION_MARKER,
  EXPORT_TRANSPORT_VERSION,
  POD_ARCHIVE_PATHS,
  boundedText,
  cleanupPodArchivePaths,
  exactPodExecutable,
  generateValidatedPodArchive,
  hashStableFile,
  installPodPgpass,
  inspectClosedArchive,
  parseArchiveInspectionOutput,
  partialPaths,
  publishVerifiedPackage,
  podExecArgs,
  podCredentialPreparationArgs,
  requirePodCommand,
  runPodStage,
  safeRemove,
  streamCommandToFile,
  verifyPackagedComponents
};
