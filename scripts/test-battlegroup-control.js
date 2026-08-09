"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ANNOTATIONS,
  BattlegroupControlJournal,
  buildMergePatch,
  resourceEvidence
} = require("../lib/battlegroup-control");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "a9-battlegroup-control-"));
try {
  const journal = new BattlegroupControlJournal({ statePath: path.join(root, "state.json"), auditPath: path.join(root, "audit.jsonl") });
  const base = { reason: "Explicit administrator start", callSite: "test:explicit-start", processIdentity: "node:123:2026-08-08T00:00:00Z", profileIdentity: "test-profile", battlegroupIdentity: "test-ns/test-bg" };
  const start = journal.begin({ ...base, action: "start", stop: false, explicit: true, operationId: "op-start" });
  assert.equal(start.generation, "1");
  const patch = buildMergePatch(start, "41");
  assert.equal(patch.metadata.resourceVersion, "41");
  assert.equal(patch.spec.stop, false);
  assert.equal(patch.metadata.annotations[ANNOTATIONS.operationId], "op-start");
  assert.equal(patch.metadata.annotations[ANNOTATIONS.generation], "1");
  assert.equal(patch.metadata.annotations[ANNOTATIONS.profile].length, 64);
  journal.record(start, { resourceVersion: "41", stop: true }, { resourceVersion: "42", stop: false });

  assert.throws(() => journal.begin({ ...base, action: "stop", stop: true, explicit: false, expectedGeneration: "0", operationId: "old-timer" }), (error) => error.code === "battlegroup_control_stale_intent");
  const currentBackground = journal.begin({ ...base, action: "scheduler-restart", stop: true, explicit: false, expectedGeneration: "1", operationId: "scheduler-current" });
  assert.equal(currentBackground.generation, "1");
  const newerStart = journal.begin({ ...base, action: "start", stop: false, explicit: true, operationId: "op-newer-start" });
  assert.equal(newerStart.generation, "2");
  assert.throws(() => journal.assertCurrent(currentBackground), (error) => error.code === "battlegroup_control_superseded");

  const remoteAhead = journal.begin({ ...base, action: "start", stop: false, explicit: true, minimumGeneration: "9", operationId: "op-remote-ahead" });
  assert.equal(remoteAhead.generation, "10", "a local journal must advance beyond the resource's durable control generation");

  const evidence = resourceEvidence({ metadata: { resourceVersion: "77", annotations: { [ANNOTATIONS.generation]: "10", [ANNOTATIONS.operationId]: "op-remote-ahead" } }, spec: { stop: false } });
  assert.deepEqual(evidence, { resourceVersion: "77", stop: false, generation: "10", operationId: "op-remote-ahead" });
  assert.equal(resourceEvidence({ metadata: { resourceVersion: "78" }, spec: { stop: true } }).generation, "0");
  assert.throws(() => resourceEvidence({ metadata: { resourceVersion: "77" }, spec: {} }), /missing or ambiguous/);

  const records = fs.readFileSync(path.join(root, "audit.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert(records.some((row) => row.outcome === "rejected-stale" && row.operationId === "old-timer"));
  assert(records.some((row) => row.oldResourceVersion === "41" && row.newResourceVersion === "42" && row.oldStop === true && row.newStop === false));
  console.log("Battlegroup control generation, attribution, and stale-intent tests passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
