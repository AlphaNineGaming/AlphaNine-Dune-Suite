'use strict';
async function runHealthChecks(tasks, limit = 4) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit');
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, tasks.length)}, async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = await tasks[index](); }
      catch (error) { results[index] = {ok:false, error: String(error.message || error)}; }
    }
  }));
  return results;
}
function healthCommandResult(result, timeout) {
  if (result.ok) return result;
  let error = String(result.stderr || '').trim();
  if (!error) {
    if (result.errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') error = 'Health check output exceeded its buffer limit.';
    else if (result.killed || result.timedOut) error = `Health command exceeded ${timeout} ms and was terminated.`;
    else error = result.error || 'Health command failed without an error message.';
  }
  return {...result, error, stderr:error};
}
module.exports = {runHealthChecks, healthCommandResult};
