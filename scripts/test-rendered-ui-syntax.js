"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const packageManifest = require(path.join(__dirname, "..", "package.json"));
assert.doesNotMatch(serverSource, /Â·|â€¦|â€”|â€“|â†’|Ã—|âŒ„|â—|â—†|â—‡|âœ¦|â˜¼|âœ“|ðŸ/, "Suite source contains mojibake text");
assert.equal(packageManifest.marketBotRuntimeVersion, "1.0.99", "Suite and Market Bot runtime release versions are not pinned to the expected compatibility pair.");
assert(serverSource.includes("expectedVersion: MARKET_BOT_RUNTIME_VERSION"), "Market Bot status is not pinned to its independent runtime version.");
assert(!serverSource.includes("marketBotCatalog(), APP_VERSION"), "A Market Bot runtime path still inherits the Suite UI version.");

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

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert(start >= 0, `Rendered function ${name} is missing.`);
  const bodyStart = source.indexOf("){", start) + 1;
  assert(bodyStart > start, `Rendered function ${name} body is missing.`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Rendered function ${name} is incomplete.`);
}

(async () => {
  try {
    const html = await waitForUi();
    assert(!html.includes('data-view="server-migration"') && !html.includes('id="server-migration"'), "Rendered Suite still exposes Server Migration.");
    assert(!html.includes('id="migrationMaintenanceBanner"') && !html.includes('id="migrationOfflineBanner"'), "Rendered Suite still exposes migration startup-hold banners.");
    assert(html.includes('id="repair"'), "Rendered Repair Inspector is missing.");
    assert(html.includes('id="dashboardSoundToggle" class="sound-toggle" type="button">Sounds OFF</button>'), "Dashboard sound toggle has invalid initial text.");
    assert(html.includes('id="landsraad"'), "Rendered Landsraad tier editor is missing.");
    assert(html.includes('id="marketBotPreviewPanel"') && html.includes('Bot Catalog &amp; Exact Market Preview'), "Rendered Market Bot catalog is not collapsible or clearly labeled.");
    assert(html.includes('id="liveMarketListingsPanel"') && html.includes('id="marketListingsSummary"'), "Rendered Market Automation view is missing live in-game listing tracking.");
    assert(html.includes('id="marketBotExchange"') && html.includes('id="marketBotSaveExchangeButton"'), "Rendered Market Automation view is missing the Bot Listing Exchange selector.");
    assert(html.includes("Exactly five distinct thresholds"), "Rendered Landsraad policy is missing the exact-five requirement.");
    assert(/id="landsraadTierPreviewButton"[^>]*disabled/.test(html), "Rendered Landsraad preview button is not fail-closed by default.");
    assert(/id="landsraadTierConfirmText"[^>]*disabled/.test(html), "Rendered Landsraad confirmation input is not fail-closed by default.");
    assert(html.includes("button:disabled") && html.includes("input:disabled") && html.includes("cursor:not-allowed"), "Disabled Landsraad controls are not visibly distinguished.");
    assert(html.includes("landsraadTierState?.ok===true&&landsraadTierState.tiers?.length===5"), "Rendered Landsraad controls are not gated on a valid five-tier inspection.");
    assert(html.includes('id="landsraadTierAdvancedDetails"'), "Rendered Landsraad advanced diagnostics are missing.");
    assert(html.includes("[d?.reason,d?.error,d?.message]"), "API error formatting does not prefer a structured reason.");
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
    assert(html.includes('getJson("/api/server-update/check"+(force?"?force=1":""),{timeoutMs:120000})'), "Server Updater check does not keep its UI deadline beyond bounded backend work.");
    assert(html.includes('getJson("/api/server-update/start",{method:"POST",timeoutMs:30000})'), "Server Updater start request is missing its explicit UI deadline.");
    assert(html.includes("serverUpdateDiagnosticText"), "Server Updater failure diagnostics are missing from the rendered UI.");
    assert(html.includes("Nested server-management timeout:"), "Server Updater does not expose a nested command timeout.");
    assert(serverSource.includes("runServerUpdateLifecycle"), "Server Updater is missing guaranteed busy-state cleanup.");
    assert(serverSource.includes("createServerUpdateCheckCoordinator"), "Server Updater status refresh is missing failure-aware cache coordination.");
    assert(serverSource.includes("serverManagementTimeoutMs(action)"), "Server management actions are not using operation-specific backend timeouts.");
    assert(html.includes('getJson("/api/action/start",{method:"POST",timeoutMs:960000})'), "Give Item server start can still let the browser fail before the backend start deadline.");
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
    assert(html.includes('id="adminSetDurability200"'), "Shared desktop/web Give Item UI is missing Set Durability to 200.");
    assert(html.includes('id="giveDurabilityStatus"'), "Shared desktop/web Give Item UI is missing durability applicability preview.");
    assert(html.includes('id="giveItemReceiptStatus"'), "Shared desktop/web Give Item UI is missing player-inventory receipt evidence.");
    assert(html.includes("admin-item-selected-mark"), "Give Item selected-item marker is missing.");
    assert(html.includes(`aria-pressed="'+(active?'true':'false')+'"`), "Give Item selection does not expose its pressed state.");
    assert(html.includes("#adminItems .admin-item.active"), "Give Item selected-row highlight styling is missing.");
    assert(html.includes("body.theme-royal #adminItems .admin-item.active"), "Royal Desert is missing its high-contrast Give Item selected-row style.");
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
    const suiteScript = scripts.join("\n");
    const statusPollSource = extractFunction(suiteScript, "refreshStatusPoll");
    assert(!statusPollSource.includes("Title not found"), "Dashboard still renders the misleading missing-title placeholder.");
    assert(statusPollSource.includes('+"\\nServer: "+'), "Dashboard status summary is missing its line break.");
    assert(!statusPollSource.includes('+"\\\\nServer: "+'), "Dashboard status summary renders a literal \\n sequence.");
    const getJsonForTest = new Function("fetch", "AbortController", "setTimeout", "clearTimeout", "location", "window", `
      function csrfCookie(){return "";}
      ${extractFunction(suiteScript, "getJson")}
      return getJson;
    `)(
      async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          ok: false,
          status: "invalid_tier_count",
          reason: "structured Landsraad reason",
          detectedThresholds: [35, 350, 700, 1050, 1400, 3500, 7000, 10500, 14000]
        })
      }),
      AbortController,
      setTimeout,
      clearTimeout,
      { protocol: "http:", href: "" },
      { prompt: () => null }
    );
    let structuredError = null;
    try {
      await getJsonForTest("/api/landsraad/tiers", { timeoutMs: 1000 });
    } catch (error) {
      structuredError = error;
    }
    assert(structuredError, "Rendered request helper accepted an invalid Landsraad response.");
    assert.equal(structuredError.message, "structured Landsraad reason", "Rendered request helper did not extract the API reason.");
    assert.equal(structuredError.apiResponse?.status, "invalid_tier_count", "Rendered request helper did not retain structured diagnostics.");
    assert.doesNotMatch(structuredError.message, /\[object Object\]|\{"?ok"?\s*:/, "Rendered request helper leaked raw JSON into the error message.");
    const elements = Object.fromEntries([
      "landsraadTierStatus",
      "landsraadTierRows",
      "landsraadTierPreviewLog",
      "landsraadTierConfirmText",
      "landsraadTierPreviewButton",
      "landsraadTierApplyButton",
      "landsraadTierAdvancedDetails",
      "landsraadTierDetectedThresholds"
    ].map((id) => [id, { id, textContent: "", innerHTML: "", value: "", disabled: false, hidden: false, open: false, className: "" }]));
    const documentStub = { getElementById: (id) => elements[id] || null };
    const landsraadHarness = new Function("document", `
      let landsraadTierState=null,landsraadTierPreviewState={previewId:"stale-preview"};
      function getValue(id){return document.getElementById(id)?.value||"";}
      function setValue(id,value){const element=document.getElementById(id);if(element)element.value=String(value);}
      function setText(id,value){const element=document.getElementById(id);if(element)element.textContent=String(value);}
      function esc(value){return String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));}
      ${extractFunction(suiteScript, "betterError")}
      ${extractFunction(suiteScript, "syncLandsraadTierApplyButton")}
      ${extractFunction(suiteScript, "renderLandsraadTiers")}
      return {render:renderLandsraadTiers,preview:()=>landsraadTierPreviewState};
    `)(documentStub);
    landsraadHarness.render({
      ok: false,
      status: "invalid_tier_count",
      termId: "42",
      detectedTierCount: 9,
      detectedThresholds: [35, 350, 700, 1050, 1400, 3500, 7000, 10500, 14000],
      tiers: [],
      reason: "raw API reason that must not be repeated",
      raw: { shouldNeverRender: true }
    });
    const expectedWarning = "Current Landsraad term 42 has 9 distinct reward thresholds; exactly 5 are required. Historical terms were ignored and no data was changed.";
    assert.equal(elements.landsraadTierStatus.textContent, expectedWarning, "Invalid current-term Landsraad response did not render the single clean warning.");
    assert.equal(landsraadHarness.preview(), null, "Invalid tier detection did not clear stale preview state.");
    assert.equal(elements.landsraadTierAdvancedDetails.hidden, false, "Invalid current-term thresholds are not available under Advanced Details.");
    assert.match(elements.landsraadTierDetectedThresholds.innerHTML, /<code>35<\/code>[\s\S]*<code>14,000<\/code>/, "Advanced Details does not show a readable threshold list.");
    assert.equal(elements.landsraadTierPreviewButton.disabled, true, "Generate Preview + Backup remains enabled for an invalid current-term configuration.");
    assert.equal(elements.landsraadTierConfirmText.disabled, true, "Landsraad confirmation remains enabled for an invalid current-term configuration.");
    assert.equal(elements.landsraadTierApplyButton.disabled, true, "Apply Tier Changes remains enabled for an invalid current-term configuration.");
    const renderedFailureText = [
      elements.landsraadTierStatus.textContent,
      elements.landsraadTierRows.innerHTML,
      elements.landsraadTierPreviewLog.textContent,
      elements.landsraadTierDetectedThresholds.innerHTML
    ].join("\n");
    assert.equal(renderedFailureText.split(expectedWarning).length - 1, 1, "The Landsraad warning is rendered more than once.");
    assert.doesNotMatch(renderedFailureText, /\[object Object\]|\{"?ok"?\s*:|"?status"?\s*:\s*"?invalid_tier_count"?|shouldNeverRender/, "Rendered Landsraad failure leaks an object or raw JSON response.");
    assert(!extractFunction(suiteScript, "renderLandsraadTiers").includes("JSON.stringify"), "Landsraad failure rendering stringifies API data.");
    console.log("Rendered Suite UI, Server Updater diagnostics, Repair Inspector, and Landsraad editor JavaScript syntax passed.");
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
