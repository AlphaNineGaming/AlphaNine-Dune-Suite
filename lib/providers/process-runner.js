"use strict";
const { execFile } = require("node:child_process");

function runProcess(binary, args, { timeoutMs = 5000, maxBytes = 16384, input } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new Error("invalid_process_limits");
  if (input !== undefined && (typeof input !== "string" || Buffer.byteLength(input) > 65536)) throw new Error("invalid_process_input");
  return new Promise(resolve => {
    const child = execFile(binary, args, { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: maxBytes, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) {
        const code = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output_limit" : error.killed ? "timeout" : "probe_failed";
        resolve({ ok: false, code });
      } else resolve({ ok: true, stdout });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => { child.kill("SIGKILL"); });
      child.stdin.end(input);
    }
  });
}
module.exports = { runProcess };
