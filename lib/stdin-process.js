"use strict";

const fs = require("fs");
const { spawn } = require("child_process");

function runWithStdin(command, args, inputPath, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const createReadStream = options.createReadStream || fs.createReadStream;
  let expectedBytes;
  try { expectedBytes = fs.statSync(inputPath, { bigint: true }).size; }
  catch (error) { return Promise.resolve({ ok: false, code: 0, stdout: "", stderr: "", inputComplete: false, error: String(error.message || error) }); }
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) {
      resolve({ ok: false, code: 0, stdout: "", stderr: "", inputComplete: false, error: String(error.message || error) });
      return;
    }
    const timeoutMs = options.timeout || 120000;
    const maxBuffer = options.maxBuffer || 1024 * 1024 * 8;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let inputBytes = 0n;
    let inputEnded = false;
    let stdinFinished = false;
    let streamError = "";
    let childClosed = false;
    let childCode = null;
    let closeGraceTimer = null;
    const input = createReadStream(inputPath);
    const stop = () => {
      try { input.destroy(); } catch {}
      try { child.stdin.destroy(); } catch {}
      try { child.kill("SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ ok: false, code: 0, stdout, stderr, inputComplete: false, error: `Command timed out after ${timeoutMs} ms.` });
    }, timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      try { input.destroy(); } catch {}
      resolve(payload);
    };
    const finishClosedChild = () => {
      if (!childClosed || settled) return;
      const complete = () => {
        const inputComplete = inputEnded && stdinFinished && inputBytes === expectedBytes && !streamError;
        finish({
          ok: childCode === 0 && inputComplete,
          code: childCode,
          stdout,
          stderr,
          inputComplete,
          inputBytes: inputBytes.toString(10),
          error: childCode === 0 && inputComplete ? "" : streamError || (!inputComplete ? "Command closed before the complete stdin payload was transferred." : `Command exited with code ${childCode}.`)
        });
      };
      // On Windows OpenSSH the child close notification can precede the local
      // Readable "end" and Writable "finish" notifications even after the
      // remote consumer has exited successfully. Give only those already-in-
      // flight stream events a short bounded window; exact remote size/hash
      // validation still follows before an archive is trusted.
      if (inputEnded && stdinFinished) complete();
      else if (!closeGraceTimer) closeGraceTimer = setTimeout(complete, 250);
    };
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout, "utf8") < maxBuffer) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") < maxBuffer) stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, code: 0, stdout, stderr, inputComplete: false, error: String(error.message || error) }));
    child.on("close", (code) => { childClosed = true; childCode = code; finishClosedChild(); });
    child.stdin.on("finish", () => { stdinFinished = true; finishClosedChild(); });
    child.stdin.on("error", (error) => {
      streamError = String(error.message || error || "stdin transfer failed");
      stop();
    });
    input.on("data", (chunk) => { inputBytes += BigInt(chunk.length); });
    input.on("end", () => { inputEnded = true; finishClosedChild(); });
    input.on("error", (error) => {
      streamError = String(error.message || error);
      stop();
    });
    input.pipe(child.stdin);
  });
}

module.exports = { runWithStdin };
