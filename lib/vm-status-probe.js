"use strict";

// A UI deadline must not discard a still-running Hyper-V read. Share that read
// across polls and retain its completed result briefly, including genuine errors.
function createVmStatusProbe({ read, fallback, ttlMs = 10000, now = Date.now }) {
  let current = null;
  return {
    invalidate() { current = null; },
    async get(key, timeoutMs) {
      if (!current || current.key !== key || (!current.pending && now() - current.completedAt >= ttlMs)) {
        const entry = { key, pending: true, completedAt: 0, startedAt: now() };
        current = entry;
        entry.promise = Promise.resolve().then(() => read(key)).then(
          result => {
            entry.pending = false;
            entry.completedAt = now();
            return { ...result, statusProbeStartedAtMs: entry.startedAt, checkedAtMs: entry.completedAt };
          },
          error => {
            if (current === entry) current = null;
            throw error;
          }
        );
      }
      const entry = current;
      let timer;
      try {
        return await Promise.race([
          entry.promise,
          new Promise(resolve => {
            timer = setTimeout(() => resolve({
              ...fallback(`Hyper-V check is still running after ${timeoutMs} ms; its result will appear on a subsequent refresh.`),
              statusProbeStartedAtMs: entry.startedAt,
              readPending: true
            }), timeoutMs);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

module.exports = { createVmStatusProbe };
