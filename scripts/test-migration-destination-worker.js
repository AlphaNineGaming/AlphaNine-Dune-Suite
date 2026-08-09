"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REMOTE_WORKER, WORKER_TRANSPORT_VERSION, ensureSigningIdentity, fixedLaunchCommand, fixedStatusCommand, hashFile, parseWorkerState, prepareSignedJob, reconnectingPoll } = require("../lib/migration-destination-worker");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a9-worker-test-"));
  try {
    const profile = path.join(root, "profile"); const stage = path.join(root, "stage"); fs.mkdirSync(profile); fs.mkdirSync(stage);
    const packagePath = path.join(root, "package.a9migration"); fs.writeFileSync(packagePath, "verified-package");
    const workerPath = path.join(root, "worker"); fs.writeFileSync(workerPath, "worker-binary");
    const workerHash = (await hashFile(workerPath)).sha256; const pinPath = path.join(root, "worker.sha256"); fs.writeFileSync(pinPath, `${workerHash}  worker\n`);
    const inputPath = path.join(root, "verify.sql"); fs.writeFileSync(inputPath, "SELECT 1;\n");
    const jobId = "migration-import-1786150000000-a1b2c3d4"; const digest = crypto.createHash("sha256").update("checkpoint").digest("hex");
    const prepared = await prepareSignedJob({ jobId, stagingDir: stage, profileDataDir: profile, packagePath, workerPath, workerPinPath: pinPath, expectedPackageSize: String(fs.statSync(packagePath).size), expectedPackageSha256: (await hashFile(packagePath)).sha256, destinationCheckpoint: digest, rollbackCheckpoint: digest, inputs: [{ name: "verify.sql", path: inputPath }], stages: [{ name: "verify", detail: "verify", commands: [] }], rollbackStages: [], cleanup: [] });
    assert.equal(prepared.descriptor.version, 1); assert.equal(prepared.descriptor.package.path, "migration-package.a9migration"); assert.equal(prepared.workerIdentity.sha256, workerHash);
    const keys = ensureSigningIdentity(profile); const bytes = fs.readFileSync(path.join(stage, "job.json")); const signature = fs.readFileSync(path.join(stage, "job.json.sig"));
    assert(crypto.verify(null, bytes, crypto.createPublicKey(keys.privateKey), signature));
    assert.equal(fixedLaunchCommand(jobId).join(" "), `sudo ${REMOTE_WORKER} launch /var/lib/alphanine/migration-worker/jobs/${jobId}`); assert.equal(fixedStatusCommand(jobId).length, 4); assert.equal(WORKER_TRANSPORT_VERSION, "destination-durable-worker-v1");
    const base = { version: 1, workerVersion: "migration-worker-v1", jobId, status: "working", stage: "backup", detail: "backup", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), heartbeat: new Date().toISOString(), pid: "123", modificationStarted: false, rollbackAttempted: false, rollbackVerified: false, attempts: [] };
    assert.equal(parseWorkerState(JSON.stringify(base), jobId).terminal, false);
    let calls = 0; const disconnects = [];
    const terminal = await reconnectingPoll({ jobId, intervalMs: 1, readStatus: async () => { calls += 1; if ([1, 3, 5].includes(calls)) throw new Error("simulated SSH disconnect"); if (calls < 7) return JSON.stringify(base); return JSON.stringify({ ...base, status: "verified", stage: "complete" }); }, onDisconnect: (error) => disconnects.push(error.message) });
    assert.equal(terminal.status, "verified"); assert.equal(disconnects.length, 3);
    assert.throws(() => parseWorkerState("{}", jobId), /identity/); assert.throws(() => fixedStatusCommand("bad"), /job ID/);
    fs.appendFileSync(workerPath, "tamper");
    await assert.rejects(() => prepareSignedJob({ jobId, stagingDir: path.join(root, "stage2"), profileDataDir: profile, packagePath, workerPath, workerPinPath: pinPath, destinationCheckpoint: digest, rollbackCheckpoint: digest }), /checksum pin/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log("Migration destination worker orchestration tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
