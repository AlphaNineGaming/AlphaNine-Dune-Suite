"use strict";
// This entry point deliberately does not import the application backend.
const fs = require("node:fs");
const { createSshProbeTransport, createRemoteLinuxProvider } = require("../lib/providers/remote-linux");
const { sanitizeReport } = require("../lib/providers/report");

async function main(argv) {
  if (argv.length !== 3 || argv[0] !== "--endpoint-file") throw new Error("usage");
  const endpoint = JSON.parse(fs.readFileSync(argv[1], "utf8"));
  if (endpoint.serverType !== "remote-linux") throw new Error("unsupported_provider");
  const provider = createRemoteLinuxProvider({ transport: createSshProbeTransport(endpoint), runtimeRoot: endpoint.runtimeRoot, deployment: endpoint.deployment || {} });
  const report = sanitizeReport(await provider.discover());
  // Refuse to overwrite an existing local file, including an installation config.
  fs.writeFileSync(argv[2], JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (report.environment.os !== "linux") process.exitCode = 2;
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error("Diagnostic failed. Check the explicit endpoint and SSH trust configuration. No raw remote output is included."); process.exitCode = 1; });
module.exports = { main };
