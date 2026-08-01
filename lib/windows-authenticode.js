"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");

function inspectAuthenticode(filePath) {
  if (process.platform !== "win32") throw new Error("Windows Authenticode verification is available only on Windows.");
  if (!fs.existsSync(filePath)) throw new Error(`Signature target is missing: ${filePath}`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:ALPHANINE_SIGNATURE_TARGET",
    "[pscustomobject]@{Status=[string]$signature.Status;StatusMessage=[string]$signature.StatusMessage;Subject=[string]$signature.SignerCertificate.Subject;Thumbprint=[string]$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, ALPHANINE_SIGNATURE_TARGET: filePath }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Authenticode inspection failed for ${filePath}`);
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Authenticode inspection returned an invalid response for ${filePath}.`);
  }
}

function verifyTrustedAuthenticode(filePath) {
  const signature = inspectAuthenticode(filePath);
  if (signature.Status !== "Valid" || !signature.Subject || !signature.Thumbprint) {
    throw new Error(`Update publisher verification failed: Windows reported ${signature.Status || "Unknown"}. The installer will not be launched.`);
  }
  return signature;
}

module.exports = { inspectAuthenticode, verifyTrustedAuthenticode };
