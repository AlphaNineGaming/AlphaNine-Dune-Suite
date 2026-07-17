const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

const QUICK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

function findOnPath(name, envPath = process.env.PATH || "") {
  const names = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  for (const directory of String(envPath).split(path.delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const resolved = path.join(directory.replace(/^"|"$/g, ""), candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  return "";
}

function downloadFile(url, destination, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error("Too many redirects while downloading cloudflared."));
    const request = https.get(url, { headers: { "User-Agent": "AlphaNine-Dune-Suite" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(downloadFile(new URL(response.headers.location, url).toString(), destination, redirects - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`cloudflared download failed with HTTP ${response.statusCode}.`));
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.download`;
      const output = fs.createWriteStream(temporary, { mode: 0o700 });
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > 150 * 1024 * 1024) request.destroy(new Error("cloudflared download exceeded the safety limit."));
      });
      response.pipe(output);
      output.on("finish", () => {
        output.close(() => {
          try {
            if (received < 1024 * 1024) throw new Error("Downloaded cloudflared file is unexpectedly small.");
            fs.renameSync(temporary, destination);
            resolve(destination);
          } catch (error) { reject(error); }
        });
      });
      output.on("error", reject);
    });
    request.setTimeout(60000, () => request.destroy(new Error("cloudflared download timed out.")));
    request.on("error", reject);
  });
}

function createInternetTunnel(options = {}) {
  const dataDir = options.dataDir;
  const originUrl = options.originUrl;
  const managedPath = path.join(dataDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const spawnProcess = options.spawnProcess || spawn;
  const idleTimeoutMs = Math.max(5 * 60 * 1000, Number(options.idleTimeoutMs || 60 * 60 * 1000));
  let child = null;
  let mode = "";
  let publicUrl = "";
  let startedAt = "";
  let lastError = "";
  let recentOutput = [];
  let lastActivityAt = "";
  let signatureCache = null;

  function verifyExecutable(filePath) {
    if (typeof options.signatureVerifier === "function") {
      const result = options.signatureVerifier(filePath);
      const stat = fs.statSync(filePath);
      signatureCache = { ...result, path: filePath, mtimeMs: stat.mtimeMs };
      return signatureCache;
    }
    if (process.platform !== "win32") return { ok: true, status: "NotApplicable", signer: "" };
    const stat = fs.statSync(filePath);
    if (signatureCache?.path === filePath && signatureCache.mtimeMs === stat.mtimeMs) return signatureCache;
    const command = "$s=Get-AuthenticodeSignature -LiteralPath $env:ALPHANINE_VERIFY_FILE; [pscustomobject]@{Status=[string]$s.Status;Signer=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, encoding: "utf8", env: { ...process.env, ALPHANINE_VERIFY_FILE: filePath }, timeout: 30000
    });
    let value = {};
    try { value = JSON.parse(String(result.stdout || "").trim()); } catch {}
    const verified = result.status === 0 && value.Status === "Valid" && /Cloudflare/i.test(String(value.Signer || ""));
    signatureCache = { ok: verified, status: value.Status || "Unknown", signer: value.Signer || "", path: filePath, mtimeMs: stat.mtimeMs };
    return signatureCache;
  }

  function executable() {
    const configured = String(process.env.ALPHANINE_CLOUDFLARED_PATH || "").trim();
    if (configured && fs.existsSync(configured)) return configured;
    if (fs.existsSync(managedPath)) return managedPath;
    return findOnPath("cloudflared");
  }

  function appendOutput(chunk) {
    const text = String(chunk || "").trim();
    if (!text) return;
    recentOutput = [...recentOutput, ...text.split(/\r?\n/)].slice(-30);
    const found = text.match(QUICK_URL_PATTERN)?.[0];
    if (found) publicUrl = found;
  }

  function status() {
    const binary = executable();
    let signature = { ok: false, status: binary ? "NotChecked" : "Missing", signer: "" };
    if (binary && signatureCache?.path === binary) signature = signatureCache;
    return {
      ok: true,
      installed: Boolean(binary),
      signatureVerified: Boolean(signature.ok),
      signatureStatus: signature.status,
      signatureSigner: signature.signer,
      running: Boolean(child && child.exitCode === null && !child.killed),
      mode,
      publicUrl,
      originUrl,
      startedAt,
      lastActivityAt,
      idleTimeoutMinutes: Math.round(idleTimeoutMs / 60000),
      lastError,
      recentOutput: recentOutput.slice(-8)
    };
  }

  async function install() {
    if (process.platform !== "win32") throw new Error("Automatic cloudflared installation is currently available only on Windows.");
    if (child) throw new Error("Stop the active internet tunnel before replacing cloudflared.");
    await downloadFile(DOWNLOAD_URL, managedPath);
    const signature = verifyExecutable(managedPath);
    if (!signature.ok) {
      try { fs.unlinkSync(managedPath); } catch {}
      throw new Error(`Downloaded cloudflared failed publisher verification (${signature.status || "unknown status"}).`);
    }
    return status();
  }

  function start(kind = "quick", token = "", expectedUrl = "") {
    if (child && child.exitCode === null && !child.killed) throw new Error("An internet tunnel is already running.");
    const binary = executable();
    if (!binary) throw new Error("cloudflared is not installed. Use Install cloudflared first.");
    const signature = verifyExecutable(binary);
    if (!signature.ok) throw new Error(`cloudflared publisher verification failed (${signature.status || "unknown status"}). Reinstall the official client.`);
    const cleanToken = String(token || "").trim();
    if (kind === "named" && cleanToken.length < 20) throw new Error("Paste the tunnel token from the Cloudflare dashboard.");
    const args = kind === "named"
      ? ["tunnel", "--no-autoupdate", "run", "--token", cleanToken]
      : ["tunnel", "--no-autoupdate", "--url", originUrl];
    mode = kind === "named" ? "named" : "quick";
    publicUrl = mode === "named" ? String(expectedUrl || "").trim().replace(/\/$/, "") : "";
    startedAt = new Date().toISOString();
    lastActivityAt = startedAt;
    lastError = "";
    recentOutput = [];
    child = spawnProcess(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => { lastError = error.message; });
    child.on("exit", (code, signal) => {
      if (code && !lastError) lastError = `cloudflared stopped with exit code ${code}${signal ? ` (${signal})` : ""}.`;
    });
    return status();
  }

  function stop() {
    if (child && child.exitCode === null && !child.killed) child.kill();
    child = null;
    mode = "";
    publicUrl = "";
    startedAt = "";
    lastActivityAt = "";
    return status();
  }

  function touch() {
    if (child && child.exitCode === null && !child.killed) lastActivityAt = new Date().toISOString();
  }

  function enforceIdleTimeout(now = Date.now()) {
    if (!child || child.exitCode !== null || child.killed || !lastActivityAt) return false;
    if (now - Date.parse(lastActivityAt) < idleTimeoutMs) return false;
    lastError = `Internet tunnel stopped after ${Math.round(idleTimeoutMs / 60000)} minutes without remote activity.`;
    stop();
    return true;
  }

  return { status, install, start, stop, touch, enforceIdleTimeout, verifyExecutable, executable, managedPath };
}

module.exports = { createInternetTunnel, findOnPath, QUICK_URL_PATTERN };
