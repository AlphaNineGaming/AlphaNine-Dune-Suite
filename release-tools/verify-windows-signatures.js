"use strict";

const fs = require("fs");
const path = require("path");
const { verifyTrustedAuthenticode } = require("../lib/windows-authenticode");

if (process.platform !== "win32") throw new Error("Windows Authenticode verification must run on Windows.");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const output = path.join(root, packageJson.build?.directories?.output || "installer-output");
const targets = [
  path.join(output, "win-unpacked", `${packageJson.build?.productName || "AlphaNine Dune Suite"}.exe`),
  path.join(output, `AlphaNine-Dune-Suite-Setup-${packageJson.version}.exe`)
];

for (const target of targets) {
  const signature = verifyTrustedAuthenticode(target);
  console.log(`Valid Authenticode signature: ${path.basename(target)} — ${signature.Subject} (${signature.Thumbprint})`);
}
