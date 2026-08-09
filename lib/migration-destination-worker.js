"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WORKER_PROTOCOL_VERSION = 1;
const WORKER_TRANSPORT_VERSION = "destination-durable-worker-v1";
const REMOTE_ROOT = "/var/lib/alphanine/migration-worker";
const REMOTE_WORKER = `${REMOTE_ROOT}/alphanine-migration-worker`;
const REMOTE_SIGNING_PUBLIC_KEY = `${REMOTE_ROOT}/suite-job-signing.pub`;
const SAFE_JOB_ID = /^migration-import-[0-9]{13}-[a-f0-9]{8}$/;
const TERMINAL = new Set(["verified", "failed"]);

class DestinationWorkerError extends Error {
  constructor(message, code = "migration_worker_failed", details = {}) {
    super(message); this.name = "DestinationWorkerError"; this.code = code; this.details = details;
  }
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  throw new DestinationWorkerError("Worker job contains an unsupported value.", "migration_worker_job_schema");
}

function canonicalJson(value) { return `${JSON.stringify(canonical(value))}\n`; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

async function hashFile(filePath) {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  if (!stat.isFile()) throw new DestinationWorkerError("Worker input is not a regular file.", "migration_worker_input");
  const hash = crypto.createHash("sha256"); let size = 0n;
  for await (const chunk of fs.createReadStream(filePath)) { hash.update(chunk); size += BigInt(chunk.length); }
  return { size: size.toString(10), sha256: hash.digest("hex") };
}

function assertDigest(value, label) {
  const digest = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new DestinationWorkerError(`${label} is not a SHA-256 digest.`, "migration_worker_job_schema");
  return digest;
}

function safeLeaf(value, label) {
  const name = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new DestinationWorkerError(`${label} is unsafe.`, "migration_worker_job_schema");
  return name;
}

function exactJobId(value) {
  const jobId = String(value || "");
  if (!SAFE_JOB_ID.test(jobId)) throw new DestinationWorkerError("Migration worker job ID is unsafe.", "migration_worker_job_schema");
  return jobId;
}

function signingPaths(profileDataDir) {
  return { privateKey: path.join(profileDataDir, "migration-worker-signing-private.pem"), publicKey: path.join(profileDataDir, "migration-worker-signing-public.hex") };
}

function atomicWrite(filePath, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = `${filePath}.next-${crypto.randomUUID()}`;
  fs.writeFileSync(next, bytes, { flag: "wx", mode });
  const handle = fs.openSync(next, "r+"); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  try { fs.renameSync(next, filePath); } finally { fs.rmSync(next, { force: true }); }
}

function ensureSigningIdentity(profileDataDir) {
  const files = signingPaths(profileDataDir);
  if (!fs.existsSync(files.privateKey) || !fs.existsSync(files.publicKey)) {
    if (fs.existsSync(files.privateKey) || fs.existsSync(files.publicKey)) throw new DestinationWorkerError("Migration worker signing identity is incomplete.", "migration_worker_signing_identity");
    const keys = crypto.generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicDer = keys.publicKey.export({ type: "spki", format: "der" });
    atomicWrite(files.privateKey, privatePem, 0o600);
    atomicWrite(files.publicKey, `${publicDer.subarray(publicDer.length - 32).toString("hex")}\n`, 0o600);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(files.privateKey));
  const publicHex = fs.readFileSync(files.publicKey, "utf8").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(publicHex)) throw new DestinationWorkerError("Migration worker public signing key is malformed.", "migration_worker_signing_identity");
  const derived = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  if (derived !== publicHex) throw new DestinationWorkerError("Migration worker signing key pair does not match.", "migration_worker_signing_identity");
  return { ...files, privateKey, publicHex, fingerprint: sha256(Buffer.from(publicHex, "hex")) };
}

async function pinnedWorkerIdentity(workerPath, pinPath) {
  const pin = fs.readFileSync(pinPath, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  assertDigest(pin, "Bundled worker pin");
  const identity = await hashFile(workerPath);
  if (identity.sha256 !== pin) throw new DestinationWorkerError("Bundled migration worker does not match its checksum pin.", "migration_worker_pin_mismatch");
  return { path: "alphanine-migration-worker", ...identity };
}

async function prepareSignedJob(options = {}) {
  const jobId = exactJobId(options.jobId);
  const stagingDir = path.resolve(String(options.stagingDir || ""));
  const profileDataDir = path.resolve(String(options.profileDataDir || ""));
  const packagePath = path.resolve(String(options.packagePath || ""));
  const workerPath = path.resolve(String(options.workerPath || ""));
  const workerPinPath = path.resolve(String(options.workerPinPath || ""));
  fs.mkdirSync(stagingDir, { recursive: true });
  const identity = ensureSigningIdentity(profileDataDir);
  const packageIdentity = await hashFile(packagePath);
  if (options.expectedPackageSize && packageIdentity.size !== String(options.expectedPackageSize)) throw new DestinationWorkerError("Migration package size changed.", "migration_worker_package_identity");
  if (options.expectedPackageSha256 && packageIdentity.sha256 !== assertDigest(options.expectedPackageSha256, "Migration package pin")) throw new DestinationWorkerError("Migration package hash changed.", "migration_worker_package_identity");
  const workerIdentity = await pinnedWorkerIdentity(workerPath, workerPinPath);
  const copied = [];
  for (const input of options.inputs || []) {
    const leaf = safeLeaf(input.name, "Worker input name"); const destination = path.join(stagingDir, leaf);
    fs.copyFileSync(path.resolve(input.path), destination, fs.constants.COPYFILE_EXCL);
    copied.push({ path: leaf, ...(await hashFile(destination)) });
  }
  const packageLeaf = "migration-package.a9migration"; const workerLeaf = "alphanine-migration-worker";
  fs.copyFileSync(packagePath, path.join(stagingDir, packageLeaf), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(workerPath, path.join(stagingDir, workerLeaf), fs.constants.COPYFILE_EXCL);
  const descriptor = {
    version: WORKER_PROTOCOL_VERSION, jobId, createdAt: new Date().toISOString(),
    package: { path: packageLeaf, ...packageIdentity }, worker: workerIdentity, inputs: copied,
    destinationCheckpoint: assertDigest(options.destinationCheckpoint, "Destination checkpoint"),
    rollbackCheckpoint: assertDigest(options.rollbackCheckpoint, "Rollback checkpoint"),
    stages: options.stages || [], rollbackStages: options.rollbackStages || [], cleanup: options.cleanup || []
  };
  const jobBytes = Buffer.from(canonicalJson(descriptor), "utf8");
  const signature = crypto.sign(null, jobBytes, identity.privateKey);
  atomicWrite(path.join(stagingDir, "job.json"), jobBytes);
  atomicWrite(path.join(stagingDir, "job.json.sha256"), `${sha256(jobBytes)}\n`);
  atomicWrite(path.join(stagingDir, "job.json.sig"), signature);
  return { jobId, stagingDir, descriptor, signingIdentity: { publicKeyPath: identity.publicKey, fingerprint: identity.fingerprint }, remoteJobDir: `${REMOTE_ROOT}/jobs/${jobId}`, workerIdentity, packageIdentity };
}

function fixedLaunchCommand(jobId) { return ["sudo", REMOTE_WORKER, "launch", `${REMOTE_ROOT}/jobs/${exactJobId(jobId)}`]; }
function fixedStatusCommand(jobId) { return ["sudo", REMOTE_WORKER, "status", `${REMOTE_ROOT}/jobs/${exactJobId(jobId)}`]; }

function parseWorkerState(text, expectedJobId) {
  let value; try { value = JSON.parse(String(text || "")); } catch { throw new DestinationWorkerError("Migration worker returned malformed status JSON.", "migration_worker_status_parse"); }
  if (!value || value.version !== 1 || value.workerVersion !== "migration-worker-v1" || value.jobId !== exactJobId(expectedJobId)) throw new DestinationWorkerError("Migration worker status identity is invalid.", "migration_worker_status_identity");
  if (!new Set(["working", "rollback", "verified", "failed"]).has(value.status)) throw new DestinationWorkerError("Migration worker status is unknown.", "migration_worker_status_schema");
  return { ...value, terminal: TERMINAL.has(value.status) };
}

async function reconnectingPoll(options = {}) {
  const jobId = exactJobId(options.jobId); const intervalMs = Math.max(1000, Math.min(5000, Number(options.intervalMs || 1500)));
  for (;;) {
    try {
      const text = await options.readStatus(fixedStatusCommand(jobId)); const state = parseWorkerState(text, jobId);
      options.onState?.(state); if (state.terminal) return state;
    } catch (error) { options.onDisconnect?.(error); }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = {
  DestinationWorkerError, REMOTE_ROOT, REMOTE_SIGNING_PUBLIC_KEY, REMOTE_WORKER, WORKER_PROTOCOL_VERSION,
  WORKER_TRANSPORT_VERSION, canonicalJson, ensureSigningIdentity, fixedLaunchCommand, fixedStatusCommand, hashFile,
  parseWorkerState, pinnedWorkerIdentity, prepareSignedJob, reconnectingPoll, sha256
};
