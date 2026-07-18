"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.doesNotMatch(serverSource, /Â·|â€¦|â€”|â€“|â†’|Ã—|âŒ„|â—|â—†|â—‡|âœ¦|â˜¼|âœ“/, "Suite source contains mojibake text");

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
    assert(html.includes("loadSharedPlayerDirectory"), "Shared browser player directory is missing.");
    assert(html.includes("PLAYER_DIRECTORY_REQUEST_TIMEOUT_MS=35000"), "Shared player request deadline is not aligned with backend work.");
    assert(html.includes("keeping the last confirmed directory"), "Player refresh failures do not preserve confirmed player data.");
    assert(!html.includes('getJson("/api/admin/players?limit=200&hydration=0",{timeoutMs:12000})'), "A legacy 12-second player loader remains in the UI.");
    assert(serverSource.includes("createPlayerDirectory"), "Backend player directory cache is missing.");
    assert(serverSource.includes("adminPlayerSchemaColumns"), "Player schema metadata is not cached.");
    assert(serverSource.includes("canonicalPlayerSchemaSupported"), "Canonical player lookup failures can still fall through to compatibility table scans.");
    assert(serverSource.includes("parsePlayerSelector(query)"), "Typed player selectors are missing from backend lookup.");
    assert(html.includes('return"controller:"+p.player_controller_id'), "Progression detected players still submit ambiguous numeric identifiers.");
    assert(html.includes('getJson("/api/progression/player?query="+encodeURIComponent(query),{timeoutMs:60000})'), "Detailed progression lookup deadline is shorter than its enrichment phases.");
    assert(!html.includes(">Rotate Left</button>") && !html.includes(">Tilt Up</button>") && !html.includes(">Zoom In</button>"), "Blueprint viewer still exposes camera-control buttons.");
    assert(html.includes("Drag to rotate and tilt"), "Blueprint viewer is missing its mouse-control guidance.");
    assert(html.includes("camera.attachControl(canvas,true)"), "Blueprint viewer is not using the renderer's native mouse camera input.");
    assert(html.includes("camera.inputs.attached.pointers.buttons=[0,1,2]"), "Blueprint viewer does not accept all mouse buttons.");
    assert(html.includes('addEventListener("dblclick",reset)'), "Blueprint viewer is missing mouse-based reset.");
    assert(html.includes('addEventListener("wheel",containWheel,{passive:false})'), "Blueprint viewer wheel input can still scroll the Suite page.");
    assert(html.includes('containedEvents=["pointerdown","pointermove","pointerup","pointercancel","click","auxclick"]'), "Blueprint viewer mouse events are not contained inside the canvas.");
    assert(html.includes("node.scaling.set(x,y,z)"), "Blueprint viewer does not replace the imported root scale.");
    assert(!html.includes("baseScale=root.scaling.clone()"), "Blueprint viewer still preserves the loader mirror that flips asymmetric pieces.");
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
