const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");

const SESSION_COOKIE = "alphanine_session";
const CSRF_COOKIE = "alphanine_csrf";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function parseCookies(header = "") {
  const result = {};
  for (const pair of String(header).split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
    try { result[key] = decodeURIComponent(pair.slice(index + 1).trim()); } catch {}
  }
  return result;
}

function normalizeAddress(value = "") {
  return String(value).replace(/^::ffff:/, "").split("%")[0];
}

function isLoopbackRequest(req) {
  const address = normalizeAddress(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1";
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, "base64"), 64).toString("base64");
}

function safeEqualBase64(left, right) {
  try {
    const a = Buffer.from(String(left), "base64");
    const b = Buffer.from(String(right), "base64");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function createRemoteAccess(options = {}) {
  const dataDir = options.dataDir;
  const authPath = path.join(dataDir, "auth.json");
  const certPath = process.env.ALPHANINE_TLS_CERT_PATH || path.join(dataDir, "tls-cert.pem");
  const keyPath = process.env.ALPHANINE_TLS_KEY_PATH || path.join(dataDir, "tls-key.pem");
  const sessions = new Map();
  const attempts = new Map();

  function credentials() {
    try { return JSON.parse(fs.readFileSync(authPath, "utf8")); } catch { return null; }
  }

  function configured() {
    const value = credentials();
    return Boolean(value?.salt && value?.hash && value?.username);
  }

  function setPassword(password, username = "admin") {
    const clean = String(password || "");
    if (clean.length < 12) throw new Error("Administrator password must be at least 12 characters.");
    if (clean.length > 256) throw new Error("Administrator password is too long.");
    const salt = crypto.randomBytes(24).toString("base64");
    atomicWriteJson(authPath, {
      version: 1,
      username: String(username || "admin").trim() || "admin",
      salt,
      hash: passwordDigest(clean, salt),
      updatedAt: new Date().toISOString()
    });
    sessions.clear();
    return { ok: true, username: String(username || "admin").trim() || "admin" };
  }

  function clientKey(req) {
    return normalizeAddress(req.socket?.remoteAddress || "unknown");
  }

  function rateState(req) {
    const key = clientKey(req);
    const now = Date.now();
    let state = attempts.get(key);
    if (!state || now - state.startedAt >= LOGIN_WINDOW_MS) {
      state = { count: 0, startedAt: now };
      attempts.set(key, state);
    }
    return { key, state, retryAfterMs: Math.max(0, LOGIN_WINDOW_MS - (now - state.startedAt)) };
  }

  function login(req, username, password) {
    const limit = rateState(req);
    if (limit.state.count >= LOGIN_MAX_ATTEMPTS) {
      return { ok: false, status: 429, error: "Too many login attempts. Try again later.", retryAfterMs: limit.retryAfterMs };
    }
    const stored = credentials();
    const candidate = stored?.salt ? passwordDigest(password, stored.salt) : passwordDigest(password, crypto.randomBytes(24).toString("base64"));
    const valid = Boolean(stored && String(username) === stored.username && safeEqualBase64(candidate, stored.hash));
    if (!valid) {
      limit.state.count += 1;
      return { ok: false, status: 401, error: configured() ? "Invalid username or password." : "Remote access has not been configured on the local Suite." };
    }
    attempts.delete(limit.key);
    const token = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    sessions.set(crypto.createHash("sha256").update(token).digest("hex"), { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    return { ok: true, token, csrf, expiresIn: Math.floor(SESSION_TTL_MS / 1000) };
  }

  function session(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const key = crypto.createHash("sha256").update(token).digest("hex");
    const value = sessions.get(key);
    if (!value || value.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    value.expiresAt = Date.now() + SESSION_TTL_MS;
    return { ...value, key };
  }

  function logout(req) {
    const active = session(req);
    if (active) sessions.delete(active.key);
  }

  function verifyCsrf(req, activeSession) {
    if (!activeSession) return false;
    const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE] || "";
    const header = String(req.headers["x-csrf-token"] || "");
    const expected = Buffer.from(activeSession.csrf);
    const suppliedCookie = Buffer.from(cookie);
    const suppliedHeader = Buffer.from(header);
    return expected.length === suppliedCookie.length && expected.length === suppliedHeader.length
      && crypto.timingSafeEqual(expected, suppliedCookie) && crypto.timingSafeEqual(expected, suppliedHeader);
  }

  function sessionCookies(result) {
    const maxAge = result.expiresIn;
    return [
      `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
      `${CSRF_COOKIE}=${encodeURIComponent(result.csrf)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`
    ];
  }

  function clearCookies() {
    return [
      `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      `${CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict`
    ];
  }

  function ensureCertificate(altNames = []) {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), generated: false };
    }
    if (process.env.ALPHANINE_TLS_CERT_PATH || process.env.ALPHANINE_TLS_KEY_PATH) {
      throw new Error("Both configured TLS certificate and key files must exist.");
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const unique = [...new Set(["localhost", "127.0.0.1", ...altNames].filter(Boolean))];
    const pems = selfsigned.generate([{ name: "commonName", value: "AlphaNine Dune Suite" }], {
      keySize: 2048,
      days: 825,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: unique.map((value) => ({ type: /^\d+\.\d+\.\d+\.\d+$/.test(value) ? 7 : 2, value, ip: /^\d+\.\d+\.\d+\.\d+$/.test(value) ? value : undefined })) }
      ]
    });
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    fs.writeFileSync(certPath, pems.cert, { mode: 0o600 });
    return { cert: Buffer.from(pems.cert), key: Buffer.from(pems.private), generated: true };
  }

  function certificateFingerprint() {
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
      return cert.fingerprint256;
    } catch { return ""; }
  }

  return {
    configured, setPassword, login, session, logout, verifyCsrf, sessionCookies, clearCookies,
    ensureCertificate, certificateFingerprint, isLoopbackRequest,
    authPath, certPath, keyPath, SESSION_COOKIE, CSRF_COOKIE
  };
}

module.exports = { createRemoteAccess, isLoopbackRequest };
