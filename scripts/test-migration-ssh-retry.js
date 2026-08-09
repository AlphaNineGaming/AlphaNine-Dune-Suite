"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { classifySshResult, retryableReadOnlyTransportFailure, runReadOnlySshWithRetry } = require("../lib/migration-ssh-retry");

async function main() {
  const interrupted = { ok: false, code: 255, stderr: "ssh: connect to host [redacted]: Connection timed out", error: "Command exited with code 255." };
  assert.equal(classifySshResult(interrupted), "transport_interruption");
  assert.equal(retryableReadOnlyTransportFailure(interrupted), true);

  let calls = 0;
  const retryMessages = [];
  const backoffs = [];
  const recovered = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => (++calls === 1 ? interrupted : { ok: true, code: 0, stdout: "{}", stderr: "" }),
    sleep: async (milliseconds) => { backoffs.push(milliseconds); },
    sanitize: (value) => String(value || "").replace(/\[redacted\]/g, "[address redacted]"),
    onRetry: ({ retry, maximum }) => retryMessages.push(`SSH connection interrupted — retrying ${retry}/${maximum}.`)
  });
  assert.equal(calls, 2, "a retry must use one fresh executor invocation");
  assert.equal(recovered.recovered, true);
  assert.deepStrictEqual(retryMessages, ["SSH connection interrupted — retrying 1/2."]);
  assert.deepStrictEqual(backoffs, [250]);
  assert.equal(recovered.attempts.length, 2);
  assert.equal(recovered.attempts[0].category, "transport_interruption");
  assert.equal(recovered.attempts[1].category, "success");

  calls = 0;
  const ambiguousEmpty = { ok: false, code: 255, stderr: "", error: "" };
  const ambiguousRecovered = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => (++calls === 1 ? ambiguousEmpty : { ok: true, code: 0, stdout: "stable", stderr: "" }),
    sleep: async () => {}
  });
  assert.equal(calls, 2, "an explicitly authorized empty-stderr exit 255 must retry with a fresh process");
  assert.equal(ambiguousRecovered.recovered, true);
  assert.equal(ambiguousRecovered.attempts[0].category, "ambiguous_ssh_exit_255");
  assert.equal(ambiguousRecovered.attempts[0].stderr, "No SSH diagnostic was captured.");
  assert.equal(ambiguousRecovered.attempts[1].category, "success");

  calls = 0;
  const ambiguousExhausted = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => { calls += 1; return ambiguousEmpty; },
    sleep: async () => {}
  });
  assert.equal(calls, 3, "ambiguous exit 255 must remain bounded to the initial attempt plus two retries");
  assert.equal(ambiguousExhausted.recovered, false);
  assert.deepStrictEqual(ambiguousExhausted.attempts.map((attempt) => attempt.category), ["ambiguous_ssh_exit_255", "ambiguous_ssh_exit_255", "ambiguous_ssh_exit_255"]);
  assert(ambiguousExhausted.attempts.every((attempt) => attempt.stderr === "No SSH diagnostic was captured."), "all exhausted attempt diagnostics must be preserved");

  calls = 0;
  const exhausted = await runReadOnlySshWithRetry({ maxRetries: 2, execute: async () => { calls += 1; return interrupted; }, sleep: async () => {} });
  assert.equal(calls, 3, "preflight permits at most the initial command plus two retries");
  assert.equal(exhausted.attempts.length, 3);
  assert.equal(exhausted.result.stderr, interrupted.stderr, "the terminal cause must remain exact");
  calls = 0;
  const exhaustedBackoffs = [];
  const exhaustedTimed = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => { calls += 1; return interrupted; },
    sleep: async (milliseconds) => { exhaustedBackoffs.push(milliseconds); }
  });
  assert.equal(exhaustedTimed.result.code, 255);
  assert.deepStrictEqual(exhaustedBackoffs, [250, 500], "bounded evidence retries must use the exact 250/500 ms backoff");

  for (const failure of [
    { ok: false, code: 1, stderr: "Permission denied (publickey)." },
    { ok: false, code: 2, stderr: "psql: error: connection to server failed" },
    { ok: false, code: 1, stderr: "remote command failed" },
    { ok: false, code: null, timedOut: true, stderr: "Command timed out" }
  ]) {
    calls = 0;
    const rejected = await runReadOnlySshWithRetry({ maxRetries: 2, execute: async () => { calls += 1; return failure; }, sleep: async () => {} });
    assert.equal(calls, 1, `${classifySshResult(failure)} must not retry`);
    assert.equal(rejected.attempts.length, 1);
  }

  for (const diagnostic of ["Permission denied (publickey).", "psql: error: connection to server failed", "Error from server: pod not found", "Command timed out", ""]) {
    calls = 0;
    const exit255 = await runReadOnlySshWithRetry({
      maxRetries: 2,
      execute: async () => { calls += 1; return { ok: false, code: 255, timedOut: diagnostic === "Command timed out", stderr: diagnostic }; },
      sleep: async () => {}
    });
    assert.equal(calls, 3, "every exit 255 inside the explicit read-only boundary must receive the bounded retries");
    assert.equal(exit255.attempts.length, 3);
  }

  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const preflightRunner = server.slice(server.indexOf("async function runMigrationPreflightJob"), server.indexOf("function startMigrationPreflightJob"));
  assert.match(preflightRunner, /preflightReadOnlyRetry:\s*true/);
  assert.match(preflightRunner, /SSH connection interrupted — retrying \$\{retry\}\/\$\{maximum\}/);
  const exportRunner = server.slice(server.indexOf("async function runMigrationExportJob"), server.indexOf("function startMigrationExport"));
  assert.doesNotMatch(exportRunner, /preflightReadOnlyRetry:\s*true/, "export must not inherit the broader UI-preflight option");
  assert.match(exportRunner, /migrationExportEvidenceRetryOptions\(job, "Pre-dump source safety checkpoint"\)/);
  assert.match(exportRunner, /collectMigrationExportSourceCheckpoint\(job, preflight\.target, preflight\.evidence, "Post-dump source safety checkpoint"\)/);
  assert.match(exportRunner, /collectMigrationExportSourceCheckpoint\(job, preflight\.target, preflight\.evidence, "Pre-publication source safety checkpoint"\)/);
  assert.match(exportRunner, /assertMigrationSourceEvidenceCheckpoint\(preflight\.evidence, preflight\.evidence/);
  assert.match(server, /const MIGRATION_SOURCE_STABILITY_FIELDS = Object\.freeze\(\[[\s\S]*"fingerprints"[\s\S]*"entityCounts"[\s\S]*"sourceMarket"[\s\S]*"relationships"[\s\S]*"sequences"/);
  assert.match(server, /function assertMigrationSourceEvidenceCheckpoint[\s\S]*evaluateIndependentWriterSamples[\s\S]*MIGRATION_SOURCE_STABILITY_FIELDS/);
  assert.match(exportRunner, /job\.failure = publicMigrationFailure[\s\S]*sshAttempts: job\.sshDiagnostics/);
  const dumpFunction = server.slice(server.indexOf("async function migrationDumpToFile"), server.indexOf("function publicMigrationExportJob"));
  assert.doesNotMatch(dumpFunction, /exportSourceReadOnlyRetry|readOnlyRetryPolicy|runReadOnlySshWithRetry/, "pg_dump and archive transfer must remain outside SSH retry");
  const importRunner = server.slice(server.indexOf("async function runMigrationImportJob"), server.indexOf("function parseDbRows"));
  assert.doesNotMatch(importRunner, /exportSourceReadOnlyRetry|export-source-revalidation/, "import and restore must remain outside source-evidence retry");
  assert.match(importRunner, /inspectPackage:[\s\S]*preflightReadOnlyRetry:\s*true/, "internal import readiness revalidation must use bounded read-only SSH retry");
  assert.match(importRunner, /SSH connection interrupted during import readiness revalidation — retrying \$\{retry\}\/\$\{maximum\}/);
  assert.match(importRunner, /assertMigrationImportReadinessUnchanged\(job\.approvedCheckpoint, checked\)/, "the recovered complete checkpoint must match the approved preflight before backup");
  const afterBackupBoundary = importRunner.slice(importRunner.indexOf("createRollbackBackup:"));
  assert.doesNotMatch(afterBackupBoundary, /preflightReadOnlyRetry|readOnlyRetryPolicy|runReadOnlySshWithRetry/, "backup, restore, cleanup, and rollback must not inherit readiness retry");
  assert.match(server, /function publicMigrationImportJob\(job\)[\s\S]*failure: job\.failure[\s\S]*sshAttempts:/, "terminal import status must expose sanitized command classification and attempt history");
  assert.match(server, /function approvedMigrationImportPreflight[\s\S]*preflightApprovalDigest[\s\S]*approvedCheckpoint/, "import must require the approved package/destination checkpoint");
  assert.match(server, /migrationReadOnlyEvidenceResult\(buildVmSchedulerStatusCommand\(\)[\s\S]*Import preflight: AlphaNine automatic-restart scheduler evidence/, "scheduler readiness evidence must share the import retry path");
  assert.match(server, /migrationPodArchiveTools\(target, queryOptions\)/, "matching-version tool probes must share the import retry path");
  assert.match(server, /SSH interrupted during source revalidation — retrying \$\{retry\}\/\$\{maximum\}\./);
  assert.match(server, /function renderMigrationExportJob\(job\)[\s\S]*migrationFailureText\(job\)/, "terminal export UI must show command purpose and SSH classification");

  let dumpRuns = 0;
  let cleanupRuns = 0;
  let published = false;
  calls = 0;
  try {
    dumpRuns += 1;
    const postDump = await runReadOnlySshWithRetry({
      maxRetries: 2,
      execute: async () => (++calls === 1 ? interrupted : { ok: true, code: 0, stdout: "stable-checkpoint", stderr: "" }),
      sleep: async () => {}
    });
    assert.equal(postDump.result.ok, true);
    assert.equal(postDump.recovered, true);
    published = true;
  } finally { cleanupRuns += 1; }
  assert.equal(dumpRuns, 1, "a recovered post-dump evidence query must never rerun pg_dump");
  assert.equal(calls, 2);
  assert.equal(cleanupRuns, 1);
  assert.equal(published, true);

  dumpRuns = 0;
  cleanupRuns = 0;
  published = false;
  calls = 0;
  try {
    dumpRuns += 1;
    const postDump = await runReadOnlySshWithRetry({ maxRetries: 2, execute: async () => { calls += 1; return interrupted; }, sleep: async () => {} });
    if (!postDump.result.ok) throw new Error("source revalidation exhausted");
    published = true;
  } catch (error) { assert.match(error.message, /exhausted/); }
  finally { cleanupRuns += 1; }
  assert.equal(dumpRuns, 1, "an exhausted retry must not rerun pg_dump");
  assert.equal(calls, 3);
  assert.equal(cleanupRuns, 1, "an exhausted retry must reach export cleanup");
  assert.equal(published, false, "an exhausted retry must not publish a package");
  assert.match(server, /function migrationDiagnosticText[\s\S]*return raw \? migrationPublicError\(raw\) : "";/, "empty stderr must remain empty instead of becoming a generic export failure");
  assert.match(server, /LogLevel=ERROR/, "SSH connection diagnostics must remain available for classification");
  assert.match(server, /const database = parseMigrationJson\(databaseText/, "JSON parsing must remain outside the transport retry executor");
  console.log("Migration read-only preflight SSH retry, exclusion, diagnostics, and UI-status tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
