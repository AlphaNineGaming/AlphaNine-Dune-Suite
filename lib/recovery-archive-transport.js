"use strict";

const { runWithStdin } = require("./stdin-process");
const { MAX_REMOTE_ARGUMENT_LENGTH, assertSafeRemoteArguments } = require("./migration-remote-args");

const REMOTE_ARCHIVE_PATH = "/tmp/alphanine-recovery-archive.backup";
const REMOTE_HOST_ARCHIVE_PATH = "/tmp/alphanine-recovery-archive.host.backup";
const SAFE_KUBERNETES_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

class RecoveryArchiveTransportError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "RecoveryArchiveTransportError";
    this.code = code;
    this.details = details;
  }
}

function safeTarget(target = {}) {
  const namespace = String(target.namespace || "");
  const dbPod = String(target.dbPod || "");
  if (!SAFE_KUBERNETES_NAME.test(namespace) || !SAFE_KUBERNETES_NAME.test(dbPod)) {
    throw new RecoveryArchiveTransportError("The database-pod target is invalid.", "recovery_archive_target_invalid");
  }
  return { namespace, dbPod };
}

function exactComponent(component = {}) {
  const size = String(component.size ?? "");
  const sha256 = String(component.sha256 || "").toLowerCase();
  if (!/^(?:0|[1-9][0-9]*)$/.test(size) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new RecoveryArchiveTransportError("The expected archive identity is invalid.", "recovery_archive_identity_invalid");
  }
  return { size, sha256 };
}

function remoteKubectlArgs(target, commandArgs) {
  const safe = safeTarget(target);
  let command;
  try { command = assertSafeRemoteArguments(commandArgs.map((value) => String(value)), "recovery pod argument"); }
  catch (error) { throw new RecoveryArchiveTransportError(error.message, "recovery_archive_argument_invalid", error.details); }
  return ["sudo", "kubectl", "exec", "-n", safe.namespace, safe.dbPod, "--", ...command];
}

function remoteKubectlStdinArgs(target, commandArgs) {
  const args = remoteKubectlArgs(target, commandArgs);
  args.splice(3, 0, "-i");
  return args;
}

function sanitizedFailure(stage, result = {}) {
  const diagnostic = String(result.stderr || result.error || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 512);
  return new RecoveryArchiveTransportError(
    diagnostic ? `Recovery archive ${stage} failed: ${diagnostic}` : `Recovery archive ${stage} failed.`,
    `recovery_archive_${stage.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
    { stage, exitCode: Number.isInteger(result.code) ? result.code : null, inputComplete: result.inputComplete === true }
  );
}

async function requireCommand(runCommand, sshArgs, target, commandArgs, stage, options = {}) {
  const result = await runCommand("ssh", [...sshArgs, ...remoteKubectlArgs(target, commandArgs)], {
    timeout: options.timeout || 120000,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 64
  });
  if (!result || result.ok !== true) throw sanitizedFailure(stage, result);
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: result.code };
}

async function cleanupRemote(runCommand, sshArgs, target) {
  const removed = await runCommand("ssh", [...sshArgs, ...remoteKubectlArgs(target, ["rm", "-f", "--", REMOTE_ARCHIVE_PATH])], { timeout: 30000, maxBuffer: 1024 * 64 });
  if (!removed || removed.ok !== true) throw sanitizedFailure("cleanup", removed);
  const absent = await runCommand("ssh", [...sshArgs, ...remoteKubectlArgs(target, ["find", "/tmp", "-maxdepth", "1", "-type", "f", "-name", "alphanine-recovery-archive.backup", "-print"])], { timeout: 30000, maxBuffer: 1024 * 64 });
  if (!absent || absent.ok !== true) throw sanitizedFailure("cleanup_verification", absent);
  if (String(absent.stdout || "").trim()) throw new RecoveryArchiveTransportError("The staged archive remains after cleanup.", "recovery_archive_cleanup_verification");
}

async function requireHostCommand(runCommand, sshArgs, commandArgs, stage, options = {}) {
  let safeArgs;
  try { safeArgs = assertSafeRemoteArguments(commandArgs.map(String), "recovery host argument"); }
  catch (error) { throw new RecoveryArchiveTransportError(error.message, "recovery_archive_argument_invalid", error.details); }
  const result = await runCommand("ssh", [...sshArgs, ...safeArgs], {
    timeout: options.timeout || 120000,
    maxBuffer: options.maxBuffer || 1024 * 1024
  });
  if (!result || result.ok !== true) throw sanitizedFailure(stage, result);
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: result.code };
}

async function cleanupHost(runCommand, sshArgs) {
  await requireHostCommand(runCommand, sshArgs, ["rm", "-f", REMOTE_HOST_ARCHIVE_PATH], "host_cleanup", { timeout: 30000 });
  const absent = await requireHostCommand(runCommand, sshArgs, ["find", "/tmp", "-maxdepth", "1", "-type", "f", "-name", "alphanine-recovery-archive.host.backup", "-print"], "host_cleanup_verification", { timeout: 30000 });
  if (absent.stdout.trim()) throw new RecoveryArchiveTransportError("The VM-staged archive remains after cleanup.", "recovery_archive_host_cleanup_verification");
}

async function inspectRecoveryArchive(options = {}) {
  if (typeof options.runCommand !== "function") throw new TypeError("A direct process runner is required.");
  const runner = options.runWithStdinImpl || runWithStdin;
  const sshArgs = Array.isArray(options.sshArgs) ? options.sshArgs.map(String) : [];
  const component = exactComponent(options.component);
  const target = safeTarget(options.target);
  const restoreExecutable = String(options.restoreExecutable || "pg_restore");
  if (!/^(?:\/[A-Za-z0-9._/-]+\/)?pg_restore$/.test(restoreExecutable)) throw new RecoveryArchiveTransportError("The matching pg_restore executable is invalid.", "recovery_archive_restore_executable_invalid");
  let primaryError = null;
  let toc = "";
  let diagnostics = "";
  try {
    await cleanupRemote(options.runCommand, sshArgs, target);
    await cleanupHost(options.runCommand, sshArgs);
    await requireHostCommand(options.runCommand, sshArgs, ["install", "-m", "0600", "/dev/null", REMOTE_HOST_ARCHIVE_PATH], "host_prepare");
    const upload = await runner(
      "ssh",
      [...sshArgs, "dd", `of=${REMOTE_HOST_ARCHIVE_PATH}`, "bs=1048576", "conv=fsync,notrunc"],
      options.filePath,
      { timeout: options.timeout || 10 * 60 * 1000, maxBuffer: 1024 * 1024 }
    );
    if (!upload || upload.ok !== true || upload.inputComplete !== true) throw sanitizedFailure("transfer", upload);
    diagnostics += String(upload.stderr || "");
    const hostPermission = await requireHostCommand(options.runCommand, sshArgs, ["stat", "-c", "%a", REMOTE_HOST_ARCHIVE_PATH], "host_permission_check");
    if (hostPermission.stdout.trim() !== "600") throw new RecoveryArchiveTransportError("The VM-staged archive permissions are not restrictive.", "recovery_archive_host_permissions");
    const hostSize = await requireHostCommand(options.runCommand, sshArgs, ["stat", "-c", "%s", REMOTE_HOST_ARCHIVE_PATH], "host_size_check");
    if (hostSize.stdout.trim() !== component.size) throw new RecoveryArchiveTransportError("The VM-staged archive byte size does not match.", "recovery_archive_host_size_mismatch");
    const hostHash = await requireHostCommand(options.runCommand, sshArgs, ["sha256sum", REMOTE_HOST_ARCHIVE_PATH], "host_hash_check");
    if (hostHash.stdout.trim().split(/\s+/)[0].toLowerCase() !== component.sha256) throw new RecoveryArchiveTransportError("The VM-staged archive SHA-256 does not match.", "recovery_archive_host_hash_mismatch");
    await requireHostCommand(options.runCommand, sshArgs, ["sudo", "kubectl", "cp", "-n", target.namespace, REMOTE_HOST_ARCHIVE_PATH, `${target.dbPod}:${REMOTE_ARCHIVE_PATH}`], "pod_copy", { timeout: options.timeout });
    await requireCommand(options.runCommand, sshArgs, target, ["chmod", "0600", REMOTE_ARCHIVE_PATH], "permission_prepare");
    await cleanupHost(options.runCommand, sshArgs);
    const permissions = await requireCommand(options.runCommand, sshArgs, target, ["stat", "-c", "%a", REMOTE_ARCHIVE_PATH], "permission_check");
    if (permissions.stdout.trim() !== "600") throw new RecoveryArchiveTransportError("The staged archive permissions are not restrictive.", "recovery_archive_permissions");
    const size = await requireCommand(options.runCommand, sshArgs, target, ["stat", "-c", "%s", REMOTE_ARCHIVE_PATH], "size_check");
    if (size.stdout.trim() !== component.size) throw new RecoveryArchiveTransportError("The staged archive byte size does not match.", "recovery_archive_size_mismatch");
    const hash = await requireCommand(options.runCommand, sshArgs, target, ["sha256sum", REMOTE_ARCHIVE_PATH], "hash_check");
    if (hash.stdout.trim().split(/\s+/)[0].toLowerCase() !== component.sha256) throw new RecoveryArchiveTransportError("The staged archive SHA-256 does not match.", "recovery_archive_hash_mismatch");
    const header = await requireCommand(options.runCommand, sshArgs, target, ["head", "-c", "5", REMOTE_ARCHIVE_PATH], "signature_check", { maxBuffer: 64 });
    if (header.stdout !== "PGDMP") throw new RecoveryArchiveTransportError("The staged archive does not have a PGDMP signature.", "recovery_archive_signature_invalid");
    const listed = await requireCommand(options.runCommand, sshArgs, target, [restoreExecutable, "--list", REMOTE_ARCHIVE_PATH], "toc", { timeout: options.timeout });
    if (!listed.stdout.trim()) throw new RecoveryArchiveTransportError("Matching-version pg_restore returned an empty TOC.", "recovery_archive_toc_empty");
    toc = listed.stdout;
    diagnostics += String(listed.stderr || "");
    const read = await requireCommand(options.runCommand, sshArgs, target, [restoreExecutable, "--file=/dev/null", REMOTE_ARCHIVE_PATH], "complete_read", { timeout: options.timeout });
    diagnostics += String(read.stderr || "");
    return { ok: true, inputComplete: true, component, toc, stdout: toc, stderr: diagnostics, remotePath: REMOTE_ARCHIVE_PATH };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupHost(options.runCommand, sshArgs);
      if (!(options.retainRemote === true && !primaryError)) await cleanupRemote(options.runCommand, sshArgs, target);
    }
    catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      primaryError.details = { ...(primaryError.details || {}), cleanupFailed: true, cleanupCode: cleanupError.code || "recovery_archive_cleanup" };
    }
  }
}

module.exports = {
  MAX_REMOTE_ARGUMENT_LENGTH,
  REMOTE_ARCHIVE_PATH,
  REMOTE_HOST_ARCHIVE_PATH,
  RecoveryArchiveTransportError,
  inspectRecoveryArchive,
  remoteKubectlArgs,
  remoteKubectlStdinArgs
};
