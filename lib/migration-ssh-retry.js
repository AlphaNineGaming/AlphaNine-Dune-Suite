"use strict";

const AUTHENTICATION_PATTERN = /permission denied|publickey|authentication failed|too many authentication failures/i;
const DATABASE_PATTERN = /(?:^|\n)psql:|(?:^|\n)(?:ERROR|FATAL|PANIC):|password authentication failed|database .* does not exist/i;
const REMOTE_COMMAND_PATTERN = /error from server|unable to upgrade connection|pods? .* not found|kubectl|command not found|sudo:/i;
const TRANSPORT_PATTERN = /ssh: connect to host|connection (?:refused|reset|closed|timed out|aborted)|connection reset by peer|connection closed by remote host|network is unreachable|no route to host|could not resolve hostname|kex_exchange_identification|banner exchange|client_loop: send disconnect|broken pipe|connection corrupted/i;

function classifySshResult(result = {}) {
  if (result.ok === true && Number(result.code) === 0) return "success";
  const diagnostic = `${String(result.stderr || "")}\n${String(result.error || "")}`.trim();
  if (result.timedOut === true) return "timeout";
  if (AUTHENTICATION_PATTERN.test(diagnostic)) return "authentication_failure";
  if (DATABASE_PATTERN.test(diagnostic)) return "postgresql_failure";
  if (REMOTE_COMMAND_PATTERN.test(diagnostic)) return "remote_command_failure";
  if (Number(result.code) === 255 && TRANSPORT_PATTERN.test(diagnostic)) return "transport_interruption";
  return Number(result.code) === 255 ? "ambiguous_ssh_exit_255" : "remote_command_failure";
}

function retryableReadOnlyTransportFailure(result) {
  // Retry authority is supplied separately through maxRetries only by explicitly
  // registered idempotent read-only evidence callers. Within that boundary every
  // SSH exit 255 is treated as a potentially transient transport termination;
  // its more specific classification is retained in the attempt diagnostics.
  return Number(result?.code) === 255;
}

async function runReadOnlySshWithRetry(options = {}) {
  if (typeof options.execute !== "function") throw new TypeError("A read-only SSH executor is required.");
  const maxRetries = Math.max(0, Math.min(2, Number(options.maxRetries || 0)));
  const sanitize = typeof options.sanitize === "function" ? options.sanitize : (value) => String(value || "").trim();
  const sleep = typeof options.sleep === "function" ? options.sleep : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const attempts = [];
  let result = null;
  for (let index = 0; index <= maxRetries; index += 1) {
    result = await options.execute(index + 1);
    const category = classifySshResult(result);
    const diagnostic = sanitize(result?.stderr || result?.error || "");
    const attempt = Object.freeze({
      attempt: String(index + 1),
      exitCode: Number.isInteger(result?.code) ? result.code : null,
      timedOut: result?.timedOut === true,
      signal: String(result?.signal || ""),
      category,
      stderr: diagnostic || (category === "success" ? "" : "No SSH diagnostic was captured.")
    });
    attempts.push(attempt);
    options.onAttempt?.(attempt);
    if (result?.ok === true) return { result, attempts, recovered: index > 0 };
    if (index >= maxRetries || !retryableReadOnlyTransportFailure(result)) break;
    const retry = index + 1;
    options.onRetry?.({ retry, maximum: maxRetries, attempt });
    await sleep(Math.min(1000, 250 * retry));
  }
  return { result, attempts, recovered: false };
}

module.exports = {
  classifySshResult,
  retryableReadOnlyTransportFailure,
  runReadOnlySshWithRetry
};
