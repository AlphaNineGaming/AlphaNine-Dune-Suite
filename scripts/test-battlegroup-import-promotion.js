"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const bash = process.env.BASH_EXE || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const quoteSource = source.slice(source.indexOf("function shQuote("), source.indexOf("function packagedPath("));
const promotionSource = source.slice(source.indexOf("async function selectedBattlegroupDumpDir("), source.indexOf("async function copyBattlegroupImportFileToVm("));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "a9-import-test-"));
const shellPath = (value) => path.relative(scratch, value).replace(/\\/g, "/");
let capturedCommand = "";
let prelude = "";
let forcedResult = null;
let currentName = "sh-reinstalled-battlegroup";
const context = vm.createContext({
  SSH_USER: "dune",
  battlegroupResource: async () => ({ metadata: { name: currentName } }),
  databaseBackupAudit: () => {},
  sshCommand: async (command) => {
    capturedCommand = command;
    if (forcedResult) return forcedResult;
    const parsed = spawnSync(bash, ["-n"], { input: command, encoding: "utf8" });
    assert.ifError(parsed.error);
    assert.equal(parsed.status, 0, parsed.stderr);
    const run = spawnSync(bash, ["-c", `${prelude}\n${command}`], { encoding: "utf8", cwd: scratch });
    assert.ifError(run.error);
    return { ok: run.status === 0, stdout: run.stdout, stderr: run.stderr };
  }
});
vm.runInContext(`${quoteSource}\n${promotionSource}`, context);

async function main() {
  try {
    assert.equal(await context.selectedBattlegroupDumpDir(), "/funcom/artifacts/database-dumps/sh-reinstalled-battlegroup");
    currentName = "sh-another-install";
    assert.equal(await context.selectedBattlegroupDumpDir(), "/funcom/artifacts/database-dumps/sh-another-install");
    currentName = "";
    await assert.rejects(context.selectedBattlegroupDumpDir(), /name was not detected/);

    // Real Bash and filesystem operations, with shell metacharacters in paths.
    const staged = path.join(scratch, "staged ' backup ; $.backup");
    const destination = path.join(scratch, "new battlegroup");
    const target = path.join(destination, "import ' ; $.backup");
    fs.mkdirSync(destination);
    const promote = () => context.promoteStagedImportFile(shellPath(staged), shellPath(target), shellPath(destination));
    for (const suffix of ["", ".yaml"]) {
      fs.writeFileSync(staged + suffix, "preserved backup bytes");
      await context.promoteStagedImportFile(shellPath(staged + suffix), shellPath(target + suffix), shellPath(destination));
      assert.equal(fs.readFileSync(target + suffix, "utf8"), "preserved backup bytes");
      assert.equal(fs.existsSync(staged + suffix), false);
    }
    // Reproduce the reported defect against the same generated script.
    const oldScript = capturedCommand.split("\n").join("; ");
    assert.notEqual(spawnSync(bash, ["-n"], { input: oldScript, encoding: "utf8" }).status, 0);

    await assert.rejects(promote(), /__ALPHANINE_STAGED_FILE_MISSING__/);
    fs.writeFileSync(staged, "retain on failure");
    prelude = 'cp() { echo "cp: Permission denied" >&2; return 1; }';
    await assert.rejects(promote(), /VM SSH connection/);
    assert.equal(fs.readFileSync(staged, "utf8"), "retain on failure");

    // A fresh installation can lack the dump folder. Mock only sudo, never elevate.
    const freshDir = path.join(scratch, "fresh-install");
    const freshTarget = path.join(freshDir, "import.backup");
    prelude = 'sudo() { if [ "$1" = chown ]; then return 0; fi; "$@"; }';
    await context.promoteStagedImportFile(shellPath(staged), shellPath(freshTarget), shellPath(freshDir));
    assert.equal(fs.readFileSync(freshTarget, "utf8"), "retain on failure");
    assert.equal(fs.existsSync(staged), false);

    fs.writeFileSync(staged, "keep original stage");
    prelude = 'command() { return 1; }';
    await assert.rejects(context.promoteStagedImportFile(shellPath(staged), shellPath(path.join(scratch, "absent", "import.backup")), shellPath(path.join(scratch, "absent"))), /VM SSH connection/);
    assert.equal(fs.existsSync(staged), true);

    // An echoed script contains the marker but is not a permission diagnostic.
    forcedResult = { ok: false, stdout: "", stderr: `bash: syntax error near unexpected token ';'\nbash: ${oldScript}` };
    await assert.rejects(promote(), (error) => /syntax error/.test(error.message) && !/VM user cannot write/.test(error.message));
    console.log("Battlegroup import promotion: Bash syntax, copy, sudo fallback, failures, sidecar, and current installation tests passed.");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
