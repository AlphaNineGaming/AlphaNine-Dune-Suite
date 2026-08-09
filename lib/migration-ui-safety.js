"use strict";

// This function is deliberately dependency-free because server.js serializes it
// into both migration pages. Keep all destructive authorization state in memory;
// browser storage and restored form values must never authorize cleanup.
function installMigrationUiSafety(options = {}) {
  const documentRef = options.document || globalThis.document;
  const windowRef = options.window || globalThis.window;
  const ids = options.ids || {};
  const byId = (name) => documentRef?.getElementById(ids[name] || "") || null;
  const state = {
    offlineLoaded: false,
    offlineHealthy: false,
    offline: null,
    previewSelection: "",
    loader: null,
    renderOffline: null,
    started: false
  };

  function selection() {
    return {
      deleteBotListings: byId("deleteBot")?.checked === true,
      deletePlayerListings: byId("deletePlayer")?.checked === true,
      deleteLegacyNpcListings: byId("deleteLegacyNpc")?.checked === true
    };
  }

  function selectionSignature(value = selection()) {
    return `${value.deleteBotListings === true ? "1" : "0"}:${value.deletePlayerListings === true ? "1" : "0"}:${value.deleteLegacyNpcListings === true ? "1" : "0"}`;
  }

  function sync() {
    const active = state.offline?.active === true;
    const failClosed = state.offline?.failClosed === true;
    const enter = byId("enterOffline");
    const exit = byId("exitOffline");
    if (enter) enter.disabled = !state.offlineLoaded || active;
    if (exit) exit.disabled = !state.offlineLoaded || !active || failClosed;
    for (const name of options.enableWhenHealthy || []) {
      const control = byId(name);
      if (control) control.disabled = !state.offlineHealthy;
    }
    if (!state.offlineHealthy) {
      for (const name of options.disableUnlessHealthy || []) {
        const control = byId(name);
        if (control) control.disabled = true;
      }
    }
    const selected = selection();
    const cleanup = byId("cleanup");
    if (cleanup) cleanup.disabled = !(state.offlineHealthy
      && state.previewSelection !== ""
      && state.previewSelection === selectionSignature(selected)
      && (selected.deleteBotListings || selected.deletePlayerListings || selected.deleteLegacyNpcListings));
  }

  function invalidatePreview() {
    const hadPreview = state.previewSelection !== "";
    state.previewSelection = "";
    sync();
    if (hadPreview) options.onPreviewInvalidated?.();
  }

  function resetDestructive() {
    const bot = byId("deleteBot");
    const player = byId("deletePlayer");
    const legacyNpc = byId("deleteLegacyNpc");
    const acknowledgement = byId("acknowledgement");
    const confirmation = byId("confirmation");
    if (bot) bot.checked = false;
    if (player) player.checked = false;
    if (legacyNpc) legacyNpc.checked = false;
    if (acknowledgement) acknowledgement.checked = false;
    if (confirmation) confirmation.value = "";
    invalidatePreview();
  }

  function setOfflineState(value) {
    const generation = String(value?.generation || "");
    const valid = value && typeof value === "object" && !Array.isArray(value)
      && typeof value.active === "boolean" && typeof value.failClosed === "boolean"
      && (value.active === true ? /^[1-9]\d*$/.test(generation) : /^(?:0|[1-9]\d*)$/.test(generation));
    if (!valid) return setOfflineFailure("Offline Mode returned malformed state.");
    const previousIdentity = state.offline && `${state.offline.active}:${state.offline.failClosed}:${state.offline.generation}:${state.offline.digest || ""}`;
    const nextIdentity = `${value.active}:${value.failClosed}:${value.generation}:${value.digest || ""}`;
    state.offlineLoaded = true;
    state.offline = value;
    state.offlineHealthy = value.active === true && value.failClosed !== true;
    if (!state.offlineHealthy || (previousIdentity && previousIdentity !== nextIdentity)) invalidatePreview();
    else sync();
    return value;
  }

  function setOfflineFailure(message = "Offline Mode status could not be loaded.") {
    state.offlineLoaded = false;
    state.offlineHealthy = false;
    state.offline = { active: true, failClosed: true, generation: "unknown", error: String(message) };
    invalidatePreview();
    return state.offline;
  }

  async function reloadOffline() {
    state.offlineLoaded = false;
    state.offlineHealthy = false;
    sync();
    try {
      const value = await state.loader();
      const accepted = setOfflineState(value);
      state.renderOffline?.(accepted);
      return accepted;
    } catch (error) {
      const failure = setOfflineFailure(error?.message || "Offline Mode status could not be loaded.");
      state.renderOffline?.(failure);
      return null;
    }
  }

  function markPreviewSucceeded(expectedSelection) {
    if (!state.offlineHealthy) throw new Error("Healthy authoritative Migration Offline Mode is required before cleanup preview approval.");
    const expected = selectionSignature(expectedSelection);
    if (expected !== selectionSignature()) throw new Error("Empty Market selection changed while preview was running.");
    state.previewSelection = expected;
    sync();
    return canCleanup();
  }

  function canCleanup() {
    const cleanup = byId("cleanup");
    return Boolean(cleanup && cleanup.disabled === false);
  }

  function start(loader, renderOffline) {
    if (state.started) return reloadOffline();
    state.started = true;
    state.loader = loader;
    state.renderOffline = renderOffline;
    for (const name of ["deleteBot", "deletePlayer", "deleteLegacyNpc"]) byId(name)?.addEventListener("change", invalidatePreview);
    windowRef?.addEventListener("pageshow", (event) => {
      resetDestructive();
      if (event?.persisted === true) void reloadOffline();
    });
    resetDestructive();
    return reloadOffline();
  }

  return {
    canCleanup,
    invalidatePreview,
    markPreviewSucceeded,
    reloadOffline,
    resetDestructive,
    selection,
    setOfflineFailure,
    setOfflineState,
    snapshot: () => ({ ...state }),
    start
  };
}

module.exports = { installMigrationUiSafety };
