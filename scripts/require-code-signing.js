"use strict";

const signingLink = String(process.env.CSC_LINK || "").trim();
const signingName = String(process.env.CSC_NAME || "").trim();

if (!signingLink && !signingName) {
  console.error([
    "A trusted Windows code-signing identity is required for a release build.",
    "Set CSC_LINK (certificate file, URL, or base64 data) and CSC_KEY_PASSWORD,",
    "or set CSC_NAME to a trusted code-signing certificate installed on this machine.",
    "Unsigned installers must be built only with npm run build:win and must not be published."
  ].join("\n"));
  process.exit(1);
}

console.log(`Windows release signing identity configured through ${signingLink ? "CSC_LINK" : "CSC_NAME"}.`);
