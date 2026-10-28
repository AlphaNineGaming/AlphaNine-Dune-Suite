"use strict";
// Parent test launcher: keep local HTTP tests real, isolate only server children.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const originalSpawn = cp.spawn;
cp.spawn = function (binary, args, options = {}) {
  if (args.some(value => path.basename(String(value)) === "server.js")) {
    const env = { ...options.env, ALPHANINE_SKIP_STARTUP_SERVICES: "1" };
    for (const name of Object.keys(env)) if (/^DUNE_/.test(name)) delete env[name];
    // Only the existing authentication test owns a fake PostgreSQL listener.
    if (process.argv.some(value => path.basename(value) === "test-setup-database-auth.js")) {
      const fixture = JSON.parse(fs.readFileSync(env.ALPHANINE_CONFIG_PATH, "utf8"));
      if (fixture.databaseHost !== "127.0.0.1" || !Number.isInteger(fixture.databasePort)) throw new Error("Expected a local fake PostgreSQL configuration.");
      env.ALPHANINE_TEST_ALLOWED_NET_PORTS = String(fixture.databasePort);
    }
    if (process.argv.some(value => path.basename(value) === "test-secret-config-persistence.js")) {
      const fixture = JSON.parse(fs.readFileSync(env.ALPHANINE_CONFIG_PATH, "utf8"));
      if (fixture.receiverHost !== "127.0.0.1" || !Number.isInteger(fixture.receiverPort)) throw new Error("Expected a local fixture Receiver configuration.");
      env.ALPHANINE_TEST_ALLOWED_NET_PORTS = String(fixture.receiverPort);
      env.ALPHANINE_TEST_ALLOW_RECEIVER = "1";
      delete env.ALPHANINE_SKIP_STARTUP_SERVICES;
    }
    args = ["--require", path.join(__dirname, "safe-backend-preload.cjs"), ...args];
    options = { ...options, env };
  }
  return originalSpawn.call(this, binary, args, options);
};
