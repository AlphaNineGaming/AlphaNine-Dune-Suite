"use strict";
const assert = require("assert/strict");
const { assertSafeRemoteArgument, assertSafeRemoteArguments } = require("../lib/migration-remote-args");
const { podExecArgs } = require("../lib/server-migration-export");
const { remoteKubectlArgs } = require("../lib/recovery-archive-transport");

const safe = ["pg_restore", "--file=/tmp/alphanine.sql", "/tmp/archive.backup", "PGPASSFILE=/tmp/a.pgpass", "--set=ON_ERROR_STOP=1", "%a", "15432", "dune", "db.service-0"];
assert.deepEqual(assertSafeRemoteArguments(safe), safe);
for (const unsafe of ["two words", "(dune|x)", "'quoted'", '"quoted"', "x;y", "x|y", "x>y", "x<y", "$(id)", "`id`", "x&y", "x\\y", "x\ny", "x*y", "x?y", "[x]"]) {
  assert.throws(() => assertSafeRemoteArgument(unsafe), (error) => error.code === "migration_remote_argument_unsafe", unsafe);
}
const target = { namespace: "test-ns", dbPod: "postgres-0" };
assert(podExecArgs(target, safe).includes("pg_restore"));
assert(remoteKubectlArgs(target, safe).includes("pg_restore"));
assert.throws(() => podExecArgs(target, ["grep", "(dune|x)"]), /shell syntax/);
assert.throws(() => remoteKubectlArgs(target, ["sh", "-c", "echo unsafe"]), (error) => error.code === "recovery_archive_argument_invalid");
console.log("Migration restore remote-argument allowlist and shell-syntax rejection tests passed.");
