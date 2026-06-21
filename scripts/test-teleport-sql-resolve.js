const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { applyTeleportRequestMode } = require("../lib/teleport-request-mode");

const ROOT = path.join(__dirname, "..");

const forcedPreview = applyTeleportRequestMode({ dryRun: false, test: false }, { frontendRequestMode: "preview", execution: false });
assert.deepEqual(forcedPreview, { dryRun: true, test: true, frontendRequestMode: "preview", backendRequestMode: "preview" });
const forcedExecute = applyTeleportRequestMode({ dryRun: true, test: true }, { frontendRequestMode: "execute", execution: true });
assert.deepEqual(forcedExecute, { dryRun: false, test: false, frontendRequestMode: "execute", backendRequestMode: "execute" });

function int16(value) { const b = Buffer.alloc(2); b.writeInt16BE(value, 0); return b; }
function int32(value) { const b = Buffer.alloc(4); b.writeInt32BE(value, 0); return b; }
function message(type, payload = Buffer.alloc(0)) { return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]); }
function rowDescription(columns) {
  const fields = columns.map((name) => Buffer.concat([
    Buffer.from(`${name}\0`), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)
  ]));
  return message("T", Buffer.concat([int16(columns.length), ...fields]));
}
function dataRow(columns, row) {
  const values = columns.map((name) => {
    const value = row[name];
    if (value === null || value === undefined) return int32(-1);
    const bytes = Buffer.from(String(value));
    return Buffer.concat([int32(bytes.length), bytes]);
  });
  return message("D", Buffer.concat([int16(columns.length), ...values]));
}

const columns = ["player_id", "character_name", "actor_id", "account_id", "fls_id", "player_controller_id", "map", "partition_id", "partition_active", "x", "y", "z", "online_status"];
const sourceBefore = { player_id: "source-fls", character_name: "Source Player", actor_id: "source-pawn", account_id: "10", fls_id: "source-fls", player_controller_id: "110", map: "HaggaBasin", partition_id: "7", partition_active: "true", x: "100", y: "200", z: "300", online_status: "Online" };
const target = { player_id: "target-fls", character_name: "Target Player", actor_id: "target-pawn", account_id: "20", fls_id: "target-fls", player_controller_id: "220", map: "HaggaBasin", partition_id: "42", partition_active: "true", x: "900", y: "800", z: "700", online_status: "Online" };

function startFakePostgres() {
  let teleported = false;
  const queries = [];
  const server = net.createServer((socket) => {
    let phase = "startup";
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (phase === "startup") {
          if (buffer.length < 4) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          buffer = buffer.slice(length);
          phase = "password";
          socket.write(message("R", int32(3)));
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        const payload = buffer.slice(5, length + 1);
        buffer = buffer.slice(length + 1);
        if (phase === "password" && type === "p") {
          phase = "query";
          socket.write(Buffer.concat([message("R", int32(0)), message("Z", Buffer.from("I"))]));
        } else if (phase === "query" && type === "Q") {
          const sql = payload.subarray(0, -1).toString("utf8");
          queries.push(sql);
          let row = null;
          if (sql.includes("'target-fls'")) row = target;
          else if (sql.includes("'source-fls'")) row = teleported ? { ...sourceBefore, partition_id: target.partition_id, x: target.x, y: target.y, z: target.z } : sourceBefore;
          const packets = [rowDescription(columns)];
          if (row) packets.push(dataRow(columns, row));
          packets.push(message("C", Buffer.from(`SELECT ${row ? 1 : 0}\0`)), message("Z", Buffer.from("I")));
          socket.write(Buffer.concat(packets));
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, queries, setTeleported: () => { teleported = true; } }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close((error) => error ? reject(error) : resolve(port)); });
  });
}

async function post(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-teleport-resolve-"));
  const fake = await startFakePostgres();
  const port = await freePort();
  const configPath = path.join(testRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ databaseHost: "127.0.0.1", databasePort: fake.port, databaseName: "dune", databaseUser: "postgres", databasePassword: "test" }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, PORT: String(port), APPDATA: path.join(testRoot, "AppData"), ALPHANINE_CONFIG_PATH: configPath },
    stdio: "ignore"
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${baseUrl}/api/config`)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const mapClick = await post(baseUrl, "/api/live-map/teleport", { requestMode: "preview", playerId: "source-fls", x: 111, y: 222, z: 9999, partitionId: 9999, map: "HaggaBasin", elevationSource: "unknown" });
    assert.equal(mapClick.canExecute, true, JSON.stringify(mapClick));
    assert.equal(mapClick.resolution.diagnostics.selectedPartitionId, 7);
    assert.match(mapClick.resolution.diagnostics.partitionReason, /source player/i);
    assert.equal(mapClick.request.z, 5000);
    assert.equal(mapClick.request.commandMode, "safe-ground");
    assert.equal(mapClick.request.dryRun, true);
    assert.equal(mapClick.request.test, true);
    assert.equal(mapClick.resolution.diagnostics.frontendRequestMode, "preview");
    assert.equal(mapClick.resolution.diagnostics.finalBackendMode, "preview");
    assert.match(mapClick.message, /No live teleport command was sent/i);
    assert.match(mapClick.command, /^TeleportTo /);
    assert.match(mapClick.resolution.diagnostics.safeZReason, /dispatch altitude 5000|safe ground/i);

    const playerPreview = await post(baseUrl, "/api/live-map/teleport", { playerId: "source-fls", targetPlayerId: "target-fls", targetActorType: "player", x: -1, y: -2, z: -3, partitionId: 9999, map: "HaggaBasin", elevationSource: "player-position" });
    assert.equal(playerPreview.canExecute, true, JSON.stringify(playerPreview));
    assert.equal(playerPreview.request.x, 900);
    assert.equal(playerPreview.request.y, 800);
    assert.equal(playerPreview.request.z, 700);
    assert.equal(playerPreview.request.partition_id, 42);
    assert.equal(playerPreview.resolution.diagnostics.sourceActorId, "source-pawn");
    assert.equal(playerPreview.resolution.diagnostics.targetActorId, "target-pawn");
    assert.match(playerPreview.resolution.diagnostics.partitionReason, /target player/i);

    fake.setTeleported();
    const verified = await post(baseUrl, "/api/live-map/teleport/verify", { playerId: "source-fls", expected: { x: 900, y: 800, z: 700, partitionId: 42 } });
    assert.equal(verified.verified, true, JSON.stringify(verified));
    assert.deepEqual(verified.postTeleport, { x: 900, y: 800, z: 700, map: "HaggaBasin", partitionId: 42 });
    assert.match(verified.reason, /match the sent target/i);

    const safeGroundVerified = await post(baseUrl, "/api/live-map/teleport/verify", { playerId: "source-fls", commandMode: "safe-ground", expected: { x: 900, y: 800, z: 5000, partitionId: 42 } });
    assert.equal(safeGroundVerified.verified, true, JSON.stringify(safeGroundVerified));
    assert.equal(safeGroundVerified.postTeleport.z, 700);
    assert.match(safeGroundVerified.reason, /game resolved the landing Z/i);

    const page = await (await fetch(baseUrl)).text();
    assert.equal(page.includes('id="teleportPartitionId"'), false, "Partition input must not be exposed in the UI.");
    assert.match(page, /Map-click and dragged-marker destinations send immediately with safe-ground mode and dispatch altitude Z 5000/);
    assert.match(page, /id="liveTeleportButton" onclick="executeLiveTeleport\(\)" disabled>Teleport</);
    assert.equal(page.includes('onclick="previewTeleport()">Preview Teleport'), false, "Map-click must not require a preview button.");
    assert.match(page, /function liveMapDragTeleportPayload[\s\S]*?z:5000[\s\S]*?commandMode:"safe-ground"/);
    const dragHandler = page.match(/async function handleLiveMapPlayerDrag[\s\S]*?\nfunction addLiveMapMarkers/)?.[0] || "";
    assert.equal(dragHandler.includes("appConfirm"), false, "Drag teleport must not show a confirmation dialog.");
    assert.match(page, /draggable:kind==="players"/);
    assert.equal(fake.queries.some((sql) => /dune\.player_state[\s\S]+dune\.actors[\s\S]+dune\.world_partition/.test(sql)), true);
    console.log("Teleport SQL resolution tests passed.");
  } finally {
    try { await fetch(`${baseUrl}/api/receiver/stop`, { method: "POST" }); } catch {}
    child.kill();
    await new Promise((resolve) => fake.server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
