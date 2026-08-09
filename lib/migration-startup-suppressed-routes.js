"use strict";

const ALWAYS_ALLOWED_GET = new Set([
  "/",
  "/api/migration-startup-suppressed",
  "/api/migration-offline",
  "/api/migration-runtime-identity",
  "/api/server-migration/vm-ip-reconciliation",
  "/api/migration-offline/market-bot-reconciliation",
  "/api/server-migration/profile",
  "/api/server-migration/active-job"
]);

const OFFLINE_PROTECTED_POST = new Set([
  "/api/migration-offline/market-bot-evidence-preflight",
  "/api/migration-offline/reconcile-market-bot-evidence",
  "/api/market-bot/deploy-paused-runtime",
  "/api/server-migration/preflight",
  "/api/server-migration/export",
  "/api/server-migration/import-preflight",
  "/api/server-migration/import",
  "/api/server-migration/vm-ip-reconciliation"
]);

const STATUS_PREFIXES = Object.freeze([
  "/api/server-migration/preflight-status/",
  "/api/server-migration/export-status/",
  "/api/server-migration/import-preflight-status/",
  "/api/server-migration/import-status/"
]);

function startupSuppressedRouteDecision({ pathname, method = "GET", offlineMode = {} } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const statusRoute = STATUS_PREFIXES.some((prefix) => String(pathname || "").startsWith(prefix));
  if (!mutating) {
    if (ALWAYS_ALLOWED_GET.has(pathname) || statusRoute) return { allowed: true, statusRoute };
    return {
      allowed: false,
      status: 403,
      code: "migration_startup_suppressed",
      error: "This endpoint is outside the startup-suppressed Server Migration surface."
    };
  }
  if (pathname === "/api/migration-offline/enter") return { allowed: true, requiresOffline: false };
  if (!OFFLINE_PROTECTED_POST.has(pathname)) {
    return {
      allowed: false,
      status: 409,
      code: "migration_startup_suppressed",
      error: "This mutation is outside the startup-suppressed Server Migration surface."
    };
  }
  if (offlineMode.active !== true || offlineMode.failClosed === true) {
    return {
      allowed: false,
      status: 409,
      code: "migration_offline_required",
      error: "Enter healthy durable Migration Offline Mode before migration preflight, export, or import."
    };
  }
  return { allowed: true, requiresOffline: true };
}

module.exports = {
  ALWAYS_ALLOWED_GET,
  OFFLINE_PROTECTED_POST,
  STATUS_PREFIXES,
  startupSuppressedRouteDecision
};
