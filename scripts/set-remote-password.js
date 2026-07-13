#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRemoteAccess } = require("../lib/remote-access");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function hiddenPrompt(label) {
  if (!process.stdin.isTTY) return Promise.reject(new Error("Set ALPHANINE_ADMIN_PASSWORD when running without an interactive terminal."));
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (character) => {
      if (character === "\u0003") return finish(new Error("Cancelled."));
      if (character === "\r" || character === "\n") return finish();
      if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); return; }
      if (character >= " ") value += character;
    };
    process.stdin.on("data", onData);
  });
}

(async () => {
  const dataDir = process.env.ALPHANINE_DATA_DIR
    || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "alphanine-dune-suite");
  fs.mkdirSync(dataDir, { recursive: true });
  const username = argument("--username", process.env.ALPHANINE_ADMIN_USERNAME || "admin");
  const password = process.env.ALPHANINE_ADMIN_PASSWORD || await hiddenPrompt("New remote administrator password: ");
  const confirm = process.env.ALPHANINE_ADMIN_PASSWORD || await hiddenPrompt("Confirm password: ");
  if (password !== confirm) throw new Error("Passwords do not match.");
  createRemoteAccess({ dataDir: path.join(dataDir, "remote-access") }).setPassword(password, username);
  console.log(`Remote administrator '${username}' configured successfully.`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
