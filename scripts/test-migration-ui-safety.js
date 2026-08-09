"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { installMigrationUiSafety } = require("../lib/migration-ui-safety");

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  dispatch(name, event = {}) {
    for (const handler of this.listeners.get(name) || []) handler(event);
  }
}

class FakeElement extends FakeTarget {
  constructor(value = {}) {
    super();
    this.checked = value.checked === true;
    this.value = String(value.value || "");
    this.disabled = value.disabled === true;
  }
}

function fixture(restored = {}) {
  const elements = Object.fromEntries([
    "bot", "player", "legacy", "ack", "confirmation", "cleanup", "preview", "enter", "exit", "preflight"
  ].map((id) => [id, new FakeElement(restored[id] || {})]));
  return {
    elements,
    document: { getElementById: (id) => elements[id] || null },
    window: new FakeTarget(),
    ids: {
      deleteBot: "bot",
      deletePlayer: "player",
      deleteLegacyNpc: "legacy",
      acknowledgement: "ack",
      confirmation: "confirmation",
      cleanup: "cleanup",
      preview: "preview",
      enterOffline: "enter",
      exitOffline: "exit",
      preflight: "preflight"
    }
  };
}

const activeGenerationOne = {
  active: true,
  failClosed: false,
  generation: "1",
  digest: "a".repeat(64),
  banner: "Migration Offline Mode — Automatic Startup and Writers Disabled"
};

async function testRestoredStateAndGenerationRendering() {
  const page = fixture({
    bot: { checked: true },
    player: { checked: true },
    legacy: { checked: true },
    ack: { checked: true },
    confirmation: { value: "EMPTY MARKET FOR MIGRATION" },
    cleanup: { disabled: false },
    preview: { disabled: false },
    enter: { disabled: false },
    preflight: { disabled: false }
  });
  let rendered = null;
  const controller = installMigrationUiSafety({ document: page.document, window: page.window, ids: page.ids, enableWhenHealthy: ["preview", "preflight"] });
  await controller.start(async () => activeGenerationOne, (state) => { rendered = state; });
  assert.equal(page.elements.bot.checked, false, "Browser-restored bot selection must be cleared.");
  assert.equal(page.elements.player.checked, false, "Browser-restored player selection must be cleared.");
  assert.equal(page.elements.legacy.checked, false, "Browser-restored Legacy/Suite NPC selection must be cleared.");
  assert.equal(page.elements.ack.checked, false, "Browser-restored acknowledgement must be cleared.");
  assert.equal(page.elements.confirmation.value, "", "Browser-restored confirmation text must be cleared.");
  assert.equal(page.elements.cleanup.disabled, true, "Cleanup must remain disabled without a current-session preview.");
  assert.equal(page.elements.preview.disabled, false, "Preview may be enabled only after healthy Offline Mode loads.");
  assert.equal(page.elements.preflight.disabled, false, "Preflight may be enabled only after healthy Offline Mode loads.");
  assert.equal(page.elements.enter.disabled, true, "Offline entry must be disabled when generation 1 is already active.");
  assert.equal(rendered.generation, "1", "The authoritative active generation must be rendered, not replaced.");
  assert.equal(controller.snapshot().offlineHealthy, true);
}

async function testPreviewInvalidationAndBackForwardReset() {
  const page = fixture();
  let loads = 0;
  const controller = installMigrationUiSafety({ document: page.document, window: page.window, ids: page.ids, enableWhenHealthy: ["preview"] });
  await controller.start(async () => { loads += 1; return activeGenerationOne; }, () => {});
  page.elements.bot.checked = true;
  const selection = controller.selection();
  controller.markPreviewSucceeded(selection);
  assert.equal(controller.canCleanup(), true, "A fresh successful preview may arm cleanup for its exact selection.");
  page.elements.player.checked = true;
  page.elements.player.dispatch("change");
  assert.equal(controller.canCleanup(), false, "Changing either selection must invalidate the preview.");

  controller.markPreviewSucceeded(controller.selection());
  page.elements.legacy.checked = true;
  page.elements.legacy.dispatch("change");
  assert.equal(controller.canCleanup(), false, "Changing the Legacy/Suite NPC selection must invalidate the preview.");

  controller.markPreviewSucceeded(controller.selection());
  page.elements.ack.checked = true;
  page.elements.confirmation.value = "EMPTY MARKET FOR MIGRATION";
  page.window.dispatch("pageshow", { persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2, "Back/forward restoration must reload authoritative Offline Mode state.");
  assert.equal(page.elements.bot.checked, false);
  assert.equal(page.elements.player.checked, false);
  assert.equal(page.elements.legacy.checked, false);
  assert.equal(page.elements.ack.checked, false);
  assert.equal(page.elements.confirmation.value, "");
  assert.equal(controller.canCleanup(), false, "Back/forward navigation must clear current-session preview approval.");
}

async function testStatusFailureFailsClosed() {
  const page = fixture({ cleanup: { disabled: false }, preview: { disabled: false }, enter: { disabled: false }, preflight: { disabled: false } });
  let rendered = null;
  const controller = installMigrationUiSafety({ document: page.document, window: page.window, ids: page.ids, enableWhenHealthy: ["preview", "preflight"] });
  const loaded = await controller.start(async () => { throw new Error("unavailable"); }, (state) => { rendered = state; });
  assert.equal(loaded, null);
  assert.equal(rendered.failClosed, true);
  assert.equal(rendered.generation, "unknown");
  assert.equal(page.elements.enter.disabled, true, "Status-load failure must not enable Offline entry or create a new generation.");
  assert.equal(page.elements.preview.disabled, true);
  assert.equal(page.elements.preflight.disabled, true);
  assert.equal(page.elements.cleanup.disabled, true);
}

function testEmbeddedPageContracts() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const id of ["migrationDeleteBotListings", "migrationDeletePlayerListings", "migrationDeleteLegacyNpcListings", "migrationEmptyMarketButton", "empty-bot", "empty-player", "empty-legacy-npc", "empty-market"]) assert.doesNotMatch(source, new RegExp(`id=["']${id}["']`), `${id} must not be exposed by read-only source migration v1.`);
  assert.match(source, /migration_source_cleanup_removed/, "Legacy cleanup endpoints must fail closed instead of mutating the source.");
  assert.match(source, /Active listings are handled only on the verified destination during import/);
  assert.match(source, /fetch\('\/api\/migration-offline',\{method:'GET',cache:'no-store'\}\)/, "Startup-suppressed UI must load authoritative Offline Mode state.");
  assert.match(source, /migrationUiSafety\.start\(loadOfflineState,renderOfflineState\)/);
  assert.match(source, /migrationUiSafety\.start\(\(\)=>getJson\("\/api\/migration-offline"/);
  assert.doesNotMatch(source, /if\(name==="server-migration"\)previewMigrationEmptyMarket\(\)/, "Opening the page must not implicitly authorize a cleanup preview.");
  const browserController = fs.readFileSync(path.join(__dirname, "..", "lib", "migration-ui-safety.js"), "utf8");
  assert.doesNotMatch(browserController, /localStorage|sessionStorage|indexedDB/, "Destructive authorization must never be persisted.");
  assert.match(browserController, /addEventListener\("pageshow"/);
  assert.match(browserController, /addEventListener\("change", invalidatePreview\)/);
}

(async () => {
  await testRestoredStateAndGenerationRendering();
  await testPreviewInvalidationAndBackForwardReset();
  await testStatusFailureFailsClosed();
  testEmbeddedPageContracts();
  console.log("Migration UI restored-state reset, authoritative Offline Mode gating, session preview invalidation, and fail-closed tests passed.");
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
