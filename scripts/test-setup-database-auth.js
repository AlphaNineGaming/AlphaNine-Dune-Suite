const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CORRECT_PASSWORD = "form-correct-password";

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function message(type, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]);
}

function pgError(text) {
  return message("E", Buffer.concat([Buffer.from("SERROR\0M"), Buffer.from(text), Buffer.from("\0\0")]));
}

function startFakePostgres() {
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
        } else {
          if (buffer.length < 5) return;
          const type = String.fromCharCode(buffer[0]);
          const length = buffer.readInt32BE(1);
          if (buffer.length < length + 1) return;
          const payload = buffer.slice(5, length + 1);
          buffer = buffer.slice(length + 1);
          if (phase === "password" && type === "p") {
            const password = payload.subarray(0, -1).toString("utf8");
            if (password !== CORRECT_PASSWORD) {
              socket.write(pgError("password authentication failed"));
              socket.end();
              return;
            }
            phase = "query";
            socket.write(Buffer.concat([message("R", int32(0)), message("Z", Buffer.from("I"))]));
          } else if (phase === "query" && type === "Q") {
            const sql = payload.subarray(0, -1).toString("utf8");
            queries.push(sql);
            const row = Buffer.concat([Buffer.from([0, 1]), int32(1), Buffer.from("1")]);
            socket.write(Buffer.concat([message("D", row), message("C", Buffer.from("SELECT 1\0")), message("Z", Buffer.from("I"))]));
          }
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, queries }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function post(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/setup/test-database`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-db-auth-"));
  const fake = await startFakePostgres();
  const port = await freePort();
  const configPath = path.join(testRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    databaseHost: "127.0.0.1",
    databasePort: fake.port,
    databaseName: "saved-db",
    databaseUser: "saved-user",
    databasePassword: CORRECT_PASSWORD
  }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA: path.join(testRoot, "AppData"),
      ALPHANINE_CONFIG_PATH: configPath,
      DUNE_DATABASE_PASSWORD: CORRECT_PASSWORD
    },
    stdio: "ignore"
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${baseUrl}/api/config`)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const page = await (await fetch(baseUrl)).text();
    assert.match(page, /id="setupFinishButton"[^>]*disabled/);
    assert.match(page, /id="setupSaveTestButton"[^>]*disabled/);
    assert.equal((page.match(/oninput="invalidateSetupDatabaseTest\(\)"/g) || []).length, 5);
    const form = { databaseHost: "127.0.0.1", databasePort: fake.port, databaseName: "form-db", databaseUser: "form-user" };
    const blank = await post(baseUrl, { ...form, databasePassword: "" });
    assert.equal(blank.ok, false);
    assert.match(blank.error, /password.*required/i);

    const wrong = await post(baseUrl, { ...form, databasePassword: "wrong-form-password" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /password authentication failed/i);
    assert.equal(JSON.stringify(wrong).includes("wrong-form-password"), false, "Password leaked in response.");

    const correct = await post(baseUrl, { ...form, databasePassword: CORRECT_PASSWORD });
    assert.equal(correct.ok, true, JSON.stringify(correct));
    assert.equal(JSON.stringify(correct).includes(CORRECT_PASSWORD), false, "Password leaked in success response.");
    assert.deepEqual(fake.queries, ["SELECT 1;"]);
    console.log("Setup database authentication tests passed.");
  } finally {
    try { await fetch(`${baseUrl}/api/receiver/stop`, { method: "POST" }); } catch {}
    child.kill();
    await new Promise((resolve) => fake.server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
