"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");

for (const required of [
  "Starting \"+label+\"…",
  "Working · Request sent",
  "Last heartbeat: request sent at",
  "No recent activity · status request failed",
  "preflight-status/",
  "import-preflight-status/",
  "renderMigrationPreflightJob",
  "renderMigrationImportPreflightJob",
  "migrationFailureText",
  "Failed gate: ",
  "Command purpose: ",
  "SSH exit code: ",
  "Sanitized stderr: ",
  "reconnectMigrationJob",
  "Cache-Control\", \"no-store, max-age=0",
  "Do not close the Suite or power off either server."
]) assert(source.includes(required), `Migration live UI is missing: ${required}`);

for (const functionName of ["runMigrationPreflight", "startMigrationExport", "runMigrationImportPreflight", "startMigrationImport"]) {
  const start = source.indexOf(`async function ${functionName}()`);
  assert(start >= 0, `${functionName} is missing.`);
  const body = source.slice(start, source.indexOf("\nfunction ", start + 20) < 0 ? start + 5000 : source.indexOf("\nfunction ", start + 20));
  assert(body.includes("beginMigrationImmediateFeedback"), `${functionName} does not publish immediate feedback.`);
  assert(body.includes("pollMigrationJob"), `${functionName} does not monitor the accepted job.`);
}

assert(source.includes("if(requestPending||activeJobId)return false"), "Startup-suppressed handlers do not synchronously reject duplicate clicks.");
assert(source.includes("['preflight','export','import-preflight','import'].includes(data.type)"), "Startup-suppressed page cannot reconnect to export/import jobs.");
assert(source.includes('error.code = "migration_ssh_command_failed"'), "SSH failures are not preserved as structured migration diagnostics.");
assert.match(source, /diagnostics:\s*\{ failure: job\.failure, sshAttempts: job\.sshDiagnostics \|\| \[\] \}/, "Terminal preflight failure and SSH-attempt evidence are not persisted in the operation journal.");
console.log("Migration live UI source regressions passed.");
