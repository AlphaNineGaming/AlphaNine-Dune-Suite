function applyTeleportRequestMode(requestPayload, { frontendRequestMode = "unspecified", execution = false } = {}) {
  const finalBackendMode = execution === true ? "execute" : "preview";
  requestPayload.dryRun = finalBackendMode === "preview";
  requestPayload.test = finalBackendMode === "preview";
  requestPayload.frontendRequestMode = String(frontendRequestMode || "unspecified").trim().toLowerCase();
  requestPayload.backendRequestMode = finalBackendMode;
  return requestPayload;
}

module.exports = { applyTeleportRequestMode };
