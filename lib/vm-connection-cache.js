'use strict';

// Cache discovery, never command results. A failed discovery cannot remain cached.
function createVmConnectionCache({read, ttlMs = 30000, now = Date.now}) {
  let current = null;
  return {
    invalidate() { current = null; },
    get(key) {
      if (!current || current.key !== key || (!current.pending && now() - current.completedAt >= ttlMs)) {
        const entry = {key, pending:true, completedAt:0};
        current = entry;
        entry.promise = Promise.resolve().then(read).then(result => {
          entry.pending = false;
          entry.completedAt = now();
          if (result.cacheVerified === false && current === entry) current = null;
          return result;
        }, error => {
          if (current === entry) current = null;
          throw error;
        });
      }
      return current.promise;
    }
  };
}
module.exports = {createVmConnectionCache};
