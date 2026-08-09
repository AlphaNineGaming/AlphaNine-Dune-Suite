"use strict";

const assert = require("assert");
const fs = require("fs");
const {
  buildSqlStdinRemoteCommand,
  runSqlOverSshStdin
} = require("../lib/ssh-sql-stdin");

(async () => {
  const marker = "LARGE_SQL_PAYLOAD_MUST_NOT_APPEAR_IN_PROCESS_ARGUMENTS";
  const sql = `select '${marker}';\n${"select 1;\n".repeat(50000)}`;
  assert(Buffer.byteLength(sql) > 400000, "large-SQL fixture is too small");
  const command = buildSqlStdinRemoteCommand({ namespace: "dune-test", pod: "database-0", dbService: "database" });
  assert(command.length < 500, "remote command is not bounded");
  assert(!command.includes(marker) && !/base64/i.test(command), "SQL payload or Base64 transport leaked into the remote command");

  let stagedPath = "";
  const result = await runSqlOverSshStdin({
    sshArgs: ["-T", "test-target"],
    namespace: "dune-test",
    pod: "database-0",
    dbService: "database",
    sql,
    runWithStdinImpl: async (executable, args, inputPath) => {
      stagedPath = inputPath;
      assert.equal(executable, "ssh");
      const joined = args.join(" ");
      assert(!joined.includes(marker), "SQL bytes appeared in process arguments");
      assert(!joined.includes(Buffer.from(marker).toString("base64")), "Base64 SQL appeared in process arguments");
      assert.equal(fs.readFileSync(inputPath, "utf8"), sql, "stdin staging file did not contain exact SQL bytes");
      return { ok: true, code: 0, stdout: '{"ok":true}\n', stderr: "diagnostic warning\n", inputComplete: true };
    }
  });
  assert.equal(result.stdout, '{"ok":true}\n', "stdout was altered");
  assert.equal(result.stderr, "diagnostic warning\n", "stderr was merged into stdout");
  assert(stagedPath && !fs.existsSync(stagedPath), "SQL staging file survived successful transport");

  let failedPath = "";
  await assert.rejects(() => runSqlOverSshStdin({
    sshArgs: ["test-target"],
    namespace: "dune-test",
    pod: "database-0",
    dbService: "database",
    sql,
    runWithStdinImpl: async (_executable, _args, inputPath) => {
      failedPath = inputPath;
      throw new Error("simulated SSH disconnect");
    }
  }), /simulated SSH disconnect/);
  assert(failedPath && !fs.existsSync(failedPath), "SQL staging file survived failed transport");

  const diagnosticPath = require("path").join(__dirname, "..", "work", "diagnose-market-bot-unknown.js");
  if (fs.existsSync(diagnosticPath)) {
    const diagnosticSource = fs.readFileSync(diagnosticPath, "utf8");
    assert(diagnosticSource.includes("runSqlOverSshStdin"), "diagnostic path does not use stdin SQL transport");
    assert(!diagnosticSource.includes('Buffer.from(sqlText, "utf8").toString("base64")'), "diagnostic path still embeds Base64 SQL");
  }
  console.log("Market Bot diagnostic SSH-stdin SQL transport tests passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
