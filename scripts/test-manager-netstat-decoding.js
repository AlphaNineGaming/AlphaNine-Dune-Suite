const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "manager", "manager-server.py"), "utf8");

function requirePattern(pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

requirePattern(/\["netstat\.exe"[\s\S]*?encoding="utf-8"[\s\S]*?errors="replace"/, "netstat output is not decoded safely.");
requirePattern(/\(result\.stdout or ""\)\.splitlines\(\)/, "Missing netstat stdout can still crash manager startup.");

console.log("Manager netstat decoding regression checks passed.");
