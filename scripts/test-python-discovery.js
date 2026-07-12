const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function requirePattern(pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

requirePattern(/LOCALAPPDATA[\s\S]*?Programs[\s\S]*?Python/, "Per-user Python install root is not searched.");
requirePattern(/\^Python\\d\+\$/i, "Versioned Python install directories are not recognized.");
requirePattern(/installedPythonCandidates\(\)[\s\S]*?commandAvailable\(command\)/, "Discovered Python executables are not validated.");

console.log("Python discovery regression checks passed.");
