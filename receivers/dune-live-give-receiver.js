const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

loadDotEnv(path.join(__dirname, "..", ".env"));
loadDotEnv(path.join(__dirname, "..", ".env.local"));

const HOST = process.env.DUNE_RECEIVER_HOST || "127.0.0.1";
const PORT = Number(process.env.DUNE_RECEIVER_PORT || 5055);
const TOKEN = String(process.env.DUNE_RECEIVER_TOKEN || "").trim();
const SSH_HOST = String(process.env.DUNE_RECEIVER_SSH_HOST || "").trim();
const SSH_USER = String(process.env.DUNE_RECEIVER_SSH_USER || "dune").trim();
const SSH_KEY = expandEnvPath(process.env.DUNE_RECEIVER_SSH_KEY || path.join(os.homedir(), "AppData", "Local", "DuneAwakeningServer", "sshKey"));
const MQ_NAMESPACE = String(process.env.DUNE_RECEIVER_MQ_NAMESPACE || "").trim();
const MQ_POD = String(process.env.DUNE_RECEIVER_MQ_POD || "").trim();
const BG_NAMESPACE = String(process.env.DUNE_RECEIVER_BG_NAMESPACE || "").trim();
const BG_NAME = String(process.env.DUNE_RECEIVER_BG_NAME || "").trim();
const TIMEOUT_MS = Number(process.env.DUNE_RECEIVER_TIMEOUT_MS || 30000);

// Static token used by the Dune server-command envelope. This is not a user secret.
const SERVER_COMMAND_AUTH_TOKEN = "Nu6VmPWUMvdPMeB7qErr";

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", async (_req, res) => {
  const diagnostics = await probeReceiver();
  res.status(diagnostics.ok ? 200 : 503).json(diagnostics);
});

app.post("/api/give-item", async (req, res) => handleGiveItem(req, res));
app.post("/give-item", async (req, res) => handleGiveItem(req, res));

app.listen(PORT, HOST, () => {
  console.log(`Dune live give-item receiver listening on http://${HOST}:${PORT}`);
  console.log(`SSH target: ${SSH_USER}@${SSH_HOST || "(missing DUNE_RECEIVER_SSH_HOST)"}`);
  console.log(`MQ pod: ${MQ_NAMESPACE && MQ_POD ? `${MQ_NAMESPACE}/${MQ_POD}` : "auto-detect"}`);
});

async function handleGiveItem(req, res) {
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
    verifyToken(req);
    const command = validateGiveItem(req.body || {});
    context.requestId = command.requestId;
    context.playerId = command.playerId;
    logReceiver("give-item player id", {
      requestId: command.requestId,
      playerId: command.playerId
    });
    const originalPlayerId = command.playerId;
    command.playerId = await resolveDunePlayerId(command.playerId);
    context.resolvedPlayerId = command.playerId;
    logReceiver("give-item resolved FLS/Funcom id", {
      requestId: command.requestId,
      originalPlayerId,
      resolvedPlayerId: command.playerId
    });
    const target = await resolveMqTarget();
    context.target = target;
    logReceiver("give-item detected mq-game pod", {
      requestId: command.requestId,
      namespace: target.namespace,
      pod: target.pod
    });
    context.command = buildAddItemServerCommand(command);
    logReceiver("give-item generated AddItemToInventory command", {
      requestId: command.requestId,
      command: context.command
    });
    context.executedCommand = buildRabbitCommandLog(target);
    const result = await publishAddItem(target, command);
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
      command: result.command
    });
  } catch (error) {
    logReceiverError("give-item failed", error, context);
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message
    });
  }
}

function verifyToken(req) {
  if (!TOKEN) return;
  const header = String(req.headers.authorization || "");
  if (header !== `Bearer ${TOKEN}`) {
    const error = new Error("Receiver token is missing or invalid.");
    error.statusCode = 401;
    throw error;
  }
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
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) {
    const error = new Error("qty must be a whole number between 1 and 9999.");
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
  const missing = [];
  if (!SSH_HOST) missing.push("DUNE_RECEIVER_SSH_HOST");
  if (!SSH_USER) missing.push("DUNE_RECEIVER_SSH_USER");
  if (!SSH_KEY) missing.push("DUNE_RECEIVER_SSH_KEY");
  const config = receiverConfigDiagnostics();
  if (missing.length) return { ok: false, missing, config, reason: "Receiver SSH config is incomplete." };
  try {
    const target = await resolveMqTarget();
    return { ok: true, config, target };
  } catch (error) {
    return { ok: false, config, error: error.message };
  }
}

function receiverConfigDiagnostics() {
  return {
    host: HOST,
    port: PORT,
    sshHost: SSH_HOST || "",
    sshUser: SSH_USER || "",
    sshKeyConfigured: Boolean(SSH_KEY),
    tokenConfigured: Boolean(TOKEN),
    mqNamespace: MQ_NAMESPACE || "",
    mqPod: MQ_POD || "",
    battlegroupNamespace: BG_NAMESPACE || "",
    battlegroupName: BG_NAME || ""
  };
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
  const bgJson = await ssh("sudo kubectl get igwbg -A -o json", TIMEOUT_MS);
  let data;
  try {
    data = JSON.parse(bgJson.stdout || "{}");
  } catch (error) {
    throw new Error(`Could not parse battlegroup resource: ${error.message}`);
  }
  const item = (data.items || [])[0];
  const namespace = item?.metadata?.namespace || "";
  const name = item?.metadata?.name || "";
  if (!namespace || !name) {
    throw new Error("Could not find the Dune battlegroup resource. Set DUNE_RECEIVER_BG_NAMESPACE and DUNE_RECEIVER_BG_NAME manually.");
  }
  return { namespace, name };
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
  if (!fs.existsSync(filePath)) return;
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
}

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
