"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Writable } = require("stream");
const { OperationRegistry, OperationBusyError, operationsConflict } = require("../lib/operations");
const { runWithStdin } = require("../lib/stdin-process");
const { validatePgRestoreToc } = require("../lib/server-migration");
const {
  ARCHIVE_INSPECTION_MARKER,
  PGPASS_PREPARATION_MARKER,
  POD_ARCHIVE_PATHS,
  cleanupPodArchivePaths,
  generateValidatedPodArchive,
  hashStableFile,
  inspectClosedArchive,
  partialPaths,
  publishVerifiedPackage,
  safeRemove,
  streamCommandToFile,
  verifyPackagedComponents
} = require("../lib/server-migration-export");

function podArchiveFixture(options = {}) {
  const files = new Map();
  const commands = [];
  const credentialCommands = [];
  const events = [];
  let downloads = 0;
  const payload = Buffer.concat([Buffer.from(options.badSignature ? "BAD!!" : "PGDMP", "ascii"), Buffer.alloc(4096, 17)]);
  const runCommand = async (_command, args) => {
    commands.push([...args]);
    if (args.includes("-i")) return { ok: false, code: 255, stderr: "websocket: close sent" };
    const marker = args.indexOf("--");
    const cmd = args.slice(marker + 1);
    if (cmd[0] === "find") {
      const name = cmd[cmd.indexOf("-name") + 1];
      const found = [...files.keys()].find((item) => path.posix.basename(item) === name);
      return { ok: true, code: 0, stdout: found ? `${found}\n` : "", stderr: "" };
    }
    if (cmd[0] === "rm") {
      const removedPath = cmd.at(-1);
      events.push(`remove:${removedPath}`);
      if (options.cleanupFailure && removedPath === POD_ARCHIVE_PATHS.credential && files.has(removedPath)) return { ok: false, code: 1, stderr: "permission denied" };
      files.delete(removedPath);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "install") { files.set(cmd.at(-1), Buffer.alloc(0)); return { ok: true, code: 0, stdout: "", stderr: "" }; }
    if (cmd[0] === "chmod") return { ok: true, code: 0, stdout: "", stderr: "" };
    if (cmd[0] === "env" && cmd[2] === "/usr/bin/pg_dump") {
      events.push(`dump:${cmd[1]}:${cmd.at(-1)}`);
      if (options.diskFull) return { ok: false, code: 1, stderr: "No space left on device" };
      if (options.wrongCredentials) return { ok: false, code: 1, stderr: "password authentication failed" };
      if (options.dumpInterrupted) return { ok: false, code: 255, signal: "SIGTERM", stderr: "dump transport interrupted" };
      if (options.secretDiagnostic) return { ok: false, code: 1, stderr: "PGPASSWORD=supersecret authentication failed" };
      const remotePath = cmd.find((item) => item.startsWith("--file=")).slice("--file=".length);
      files.set(remotePath, payload);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    const remotePath = cmd.at(-1);
    const data = files.get(remotePath);
    if (cmd[0] === "stat") {
      const format = cmd[cmd.indexOf("-c") + 1];
      events.push(`stat:${format}:${remotePath}`);
      return { ok: true, code: 0, stdout: `${format === "%a" ? "600" : data.length}\n`, stderr: "" };
    }
    if (cmd[0] === "sha256sum") return { ok: true, code: 0, stdout: `${crypto.createHash("sha256").update(data).digest("hex")}  archive\n`, stderr: "" };
    if (cmd[0] === "head") return { ok: true, code: 0, stdout: data.subarray(0, 5).toString("ascii"), stderr: "" };
    if (cmd[0] === "/usr/bin/pg_restore" && cmd[1] === "--list") {
      events.push(`verify:list:${remotePath}`);
      if (options.corrupt) return { ok: false, code: 1, stderr: "unexpected end of file" };
      return { ok: true, code: 0, stdout: duneToc, stderr: "" };
    }
    if (cmd[0] === "/usr/bin/pg_restore" && cmd[1] === "--file=/dev/null") {
      events.push(`verify:read:${remotePath}`);
      if (options.fullReadFailure) return { ok: false, code: 1, stderr: "corrupt data block" };
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected fixture command: ${cmd.join(" ")}`);
  };
  const streamToFile = async ({ args, outputPath, expectedBytes, onProgress }) => {
    downloads += 1;
    const remotePath = args.at(-1);
    const data = files.get(remotePath);
    fs.writeFileSync(outputPath, options.downloadMismatch ? Buffer.concat([data, Buffer.from([1])]) : data);
    onProgress?.({ bytes: String(data.length), totalBytes: String(expectedBytes), progress: 80 });
    if (options.downloadInterrupted) throw new Error("SSH download interrupted");
    const local = fs.readFileSync(outputPath);
    return { size: String(local.length), sha256: crypto.createHash("sha256").update(local).digest("hex") };
  };
  const runCredentialScript = async ({ args, script }) => {
    const effectiveArgs = options.omitCredentialInteractive ? args.filter((value) => value !== "-i") : [...args];
    credentialCommands.push({ args: [...effectiveArgs], script: String(script) });
    events.push(`credential:create:${args.at(-2)}:${args.at(-1)}`);
    if (options.missingCredentials) return { ok: false, code: 42, inputComplete: true, stdout: "", stderr: "" };
    if (!effectiveArgs.includes("-i") || options.missingCredentialMarker) {
      return { ok: true, code: 0, inputComplete: true, stdout: "", stderr: "" };
    }
    if (options.incompleteCredentialStdin) return { ok: false, code: 0, inputComplete: false, stdout: "", stderr: "" };
    if (options.markerWithoutPassfile) return { ok: true, code: 0, inputComplete: true, stdout: `${PGPASS_PREPARATION_MARKER}\n`, stderr: "" };
    files.set(POD_ARCHIVE_PATHS.credential, Buffer.from("approved-db-service:15432:dune:postgres:[fixture-secret]\n"));
    return { ok: true, code: 0, inputComplete: true, stdout: `${PGPASS_PREPARATION_MARKER}\n`, stderr: "" };
  };
  return { files, commands, credentialCommands, events, runCommand, runCredentialScript, streamToFile, downloads: () => downloads };
}

async function testPodNativeArchiveExport() {
  const target = { namespace: "approved-namespace", dbPod: "approved-db-0" };
  const outputPath = path.join(root, "pod-native-world.dump");
  const good = podArchiveFixture();
  const heartbeats = [];
  const result = await generateValidatedPodArchive({
    kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: good.runCommand, runCredentialScript: good.runCredentialScript,
    dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore",
    streamToFile: good.streamToFile, outputPath, dumpFlags: ["--format=custom", "--schema=dune"],
    onHeartbeat: (value) => heartbeats.push(value),
    validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
  });
  assert.equal(result.archiveReadVerified, true);
  assert(heartbeats.some((value) => value.stage === "dump") && heartbeats.some((value) => value.stage === "complete_read"));
  assert(heartbeats.every((value) => Number.isInteger(value.elapsedMs) && Number.isInteger(value.remainingMs) && value.lastProgressAt));
  assert.equal(result.downloadedOnce, true);
  assert.equal(good.downloads(), 1, "a validated pod archive must be downloaded exactly once");
  assert.equal(good.files.size, 0, "the fixed pod archive must be removed after success");
  assert(good.commands.some((args) => args.some((value) => String(value).startsWith(`--file=${POD_ARCHIVE_PATHS.world}`))), "pg_dump must write directly to the fixed pod path");
  assert(good.commands.some((args) => args.includes("--list")) && good.commands.some((args) => args.includes("--file=/dev/null")));
  assert(good.commands.every((args) => !args.includes("-i")), "archive transport must never use kubectl exec stdin");
  const finalVectors = good.commands.map((args) => args.slice(args.indexOf("--") + 1));
  const worldDumpVector = finalVectors.find((args) => args.includes(`--file=${POD_ARCHIVE_PATHS.world}`));
  assert.deepEqual(worldDumpVector.slice(0, 4), ["env", `PGPASSFILE=${POD_ARCHIVE_PATHS.credential}`, "/usr/bin/pg_dump", "--no-password"], "pg_dump must use the restrictive passfile and never prompt");
  assert(!worldDumpVector.includes("sh") && !worldDumpVector.includes("-c") && !worldDumpVector.some((value) => /supersecret|fixture-secret/.test(value)));
  const worldRestoreVectors = finalVectors.filter((args) => args[0] === "/usr/bin/pg_restore");
  assert.deepEqual(worldRestoreVectors, [
    ["/usr/bin/pg_restore", "--list", POD_ARCHIVE_PATHS.world],
    ["/usr/bin/pg_restore", "--file=/dev/null", POD_ARCHIVE_PATHS.world]
  ], "pg_restore must receive bounded direct argument vectors");
  assert(finalVectors.some((args) => args[0] === "chmod" && args[1] === "0600" && args[2] === POD_ARCHIVE_PATHS.world));
  assert(finalVectors.some((args) => args[0] === "sha256sum" && args[1] === POD_ARCHIVE_PATHS.world));
  assert(finalVectors.some((args) => args[0] === "rm" && args[1] === "-f" && args[2] === "--" && args[3] === POD_ARCHIVE_PATHS.world));
  assert(finalVectors.every((args) => !["sh", "/bin/sh", "bash", "/bin/bash"].includes(args[0])), "no pod archive command may introduce a shell interpreter");
  assert.equal(good.credentialCommands.length, 1, "the pod credential source must be prepared exactly once");
  assert.equal(good.credentialCommands[0].args.filter((value) => value === "-i").length, 1, "only credential preparation must attach kubectl stdin");
  assert.deepEqual(good.credentialCommands[0].args.slice(good.credentialCommands[0].args.indexOf("exec"), good.credentialCommands[0].args.indexOf("exec") + 3), ["exec", "-i", "-n"], "credential preparation must attach stdin immediately after kubectl exec");
  assert(good.credentialCommands[0].script.includes("POSTGRES_PASSWORD"), "the passfile must reuse the pod-mounted credential source");
  assert(good.credentialCommands[0].script.includes(`printf '%s\\n' '${PGPASS_PREPARATION_MARKER}'`), "credential preparation must emit the fixed non-secret completion marker");
  assert(!good.credentialCommands[0].args.some((value) => /fixture-secret|supersecret/.test(value)), "credentials must never enter process arguments");
  assert.deepEqual(good.credentialCommands[0].args.slice(-3), ["approved-db-service", POD_ARCHIVE_PATHS.credential, POD_ARCHIVE_PATHS.credentialNext], "creation must use the same fixed credential identity as validation and cleanup");
  assert.doesNotMatch(good.credentialCommands[0].script, /rm\s+-f[^\n]*\$target/, "successful credential preparation must not delete the published passfile");
  const createdAt = good.events.indexOf(`credential:create:${POD_ARCHIVE_PATHS.credential}:${POD_ARCHIVE_PATHS.credentialNext}`);
  const modeCheckedAt = good.events.indexOf(`stat:%a:${POD_ARCHIVE_PATHS.credential}`, createdAt);
  const sizeCheckedAt = good.events.indexOf(`stat:%s:${POD_ARCHIVE_PATHS.credential}`, createdAt);
  const dumpAt = good.events.indexOf(`dump:PGPASSFILE=${POD_ARCHIVE_PATHS.credential}:--file=${POD_ARCHIVE_PATHS.world}`, createdAt);
  const listedAt = good.events.indexOf(`verify:list:${POD_ARCHIVE_PATHS.world}`, dumpAt);
  const readAt = good.events.indexOf(`verify:read:${POD_ARCHIVE_PATHS.world}`, listedAt);
  const credentialDeletedAt = good.events.indexOf(`remove:${POD_ARCHIVE_PATHS.credential}`, readAt);
  assert(createdAt >= 0 && createdAt < modeCheckedAt && modeCheckedAt < sizeCheckedAt && sizeCheckedAt < dumpAt && dumpAt < listedAt && listedAt < readAt && readAt < credentialDeletedAt, "credential lifecycle must be create -> mode/size -> authenticated dump -> archive verification -> finalizer deletion");
  assert.equal(result.archiveReadVerified, true, "a websocket-close failure reserved for stdin transport must be unreachable");

  const schema = podArchiveFixture();
  await generateValidatedPodArchive({
    kind: "schemaInventory", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: schema.runCommand, runCredentialScript: schema.runCredentialScript,
    dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore",
    streamToFile: schema.streamToFile, outputPath: path.join(root, "pod-native-schema.dump"),
    dumpFlags: ["--format=custom", "--schema=dune", "--schema-only"], validateToc: () => ({ valid: true })
  });
  const schemaVectors = schema.commands.map((args) => args.slice(args.indexOf("--") + 1));
  const schemaDumpVector = schemaVectors.find((args) => args.includes(`--file=${POD_ARCHIVE_PATHS.schemaInventory}`));
  assert.deepEqual(schemaDumpVector.slice(0, 4), ["env", `PGPASSFILE=${POD_ARCHIVE_PATHS.credential}`, "/usr/bin/pg_dump", "--no-password"]);
  assert(!schemaDumpVector.includes("sh") && schemaDumpVector.includes("--schema-only"));
  assert.deepEqual(schemaVectors.filter((args) => args[0] === "/usr/bin/pg_restore"), [
    ["/usr/bin/pg_restore", "--list", POD_ARCHIVE_PATHS.schemaInventory],
    ["/usr/bin/pg_restore", "--file=/dev/null", POD_ARCHIVE_PATHS.schemaInventory]
  ]);
  assert(schemaVectors.every((args) => !["sh", "/bin/sh", "bash", "/bin/bash"].includes(args[0])), "schema inventory commands must remain shell-free");

  const boundaryFailure = podArchiveFixture();
  const boundaryPath = path.join(root, "pod-boundary-failure.dump");
  await assert.rejects(() => generateValidatedPodArchive({
    kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: boundaryFailure.runCommand, runCredentialScript: boundaryFailure.runCredentialScript,
    dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore",
    streamToFile: boundaryFailure.streamToFile, outputPath: boundaryPath, dumpFlags: ["--format=custom", "--schema=dune"],
    validateToc: () => { throw new Error("exact TOC boundary mismatch"); }
  }), /boundary mismatch/);
  assert.equal(boundaryFailure.downloads(), 0, "an invalid TOC must be rejected before any outward archive stream");
  assert.equal(boundaryFailure.files.size, 0);

  for (const [name, fixtureOptions, pattern] of [
    ["remote disk full", { diskFull: true }, /space left/],
    ["interrupted authenticated dump", { dumpInterrupted: true }, /interrupted/],
    ["corrupt archive", { corrupt: true }, /unexpected end/],
    ["invalid signature", { badSignature: true }, /PGDMP/],
    ["full read failure", { fullReadFailure: true }, /corrupt data block/],
    ["download interruption", { downloadInterrupted: true }, /interrupted/],
    ["size hash mismatch", { downloadMismatch: true }, /differs/]
  ]) {
    const fixture = podArchiveFixture(fixtureOptions);
    const failedPath = path.join(root, `${name.replace(/\s/g, "-")}.dump`);
    await assert.rejects(() => generateValidatedPodArchive({
      kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: fixture.runCommand, runCredentialScript: fixture.runCredentialScript,
      dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore",
      streamToFile: fixture.streamToFile, outputPath: failedPath, dumpFlags: ["--format=custom", "--schema=dune"],
      validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
    }), pattern, name);
    assert.equal(fixture.files.size, 0, `${name} must clean the fixed pod archive`);
    assert.equal(fs.existsSync(failedPath), false, `${name} must clean the local partial`);
  }

  for (const [name, fixtureOptions, pattern] of [
    ["missing credentials", { missingCredentials: true }, /credential preparation did not complete/],
    ["wrong credentials", { wrongCredentials: true }, /password authentication failed/]
  ]) {
    const fixture = podArchiveFixture(fixtureOptions);
    const failedPath = path.join(root, `${name.replace(/\s/g, "-")}.dump`);
    await assert.rejects(() => generateValidatedPodArchive({
      kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: fixture.runCommand, runCredentialScript: fixture.runCredentialScript,
      dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore", streamToFile: fixture.streamToFile,
      outputPath: failedPath, dumpFlags: ["--format=custom", "--schema=dune"], validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
    }), pattern, name);
    assert.equal(fixture.files.size, 0, `${name} must remove archive and credential files`);
    assert.equal(fs.existsSync(failedPath), false, `${name} must remove the local partial`);
  }

  for (const [name, fixtureOptions] of [
    ["omitted kubectl stdin attachment", { omitCredentialInteractive: true }],
    ["missing completion marker", { missingCredentialMarker: true }],
    ["incomplete credential stdin", { incompleteCredentialStdin: true }],
    ["marker without published passfile", { markerWithoutPassfile: true }]
  ]) {
    const fixture = podArchiveFixture(fixtureOptions);
    const failedPath = path.join(root, `${name.replace(/\s/g, "-")}.dump`);
    let failure = null;
    try {
      await generateValidatedPodArchive({
        kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: fixture.runCommand, runCredentialScript: fixture.runCredentialScript,
        dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore", streamToFile: fixture.streamToFile,
        outputPath: failedPath, dumpFlags: ["--format=custom", "--schema=dune"], validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
      });
    } catch (error) { failure = error; }
    assert(failure, `${name} must fail closed`);
    assert.equal(failure.code, "credential_preparation_incomplete", `${name} must use the explicit credential preparation failure code`);
    assert.equal(fixture.downloads(), 0, `${name} must fail before archive download`);
    assert.equal(fixture.files.size, 0, `${name} must clean all credential and archive paths`);
    assert.equal(fs.existsSync(failedPath), false, `${name} must not leave a local partial`);
  }

  const redaction = podArchiveFixture({ secretDiagnostic: true });
  let redactionError = null;
  try {
    await generateValidatedPodArchive({
      kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: redaction.runCommand, runCredentialScript: redaction.runCredentialScript,
      dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore", streamToFile: redaction.streamToFile,
      outputPath: path.join(root, "credential-redaction.dump"), dumpFlags: ["--format=custom", "--schema=dune"], validateToc: () => ({ valid: true })
    });
  } catch (error) { redactionError = error; }
  assert(redactionError, "credential diagnostic fixture unexpectedly succeeded");
  assert.doesNotMatch(redactionError.message, /supersecret/);
  assert.match(redactionError.message, /PGPASSWORD=\[redacted\]/);
  assert.equal(redaction.files.size, 0);

  const cleanupFailure = podArchiveFixture({ cleanupFailure: true });
  const cleanupFailurePath = path.join(root, "credential-cleanup-failure.dump");
  await assert.rejects(() => generateValidatedPodArchive({
    kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: cleanupFailure.runCommand, runCredentialScript: cleanupFailure.runCredentialScript,
    dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore", streamToFile: cleanupFailure.streamToFile,
    outputPath: cleanupFailurePath, dumpFlags: ["--format=custom", "--schema=dune"], validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
  }), /cleanup|permission denied/i, "credential cleanup failure must fail closed");
  assert.equal(fs.existsSync(cleanupFailurePath), false, "credential cleanup failure must remove the downloaded local partial");

  const stale = podArchiveFixture();
  stale.files.set(POD_ARCHIVE_PATHS.legacyRecovery, Buffer.from("stale"));
  const cleaned = await cleanupPodArchivePaths({ runCommand: stale.runCommand, sshArgs: ["target"], target });
  assert.equal(cleaned.removedCount, "1");
  assert.equal(stale.files.size, 0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-migration-integration-"));

const duneToc = `
1; 0 0 ENCODING - ENCODING postgres
2; 0 0 STDSTRINGS - STDSTRINGS postgres
3; 2615 100 SCHEMA - dune postgres
4; 1247 101 TYPE dune actor_kind postgres
5; 1255 102 FUNCTION dune calculate_state() postgres
6; 1259 103 TABLE dune actors postgres
7; 1259 104 TABLE dune world_partition postgres
8; 1259 105 SEQUENCE dune actors_id_seq postgres
9; 2606 106 CONSTRAINT dune actors actors_pkey postgres
10; 1259 107 VIEW dune actor_view postgres
11; 2620 108 TRIGGER dune actors actors_trigger postgres
12; 0 103 TABLE DATA dune actors postgres
13; 0 105 SEQUENCE SET dune actors_id_seq postgres
14; 2606 109 FK CONSTRAINT dune actors actors_partition_fk postgres
15; 0 110 TABLE ATTACH dune world_partition world_partition_0 postgres
`;

function inspectionOutput(component, toc) {
  return `${ARCHIVE_INSPECTION_MARKER}\t${component.size}\t${component.sha256}\n${toc}`;
}

async function testClosedSeekableArchiveInspection() {
  const worldPath = path.join(root, "closed-world.dump");
  fs.writeFileSync(worldPath, Buffer.concat([Buffer.from("PGDMP", "ascii"), Buffer.alloc(8192, 11)]));
  const seen = [];
  const run = (toc) => async ({ filePath, component }) => {
    seen.push({ filePath, component });
    return { ok: true, inputComplete: true, stdout: inspectionOutput(component, toc), stderr: "diagnostic stderr remains separate" };
  };
  const world = await inspectClosedArchive({ filePath: worldPath, label: "world.dump", scope: "dune", validateToc: validatePgRestoreToc, runInspection: run(duneToc) });
  assert.equal(world.archiveReadVerified, true);
  assert.equal(world.objectClasses.foreignKeys, true);
  assert.deepEqual(world.component, await hashStableFile(worldPath));
  assert.equal(seen.length, 1, "the closed world component must be inspected before packaging");
}

async function testArchiveInspectionFailures() {
  const inputPath = path.join(root, "archive-failure.dump");
  fs.writeFileSync(inputPath, Buffer.alloc(16 * 1024 * 1024, 23));
  await assert.rejects(() => inspectClosedArchive({
    filePath: inputPath,
    label: "world.dump",
    scope: "dune",
    validateToc: validatePgRestoreToc,
    runInspection: ({ filePath }) => runWithStdin(process.execPath, ["-e", "process.stdin.once('data',()=>process.exit(0))"], filePath, { timeout: 10000 })
  }), /closed before|could not fully read/i, "an early-closing consumer must remain a hard failure");

  for (const [diagnostic, pattern] of [
    ["pg_restore exited nonzero", /nonzero/],
    ["archive is corrupt", /corrupt/],
    ["unexpected end of file", /unexpected end/],
    ["full archive read failed while decompressing data", /decompressing/]
  ]) {
    await assert.rejects(() => inspectClosedArchive({
      filePath: inputPath,
      label: "world.dump",
      scope: "dune",
      validateToc: validatePgRestoreToc,
      runInspection: async () => ({ ok: false, code: 7, inputComplete: true, stdout: "", stderr: diagnostic, error: "Command exited with code 7." })
    }), pattern);
  }

  const expected = await hashStableFile(inputPath);
  await assert.rejects(() => inspectClosedArchive({
    filePath: inputPath,
    label: "world.dump",
    scope: "dune",
    validateToc: validatePgRestoreToc,
    runInspection: async () => ({ ok: true, inputComplete: true, stdout: inspectionOutput({ ...expected, sha256: "0".repeat(64) }, duneToc), stderr: "" })
  }), /different bytes/);
  await assert.rejects(() => inspectClosedArchive({
    filePath: inputPath,
    label: "world.dump",
    scope: "dune",
    validateToc: validatePgRestoreToc,
    runInspection: async ({ component }) => ({ ok: true, inputComplete: true, stdout: inspectionOutput(component, duneToc.replace(/14;.*\n/, "")), stderr: "" })
  }), /foreignKeys/, "exact TOC boundary validation must still fail closed");
}

function testPackageComponentBinding() {
  const world = { size: "9007199254740993", sha256: "a".repeat(64) };
  const inspection = {
    entries: [{ path: "world.dump", ...world }],
    manifest: { components: [{ path: "manifest.json", size: "1", sha256: "c".repeat(64) }, { path: "world.dump", ...world }] }
  };
  assert.deepEqual(verifyPackagedComponents(inspection, { "world.dump": world }), { "world.dump": world });
  const changedEntry = JSON.parse(JSON.stringify(inspection));
  changedEntry.entries[0].sha256 = "d".repeat(64);
  assert.throws(() => verifyPackagedComponents(changedEntry, { "world.dump": world }), /does not match/);
  const changedManifest = JSON.parse(JSON.stringify(inspection));
  changedManifest.manifest.components[1].size = "1";
  assert.throws(() => verifyPackagedComponents(changedManifest, { "world.dump": world }), /Manifest .* does not match/i);
}

async function testStreamingAndPublication() {
  const finalPath = path.join(root, "world.a9migration");
  const paths = partialPaths(finalPath, "stream-test");
  const progress = [];
  const result = await streamCommandToFile({
    command: process.execPath,
    args: ["-e", "for(let i=0;i<1024;i++)process.stdout.write(Buffer.alloc(8192,i%251))"],
    outputPath: paths.packagePartialPath,
    expectedBytes: String(8 * 1024 * 1024),
    timeoutMs: 30000,
    onProgress: (value) => progress.push(value)
  });
  assert.equal(result.size, String(8 * 1024 * 1024));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert(progress.length > 0, "a successful download must publish byte progress");
  assert.equal(progress.at(-1).bytes, String(8 * 1024 * 1024));
  assert.equal(progress.at(-1).totalBytes, String(8 * 1024 * 1024));
  assert.equal(progress.at(-1).progress, 80);
  const published = await publishVerifiedPackage(paths.packagePartialPath, finalPath);
  assert.equal(published.fileName, "world.a9migration");
  assert(fs.existsSync(finalPath));
  await assert.rejects(() => publishVerifiedPackage(finalPath, finalPath), /already exists|siblings/);
}

async function testProgressCallbackFailureContainment() {
  const output = path.join(root, "progress-callback.partial");
  const finalPath = path.join(root, "progress-callback.a9migration");
  let childProcess = null;
  const job = { status: "running", error: "" };
  try {
    await streamCommandToFile({
      command: process.execPath,
      args: ["-e", "setInterval(()=>process.stdout.write(Buffer.alloc(65536,7)),2)"],
      outputPath: output,
      expectedBytes: "1048576",
      timeoutMs: 30000,
      spawnImpl: (...args) => {
        childProcess = require("child_process").spawn(...args);
        return childProcess;
      },
      onProgress: () => { throw new Error("journal unavailable"); }
    });
    assert.fail("a progress callback exception must fail the download");
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    assert.equal(error.code, "migration_progress_reporting_failed");
  }
  assert.equal(job.status, "failed", "the caller remains alive and can make the job terminal failed");
  assert.match(job.error, /progress reporting failed/i);
  assert(childProcess && (childProcess.killed || childProcess.exitCode !== null || childProcess.signalCode), "the SSH/download process must be terminated");
  assert.equal(fs.existsSync(output), false, "the local stream partial must be removed");
  assert.equal(fs.existsSync(finalPath), false, "no final package may be published");

  const target = { namespace: "approved-namespace", dbPod: "approved-db-0" };
  const fixture = podArchiveFixture();
  const podOutput = path.join(root, "progress-pod.partial");
  await assert.rejects(() => generateValidatedPodArchive({
    kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: fixture.runCommand,
    runCredentialScript: fixture.runCredentialScript, dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore",
    streamToFile: fixture.streamToFile, outputPath: podOutput, dumpFlags: ["--format=custom", "--schema=dune"],
    onProgress: () => { throw new Error("operation journal write failed"); },
    validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
  }), /journal write failed/);
  assert.equal(fixture.files.size, 0, "pod archive and credential files must be removed after a progress callback failure");
  assert.equal(fs.existsSync(podOutput), false, "the downloaded component partial must be removed after callback failure");

  const heartbeatFixture = podArchiveFixture();
  const heartbeatOutput = path.join(root, "heartbeat-callback.partial");
  await assert.rejects(() => generateValidatedPodArchive({
    kind: "world", target, dbSvc: "approved-db-service", sshArgs: ["target"], runCommand: heartbeatFixture.runCommand,
    runCredentialScript: heartbeatFixture.runCredentialScript, dumpExecutable: "/usr/bin/pg_dump", restoreExecutable: "/usr/bin/pg_restore",
    streamToFile: heartbeatFixture.streamToFile, outputPath: heartbeatOutput, dumpFlags: ["--format=custom", "--schema=dune"],
    onHeartbeat: () => { throw new Error("heartbeat journal failed"); },
    validateToc: (toc) => validatePgRestoreToc(toc, { scope: "dune" })
  }), /progress reporting failed/i);
  assert.equal(heartbeatFixture.files.size, 0, "pod temporaries must be removed after heartbeat publication failure");
  assert.equal(fs.existsSync(heartbeatOutput), false);
}

async function testInterruptedStreamCleanup() {
  const output = path.join(root, "interrupted.partial");
  await assert.rejects(() => streamCommandToFile({
    command: process.execPath,
    args: ["-e", "process.stdout.write('partial');process.stderr.write('connection ended');process.exit(7)"],
    outputPath: output,
    timeoutMs: 30000
  }), /ended unexpectedly/);
  assert.equal(fs.existsSync(output), false, "SSH/process interruption must clean the partial file");
  const empty = path.join(root, "empty.partial");
  await assert.rejects(() => streamCommandToFile({ command: process.execPath, args: ["-e", ""], outputPath: empty, timeoutMs: 30000 }), /empty file/);
  assert.equal(fs.existsSync(empty), false);
  const diskFull = path.join(root, "disk-full.partial");
  await assert.rejects(() => streamCommandToFile({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.alloc(1024))"],
    outputPath: diskFull,
    timeoutMs: 30000,
    createWriteStreamImpl: () => new Writable({ write(_chunk, _encoding, callback) { const error = new Error("disk full"); error.code = "ENOSPC"; callback(error); } })
  }), /disk full/);
  assert.equal(fs.existsSync(diskFull), false);
}

async function testExplicitPartialCleanup() {
  const rows = [path.join(root, "package.partial"), path.join(root, "world.partial.dump"), path.join(root, "market.partial.dump")];
  rows.forEach((file) => fs.writeFileSync(file, "partial"));
  await safeRemove(rows);
  assert(rows.every((file) => !fs.existsSync(file)));
}

function testConflictAndRestartRecovery() {
  assert.equal(operationsConflict("migration:export", "database:backup"), true);
  assert.equal(operationsConflict("migration:export", "database:import"), true);
  assert.equal(operationsConflict("migration:export", "battlegroup:update"), true);
  assert.equal(operationsConflict("migration:export", "maintenance:deployment"), true);
  assert.equal(operationsConflict("migration:export", "repair:42"), true);
  const history = path.join(root, "operations.json");
  const registry = new OperationRegistry(history);
  registry.begin("database:backup", "Database Backup");
  assert.throws(() => registry.begin("migration:export", "Server Migration Export"), OperationBusyError);
  const restarted = new OperationRegistry(history);
  const interrupted = restarted.snapshot().operations[0];
  assert.equal(interrupted.status, "interrupted");
  assert.doesNotMatch(JSON.stringify(interrupted), /C:\\|ssh|password|manifest\.json/i);
}

function testPackagedSourceAndElectronDialog() {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const migrationExport = fs.readFileSync(path.join(__dirname, "..", "lib", "server-migration-export.js"), "utf8");
  const migrationImport = fs.readFileSync(path.join(__dirname, "..", "lib", "server-migration-import.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.js"), "utf8");
  assert.match(server, /data-view="server-migration"/);
  assert.match(server, /id="server-migration"/);
  assert.match(server, /Verified — Keep This File Safe/);
  assert.doesNotMatch(server, /Safe to Delete Server/);
  assert.match(server, /\/api\/server-migration\//);
  assert.match(server, /StrictHostKeyChecking=yes/);
  assert.match(server, /UserKnownHostsFile=/);
  assert.doesNotMatch(server.slice(server.indexOf("async function migrationDumpToFile"), server.indexOf("function publicMigrationExportJob")), /sftp|scp/i);
  const archiveInspector = migrationExport.slice(migrationExport.indexOf("async function generateValidatedPodArchive"), migrationExport.indexOf("async function publishVerifiedPackage"));
  assert.match(archiveInspector, /pg_dump[\s\S]*--file=/);
  assert.match(archiveInspector, /pg_restore[\s\S]*--list[\s\S]*--file=\/dev\/null/);
  assert.match(archiveInspector, /const dumpArgs = \["env", `PGPASSFILE=\$\{POD_ARCHIVE_PATHS\.credential\}`, dumpExecutable, "--no-password",[\s\S]*`--file=\$\{remotePath\}`\]/, "direct pg_dump must use the restrictive passfile and disable password prompts");
  assert.match(archiveInspector, /\[restoreExecutable, "--list", remotePath\]/);
  assert.match(archiveInspector, /\[restoreExecutable, "--file=\/dev\/null", remotePath\]/);
  assert.doesNotMatch(archiveInspector, /\[(?:"|')(?:\/bin\/)?(?:ba)?sh(?:"|')\s*,/, "archive execution must never prepend a shell executable");
  assert.match(server, /inspectRecoveryArchive/);
  assert.doesNotMatch(archiveInspector, /buildSeekableArchiveInspectionScript|base64|kubectl[^\n]*exec[^\n]*-i/i);
  assert.doesNotMatch(archiveInspector, /streamMigrationEntry|EPIPE|write EOF|ignore/i, "export archive inspection must not suppress transfer failures");
  const exportJob = server.slice(server.indexOf("async function runMigrationExportJob"), server.indexOf("function startMigrationExport"));
  assert.doesNotMatch(exportJob, /collectMigrationMarketBotSafety|revalidateMigrationMarketBotSafety|assertMarketBotMigrationSafetyCheckpoint|migrationSafety/, "read-only source export must not depend on or mutate Market Bot infrastructure");
  assert.match(exportJob, /sourceMarket:\s*after\.sourceMarket/, "verified packages must record read-only portable source-market counts and digests");
  assert.match(server, /const MIGRATION_SOURCE_STABILITY_FIELDS = Object\.freeze\(\[[\s\S]*"fingerprints"[\s\S]*"extensions"[\s\S]*"entityCounts"[\s\S]*"sourceMarket"[\s\S]*"codexBackupArtifacts"[\s\S]*"relationships"[\s\S]*"sequences"/, "source-market evidence must be stable after dumping and before publication");
  assert.match(exportJob, /collectMigrationExportSourceCheckpoint[\s\S]*Post-dump source safety checkpoint[\s\S]*collectMigrationExportSourceCheckpoint[\s\S]*Pre-publication source safety checkpoint/, "the complete baseline must be revalidated after dumping and before publication");
  assert.doesNotMatch(exportJob, /rc-service|buildMarketBotActionCommand\(|setMarketBotPaused\(|installMarketBot\(/i, "migration export must never control the Market Bot service");
  assert.match(exportJob, /migrationDumpToFile[\s\S]*writeMigrationPackage/, "the pod-validated component must exist before packaging");
  assert.doesNotMatch(exportJob, /migrationArchiveToc\(|inspectRecoveryArchive|kubectl exec -i/, "export must not upload a local archive back into the database pod");
  assert(exportJob.indexOf("verifyPackagedComponents") < exportJob.indexOf("publishVerifiedPackage"), "reopened component binding must precede atomic publication");
  assert.match(exportJob, /finally\s*\{[\s\S]*removeMigrationPartials/, "all component and package partials must be cleaned in a finalizer");
  assert.match(main, /showSaveDialog/);
  assert.match(main, /a9migration/);
  assert.match(preload, /chooseServerMigrationExportFile/);
  assert.match(preload, /chooseServerMigrationImportFile/);
  assert.match(main, /choose-server-migration-import-file/);
  assert.match(server, /Server Migration is available only from the local Suite/);
  assert.match(server, /Migration Offline Mode — Automatic Startup and Writers Disabled/);
  assert.match(server, /\/api\/server-migration\/import-preflight/);
  assert.match(server, /runServerMigrationImport/);
  assert.match(server, /prefix:\s*"server-migration-destination-rollback"[\s\S]*expectedStructuredOfflineCheckpoint:\s*job\.approvedCheckpoint\.snapshot\.destination\.battlegroup/);
  assert.match(server, /restoreRollback/);
  assert.doesNotMatch(exportJob, /market-bot\.dump|MIGRATION_MARKET_BOT_DUMP_FLAGS/);
  assert.match(exportJob, /MIGRATION_CODEX_BACKUP_ARTIFACTS/);
  const exportPreflight = server.slice(server.indexOf("async function migrationExportPreflight"), server.indexOf("async function runMigrationExportJob"));
  assert.match(exportPreflight, /sourcePortableSchemaSha256/, "export must validate the source-portable schema pin");
  assert.doesNotMatch(exportPreflight, /freshDestinationSchemaSha256/, "export must not require the fresh-destination schema pin");
  assert.match(exportPreflight, /cleanupPodArchivePaths/, "preflight must remove and report stale fixed-name pod archives");
  assert.match(server, /recoveredPodTemporaryFiles/, "preflight must report the fixed-name pod cleanup count");
  const inventoryArchive = server.slice(server.indexOf("async function createExpectedBackupInventory"), server.indexOf("async function inspectLocalBackupArchive"));
  assert.match(inventoryArchive, /generateValidatedPodArchive[\s\S]*kind:\s*"schemaInventory"/);
  assert.match(inventoryArchive, /dumpExecutable:\s*podTools\.dumpExecutable[\s\S]*restoreExecutable:\s*podTools\.restoreExecutable/);
  assert.doesNotMatch(inventoryArchive, /streamCommandToFile|inspectLocalArchive|inspectRecoveryArchive/, "schema inventory must not make an archive round trip");
  const worldArchive = server.slice(server.indexOf("async function migrationDumpToFile"), server.indexOf("function publicMigrationExportJob"));
  assert.match(worldArchive, /generateValidatedPodArchive[\s\S]*kind:\s*"world"/);
  assert.match(worldArchive, /dumpExecutable:\s*preflight\.evidence\.podTools\.dumpExecutable[\s\S]*restoreExecutable:\s*preflight\.evidence\.podTools\.restoreExecutable/);
  assert.doesNotMatch(worldArchive, /streamCommandToFile|inspectRecoveryArchive|kubectl exec -i/, "world.dump must be generated and validated in the pod before one outward stream");
  assert.match(server, /function migrationJobHeartbeat[\s\S]*elapsedMs[\s\S]*remainingMs/);
  assert.match(server, /function renderMigrationExportJob[\s\S]*migrationLiveText/);
  assert.match(server, /migration_source_cleanup_removed/);
  assert.doesNotMatch(server, /id="migrationDeleteBotListings"|id="migrationDeletePlayerListings"|id="migrationDeleteLegacyNpcListings"/);
  const v1Import = server.slice(server.indexOf("async function runMigrationImportJob"), server.indexOf("function parseDbRows"));
  assert.match(migrationImport, /\["schemaCatalogSha256",\s*String\(profile\.freshDestinationSchemaSha256/, "destination preflight must use the clean destination schema pin");
  assert.match(migrationImport, /compatibilityExtensionIdentities\(profile\.extensions\)[\s\S]*compatibilityExtensionIdentities\(actual\.extensions\)/, "extension compatibility must compare explicit semantic identities independent of rich evidence shape and order");
  assert.match(v1Import, /buildDestinationMarketCleanupSql/);
  const importArchiveRead = v1Import.slice(v1Import.indexOf("readArchiveCompletely"), v1Import.indexOf("restorePackage"));
  assert.match(importArchiveRead, /validatePgRestoreToc\(toc, \{ scope: "dune" \}\)/, "import must enforce the strict portable archive boundary");
  assert.doesNotMatch(importArchiveRead, /createExpectedBackupInventory|validateFullBackupToc/, "import must not reconstruct source data inventory from the intentionally different fresh-destination catalog");
  assert.match(v1Import, /cleanupDestinationMarket/);
  assert.match(v1Import, /verifyFinal/);
  assert.doesNotMatch(v1Import, /public\.alphanine_market_bot_|Market Bot runtime|Clean Bot|marketBotClean|cleanMarketBot/i, "v1 import must not require Market Bot tables or runtime");
  assert.match(v1Import, /evaluateIndependentWriterSamples/, "destination import checkpoints must remain writer-free without requiring Market Bot");
  assert.match(v1Import, /verifyStopped:\s*async/, "import and automatic rollback must share the stopped-destination checkpoint callback");
  assert.doesNotMatch(v1Import, /rc-service|buildMarketBotActionCommand\(|setMarketBotPaused\(|installMarketBot\(/i, "destination import must never control the Market Bot service");
  assert.match(main, /offlineStartup\.active/);
  assert.match(server, /migrationOfflineMode\.startupPolicy\(\)\.allowBackgroundWriters/);
  assert.doesNotMatch(server.slice(server.indexOf("function publicMigrationPreflight"), server.indexOf("async function cleanInterruptedMigrationPartials")), /resolvedPath|parentPath|namespace|dbPod|ssh/i);
}

async function main() {
  try {
    await testPodNativeArchiveExport();
    await testClosedSeekableArchiveInspection();
    await testArchiveInspectionFailures();
    testPackageComponentBinding();
    await testStreamingAndPublication();
    await testProgressCallbackFailureContainment();
    await testInterruptedStreamCleanup();
    await testExplicitPartialCleanup();
    testConflictAndRestartRecovery();
    testPackagedSourceAndElectronDialog();
    console.log("Server Migration streaming, interruption, conflict, restart, UI, and Electron integration tests passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
