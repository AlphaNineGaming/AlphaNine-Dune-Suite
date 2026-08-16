"use strict";

const assert = require("assert/strict");
const {
  evaluateReadOnlySafetyGates,
  parseBattlegroupStatus,
  validateMarketBotInfrastructureEvidence,
  validateMarketBotStopCompletion
} = require("../lib/migration-preflight");
const {
  assertMigrationRollbackOfflineCheckpoint,
  assertStableStructuredMigrationOfflineSamples,
  buildMigrationRollbackOfflineCheckpoint,
  classifyStructuredMigrationOfflineSample,
  parseJsonResult
} = require("../lib/server-migration");

const successfulBattlegroupOutput = `
Battlegroup: production-fixture
PHASE=Stopped SERVERGROUP=Stopped GATEWAY=Suspended DIRECTOR=Suspended
Game Servers
Map Phase Ready Players Age
`;

const successfulKubernetesOutput = {
  apiVersion: "v1",
  items: [
    { metadata: { name: "database-fixture" }, status: { phase: "Running" }, spec: { containers: [{ name: "postgres", image: "postgres:17.4" }] } },
    { metadata: { name: "controller-fixture" }, status: { phase: "Running" }, spec: { containers: [{ name: "controller", image: "vendor/controller:fixture" }] } },
    { metadata: { name: "stopped-game-fixture" }, status: { phase: "Succeeded" }, spec: { containers: [{ name: "game", image: "registry/seabass-server:2051294-0-shipping" }] } }
  ]
};

function stoppedMarketBot(overrides = {}) {
  return {
    version: 3,
    serviceManager: "openrc",
    serviceState: "stopped",
    serviceInstalled: true,
    runtimeInstalled: true,
    serviceAuthoritative: true,
    statusExit: "3",
    pidFilePresent: false,
    matchingProcessCount: "0",
    supervisorProcessCount: "0",
    defaultRunlevelRegistered: false,
    restartPathActive: false,
    ...overrides
  };
}

function successfulInput() {
  return {
    battlegroup: { ok: true, stdout: successfulBattlegroupOutput },
    kubernetes: { ok: true, value: successfulKubernetesOutput },
    postgresql: { ok: true, value: { reachable: true, database: "dune" } },
    marketBot: { ok: true, value: stoppedMarketBot() }
  };
}

function testSuccessfulSanitizedSshShape() {
  const parsed = parseBattlegroupStatus(successfulBattlegroupOutput);
  assert.equal(parsed.summary.phase, "Stopped");
  assert.equal(parsed.summary.gateway, "Suspended");
  assert.equal(parsed.summary.director, "Suspended");
  const result = evaluateReadOnlySafetyGates(successfulInput());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.fromEntries(Object.entries(result.gates).map(([key, value]) => [key, value.ok])), {
    battlegroup: true, controllers: true, workloads: true, postgresql: true, marketBot: true
  });
}

function testTabularStatusShape() {
  const parsed = parseBattlegroupStatus("Status ServerGroup Database Gateway Director Uptime\nStopped Stopped Healthy Suspended Suspended 2h\n");
  assert.deepEqual(parsed.summary, {
    status: "Stopped", phase: "Stopped", servergroup: "Stopped", database: "Healthy",
    gateway: "Suspended", director: "Suspended", uptime: "2h"
  });
}

function testGateIndependence() {
  const malformedBattlegroup = successfulInput();
  malformedBattlegroup.battlegroup.stdout = "successful transport but incompatible output";
  const first = evaluateReadOnlySafetyGates(malformedBattlegroup);
  assert.equal(first.gates.battlegroup.ok, false);
  assert.equal(first.gates.controllers.ok, false);
  assert.equal(first.gates.workloads.ok, true);
  assert.equal(first.gates.postgresql.ok, true, "PostgreSQL classification must survive battlegroup parser failure");
  assert.equal(first.gates.marketBot.ok, true, "Market Bot classification must survive battlegroup parser failure");

  const badPostgres = successfulInput();
  badPostgres.postgresql.value = { reachable: false, database: "dune" };
  const second = evaluateReadOnlySafetyGates(badPostgres);
  assert.equal(second.gates.postgresql.ok, false);
  for (const key of ["battlegroup", "controllers", "workloads", "marketBot"]) assert.equal(second.gates[key].ok, true);

  const activeBot = successfulInput();
  activeBot.marketBot.value = stoppedMarketBot({ serviceState: "started", serviceAuthoritative: false, matchingProcessCount: "1", restartPathActive: true });
  const third = evaluateReadOnlySafetyGates(activeBot);
  assert.equal(third.gates.marketBot.ok, false);
  for (const key of ["battlegroup", "controllers", "workloads", "postgresql"]) assert.equal(third.gates[key].ok, true);
}

function testStoppedAndAbsentInfrastructure() {
  assert.equal(validateMarketBotInfrastructureEvidence(stoppedMarketBot()).mode, "service-stopped");
  const absent = stoppedMarketBot({ serviceManager: "none", serviceState: "absent", serviceInstalled: false, runtimeInstalled: false, statusExit: "not-installed" });
  assert.equal(validateMarketBotInfrastructureEvidence(absent, { requireAbsent: true }).mode, "service-absent");
  assert.throws(() => validateMarketBotInfrastructureEvidence({ ...absent, runtimeInstalled: true }, { requireAbsent: true }), /not fully removed/);
  assert.throws(() => validateMarketBotInfrastructureEvidence({ ...stoppedMarketBot(), unknownCritical: true }), /missing or unknown/);
  assert.throws(() => validateMarketBotInfrastructureEvidence(stoppedMarketBot({ defaultRunlevelRegistered: true })), /active or ambiguous/, "registration must fail closed even if a defective producer reports restartPathActive=false");
}

function testAlreadyStoppedWarningRequiresIndependentProof() {
  const result = { code: 0, stdout: "", stderr: "WARNING: alphanine-market-bot is already stopped\n" };
  assert.equal(validateMarketBotStopCompletion(result, stoppedMarketBot()).mode, "service-stopped", "exit-0 informational stderr must be accepted only with a fresh stopped proof");
  assert.throws(() => validateMarketBotStopCompletion({ ...result, code: 1 }, stoppedMarketBot()), /did not exit successfully/);
  assert.throws(() => validateMarketBotStopCompletion(result, stoppedMarketBot({ pidFilePresent: true })), /active or ambiguous/);
  assert.throws(() => validateMarketBotStopCompletion(result, stoppedMarketBot({ matchingProcessCount: "1" })), /active or ambiguous/);
  assert.throws(() => validateMarketBotStopCompletion(result, stoppedMarketBot({ defaultRunlevelRegistered: true, restartPathActive: true })), /active or ambiguous/);

  const serverSource = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /const stopResult = await migrationSshCommand[\s\S]*const evidence = await remoteMarketBotStoppedServiceEvidence\(\)[\s\S]*validateMarketBotStopCompletion\(stopResult, evidence\)/,
    "the supported stop path must independently re-read stopped infrastructure before accepting exit-0 diagnostic stderr");
}

function structuredDestinationFixture(overrides = {}) {
  const battlegroup = {
    apiVersion: "igw.funcom.com/v1",
    kind: "Battlegroup",
    metadata: { namespace: "destination-fixture", name: "destination-fixture" },
    spec: { stop: true },
    status: {
      phase: "Stopped",
      serverGroupPhase: "Stopped",
      utilities: { serverGateway: { phase: "Suspended" }, director: { phase: "Suspended" } }
    }
  };
  const workloads = {
    apiVersion: "v1",
    kind: "List",
    items: [
      { apiVersion: "v1", kind: "Pod", metadata: { name: "database" }, spec: { containers: [{ image: "postgres:17.4" }] }, status: { phase: "Running" } },
      { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "game" }, spec: { replicas: 0, template: { spec: { containers: [{ image: "registry/seabass-server:2051294-0-shipping" }] } } }, status: {} }
    ]
  };
  return { battlegroup, workloads, ...overrides };
}

function testStructuredDestinationOfflineEvidence() {
  const displayOnly = parseBattlegroupStatus("Status Database Gateway Director Uptime\nDestination 2 Ready 0/0 Suspended\nGame Servers\nMap Phase Ready Players Age\n");
  assert.equal(displayOnly.summary.phase, undefined, "The production-shaped display label must not masquerade as an authoritative phase.");
  const target = { namespace: "destination-fixture", name: "destination-fixture" };
  const first = classifyStructuredMigrationOfflineSample(structuredDestinationFixture(), target);
  const second = classifyStructuredMigrationOfflineSample(structuredDestinationFixture(), target);
  assert.equal(first.offline, true);
  assert.equal(first.battlegroupPhase, "stopped");
  assert.deepEqual(first.componentStates, { servergroup: "stopped", gateway: "suspended", director: "suspended" });
  assert.equal(first.runningGamePods, "0");
  assert.equal(first.desiredGameReplicas, "0");
  assert.equal(assertStableStructuredMigrationOfflineSamples([first, second]).offline, true);
  const approvedRollbackCheckpoint = buildMigrationRollbackOfflineCheckpoint(
    assertStableStructuredMigrationOfflineSamples([first, second]),
    target
  );
  assert.equal(approvedRollbackCheckpoint.samples.length, 2);
  assert.equal(assertMigrationRollbackOfflineCheckpoint(approvedRollbackCheckpoint, approvedRollbackCheckpoint).offline, true);
  const approvedDrift = structuredDestinationFixture();
  approvedDrift.battlegroup.status.utilities.director.phase = "Offline";
  const approvedDriftSample = classifyStructuredMigrationOfflineSample(approvedDrift, target);
  const approvedDriftCheckpoint = buildMigrationRollbackOfflineCheckpoint({ ...approvedDriftSample, samples: [approvedDriftSample, approvedDriftSample] }, target);
  assert.throws(() => assertMigrationRollbackOfflineCheckpoint(approvedRollbackCheckpoint, approvedDriftCheckpoint), /does not match the approved import checkpoint/);
  assert.throws(() => buildMigrationRollbackOfflineCheckpoint({ ...first, samples: [first] }, target), /exactly two structured offline samples/);

  const replicaDrift = structuredDestinationFixture();
  replicaDrift.workloads.items.find((item) => item.kind === "StatefulSet").spec.replicas = 1;
  const replicaDriftResult = classifyStructuredMigrationOfflineSample(replicaDrift, target);
  assert.throws(() => buildMigrationRollbackOfflineCheckpoint({ ...replicaDriftResult, samples: [replicaDriftResult, replicaDriftResult] }, target), /zero running game pods and zero desired game replicas/);

  const gatewayStopped = structuredDestinationFixture();
  gatewayStopped.battlegroup.status.utilities.serverGateway.phase = "Stopped";
  const gatewayStoppedResult = classifyStructuredMigrationOfflineSample(gatewayStopped, target);
  assert.equal(gatewayStoppedResult.offline, true, "the shared collector may classify a stopped utility as generally offline");
  assert.throws(() => buildMigrationRollbackOfflineCheckpoint({ ...gatewayStoppedResult, samples: [gatewayStoppedResult, gatewayStoppedResult] }, target), /Suspended or Offline/, "rollback backup uses the narrower approved destination checkpoint");

  const targetDrift = structuredDestinationFixture();
  targetDrift.battlegroup.metadata.name = "different-destination";
  assert.throws(() => classifyStructuredMigrationOfflineSample(targetDrift, target), /conflicts with the selected destination/);

  assert.throws(() => parseJsonResult("{broken", "structured workload"), /could not parse structured workload evidence/);
  const missing = structuredDestinationFixture();
  delete missing.battlegroup.status.utilities.director;
  assert.throws(() => classifyStructuredMigrationOfflineSample(missing, target), /Director status is missing or malformed/);

  const active = structuredDestinationFixture();
  active.workloads.items.push({ apiVersion: "v1", kind: "Pod", metadata: { name: "active-game" }, spec: { containers: [{ image: "registry/seabass-server:2051294-0-shipping" }] }, status: { phase: "Running" } });
  const activeResult = classifyStructuredMigrationOfflineSample(active, target);
  assert.equal(activeResult.offline, false);
  assert.equal(activeResult.runningGamePods, "1");
  assert.throws(() => assertStableStructuredMigrationOfflineSamples([activeResult, activeResult]), /not authoritatively stopped/);

  const changed = classifyStructuredMigrationOfflineSample(structuredDestinationFixture(), target);
  changed.componentStates = { ...changed.componentStates, gateway: "stopped" };
  assert.throws(() => assertStableStructuredMigrationOfflineSamples([first, changed]), /changed between samples/);
  assert.throws(() => classifyStructuredMigrationOfflineSample(structuredDestinationFixture(), { namespace: "wrong", name: "destination-fixture" }), /conflicts with the selected destination/);

  const serverSource = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /kubectl get igwbg -n[\s\S]*-o json/);
  assert.match(serverSource, /kubectl get pods,deployments,statefulsets -n[\s\S]*-o json/);
  assert.match(serverSource, /async function collectMigrationStructuredOfflineEvidence[\s\S]*assertStableStructuredMigrationOfflineSamples/);
  const exportPreflight = serverSource.slice(serverSource.indexOf("async function migrationExportPreflight"), serverSource.indexOf("async function migrationDumpToFile"));
  const importPreflight = serverSource.slice(serverSource.indexOf("async function migrationImportPreflight"), serverSource.indexOf("async function restoreCustomArchive"));
  const rollbackBackupPreflight = serverSource.slice(serverSource.indexOf("async function nativeSafetyBackupPreflight"), serverSource.indexOf("async function matchingPgRestore"));
  assert.match(exportPreflight, /collectMigrationStructuredOfflineEvidence/);
  assert.doesNotMatch(exportPreflight, /battlegroup\("status"\)|parseStatus/);
  assert.match(importPreflight, /migrationStoppedEvidence/);
  assert.doesNotMatch(importPreflight, /battlegroup\("status"\)|parseStatus/);
  assert.match(rollbackBackupPreflight, /collectDatabaseBackupOfflineEvidence/);
  assert.doesNotMatch(rollbackBackupPreflight, /Migration|migration/, "native rollback creation must use the standalone database backup preflight");
  assert.doesNotMatch(rollbackBackupPreflight, /battlegroup\("status"\)|parseStatus|classifyMigrationOfflineStatus/, "migration-triggered native rollback backup must not depend on formatted CLI output");
  assert.match(serverSource, /verifyCheckpoint:\s*\(stage\)\s*=>\s*migrationOfflineMode\.verifyCheckpoint\(job\.offlineCheckpoint, stage\)/, "the migration workflow must inject its checkpoint verifier without coupling backup internals to migration state");
}

testSuccessfulSanitizedSshShape();
testTabularStatusShape();
testGateIndependence();
testStoppedAndAbsentInfrastructure();
testAlreadyStoppedWarningRequiresIndependentProof();
testStructuredDestinationOfflineEvidence();
console.log("Migration read-only parser and independent battlegroup, controller, workload, PostgreSQL, and Market Bot gates passed.");
