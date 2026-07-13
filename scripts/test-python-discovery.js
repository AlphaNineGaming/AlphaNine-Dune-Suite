const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function requirePattern(pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

requirePattern(/LOCALAPPDATA[\s\S]*?Programs[\s\S]*?Python/, "Per-user Python install root is not searched.");
requirePattern(/\^Python\\d\+\$/i, "Versioned Python install directories are not recognized.");
requirePattern(/installedPythonCandidates\(\)[\s\S]*?commandAvailable\(command\)/, "Discovered Python executables are not validated.");
requirePattern(/async function waitForManagerReady[\s\S]*?MANAGER_PORT[\s\S]*?setTimeout/, "Manager startup does not wait for the Python service to become ready.");
requirePattern(/stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/, "Manager startup output is not captured for diagnostics.");
requirePattern(/Manager service exited before becoming ready/, "Early Python process exits do not report their actual error.");
requirePattern(/await waitForManagerReady\(\)/, "Manager requests can still race the Python startup process.");
requirePattern(/const spawnCommand = useShell \? `"\$\{String\(resolved\.command\)/, "WindowsApps shell fallback does not quote executable paths.");

const quotedNode = spawnSync(`"${process.execPath}"`, ["--version"], {
  shell: true,
  windowsHide: true,
  encoding: "utf8"
});
if (quotedNode.status !== 0) {
  throw new Error(`Quoted shell executable regression failed: ${quotedNode.stderr || quotedNode.error || "unknown error"}`);
}

console.log("Python discovery regression checks passed.");
