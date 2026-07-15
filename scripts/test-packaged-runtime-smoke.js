"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const asar = require("@electron/asar");

const root = path.join(__dirname, "..");
const outputDir = process.env.ALPHANINE_BUILD_OUTPUT_DIR || path.join(root, "installer-output");
const archive = path.join(outputDir, "win-unpacked", "resources", "app.asar");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-packaged-smoke-"));
const extracted = path.join(scratch, "app");
const dataDir = path.join(scratch, "data");
const port = 19080 + Math.floor(Math.random() * 400);
const httpsPort = port + 500;

if (!fs.existsSync(archive)) throw new Error(`Packaged archive was not found: ${archive}`);
asar.extractAll(archive, extracted);

const child = spawn(process.execPath, [path.join(extracted, "server.js")], {
  cwd: extracted,
  env: {
    ...process.env,
    PORT: String(port),
    ALPHANINE_HTTPS_PORT: String(httpsPort),
    ALPHANINE_DATA_DIR: dataDir,
    ALPHANINE_SKIP_MANAGER: "1",
    ALPHANINE_SKIP_STARTUP_SERVICES: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitForUi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited with ${child.exitCode}.\n${stdout}\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.text();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Packaged Suite UI did not become reachable.\n${stdout}\n${stderr}`);
}

(async () => {
  try {
    const html = await waitForUi();
    assert(html.includes("loadSharedPlayerDirectory"), "Packaged UI is missing the shared player directory.");
    assert(html.includes("keeping the last confirmed directory"), "Packaged UI is missing stale player preservation.");
    const packagedVersion = JSON.parse(fs.readFileSync(path.join(extracted, "package.json"), "utf8")).version;
    console.log(`Packaged Suite smoke test passed on isolated port ${port}; version ${packagedVersion}.`);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
