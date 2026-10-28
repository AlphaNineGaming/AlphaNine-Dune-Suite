"use strict";
const assert = require("node:assert/strict");
const { classifySshResult, retryableReadOnlyTransportFailure, runReadOnlySshWithRetry } = require("../lib/migration-ssh-retry");
async function main() {
  const interrupted = { ok: false, code: 255, stderr: "ssh: connect to host [redacted]: Connection timed out", error: "Command exited with code 255." };
  assert.equal(classifySshResult(interrupted), "transport_interruption");
  assert.equal(retryableReadOnlyTransportFailure(interrupted), true);

  let calls = 0;
  const retryMessages = [];
  const backoffs = [];
  const recovered = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => (++calls === 1 ? interrupted : { ok: true, code: 0, stdout: "{}", stderr: "" }),
    sleep: async (milliseconds) => { backoffs.push(milliseconds); },
    sanitize: (value) => String(value || "").replace(/\[redacted\]/g, "[address redacted]"),
    onRetry: ({ retry, maximum }) => retryMessages.push(`SSH connection interrupted — retrying ${retry}/${maximum}.`)
  });
  assert.equal(calls, 2, "a retry must use one fresh executor invocation");
  assert.equal(recovered.recovered, true);
  assert.deepStrictEqual(retryMessages, ["SSH connection interrupted — retrying 1/2."]);
  assert.deepStrictEqual(backoffs, [250]);
  assert.equal(recovered.attempts.length, 2);
  assert.equal(recovered.attempts[0].category, "transport_interruption");
  assert.equal(recovered.attempts[1].category, "success");

  calls = 0;
  const ambiguousEmpty = { ok: false, code: 255, stderr: "", error: "" };
  const ambiguousRecovered = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => (++calls === 1 ? ambiguousEmpty : { ok: true, code: 0, stdout: "stable", stderr: "" }),
    sleep: async () => {}
  });
  assert.equal(calls, 2, "an explicitly authorized empty-stderr exit 255 must retry with a fresh process");
  assert.equal(ambiguousRecovered.recovered, true);
  assert.equal(ambiguousRecovered.attempts[0].category, "ambiguous_ssh_exit_255");
  assert.equal(ambiguousRecovered.attempts[0].stderr, "No SSH diagnostic was captured.");
  assert.equal(ambiguousRecovered.attempts[1].category, "success");

  calls = 0;
  const ambiguousExhausted = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => { calls += 1; return ambiguousEmpty; },
    sleep: async () => {}
  });
  assert.equal(calls, 3, "ambiguous exit 255 must remain bounded to the initial attempt plus two retries");
  assert.equal(ambiguousExhausted.recovered, false);
  assert.deepStrictEqual(ambiguousExhausted.attempts.map((attempt) => attempt.category), ["ambiguous_ssh_exit_255", "ambiguous_ssh_exit_255", "ambiguous_ssh_exit_255"]);
  assert(ambiguousExhausted.attempts.every((attempt) => attempt.stderr === "No SSH diagnostic was captured."), "all exhausted attempt diagnostics must be preserved");

  calls = 0;
  const exhausted = await runReadOnlySshWithRetry({ maxRetries: 2, execute: async () => { calls += 1; return interrupted; }, sleep: async () => {} });
  assert.equal(calls, 3, "preflight permits at most the initial command plus two retries");
  assert.equal(exhausted.attempts.length, 3);
  assert.equal(exhausted.result.stderr, interrupted.stderr, "the terminal cause must remain exact");
  calls = 0;
  const exhaustedBackoffs = [];
  const exhaustedTimed = await runReadOnlySshWithRetry({
    maxRetries: 2,
    execute: async () => { calls += 1; return interrupted; },
    sleep: async (milliseconds) => { exhaustedBackoffs.push(milliseconds); }
  });
  assert.equal(exhaustedTimed.result.code, 255);
  assert.deepStrictEqual(exhaustedBackoffs, [250, 500], "bounded evidence retries must use the exact 250/500 ms backoff");

  for (const failure of [
    { ok: false, code: 1, stderr: "Permission denied (publickey)." },
    { ok: false, code: 2, stderr: "psql: error: connection to server failed" },
    { ok: false, code: 1, stderr: "remote command failed" },
    { ok: false, code: null, timedOut: true, stderr: "Command timed out" }
  ]) {
    calls = 0;
    const rejected = await runReadOnlySshWithRetry({ maxRetries: 2, execute: async () => { calls += 1; return failure; }, sleep: async () => {} });
    assert.equal(calls, 1, `${classifySshResult(failure)} must not retry`);
    assert.equal(rejected.attempts.length, 1);
  }

  for (const diagnostic of ["Permission denied (publickey).", "psql: error: connection to server failed", "Error from server: pod not found", "Command timed out", ""]) {
    calls = 0;
    const exit255 = await runReadOnlySshWithRetry({
      maxRetries: 2,
      execute: async () => { calls += 1; return { ok: false, code: 255, timedOut: diagnostic === "Command timed out", stderr: diagnostic }; },
      sleep: async () => {}
    });
    assert.equal(calls, 3, "every exit 255 inside the explicit read-only boundary must receive the bounded retries");
    assert.equal(exit255.attempts.length, 3);
  }


  console.log("PASS shared read-only SSH retry behavior; discontinued migration workflow assertions removed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
