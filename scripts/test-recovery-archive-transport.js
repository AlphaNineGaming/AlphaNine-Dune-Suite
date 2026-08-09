"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MAX_REMOTE_ARGUMENT_LENGTH,
  REMOTE_ARCHIVE_PATH,
  inspectRecoveryArchive,
  remoteKubectlArgs
} = require("../lib/recovery-archive-transport");

const target = { namespace: "safe-namespace", dbPod: "safe-database-pod-0" };
const toc = "1; 0 0 SCHEMA - dune postgres\n2; 0 0 TABLE dune actors postgres\n";

function fixture(options = {}) {
  const calls = [];
  let present = false;
  let hostPresent = false;
  let cleanupCount = 0;
  let runIndex = 0;
  const component = options.component;
  const runCommand = async (command, args) => {
    runIndex += 1;
    calls.push({ kind: "command", command, args: [...args] });
    const podDelimiter = args.indexOf("--");
    const hostTarget = args.indexOf("user@host");
    const commandArgs = podDelimiter >= 0 ? args.slice(podDelimiter + 1) : args.slice(hostTarget + 1);
    const executable = commandArgs[0];
    if (options.disconnectAt === executable) return { ok: false, code: 255, stdout: "", stderr: "connection closed" };
    if (executable === "rm") {
      if (commandArgs.some((value) => String(value).includes(".host.backup"))) { hostPresent = false; return { ok: true, code: 0, stdout: "", stderr: "" }; }
      cleanupCount += 1;
      if (options.finalCleanupFailure && cleanupCount > 1) return { ok: false, code: 1, stdout: "", stderr: "permission denied" };
      present = false;
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    if (executable === "find") {
      const host = commandArgs.some((value) => String(value).includes(".host.backup"));
      return { ok: true, code: 0, stdout: (host ? hostPresent : present) ? `${host ? "/tmp/alphanine-recovery-archive.host.backup" : REMOTE_ARCHIVE_PATH}\n` : "", stderr: "" };
    }
    if (executable === "install") { if (commandArgs.some((value) => String(value).includes(".host.backup"))) hostPresent = true; else present = true; return { ok: true, code: 0, stdout: "", stderr: "" }; }
    if (executable === "sudo" && commandArgs[1] === "kubectl" && commandArgs[2] === "cp") { if (!hostPresent) return { ok: false, code: 1, stdout: "", stderr: "source missing" }; present = true; return { ok: true, code: 0, stdout: "", stderr: "" }; }
    if (executable === "chmod") return { ok: true, code: 0, stdout: "", stderr: "" };
    if (executable === "stat" && commandArgs.includes("%a")) return { ok: true, code: 0, stdout: "600\n", stderr: "" };
    if (executable === "stat") return { ok: true, code: 0, stdout: `${options.truncated ? BigInt(component.size) - 1n : component.size}\n`, stderr: "" };
    if (executable === "sha256sum") return { ok: true, code: 0, stdout: `${component.sha256}  ${REMOTE_ARCHIVE_PATH}\n`, stderr: "hash diagnostic" };
    if (executable === "head") return { ok: true, code: 0, stdout: "PGDMP", stderr: "" };
    if (executable === "pg_restore" && commandArgs.includes("--list")) return { ok: true, code: 0, stdout: toc, stderr: "list diagnostic" };
    if (executable === "pg_restore") return options.fullReadFailure
      ? { ok: false, code: 1, stdout: "", stderr: "corrupted data block" }
      : { ok: true, code: 0, stdout: "", stderr: "read diagnostic" };
    throw new Error(`Unexpected command ${runIndex}: ${commandArgs.join(" ")}`);
  };
  const runWithStdinImpl = async (command, args, inputPath) => {
    calls.push({ kind: "stdin", command, args: [...args], inputPath });
    present = true;
    if (options.incompleteStdin) return { ok: false, code: 0, stdout: "", stderr: "", inputComplete: false, error: "incomplete stdin" };
    if (options.uploadDisconnect) return { ok: false, code: 255, stdout: "", stderr: "connection closed", inputComplete: false };
    hostPresent = true;
    return { ok: true, code: 0, stdout: "", stderr: "dd diagnostic", inputComplete: true, inputBytes: component.size };
  };
  return { calls, runCommand, runWithStdinImpl, cleanupCount: () => cleanupCount, present: () => present };
}

async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "a9 recovery transport & spaces "));
  try {
    const archive = path.join(folder, "rollback archive & [safe].backup");
    const bytes = Buffer.concat([Buffer.from("PGDMP", "ascii"), crypto.randomBytes(8192)]);
    fs.writeFileSync(archive, bytes);
    const component = { size: String(bytes.length), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    const sshArgs = ["-T", "-i", "C:\\Key Folder\\test key", "user@host"];
    const good = fixture({ component });
    const result = await inspectRecoveryArchive({ filePath: archive, component, sshArgs, target, runCommand: good.runCommand, runWithStdinImpl: good.runWithStdinImpl });
    assert.equal(result.toc, toc);
    assert.equal(result.inputComplete, true);
    assert.match(result.stderr, /dd diagnostic/);
    assert.match(result.stderr, /list diagnostic/);
    assert.match(result.stderr, /read diagnostic/);
    assert.equal(good.present(), false);
    assert(good.cleanupCount() >= 2, "stale and final archive cleanup must both run");

    const stdinCall = good.calls.find((call) => call.kind === "stdin");
    assert.equal(stdinCall.inputPath, archive, "a Windows path with spaces and metacharacters stays out of process arguments");
    assert(stdinCall.args.includes("C:\\Key Folder\\test key"), "spawn argument arrays preserve Windows paths with spaces");
    const stdinRemoteArgs = stdinCall.args.slice(stdinCall.args.indexOf("user@host") + 1);
    assert(!stdinRemoteArgs.includes("-i") && !stdinRemoteArgs.includes("kubectl"), "archive bytes must use plain SSH host staging, never Kubernetes websocket stdin");
    assert(good.calls.some((call) => call.args.includes("cp") && call.args.includes("kubectl")), "the verified VM-stage file must be copied into the pod without attaching Windows stdin");
    const allRemoteTokens = good.calls.flatMap((call) => call.args.slice(call.args.indexOf("--") + 1));
    const forbiddenTokens = allRemoteTokens.filter((token) => /(?:^|\s)(?:sh|bash)(?:$|\s)|base64|encodedcommand|PGDMP|[;|`$\r\n]/i.test(token));
    assert.deepEqual(forbiddenTokens, [], "no script, archive payload, encoding, or shell syntax may enter SSH arguments");
    assert(good.calls.some((call) => call.args.includes("--list")));
    assert(good.calls.some((call) => call.args.includes("--file=/dev/null")));
    assert(good.calls.every((call) => call.args.every((value) => String(value).length < 1024)), "all generated remote arguments remain bounded");

    for (const failing of [
      { incompleteStdin: true, pattern: /transfer failed/i },
      { uploadDisconnect: true, pattern: /connection closed/i },
      { truncated: true, pattern: /byte size does not match/i },
      { disconnectAt: "pg_restore", pattern: /connection closed/i },
      { fullReadFailure: true, pattern: /corrupted data block/i }
    ]) {
      const test = fixture({ component, ...failing });
      await assert.rejects(inspectRecoveryArchive({ filePath: archive, component, sshArgs, target, runCommand: test.runCommand, runWithStdinImpl: test.runWithStdinImpl }), failing.pattern);
      assert.equal(test.present(), false, "failure and interruption must remove the staged archive");
      assert(test.cleanupCount() >= 2, "cleanup must run after every failure");
    }

    const cleanupFailure = fixture({ component, finalCleanupFailure: true });
    await assert.rejects(inspectRecoveryArchive({ filePath: archive, component, sshArgs, target, runCommand: cleanupFailure.runCommand, runWithStdinImpl: cleanupFailure.runWithStdinImpl }), /cleanup failed.*permission denied/i);

    assert.throws(() => remoteKubectlArgs({ namespace: "safe;rm", dbPod: target.dbPod }, ["stat"]), /target is invalid/i);
    assert.throws(() => remoteKubectlArgs(target, ["x".repeat(MAX_REMOTE_ARGUMENT_LENGTH + 1)]), /invalid or unbounded/i);
    assert.throws(() => remoteKubectlArgs(target, ["stat\nrm"]), /invalid or unbounded/i);
    console.log("Recovery archive direct-argument stdin transport tests passed");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
