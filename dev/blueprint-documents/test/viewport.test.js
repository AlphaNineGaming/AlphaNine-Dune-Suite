"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BlueprintDocument } = require("../document");
const { createReferenceSnapshot, exactCoordinate } = require("../reference-adapter");
const { fixtureBytes, positionEvidence } = require("../reference-fixtures");
const { ViewState } = require("../view-state");
const reference = positionEvidence(fixtureBytes());

test("only byte-verified fixtures resolve; arbitrary JSON cannot self-certify positions", () => {
  const bytes = fixtureBytes(), doc = new BlueprintDocument(bytes);
  assert.equal(createReferenceSnapshot(doc, positionEvidence(bytes)).resolved, 36);
  assert.equal(createReferenceSnapshot(doc).unresolved, 36);
  const altered = doc.replaceValue(["name"], '"I certify this file"');
  assert.equal(positionEvidence(altered.toBuffer()), null);
  assert.equal(createReferenceSnapshot(altered).resolved, 0);
});

test("malformed, missing, alternate, and lossy transform data is unresolved, never defaulted", () => {
  const rows = [
    { x: 1, y: 2, z: 3 }, { x: "1", y: 2, z: 3 }, { x: null, y: 2, z: 3 },
    { y: 2, z: 3 }, { x: [], y: 2, z: 3 }, { x: {}, y: 2, z: 3 },
    { x: 1, y: 2, z: 3, rotation: "ninety" }, { x: 1, y: 2, z: 3, transform: [1, 2, 3] },
    { x: 0.1, y: 2, z: 3 }, { x: 1e20, y: 2, z: 3 }
  ];
  const doc = new BlueprintDocument(Buffer.from(JSON.stringify({ instances: rows, pentashields: [{ placeable_id: 0, scale: [1, 2, 3] }] })));
  const snapshot = createReferenceSnapshot(doc, reference);
  assert.deepEqual(snapshot.records[0].position, [1, 2, 3]);
  assert.equal(snapshot.resolved, 1);
  assert.ok(snapshot.records.slice(1).every(row => row.position === null && row.reasons.length));
  assert.equal(snapshot.records[6].fields.rotation.raw, '"ninety"');
  for (const token of ["1e999999", "1e-999999", "900719925474099312345", "0.12345678901234567890123"]) assert.ok(exactCoordinate({ type: "number", raw: token }).reason);
  for (const token of ["1", "-0", "0.5", "1.2500", "1e2"]) assert.equal(typeof exactCoordinate({ type: "number", raw: token }).value, "number");
});

test("selection uses source row keys, not duplicate or imprecise native identifiers", () => {
  const bytes = Buffer.from('{"instances":[{"instance_id":9007199254740993123,"x":0,"y":0,"z":0},{"instance_id":9007199254740993123,"x":1,"y":0,"z":0}],"placeables":[{"placeable_id":0,"x":0,"y":0,"z":0}]}');
  const doc = new BlueprintDocument(bytes), snapshot = createReferenceSnapshot(doc, reference), view = new ViewState(snapshot);
  assert.deepEqual(snapshot.records.map(row => row.key), ["instances:0", "instances:1", "placeables:0"]);
  view.select("instances:0"); view.select("instances:1", true);
  assert.deepEqual([...view.selected], ["instances:0", "instances:1"]);
  view.select("instances:0", true); assert.deepEqual([...view.selected], ["instances:1"]);
  view.select("placeables:0"); assert.deepEqual([...view.selected], ["placeables:0"]);
  assert.equal(view.select("unknown:0"), false);
  assert.equal(view.filter("9007199254740993123").length, 2);
  assert.equal(view.filter("", "unresolved").length, 1);
  assert.equal(snapshot.records[0].fields.instance_id.raw, "9007199254740993123");
  assert.deepEqual(doc.toBuffer(), bytes);
});

test("opening, orbit, pan, zoom, focus and selection cannot modify document bytes", () => {
  const bytes = fixtureBytes(1000), doc = new BlueprintDocument(bytes);
  const snapshot = createReferenceSnapshot(doc, positionEvidence(bytes)), view = new ViewState(snapshot);
  const originalPosition = [...snapshot.records[0].position];
  for (let i = 0; i < 250; i++) { view.select(`instances:${i}`, true); view.orbit(4, -2); view.pan(2, 1, 600); view.zoom(i % 2 ? 10 : -10); }
  assert.equal(view.focusSelection(), true); view.focusAll();
  assert.deepEqual(snapshot.records[0].position, originalPosition);
  assert.deepEqual(doc.toBuffer(), bytes);
  const detached = structuredClone(snapshot); detached.records[0].fields.x.raw = "999";
  assert.deepEqual(doc.toBuffer(), bytes);
});

test("focus ignores unresolved selections and camera operations stay finite", () => {
  const doc = new BlueprintDocument(Buffer.from('{"instances":[{"x":0,"y":0,"z":0},{"x":"bad","y":0,"z":0}]}'));
  const view = new ViewState(createReferenceSnapshot(doc, reference));
  view.select("instances:1"); const before = structuredClone(view.camera); assert.equal(view.focusSelection(), false); assert.deepEqual(view.camera, before);
  view.select("instances:0", true); assert.equal(view.focusSelection(), true);
  for (let i = 0; i < 100; i++) { view.orbit(1e4, 1e4); view.zoom(1e9); view.pan(1, 1, 0); }
  assert.ok(view.camera.target.every(Number.isFinite));
  const point = view.project([0, 0, 0], 800, 600); assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});

test("focus frames all reference points in a narrow viewport", () => {
  const bytes = fixtureBytes(), view = new ViewState(createReferenceSnapshot(new BlueprintDocument(bytes), positionEvidence(bytes)));
  view.focusAll(300 / 700);
  for (const row of view.records) {
    const point = view.project(row.position, 300, 700);
    assert.ok(point.x >= 0 && point.x <= 300 && point.y >= 0 && point.y <= 700);
  }
});
