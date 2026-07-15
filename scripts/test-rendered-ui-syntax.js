"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const port = 18910 + Math.floor(Math.random() * 200);
const httpsPort = port + 500;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-rendered-ui-"));
const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, PORT: String(port), ALPHANINE_HTTPS_PORT: String(httpsPort), ALPHANINE_DATA_DIR: dataDir, ALPHANINE_SKIP_MANAGER: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitForUi() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.text();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Rendered UI did not start. ${stderr}`);
}

(async () => {
  try {
    const html = await waitForUi();
    assert(html.includes('id="repair"'), "Rendered Repair Inspector is missing.");
    assert(html.includes('id="landsraad"'), "Rendered Landsraad tier editor is missing.");
    assert(html.includes("statusRefreshInFlight"), "Server indicator polling is missing its single-flight guard.");
    assert(html.includes("vmMonitorRefreshInFlight"), "VM indicator polling is missing its single-flight guard.");
    assert(serverSource.includes("suiteStatusSnapshotInFlight"), "Backend server status requests are not coalesced.");
    assert(serverSource.includes("vmConnectionMonitorInFlight"), "Backend VM monitor requests are not coalesced.");
    assert(html.includes('getJson("/api/status",{timeoutMs:45000})'), "Server indicator polling deadline is too short.");
    assert(html.includes('getJson("/api/vm-monitor",{timeoutMs:45000})'), "VM indicator polling deadline is too short.");
    assert(html.includes("keeping the last confirmed indicators"), "Transient indicator delays do not preserve the last confirmed state.");
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((script) => script.trim());
    assert(scripts.length, "No inline UI script was rendered.");
    for (const script of scripts) new Function(script);
    console.log("Rendered Suite UI, Repair Inspector, and Landsraad editor JavaScript syntax passed.");
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
