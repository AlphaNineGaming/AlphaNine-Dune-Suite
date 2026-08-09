"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runWithStdin } = require("./stdin-process");

function shQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function safeKubernetesName(value, label) {
  const text = String(value || "").trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(text)) throw new Error(`${label} is missing or malformed.`);
  return text;
}

function buildSqlStdinRemoteCommand(input = {}) {
  const namespace = safeKubernetesName(input.namespace, "Database namespace");
  const pod = safeKubernetesName(input.pod, "Database pod");
  const service = safeKubernetesName(input.dbService, "Database service");
  const inner = `PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -h ${shQuote(service)} -p 15432 -U postgres -d dune -At -f -`;
  return `sudo kubectl exec -i -n ${shQuote(namespace)} ${shQuote(pod)} -- sh -c ${shQuote(inner)}`;
}

async function runSqlOverSshStdin(input = {}) {
  const sql = String(input.sql || "");
  if (!sql.trim()) throw new Error("Diagnostic SQL input is empty.");
  const sshArgs = Array.isArray(input.sshArgs) ? input.sshArgs.map(String) : [];
  const remoteCommand = buildSqlStdinRemoteCommand(input);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-diagnostic-query-"));
  const inputPath = path.join(temporaryDirectory, "query.sql");
  fs.writeFileSync(inputPath, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const runner = input.runWithStdinImpl || runWithStdin;
  try {
    return await runner("ssh", [...sshArgs, remoteCommand], inputPath, {
      timeout: input.timeout || 120000,
      maxBuffer: input.maxBuffer || 64 * 1024 * 1024,
      ...(input.runnerOptions || {})
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  buildSqlStdinRemoteCommand,
  runSqlOverSshStdin
};
