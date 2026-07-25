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
  env: { ...process.env, PORT: String(port), ALPHANINE_HTTPS_PORT: String(httpsPort), ALPHANINE_DATA_DIR: dataDir, ALPHANINE_SKIP_MANAGER: "1", ALPHANINE_DISABLE_SERVER_ITEM_DISCOVERY: "1" },
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
    assert(html.includes("Exactly five distinct thresholds"), "Rendered Landsraad policy is missing the exact-five requirement.");
    assert(/id="landsraadTierPreviewButton"[^>]*disabled/.test(html), "Rendered Landsraad preview button is not fail-closed by default.");
    assert(html.includes("landsraadTierState?.ok===true&&landsraadTierState.tiers?.length===5"), "Rendered Landsraad controls are not gated on a valid five-tier inspection.");
    assert(html.includes('id="database-explorer"'), "Rendered Database Explorer is missing.");
    assert(html.includes('id="databaseExplorerGrid"'), "Database Explorer result grid is missing.");
    assert(html.includes('getJson("/api/database-browser/rows"'), "Database Explorer is not wired to its bounded row API.");
    assert(serverSource.includes('"/api/database-browser/"'), "Database Explorer routes are not classified as local-only.");
    assert(serverSource.includes('Database Explorer is available only from the local Suite.'), "Database Explorer routes are missing their loopback guard.");
    assert(serverSource.includes('BEGIN TRANSACTION READ ONLY') || fs.readFileSync(path.join(__dirname, "..", "lib", "database-browser.js"), "utf8").includes('BEGIN TRANSACTION READ ONLY'), "Database Explorer is missing a database-level read-only transaction.");
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
    assert(html.includes("Player Building Blueprints"), "Blueprint management is missing.");
    assert(html.includes("Export Selected") && html.includes("Export All"), "Blueprint batch export controls are missing.");
    assert(!/blueprintViewer|BABYLON|blueprintProcedural|blueprint-piece-catalog|blueprint-viewer-transform/.test(html), "Blueprint visualization code remains in the rendered UI.");
    assert(!html.includes('data-blueprint-action="view"') && !html.includes(">View</button>"), "Blueprint View controls remain in the rendered UI.");
    assert(html.includes('id="adminRawTemplate"'), "Give Item raw template-ID input is missing.");
    assert(html.includes("Discover Server IDs"), "Read-only server item discovery control is missing.");
    assert(!/gaming\.tools|awakening\.wiki/i.test(html), "Rendered Suite UI references a removed item-catalog website.");
    const itemResponse = await fetch(`http://127.0.0.1:${port}/api/item-database/items?q=Maula`);
    const itemData = await itemResponse.json();
    assert.equal(itemData.ok, true, "Offline Item Database endpoint failed.");
    assert.equal(itemData.offlineReady, true, "Item Database is not marked offline-ready.");
    assert(itemData.items.length > 0, "Offline Item Database search returned no items.");
    assert(itemData.items.every((item) => String(item.icon || "").startsWith("/")), "Item Database returned a non-local icon.");
    const codexHtml = await (await fetch(`http://127.0.0.1:${port}/gear-codex/`)).text();
    assert(codexHtml.includes('fetch("/api/gear-codex/items"'), "Gear Codex is not migrated to the local catalog provider.");
    const codexScripts = [...codexHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((match) => !/type=["']application\/json["']/i.test(match[1]))
      .map((match) => match[2])
      .filter((script) => script.trim());
    for (const script of codexScripts) new Function(script);
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
