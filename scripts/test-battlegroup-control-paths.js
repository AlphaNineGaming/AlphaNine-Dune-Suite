"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const server = read("server.js");
const scheduler = read("assets/scheduler/alphanine-scheduler.sh");
const manager = read("manager/manager-server.py");
const worker = read("migration-worker/main.go") + read("lib/migration-worker-plan.js");

assert.match(server, /runAttributedBattlegroupAction\(action, options\)/, "normal start/stop/restart must use the attributed control path");
assert.match(server, /buildBattlegroupControlMergePatch/, "Suite mutations must use resource-version-bound patches");
assert.match(server, /operationId: operation\.id[\s\S]*callSite: "server\.js:\/api\/action\/:action"/, "explicit API control must retain its operation identity and call site");
assert.match(server, /attemptConfiguredServerStart[\s\S]*operationId: `startup-/, "startup synchronization must be attributed");
assert(!/battlegroup\("stop"\)/.test(server), "no delayed Suite closure may issue an anonymous stop");
assert.match(server, /prepareAttributedVendorBattlegroupAction\("update"[\s\S]*operationId: operation\.id/, "vendor updater control must carry the explicit operation identity");
assert.match(server, /prepareAttributedVendorBattlegroupAction\("import"[\s\S]*operationId: options\.operationId/, "vendor import control must carry the explicit operation identity");
assert.match(server, /minimumGeneration: initial\.evidence\.generation/, "explicit control must advance beyond durable remote generation");

assert(!manager.includes('/home/dune/.dune/bin/battlegroup restart'), "Manager must not bypass attributed control with a vendor restart");
assert.match(manager, /restartRequired": True/, "Manager must return restart-required state instead");

assert.match(scheduler, /control_before=\$\(control_snapshot\)/, "scheduler must capture control generation before lengthy restart preflight");
assert.match(scheduler, /guarded_control_patch true "\$control_generation"/, "scheduler stop must carry its captured generation");
assert.match(scheduler, /rejected-stale/, "scheduler must durably report stale intent rejection");
assert(!/kubectl_safe patch battlegroup[^\n]+spec[^\n]+stop/.test(scheduler), "scheduler must not retain direct anonymous stop patches");
assert.match(scheduler, /oldResourceVersion[\s\S]*newResourceVersion[\s\S]*oldStop[\s\S]*newStop/, "scheduler attribution must record the complete mutation transition");

assert(!/kubectl[^\n]+patch[^\n]+battlegroup|spec[.]stop/.test(worker), "migration worker and rollback paths must never mutate battlegroup stop state");
assert.match(server, /setTimeout\(\(\) => attemptConfiguredServerStart\("startup"\), 1000\)/, "startup timer may only issue an attributed start");

console.log("Suite, Manager, scheduler, worker, recovery, and startup battlegroup control-path audit passed.");
