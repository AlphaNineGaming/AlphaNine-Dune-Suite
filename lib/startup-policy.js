"use strict";

const MIGRATION_STARTUP_SUPPRESSED_FLAG = "--migration-startup-suppressed";

function createStartupPolicy(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const env = options.env || process.env;
  const sideEffectFree = options.sideEffectFree === true
    || env.ALPHANINE_SIDE_EFFECT_FREE_RUNNER === "1"
    || argv.includes("--side-effect-free");
  const maintenanceBootstrap = options.maintenanceBootstrap === true
    || argv.includes("--maintenance-bootstrap");
  const migrationStartupSuppressed = options.migrationStartupSuppressed === true
    || env.ALPHANINE_MIGRATION_STARTUP_SUPPRESSED === "1"
    || argv.includes(MIGRATION_STARTUP_SUPPRESSED_FLAG);
  const legacyStartupSuppressed = env.ALPHANINE_SKIP_STARTUP_SERVICES === "1";
  const startupSuppressed = sideEffectFree || maintenanceBootstrap || migrationStartupSuppressed || legacyStartupSuppressed;

  const selectedModes = [sideEffectFree, maintenanceBootstrap, migrationStartupSuppressed].filter(Boolean).length;
  if (selectedModes > 1) throw new Error("Choose exactly one isolated Suite runner mode.");

  return Object.freeze({
    mode: migrationStartupSuppressed
      ? "migration-startup-suppressed"
      : maintenanceBootstrap
        ? "maintenance-bootstrap"
        : sideEffectFree
          ? "side-effect-free"
          : legacyStartupSuppressed
            ? "legacy-startup-suppressed"
            : "normal",
    sideEffectFree,
    maintenanceBootstrap,
    migrationStartupSuppressed,
    startupSuppressed,
    allowPrimaryBackend: true,
    allowManager: !startupSuppressed && env.ALPHANINE_SKIP_MANAGER !== "1",
    allowAuxiliaryListeners: !startupSuppressed,
    allowInternetTunnelTimer: !startupSuppressed,
    allowStartupAutomation: !startupSuppressed,
    allowBackgroundWriters: !startupSuppressed,
    allowDesktopReceiver: !startupSuppressed,
    allowDesktopEnvironmentMutation: !migrationStartupSuppressed,
    allowDesktopUpdater: !migrationStartupSuppressed,
    allowedListeners: migrationStartupSuppressed ? Object.freeze(["primary-loopback-backend"]) : Object.freeze([])
  });
}

module.exports = { MIGRATION_STARTUP_SUPPRESSED_FLAG, createStartupPolicy };
