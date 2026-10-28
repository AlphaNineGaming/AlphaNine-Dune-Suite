"use strict";
// Used only by disposable integration backends; never by the shipped application.
const fs = require("node:fs");
const cp = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const originalSpawn = cp.spawn;
function record(kind) { if (process.env.ALPHANINE_TEST_CALL_LOG) fs.appendFileSync(process.env.ALPHANINE_TEST_CALL_LOG, JSON.stringify({ kind }) + "\n"); }
if (process.env.ALPHANINE_TEST_READONLY_DATABASE === "1") {
  // Exercise real database-admission code with a catalog/query fixture. This is
  // not PostgreSQL or TLS evidence; the network remains blocked below.
  const remote = require("../../lib/providers/remote-database"), factory = remote.createRemoteDatabase;
  remote.createRemoteDatabase = () => factory({ clientFactory(settings) {
    if (settings.ssl.rejectUnauthorized !== true) throw new Error("Fixture requires verified TLS settings");
    return { on() {}, async connect() {}, async end() {}, async query(sql, params) {
      record("fixture-read-only-sql");
      if (sql.includes("provider-role")) return { rows: [Object.fromEntries(["superuser", "bypass_rls", "create_database", "create_role", "database_create", "schema_create", "table_write"].map(key => [key, false]))] };
      if (sql.includes("provider-relation")) return { rows: [{ kind: "r", rls: false, subclasses: false, can_select: true, id_primary: true }] };
      if (sql.includes("provider-columns")) return { rows: [{ name: "id", type: "int8", type_schema: "pg_catalog", not_null: true }, { name: "character_name", type: "text", type_schema: "pg_catalog", not_null: false }, { name: "online_status", type: "int4", type_schema: "pg_catalog", not_null: false }] };
      if (sql.includes("provider-players")) return { rows: [{ id: "1", name: "private-player-canary", status: "1" }] };
      if (sql.includes("provider-explorer")) return { rows: [{ id: "1", character_name: "private-player-canary", online_status: "1", forbidden: "secret-canary" }] };
      if (sql.includes("server_version_num")) return { rows: [{ version: "160010" }] };
      if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
      if (["BEGIN READ ONLY", "SET LOCAL statement_timeout = 3000", "SELECT 1 AS connected", "ROLLBACK", "LOCK TABLE dune.player_state IN ACCESS SHARE MODE"].includes(sql)) return { rows: [] };
      throw new Error("Disallowed SQL fixture request");
    } };
  } });
}
cp.execFile = (binary, args, options, callback) => {
  if (typeof options === "function") callback = options;
  const ssh = /(?:^|[\\/])ssh(?:\.exe)?$/.test(binary);
  if (!ssh) { record("blocked-external-process"); queueMicrotask(() => callback(Object.assign(new Error("External execution blocked by test fixture"), { code: 1 }), "", "")); return { kill() {} }; }
  record("fixture-ssh-read");
  const command = args.at(-1);
  const values = { "LC_ALL=C uname -s": "Linux\n", "LC_ALL=C uname -m": "x86_64\n", "LC_ALL=C cat /etc/os-release": 'ID="alpine"\nPRIVATE_HOST=secret-canary\n' };
  const deployment = process.env.ALPHANINE_TEST_RECOGNIZED_DEPLOYMENT === "1" ? { schemaVersion: 1, layout: "native-v1", identityEstablished: true, runtime: { kind: "native", state: "running", scope: "process", bound: true }, configuration: { userGame: "readable", userEngine: "readable" }, version: { steamBuild: "123456" }, settings: { m_GlobalXPMultiplier: 2 }, gameProcessCount: 1 } : { schemaVersion: 1, layout: "unknown", identityEstablished: false };
  const output = values[command] ?? (command.includes('for t in kubectl docker') ? "kubectl\npsql\n" : command.startsWith("if test -d ") ? "readable\n" : /^python3 -B -I - '[A-Za-z0-9+/=]+'$/.test(command) ? JSON.stringify(deployment) : null);
  if (output === null || args.includes("StrictHostKeyChecking=no")) { queueMicrotask(() => callback(Object.assign(new Error("Disallowed SSH fixture command"), { code: 1 }), "", "")); }
  else if (process.env.ALPHANINE_TEST_PROBE_DELAY_MS) setTimeout(() => callback(null, output, ""), Number(process.env.ALPHANINE_TEST_PROBE_DELAY_MS));
  else queueMicrotask(() => callback(null, output, ""));
  return { kill() {} };
};
cp.spawn = (binary, args, options = {}) => {
  const receiver = path.resolve(__dirname, "../../receivers/dune-live-give-receiver.js");
  if (process.env.ALPHANINE_TEST_ALLOW_RECEIVER === "1" && binary === process.execPath && args.some(value => path.resolve(String(value)) === receiver)) {
    record("fixture-local-receiver");
    return originalSpawn(binary, ["--require", __filename, ...args], options);
  }
  record("blocked-external-spawn"); throw new Error("External child execution blocked by test fixture");
};
cp.spawnSync = () => { record("blocked-external-spawn-sync"); return { status: 1, error: new Error("External child execution blocked by test fixture"), stdout: "", stderr: "" }; };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (process.env.ALPHANINE_TEST_ALLOWED_NET_PORTS) {
    const options = typeof args[0] === "object" ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] };
    const ports = process.env.ALPHANINE_TEST_ALLOWED_NET_PORTS.split(",").map(Number);
    if ((options.host === "127.0.0.1" || options.host === "localhost") && ports.includes(Number(options.port))) { record("fixture-loopback-socket"); return originalConnect.apply(this, args); }
  }
  record("blocked-outbound-socket");
  queueMicrotask(() => this.destroy(Object.assign(new Error("Outbound connections blocked by test fixture"), { code: "ECONNREFUSED" })));
  return this;
};
