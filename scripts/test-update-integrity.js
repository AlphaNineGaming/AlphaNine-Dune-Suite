"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MAX_UPDATE_BYTES,
  normalizeSha256Digest,
  normalizeExpectedSize,
  updateVerificationMetadata,
  verifyUpdateFile
} = require("../lib/update-integrity");
const { inspectAuthenticode, verifyTrustedAuthenticode } = require("../lib/windows-authenticode");

async function main() {
  assert.equal(normalizeSha256Digest(`SHA256:${"A".repeat(64)}`), `sha256:${"a".repeat(64)}`);
  assert.equal(normalizeSha256Digest("sha256:not-a-digest"), "");
  assert.equal(normalizeExpectedSize(137132110), 137132110);
  assert.equal(normalizeExpectedSize(0), 0);
  assert.equal(normalizeExpectedSize(MAX_UPDATE_BYTES + 1), 0);
  assert.throws(() => updateVerificationMetadata({ digest: "", size: 10 }), /SHA-256 digest/);
  assert.throws(() => updateVerificationMetadata({ digest: `sha256:${"0".repeat(64)}`, size: 0 }), /expected file size/);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-update-integrity-"));
  const installer = path.join(scratch, "AlphaNine-Dune-Suite-Setup-test.exe");
  const payload = Buffer.from("verified release payload\n", "utf8");
  fs.writeFileSync(installer, payload);
  const digest = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;

  try {
    assert.deepEqual(await verifyUpdateFile(installer, { digest, size: payload.length }), {
      digest,
      size: payload.length
    });
    await assert.rejects(
      verifyUpdateFile(installer, { digest: `sha256:${"0".repeat(64)}`, size: payload.length }),
      /SHA-256 verification failed/
    );
    await assert.rejects(
      verifyUpdateFile(installer, { digest, size: payload.length + 1 }),
      /size verification failed/
    );
    if (process.platform === "win32") {
      const unsigned = inspectAuthenticode(installer);
      assert.notEqual(unsigned.Status, "Valid");
      assert.throws(() => verifyTrustedAuthenticode(installer), /publisher verification failed/);
      const trustedWindowsBinary = path.join(process.env.WINDIR || "C:\\Windows", "System32", "notepad.exe");
      const trusted = verifyTrustedAuthenticode(trustedWindowsBinary);
      assert.equal(trusted.Status, "Valid");
      assert.ok(trusted.Subject);
      assert.ok(trusted.Thumbprint);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const root = path.join(__dirname, "..");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const desktopSource = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(serverSource, /digest:\s*normalizeSha256Digest\(installerAsset\.digest\)/);
  assert.match(serverSource, /asset\?\.downloadUrl&&asset\?\.digest&&asset\?\.size/);
  assert.match(desktopSource, /await verifyUpdateFile\(downloaded\.path, verification\)/);
  assert.doesNotMatch(desktopSource, /verifyTrustedAuthenticode\(downloaded\.path\)/);
  assert.match(desktopSource, /Self update verified against GitHub release metadata: .*Launching installer/);
  assert.match(desktopSource, /fs\.rmSync\(destination, \{ force: true \}\)/);
  if (packageJson.scripts?.["build:release:win"]) {
    assert.match(packageJson.scripts["build:release:win"], /npm run build:win/);
    assert.match(packageJson.scripts["build:release:win"], /npm run test:packaged/);
  }

  console.log("Self-update SHA-256 and size verification tests passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
