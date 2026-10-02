// Runs each request id once. A phone that loses the connection while a
// payment is under way sends it again with the same id, and gets the first
// attempt's outcome, success or failure, instead of paying twice. A new
// attempt, after the user has seen a failure, comes with a new id.
const ID = /^[A-Za-z0-9_-]{8,64}$/;

function createIdempotency({ ttlMs = 24 * 60 * 60 * 1000, max = 1000, now = Date.now } = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.at < cutoff || entries.size > max) {
        entries.delete(key);
      } else {
        break;
      }
    }
  }

  // `scope` keeps one device's ids apart from another's.
  function run(scope, requestId, fn) {
    if (requestId === undefined || requestId === null || requestId === "") {
      return fn();
    }
    if (!ID.test(String(requestId))) {
      const error = new Error("requestId must be 8 to 64 letters, digits, - or _");
      error.statusCode = 400;
      return Promise.reject(error);
    }
    prune();
    const key = `${scope}:${requestId}`;
    const hit = entries.get(key);
    if (hit) {
      return hit.promise;
    }
    const promise = Promise.resolve().then(fn);
    entries.set(key, { at: now(), promise });
    // Keep the failure too, but do not let it count as unhandled here.
    promise.catch(() => {});
    return promise;
  }

  return { run, size: () => entries.size };
}

module.exports = { createIdempotency };
