const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANAGED_ENV_PATH = String(process.env.ALPHANINE_MANAGED_ENV_PATH || "").trim();
const MANAGED_ENV_LOADED = loadDotEnv(MANAGED_ENV_PATH);
const APP_ENV_LOADED = loadDotEnv(path.join(__dirname, "..", ".env"));
loadDotEnv(path.join(__dirname, "..", ".env.local"));
const ENV_SOURCE = String(process.env.ALPHANINE_RECEIVER_ENV_SOURCE || (MANAGED_ENV_LOADED ? "managed .env" : (APP_ENV_LOADED ? "app .env" : "runtime"))).trim();

const HOST = process.env.DUNE_RECEIVER_HOST || "127.0.0.1";
const PORT = Number(process.env.DUNE_RECEIVER_PORT || 5055);
const TOKEN = String(process.env.DUNE_RECEIVER_TOKEN || "").trim();
const SSH_HOST = String(process.env.DUNE_RECEIVER_SSH_HOST || "").trim();
const SSH_USER = String(process.env.DUNE_RECEIVER_SSH_USER || "dune").trim();
const SSH_KEY = expandEnvPath(process.env.DUNE_RECEIVER_SSH_KEY || "");
const MQ_NAMESPACE = String(process.env.DUNE_RECEIVER_MQ_NAMESPACE || "").trim();
const MQ_POD = String(process.env.DUNE_RECEIVER_MQ_POD || "").trim();
const BG_NAMESPACE = String(process.env.DUNE_RECEIVER_BG_NAMESPACE || "").trim();
const BG_NAME = String(process.env.DUNE_RECEIVER_BG_NAME || "").trim();
const TIMEOUT_MS = Number(process.env.DUNE_RECEIVER_TIMEOUT_MS || 30000);
const LIVE_TELEPORT_ENABLED = /^(true|1|yes)$/i.test(String(process.env.DUNE_RECEIVER_LIVE_TELEPORT_ENABLED || ""));
const TELEPORT_TIMEOUT_MS = Number(process.env.DUNE_RECEIVER_TELEPORT_TIMEOUT_MS || TIMEOUT_MS);

// Static token used by the Dune server-command envelope. This is not a user secret.
const SERVER_COMMAND_AUTH_TOKEN = "Nu6VmPWUMvdPMeB7qErr";

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  const diagnostics = receiverHealthDiagnostics();
  res.status(diagnostics.ok ? 200 : 503).json(diagnostics);
});

app.post("/api/give-item", async (req, res) => handleGiveItem(req, res));
app.post("/give-item", async (req, res) => handleGiveItem(req, res));
app.post("/teleport", async (req, res) => handleTeleport(req, res));
app.post("/api/teleport", async (req, res) => handleTeleport(req, res));
app.post("/api/v1/players/teleport-coords", async (req, res) => handleTeleport(req, res));
app.post("/api/v1/players/teleport-to-player", async (req, res) => handleTeleportToPlayer(req, res));
app.get("/teleport/capabilities", (_req, res) => {
  res.json({
    ok: true,
    teleportSupported: LIVE_TELEPORT_ENABLED,
    dryRunSupported: true,
    commandTypes: ["http-json"],
    liveTeleportEnabled: LIVE_TELEPORT_ENABLED,
    commandTemplateConfigured: true,
    endpoints: ["/teleport", "/api/teleport", "/api/v1/players/teleport-coords", "/api/v1/players/teleport-to-player"],
    onlineCommand: "TeleportToExact",
    offlineDbFunction: "dune.admin_move_offline_player_to_partition"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Dune live give-item receiver listening on http://${HOST}:${PORT}`);
  console.log(`SSH target: ${SSH_USER}@${SSH_HOST || "(missing DUNE_RECEIVER_SSH_HOST)"}`);
  console.log(`MQ pod: ${MQ_NAMESPACE && MQ_POD ? `${MQ_NAMESPACE}/${MQ_POD}` : "auto-detect"}`);
});

function receiverTimingTracker() {
  const started = Date.now();
  const timings = {};
  return {
    timings,
    async step(name, fn) {
      const stepStarted = Date.now();
      try {
        return await fn();
      } finally {
        timings[name] = Date.now() - stepStarted;
      }
    },
    finish() {
      timings.total = Date.now() - started;
      return timings;
    }
  };
}

async function handleGiveItem(req, res) {
  const timer = receiverTimingTracker();
  const context = {
    requestId: "",
    playerId: "",
    resolvedPlayerId: "",
    target: null,
    command: null,
    executedCommand: ""
  };
  try {
    logReceiver("give-item request received", {
      path: req.path,
      remoteAddress: req.socket?.remoteAddress || "",
      contentLength: req.headers["content-length"] || ""
    });
    timer.timings.request_received = 0;
    await timer.step("verify_token", () => verifyToken(req));
    const command = await timer.step("validate_payload", () => validateGiveItem(req.body || {}));
    context.requestId = command.requestId;
    context.playerId = command.playerId;
    logReceiver("give-item player id", {
      requestId: command.requestId,
      playerId: command.playerId
    });
    const originalPlayerId = command.playerId;
    command.playerId = await timer.step("resolve_player_id", () => resolveDunePlayerId(command.playerId));
    context.resolvedPlayerId = command.playerId;
    logReceiver("give-item resolved FLS/Funcom id", {
      requestId: command.requestId,
      originalPlayerId,
      resolvedPlayerId: command.playerId
    });
    const target = await timer.step("resolve_mq_target", () => resolveMqTarget());
    context.target = target;
    logReceiver("give-item detected mq-game pod", {
      requestId: command.requestId,
      namespace: target.namespace,
      pod: target.pod
    });
    context.command = await timer.step("build_command", () => buildAddItemServerCommand(command));
    logReceiver("give-item generated AddItemToInventory command", {
      requestId: command.requestId,
      command: context.command
    });
    context.executedCommand = buildRabbitCommandLog(target);
    const result = await timer.step("rabbitmq_publish", () => publishAddItem(target, command));
    logReceiver("give-item rabbitmqctl command executed", {
      requestId: command.requestId,
      command: result.executedCommand
    });
    logReceiver("give-item publish result", {
      requestId: command.requestId,
      output: result.output || "(no output)"
    });
    res.json({
      ok: true,
      path: "rabbitmqctl-eval",
      requestId: command.requestId,
      target,
      originalPlayerId,
      resolvedPlayerId: command.playerId,
      command: result.command,
      timings: timer.finish()
    });
  } catch (error) {
    const timings = timer.finish();
    logReceiverError("give-item failed", error, context);
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message,
      timings
    });
  }
}

async function handleTeleport(req, res) {
  const context = { requestId: "", playerId: "", command: "", payload: null };
  try {
    const auth = verifyToken(req);
    const request = validateTeleport(req.body || {});
    context.requestId = request.requestId;
    context.playerId = request.flsId;
    context.payload = request;
    const originalFlsId = request.flsId;
    request.flsId = await resolveDunePlayerId(request.flsId);
    if (originalFlsId !== request.flsId) {
      logReceiver("teleport resolved numeric player id to FLS id", {
        requestId: request.requestId,
        originalPlayerId: originalFlsId,
        resolvedFlsId: request.flsId
      });
    }
    const preview = buildTeleportPreview(req.path, request);
    context.command = preview.command;
    logReceiver("teleport request received", {
      path: req.path,
      requestId: request.requestId,
      flsId: request.flsId,
      dryRun: request.dryRun,
      test: request.test,
      frontendRequestMode: request.frontendRequestMode,
      backendRequestMode: request.backendRequestMode,
      finalReceiverMode: request.dryRun || request.test ? "preview" : "execute",
      auth
    });

    if (request.dryRun || request.test) {
      res.json({
        ok: true,
        status: "preview",
        message: "Teleport dry-run preview accepted. No live teleport command was executed.",
        ...preview
      });
      return;
    }

    if (!LIVE_TELEPORT_ENABLED) {
      res.status(409).json({
        ok: false,
        status: "disabled",
        message: "Receiver live teleport is disabled. Set DUNE_RECEIVER_LIVE_TELEPORT_ENABLED=true to allow live teleport.",
        ...preview
      });
      return;
    }

    const result = await processTeleportCoords(request);
    logReceiver("teleport processed", {
      requestId: request.requestId,
      flsId: request.flsId,
      path: result.path,
      command: result.command,
      frontendRequestMode: request.frontendRequestMode,
      backendRequestMode: request.backendRequestMode,
      finalReceiverMode: "execute"
    });
    res.json({
      ok: true,
      status: result.path === "rmq" ? "sent_to_rmq" : "db-updated",
      message: result.message,
      ...preview,
      path: result.path,
      target: result.target,
      command: result.command,
      rmq: result.rmq || undefined,
      warning: request.warning || undefined
    });
  } catch (error) {
    logReceiverError("teleport failed", error, context);
    res.status(error.statusCode || 500).json({
      ok: false,
      status: "failed",
      error: error.message,
      auth: error.auth || undefined,
      diagnostics: error.diagnostics || undefined
    });
  }
}

async function handleTeleportToPlayer(req, res) {
  const context = { requestId: "", playerId: "", command: "", payload: null };
  try {
    const auth = verifyToken(req);
    const request = validateTeleportToPlayer(req.body || {});
    context.requestId = request.requestId;
    context.playerId = request.sourceFlsId;
    context.payload = request;
    const originalSourceFlsId = request.sourceFlsId;
    request.sourceFlsId = await resolveDunePlayerId(request.sourceFlsId);
    if (originalSourceFlsId !== request.sourceFlsId) {
      logReceiver("teleport-to-player resolved numeric player id to FLS id", {
        requestId: request.requestId,
        originalPlayerId: originalSourceFlsId,
        resolvedFlsId: request.sourceFlsId
      });
    }
    logReceiver("teleport-to-player request received", {
      path: req.path,
      requestId: request.requestId,
      sourceFlsId: request.sourceFlsId,
      targetId: request.targetId,
      dryRun: request.dryRun,
      test: request.test,
      auth
    });
    const target = await getPlayerPosition(request.targetId);
    const coordsRequest = {
      flsId: request.sourceFlsId,
      x: target.x,
      y: target.y,
      z: target.z,
      partitionId: target.partitionId,
      requestId: request.requestId,
      dryRun: request.dryRun,
      test: request.test
    };
    const preview = buildTeleportPreview(req.path, coordsRequest);
    context.command = preview.command;

    if (request.dryRun || request.test) {
      res.json({
        ok: true,
        status: "preview",
        message: "Teleport-to-player dry-run preview accepted. No live teleport command was executed.",
        ...preview,
        target
      });
      return;
    }
    if (!LIVE_TELEPORT_ENABLED) {
      res.status(409).json({
        ok: false,
        status: "disabled",
        message: "Receiver live teleport is disabled. Set DUNE_RECEIVER_LIVE_TELEPORT_ENABLED=true to allow live teleport.",
        ...preview,
        target
      });
      return;
    }

    const result = await processTeleportCoords(coordsRequest);
    res.json({
      ok: true,
      status: result.path === "rmq" ? "sent_to_rmq" : "db-updated",
      message: result.message,
      ...preview,
      path: result.path,
      target,
      command: result.command,
      rmq: result.rmq || undefined,
      warning: coordsRequest.warning || undefined
    });
  } catch (error) {
    logReceiverError("teleport-to-player failed", error, context);
    res.status(error.statusCode || 500).json({
      ok: false,
      status: "failed",
      error: error.message,
      auth: error.auth || undefined,
      diagnostics: error.diagnostics || undefined
    });
  }
}

function verifyToken(req) {
  const header = String(req.headers.authorization || "");
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  const receivedToken = String(bearer?.[1] || "").trim();
  const diagnostics = {
    authHeaderPresent: Boolean(header),
    tokenReceived: Boolean(receivedToken),
    tokenMatched: Boolean(TOKEN && receivedToken && receivedToken === TOKEN),
    tokenConfigured: Boolean(TOKEN),
    tokenSource: "DUNE_RECEIVER_TOKEN"
  };
  if (!TOKEN) return diagnostics;
  if (!diagnostics.tokenMatched) {
    const error = new Error("Receiver token is missing or invalid.");
    error.statusCode = 401;
    error.auth = diagnostics;
    throw error;
  }
  return diagnostics;
}

function validateGiveItem(payload) {
  const playerId = String(payload.playerId || "").trim();
  const template = String(payload.template || payload.itemId || "").trim();
  const qty = Number(payload.qty ?? payload.quantity ?? 1);
  const quality = Number(payload.quality ?? 0);
  const requestId = String(payload.requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`).trim();

  if (!playerId || playerId.length > 128 || !/^[A-Za-z0-9_.:+\-#@ ]+$/.test(playerId)) {
    const error = new Error("playerId must be a valid Dune FLS/player id.");
    error.statusCode = 400;
    throw error;
  }
  if (!template || template.length > 180 || !/^[A-Za-z0-9_.:+\-]+$/.test(template)) {
    const error = new Error("template must be a valid Dune item template id.");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > 50000) {
    const error = new Error("qty must be a whole number between 1 and 50000.");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    const error = new Error("quality must be a whole number between 0 and 100.");
    error.statusCode = 400;
    throw error;
  }
  if (quality > 0) {
    const error = new Error("Live RabbitMQ AddItemToInventory does not support item quality/grade. Send quality 0, or use a DB-backed grant receiver for grade-sensitive items.");
    error.statusCode = 422;
    throw error;
  }
  return { playerId, template, qty, quality, requestId };
}

function validateTeleport(payload) {
  const flsId = String(payload.fls_id || payload.flsId || payload.playerId || "").trim();
  const characterName = String(payload.characterName || "").trim();
  const x = Number(payload.x);
  const y = Number(payload.y);
  const zInfo = normalizeTeleportZ(payload);
  const z = zInfo.z;
  const map = String(payload.map || "HaggaBasin").trim();
  const partitionId = Number(payload.partition_id ?? payload.partitionId ?? 0);
  const requestId = String(payload.requestId || `teleport-${Date.now()}-${Math.random().toString(16).slice(2)}`).trim();
  const dryRun = payload.dryRun === true || payload.dryRun === "true" || payload.test === true || payload.test === "true";
  const test = payload.test === true || payload.test === "true";
  const commandMode = String(payload.commandMode || "exact").trim().toLowerCase();
  const playerOnlineStatus = String(payload.playerOnlineStatus || payload.onlineStatus || "unknown").trim().toLowerCase();
  const frontendRequestMode = String(payload.frontendRequestMode || "unspecified").trim().toLowerCase();
  const backendRequestMode = String(payload.backendRequestMode || (dryRun || test ? "preview" : "execute")).trim().toLowerCase();

  if (!flsId || flsId.length > 128 || !/^[A-Za-z0-9_.:+\-#@ ]+$/.test(flsId)) {
    const error = new Error("fls_id must be a valid Dune FLS/player id.");
    error.statusCode = 400;
    throw error;
  }
  if (![x, y, z].every(Number.isFinite)) {
    const error = new Error("x, y, and z must be numeric teleport coordinates.");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(partitionId) || partitionId < 0) {
    const error = new Error("partition_id must be a non-negative number when provided.");
    error.statusCode = 400;
    throw error;
  }
  if (map.length > 80 || !/^[A-Za-z0-9_.:+\-#@ ]*$/.test(map)) {
    const error = new Error("map contains unsupported characters.");
    error.statusCode = 400;
    throw error;
  }
  if (!["exact", "safe-ground"].includes(commandMode)) {
    const error = new Error("commandMode must be exact or safe-ground.");
    error.statusCode = 400;
    throw error;
  }
  return {
    flsId,
    characterName,
    x,
    y,
    z,
    map,
    partitionId: Math.trunc(partitionId),
    requestId,
    dryRun,
    test,
    commandMode,
    playerOnlineStatus,
    frontendRequestMode,
    backendRequestMode,
    warning: zInfo.warning
  };
}

function normalizeTeleportZ(payload) {
  const raw = String(payload.z ?? "").trim();
  const z = Number(raw);
  if (raw !== "" && Number.isFinite(z) && z !== 0) return { z, warning: "" };
  const error = new Error("Teleport Z/elevation is required. Map clicks provide X/Y only; enter a verified Z, choose a location preset, or use teleport-to-player.");
  error.statusCode = 400;
  throw error;
}

function validateTeleportToPlayer(payload) {
  const sourceFlsId = String(payload.source_fls_id || payload.sourceFlsId || payload.fls_id || payload.flsId || payload.playerId || "").trim();
  const targetId = Number(payload.target_id || payload.targetId || payload.targetPlayerId || 0);
  const requestId = String(payload.requestId || `teleport-player-${Date.now()}-${Math.random().toString(16).slice(2)}`).trim();
  const dryRun = payload.dryRun === true || payload.dryRun === "true" || payload.test === true || payload.test === "true";
  const test = payload.test === true || payload.test === "true";
  if (!sourceFlsId || sourceFlsId.length > 128 || !/^[A-Za-z0-9_.:+\-#@ ]+$/.test(sourceFlsId)) {
    const error = new Error("source_fls_id must be a valid Dune FLS/player id.");
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    const error = new Error("target_id must be a valid target actor/player id.");
    error.statusCode = 400;
    throw error;
  }
  return { sourceFlsId, targetId, requestId, dryRun, test };
}

function buildTeleportPreview(pathname, request) {
  const command = buildTeleportServerCommand(request);
  return {
    endpoint: pathname,
    liveTeleportEnabled: LIVE_TELEPORT_ENABLED,
    commandTemplateConfigured: true,
    command,
    payload: {
      fls_id: request.flsId,
      playerId: request.flsId,
      characterName: request.characterName,
      x: request.x,
      y: request.y,
      z: request.z,
      map: request.map,
      partition_id: request.partitionId,
      dryRun: request.dryRun,
      test: request.test,
      frontendRequestMode: request.frontendRequestMode,
      backendRequestMode: request.backendRequestMode,
      finalReceiverMode: request.dryRun || request.test ? "preview" : "execute",
      requestId: request.requestId,
      warning: request.warning
    }
  };
}

async function processTeleportCoords(request) {
  if (isExplicitOfflinePlayerStatus(request.playerOnlineStatus)) {
    logReceiver("teleport routing directly to offline DB", {
      requestId: request.requestId,
      flsId: request.flsId,
      playerOnlineStatus: request.playerOnlineStatus
    });
    const result = await updateOfflinePlayerPosition(request);
    return {
      path: "db",
      message: `Offline player ${request.flsId} position updated for next login.`,
      target: { x: request.x, y: request.y, z: request.z, partition_id: result.partitionId },
      command: result.sql,
      onlineStatusSource: "suite-database"
    };
  }
  let rmqError = null;
  try {
    const result = await publishTeleport(request);
    return {
      path: "rmq",
      message: "Teleport command sent. Verify in game.",
      target: { x: request.x, y: request.y, z: request.z, partition_id: request.partitionId },
      command: result.command,
      output: result.output,
      rmq: result.rmq,
      onlineStatusSource: "rabbitmq"
    };
  } catch (error) {
    rmqError = error;
    logReceiver("teleport rmq path failed; checking offline DB fallback", {
      requestId: request.requestId,
      flsId: request.flsId,
      error: error.message
    });
  }

  let result;
  try {
    result = await updateOfflinePlayerPosition(request);
  } catch (error) {
    error.diagnostics = {
      ...(error.diagnostics || {}),
      rmqError: rmqError?.message || ""
    };
    throw error;
  }
  return {
    path: "db",
    message: `Offline player ${request.flsId} position updated for next login.`,
    target: { x: request.x, y: request.y, z: request.z, partition_id: result.partitionId },
    command: result.sql
  };
}

function isExplicitOfflinePlayerStatus(value) {
  return /^(offline|disconnected|inactive|false|f|0|no)$/i.test(String(value || "").trim());
}

async function publishTeleport(request) {
  const target = await resolveMqTarget();
  const serverCommand = buildTeleportServerCommand(request);
  const erlang = buildRabbitEval(serverCommand, request.requestId);
  const rmq = {
    exchange: "heartbeats",
    routingKey: "notifications",
    targetQueue: "notifications",
    targetNamespace: target.namespace,
    targetPod: target.pod,
    payload: serverCommand,
    envelope: {
      Version: 2,
      AuthToken: "<redacted>",
      MessageContent: JSON.stringify(serverCommand)
    }
  };
  logReceiver("teleport rmq publish", {
    requestId: request.requestId,
    exchange: rmq.exchange,
    routingKey: rmq.routingKey,
    targetQueue: rmq.targetQueue,
    targetNamespace: rmq.targetNamespace,
    targetPod: rmq.targetPod,
    payload: rmq.payload,
    envelope: rmq.envelope
  });
  const remote = [
    "sudo kubectl exec",
    "-n", shQuote(target.namespace),
    shQuote(target.pod),
    "-- rabbitmqctl eval",
    shQuote(erlang)
  ].join(" ");
  const output = await ssh(remote, TELEPORT_TIMEOUT_MS);
  return { command: serverCommand, executedCommand: buildRabbitCommandLog(target), output: output.stdout || output.stderr || "", rmq };
}

async function updateOfflinePlayerPosition(request) {
  const bg = await resolveBattlegroup();
  const schema = await detectOfflineTeleportSchema(bg);
  if (!schema.ok) {
    const error = new Error("Offline teleport DB schema not detected. Online teleport may still work.");
    error.statusCode = 501;
    error.diagnostics = schema;
    throw error;
  }
  const partitionId = request.partitionId || await resolveTeleportPartitionId(bg, request.flsId);
  const sql = [
    "select dune.admin_move_offline_player_to_partition(",
    sqlLiteral(request.flsId),
    ", ",
    String(partitionId),
    ", row(",
    sqlNumber(request.x),
    ", ",
    sqlNumber(request.y),
    ", ",
    sqlNumber(request.z),
    ")::dune.vector)"
  ].join("");
  await runDuneSql(bg, sql);
  return { partitionId, sql: "select dune.admin_move_offline_player_to_partition(<fls_id>, <partition_id>, row(<x>, <y>, <z>)::dune.vector)" };
}

async function detectOfflineTeleportSchema(bg) {
  const candidates = await discoverTeleportDbCandidatesSafe(bg);
  const names = new Set(candidates.map((row) => `${row.schema}.${row.table}`.toLowerCase()));
  const hasDuneAccounts = names.has("dune.accounts");
  const hasDunePlayerState = names.has("dune.player_state");
  const hasMoveFunction = await hasDbRoutine(bg, "admin_move_offline_player_to_partition");
  const ok = hasDuneAccounts && hasDunePlayerState && hasMoveFunction;
  if (!ok) {
    logReceiver("teleport offline DB schema not detected", {
      hasDuneAccounts,
      hasDunePlayerState,
      hasMoveFunction,
      candidates
    });
  }
  return { ok, hasDuneAccounts, hasDunePlayerState, hasMoveFunction, candidates };
}

async function discoverTeleportDbCandidatesSafe(bg) {
  try {
    return await discoverTeleportDbCandidates(bg);
  } catch (error) {
    return [{ schema: "", table: "", columns: "", error: error.message }];
  }
}

async function discoverTeleportDbCandidates(bg) {
  const patterns = ["player", "players", "player_state", "character", "characters", "accounts", "account", "entity", "entities"];
  const likeList = patterns.map((pattern) => `table_name ilike ${sqlLiteral(`%${pattern}%`)}`).join(" or ");
  const sql = `
    select table_schema, table_name, string_agg(column_name, ',' order by ordinal_position)
    from information_schema.columns
    where table_schema not in ('pg_catalog', 'information_schema')
      and (${likeList})
    group by table_schema, table_name
    order by table_schema, table_name
    limit 80
  `;
  const output = await runDuneSql(bg, sql);
  return String(output.stdout || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [schema, table, columns] = line.split("\t");
    return { schema, table, columns };
  });
}

async function hasDbRoutine(bg, routineName) {
  const sql = `
    select exists(
      select 1
      from information_schema.routines
      where routine_schema = 'dune'
        and routine_name = ${sqlLiteral(routineName)}
    )::text
  `;
  const output = await runDuneSql(bg, sql);
  return /^true$/i.test(String(output.stdout || "").trim().split(/\r?\n/).find(Boolean) || "");
}

async function resolveTeleportPartitionId(bg, flsId) {
  const sql = `
    select id::text
    from dune.world_partition
    where blocked = false
    order by id
    limit 1
  `;
  const output = await runDuneSql(bg, sql);
  const id = Number(String(output.stdout || "").trim().split(/\r?\n/).find(Boolean) || 0);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Could not resolve a valid partition for offline teleport.");
  }
  return id;
}

async function getPlayerPosition(targetId) {
  const bg = await resolveBattlegroup();
  const sql = `
    select
      ((a.transform).location).x::text,
      ((a.transform).location).y::text,
      ((a.transform).location).z::text,
      coalesce(a.partition_id, 0)::text
    from dune.actors a
    where a.id = ${String(targetId)}
    limit 1
  `;
  const output = await runDuneSql(bg, sql);
  const line = String(output.stdout || "").trim().split(/\r?\n/).find(Boolean);
  if (!line) {
    const error = new Error(`Target player position not found for actor id ${targetId}.`);
    error.statusCode = 404;
    throw error;
  }
  const [x, y, z, partitionId] = line.split("\t");
  const pos = { x: Number(x), y: Number(y), z: Number(z), partitionId: Number(partitionId || 0) };
  if (![pos.x, pos.y, pos.z].every(Number.isFinite)) {
    throw new Error(`Target player position was not numeric for actor id ${targetId}.`);
  }
  return pos;
}

async function resolveDunePlayerId(playerId) {
  if (!/^\d+$/.test(playerId)) return playerId;
  const id = Number(playerId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Numeric playerId is not a valid Dune account/actor id.");
  const bg = await resolveBattlegroup();
  const sql = `
    select coalesce(ac."user", '')
    from dune.accounts ac
    where ac.id = ${id}
    union all
    select coalesce(ac."user", '')
    from dune.actors a
    join dune.accounts ac on ac.id = a.owner_account_id
    where a.id = ${id}
    limit 1
  `;
  const output = await runDuneSql(bg, sql);
  const flsId = String(output.stdout || "").trim().split(/\r?\n/).find(Boolean);
  if (!flsId) {
    throw new Error(`Could not resolve numeric playerId ${playerId} to the FLS id required by Dune server commands.`);
  }
  return flsId;
}

async function probeReceiver() {
  const config = receiverConfigDiagnostics();
  let detected = { battlegroups: [], selectedBattlegroup: null, error: "" };
  if (config.sshConfigured && config.sshKeyExists) {
    try {
      detected = await Promise.race([
        detectBattlegroups(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Receiver battlegroup detection timed out.")), Math.min(TIMEOUT_MS, 5000)))
      ]);
    } catch (error) {
      detected.error = error.message;
    }
  }
  config.selectedBattlegroup = detected.selectedBattlegroup || config.selectedBattlegroup;
  config.battlegroupsDetected = detected.battlegroups.length;
  config.battlegroups = detected.battlegroups;
  if (detected.selectedBattlegroup) {
    config.battlegroupNamespace = detected.selectedBattlegroup.namespace || "";
    config.battlegroupName = detected.selectedBattlegroup.name || "";
  }
  try {
    let target = null;
    if (config.sshConfigured && config.sshKeyExists) {
      target = await Promise.race([
        resolveMqTarget(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Receiver MQ target probe timed out.")), Math.min(TIMEOUT_MS, 5000)))
      ]);
    }
    return {
      ok: Boolean(TOKEN),
      receiverOnline: true,
      tokenConfigured: Boolean(TOKEN),
      sshHostConfigured: config.sshHostConfigured,
      sshUserConfigured: config.sshUserConfigured,
      sshKeyConfigured: config.sshKeyConfigured,
      envSource: config.envSource,
      sshConfigured: config.sshConfigured,
      sshKeyExists: config.sshKeyExists,
      selectedBattlegroup: config.selectedBattlegroup,
      battlegroupsDetected: config.battlegroupsDetected,
      battlegroupNamespace: config.battlegroupNamespace || "",
      battlegroupName: config.battlegroupName || "",
      mgNamespace: target?.namespace || config.mqNamespace || "",
      mgPod: target?.pod || config.mqPod || "",
      database: { status: config.selectedBattlegroup ? "target-detected" : "unknown" },
      teleport: config.teleport,
      config,
      target,
      warning: !config.sshConfigured ? "SSH key is not configured" : (!config.sshKeyExists ? `SSH key file does not exist: ${SSH_KEY}` : (detected.error || ""))
    };
  } catch (error) {
    return {
      ok: Boolean(TOKEN),
      receiverOnline: true,
      tokenConfigured: Boolean(TOKEN),
      sshHostConfigured: config.sshHostConfigured,
      sshUserConfigured: config.sshUserConfigured,
      sshKeyConfigured: config.sshKeyConfigured,
      envSource: config.envSource,
      sshConfigured: config.sshConfigured,
      sshKeyExists: config.sshKeyExists,
      selectedBattlegroup: config.selectedBattlegroup,
      battlegroupsDetected: config.battlegroupsDetected,
      battlegroupNamespace: config.battlegroupNamespace || "",
      battlegroupName: config.battlegroupName || "",
      mgNamespace: config.mqNamespace || "",
      mgPod: config.mqPod || "",
      database: { status: "unknown" },
      teleport: config.teleport,
      config,
      error: error.message
    };
  }
}

function receiverHealthDiagnostics() {
  const config = receiverConfigDiagnostics();
  return {
    ok: Boolean(TOKEN),
    receiverOnline: true,
    tokenConfigured: config.tokenConfigured,
    sshHostConfigured: config.sshHostConfigured,
    sshUserConfigured: config.sshUserConfigured,
    sshKeyConfigured: config.sshKeyConfigured,
    sshConfigured: config.sshConfigured,
    sshKeyExists: config.sshKeyExists,
    envSource: config.envSource,
    config,
    warning: !config.sshHostConfigured
      ? "SSH host is not configured."
      : (!config.sshKeyConfigured
        ? "SSH key is not configured."
        : (!config.sshKeyExists ? "SSH key file does not exist." : ""))
  };
}

function receiverConfigDiagnostics() {
  const sshConfigured = Boolean(SSH_HOST && SSH_USER && SSH_KEY);
  const sshKeyExists = Boolean(SSH_KEY && fs.existsSync(SSH_KEY));
  const selectedBattlegroup = BG_NAMESPACE && BG_NAME ? { namespace: BG_NAMESPACE, name: BG_NAME } : null;
  return {
    host: HOST,
    port: PORT,
    sshHost: SSH_HOST || "",
    sshUser: SSH_USER || "",
    sshHostConfigured: Boolean(SSH_HOST),
    sshUserConfigured: Boolean(SSH_USER),
    sshConfigured,
    sshKeyConfigured: Boolean(SSH_KEY),
    sshKeyExists,
    sshKeyPath: SSH_KEY ? "<set>" : "",
    tokenConfigured: Boolean(TOKEN),
    envSource: ENV_SOURCE,
    startedBySuite: /^(true|1|yes)$/i.test(String(process.env.ALPHANINE_RECEIVER_STARTED_BY_SUITE || "")),
    mqNamespace: MQ_NAMESPACE || "",
    mqPod: MQ_POD || "",
    battlegroupNamespace: BG_NAMESPACE || "",
    battlegroupName: BG_NAME || "",
    selectedBattlegroup,
    battlegroupsDetected: 0,
    database: { status: selectedBattlegroup ? "target-configured" : "unknown" },
    teleport: {
      dryRunSupported: true,
      teleportSupported: LIVE_TELEPORT_ENABLED,
      liveTeleportEnabled: LIVE_TELEPORT_ENABLED,
      commandTemplateConfigured: true,
      onlineCommand: "TeleportToExact",
      offlineDbFunction: "dune.admin_move_offline_player_to_partition"
    }
  };
}

function battlegroupStatus(item = {}) {
  const status = item.status || {};
  const condition = Array.isArray(status.conditions) ? status.conditions.find((row) => /^(Ready|Healthy|Reconciled)$/i.test(String(row.type || ""))) : null;
  return status.phase || status.status || status.state || (condition && String(condition.status || "").toLowerCase() === "true" ? condition.type : "") || "Unknown";
}

function battlegroupTitle(item = {}) {
  const paths = [
    item.spec?.title,
    item.spec?.serverName,
    item.spec?.name,
    item.spec?.values?.title,
    item.spec?.values?.serverName,
    item.spec?.values?.server?.title,
    item.spec?.values?.server?.name
  ];
  const direct = paths.find((value) => typeof value === "string" && value.trim());
  if (direct) return direct.trim();
  for (const [key, value] of Object.entries(item.metadata?.annotations || {})) {
    if (/title|server[-_.]?name|display[-_.]?name/i.test(key) && String(value || "").trim()) return String(value).trim();
  }
  return "";
}

async function detectBattlegroups() {
  const bgJson = await ssh("sudo kubectl get igwbg -A -o json", Math.min(TIMEOUT_MS, 10000));
  let data;
  try {
    data = JSON.parse(bgJson.stdout || "{}");
  } catch (error) {
    throw new Error(`Could not parse battlegroup resources: ${error.message}`);
  }
  const battlegroups = (data.items || []).map((item) => ({
    namespace: item.metadata?.namespace || "",
    name: item.metadata?.name || "",
    title: battlegroupTitle(item),
    status: battlegroupStatus(item)
  })).filter((item) => item.namespace && item.name);
  const configured = BG_NAMESPACE && BG_NAME ? battlegroups.find((item) => item.namespace === BG_NAMESPACE && item.name === BG_NAME) : null;
  const selectedBattlegroup = configured || (battlegroups.length === 1 ? battlegroups[0] : null);
  return { battlegroups, selectedBattlegroup };
}

async function resolveMqTarget() {
  if (!SSH_HOST) throw new Error("DUNE_RECEIVER_SSH_HOST is required.");
  if (MQ_NAMESPACE && MQ_POD) return { namespace: MQ_NAMESPACE, pod: MQ_POD };

  const podsJson = await ssh("sudo kubectl get pods -A -o json", TIMEOUT_MS);
  let data;
  try {
    data = JSON.parse(podsJson.stdout || "{}");
  } catch (error) {
    throw new Error(`Could not parse kubectl pod list: ${error.message}`);
  }

  const pods = (data.items || []).map((item) => ({
    namespace: item.metadata?.namespace || "",
    pod: item.metadata?.name || "",
    phase: item.status?.phase || ""
  }));
  const candidates = pods.filter((pod) => /mq-game|game.*mq|rabbit.*game/i.test(`${pod.namespace}/${pod.pod}`));
  const running = candidates.find((pod) => pod.phase === "Running") || candidates[0];
  if (!running) {
    throw new Error("Could not find the Dune mq-game RabbitMQ pod. Set DUNE_RECEIVER_MQ_NAMESPACE and DUNE_RECEIVER_MQ_POD manually.");
  }
  return { namespace: running.namespace, pod: running.pod };
}

async function resolveBattlegroup() {
  if (BG_NAMESPACE && BG_NAME) return { namespace: BG_NAMESPACE, name: BG_NAME };
  const detected = await detectBattlegroups();
  if (detected.selectedBattlegroup) {
    return { namespace: detected.selectedBattlegroup.namespace, name: detected.selectedBattlegroup.name };
  }
  if (!detected.battlegroups.length) {
    throw new Error("Could not find the Dune battlegroup resource. Set DUNE_RECEIVER_BG_NAMESPACE and DUNE_RECEIVER_BG_NAME manually.");
  }
  throw new Error("Multiple Dune battlegroups were detected. Select one in the Suite so DUNE_RECEIVER_BG_NAMESPACE and DUNE_RECEIVER_BG_NAME are set.");
}

async function runDuneSql(bg, sql) {
  const dbPod = `${bg.name}-db-dbdepl-sts-0`;
  const dbSvc = `${bg.name}-db-dbdepl-svc`;
  const remote = [
    `PW=$(sudo kubectl exec -n ${shQuote(bg.namespace)} ${shQuote(dbPod)} -- printenv POSTGRES_PASSWORD)`,
    `sudo kubectl exec -n ${shQuote(bg.namespace)} ${shQuote(dbPod)} -- env PGPASSWORD="$PW" psql -h ${shQuote(dbSvc)} -p 15432 -U postgres -d dune -At -F $'\\t' -c ${shQuote(sql)}`
  ].join("; ");
  return ssh(remote, TIMEOUT_MS);
}

async function publishAddItem(target, command) {
  const serverCommand = buildAddItemServerCommand(command);
  const erlang = buildRabbitEval(serverCommand, command.requestId);
  const remote = [
    "sudo kubectl exec",
    "-n", shQuote(target.namespace),
    shQuote(target.pod),
    "-- rabbitmqctl eval",
    shQuote(erlang)
  ].join(" ");
  const executedCommand = buildRabbitCommandLog(target);
  const output = await ssh(remote, TIMEOUT_MS);
  return { command: serverCommand, executedCommand, output: output.stdout || output.stderr || "" };
}

function buildRabbitCommandLog(target) {
  return [
    "sudo kubectl exec",
    "-n", target.namespace,
    target.pod,
    "-- rabbitmqctl eval",
    "<redacted-server-command-envelope>"
  ].join(" ");
}

function buildAddItemServerCommand(command) {
  return {
    ServerCommand: "AddItemToInventory",
    PlayerId: command.playerId,
    ItemName: command.template,
    Quantity: command.qty,
    Durability: 1.0
  };
}

function buildTeleportToExactServerCommand(command) {
  return {
    ServerCommand: "TeleportToExact",
    PlayerId: command.flsId,
    X: command.x,
    Y: command.y,
    Z: command.z
  };
}

function buildTeleportServerCommand(command) {
  if (command.commandMode === "safe-ground") {
    return {
      ServerCommand: "TeleportTo",
      PlayerId: command.flsId,
      X: command.x,
      Y: command.y,
      Z: command.z
    };
  }
  return buildTeleportToExactServerCommand(command);
}

function buildRabbitEval(serverCommand, requestId) {
  const outer = Buffer.from(JSON.stringify({
    Version: 2,
    AuthToken: SERVER_COMMAND_AUTH_TOKEN,
    MessageContent: JSON.stringify(serverCommand)
  })).toString("base64");
  const msgId = `alphanine-give-${String(requestId || Date.now()).replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
  return [
    `Outer = base64:decode(<<"${outer}">>)`,
    `XName = rabbit_misc:r(<<"/">>, exchange, <<"heartbeats">>)`,
    `X = rabbit_exchange:lookup_or_die(XName)`,
    `MsgId = <<"${msgId}">>`,
    `P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, undefined, <<"fls">>, <<"fls_backend">>, undefined}`,
    `Content = rabbit_basic:build_content(P, Outer)`,
    `{ok, Msg} = rabbit_basic:message(XName, <<"notifications">>, Content)`,
    `rabbit_queue_type:publish_at_most_once(X, Msg).`
  ].join(",");
}

function ssh(command, timeout) {
  return new Promise((resolve, reject) => {
    if (!SSH_HOST) return reject(new Error("DUNE_RECEIVER_SSH_HOST is required."));
    if (!SSH_USER) return reject(new Error("DUNE_RECEIVER_SSH_USER is required."));
    if (!SSH_KEY) return reject(new Error("SSH key is not configured"));
    if (!fs.existsSync(SSH_KEY)) return reject(new Error(`SSH key file does not exist: ${SSH_KEY}`));
    const args = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "LogLevel=QUIET",
      "-i", SSH_KEY,
      `${SSH_USER}@${SSH_HOST}`,
      command
    ];
    execFile("ssh", args, {
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "SSH command failed.").trim()));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function expandEnvPath(value) {
  return String(value || "").replace(/%([^%]+)%/g, (_match, name) => process.env[name] || _match);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid numeric SQL value.");
  return String(number);
}

function logReceiver(message, data = {}) {
  console.log(`[give-receiver] ${message}: ${JSON.stringify(sanitizeForLog(data))}`);
}

function logReceiverError(message, error, context = {}) {
  console.error(`[give-receiver] ${message}: ${JSON.stringify(sanitizeForLog({
    requestId: context.requestId || "",
    playerId: context.playerId || "",
    resolvedPlayerId: context.resolvedPlayerId || "",
    target: context.target || null,
    command: context.command || null,
    executedCommand: context.executedCommand || "",
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      statusCode: error?.statusCode || 500,
      stack: error?.stack || ""
    }
  }), null, 2)}`);
}

function sanitizeForLog(value) {
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|auth|key/i.test(key)) {
      clean[key] = item ? "<redacted>" : item;
    } else {
      clean[key] = sanitizeForLog(item);
    }
  }
  return clean;
}

function loadDotEnv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = unquoteEnvValue(match[2]);
  }
  return true;
}

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
