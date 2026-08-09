"use strict";

const assert = require("assert/strict");
const {
  OFFLINE_PROTECTED_POST,
  startupSuppressedRouteDecision
} = require("../lib/migration-startup-suppressed-routes");

const inactive = { active: false, failClosed: false };
const recovery = { active: true, failClosed: true };
const active = { active: true, failClosed: false };

for (const pathname of [
  "/api/server-migration/preflight",
  "/api/server-migration/export",
  "/api/server-migration/import-preflight",
  "/api/server-migration/import"
]) {
  assert(OFFLINE_PROTECTED_POST.has(pathname), `${pathname} is missing from the exact protected mutation surface.`);
  for (const state of [inactive, recovery]) {
    const blocked = startupSuppressedRouteDecision({ pathname, method: "POST", offlineMode: state });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, "migration_offline_required");
  }
  assert.equal(startupSuppressedRouteDecision({ pathname, method: "POST", offlineMode: active }).allowed, true);
}

assert.equal(startupSuppressedRouteDecision({ pathname: "/api/server-migration/vm-ip-reconciliation", method: "GET", offlineMode: inactive }).allowed, true);
assert.equal(startupSuppressedRouteDecision({ pathname: "/api/server-migration/vm-ip-reconciliation", method: "POST", offlineMode: inactive }).code, "migration_offline_required");
assert.equal(startupSuppressedRouteDecision({ pathname: "/api/server-migration/vm-ip-reconciliation", method: "POST", offlineMode: active }).allowed, true);

for (const pathname of [
  "/api/server-migration/preflight-status/job",
  "/api/server-migration/export-status/job",
  "/api/server-migration/import-preflight-status/job",
  "/api/server-migration/import-status/job",
  "/api/server-migration/active-job"
]) assert.equal(startupSuppressedRouteDecision({ pathname, method: "GET", offlineMode: inactive }).allowed, true, `${pathname} must remain available for status/reconnect.`);

const enter = startupSuppressedRouteDecision({ pathname: "/api/migration-offline/enter", method: "POST", offlineMode: inactive });
assert.equal(enter.allowed, true);
assert.equal(enter.requiresOffline, false);

for (const pathname of ["/api/action/start", "/api/market-bot/resume", "/api/server/update", "/api/database/restore"]) {
  for (const state of [inactive, active]) {
    const blocked = startupSuppressedRouteDecision({ pathname, method: "POST", offlineMode: state });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, "migration_startup_suppressed");
  }
}

assert.equal(startupSuppressedRouteDecision({ pathname: "/manager/", method: "GET", offlineMode: active }).status, 403);
console.log("Startup-suppressed Offline Mode route matrix tests passed.");
