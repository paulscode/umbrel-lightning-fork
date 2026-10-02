// The mobile API's door: a paired device's key as a bearer token.
//
// A valid key always gets in. Failures are counted per source address, and
// a source with many recent failures is refused for a while before its key
// is even looked at, which slows guessing without ever locking out a phone
// that holds a real key. The keys are 256-bit random, so the count is about
// noise, not about the odds.
function createFailureLimiter({ max = 20, windowMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const failures = new Map();

  function recent(key) {
    const cutoff = now() - windowMs;
    const list = (failures.get(key) || []).filter((t) => t > cutoff);
    if (list.length) {
      failures.set(key, list);
    } else {
      failures.delete(key);
    }
    return list;
  }

  return {
    blocked: (key) => recent(key).length >= max,
    fail: (key) => {
      const list = recent(key);
      list.push(now());
      failures.set(key, list);
      if (failures.size > 10000) {
        failures.delete(failures.keys().next().value);
      }
    },
  };
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

function transportOf(req) {
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  return host.endsWith(".onion") ? "tor" : "lan";
}

function createDeviceAuth({ devices, limiter = createFailureLimiter() }) {
  return function deviceAuth(req, res, next) {
    const source = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "?";
    const token = bearer(req);
    const device = token ? devices().verify(token, transportOf(req)) : null;
    if (device) {
      req.device = device;
      return next();
    }
    if (limiter.blocked(source)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    limiter.fail(source);
    return res.status(401).json({ error: "This device is not paired, or was removed. Pair it again." });
  };
}

module.exports = { createDeviceAuth, createFailureLimiter, transportOf, bearer };
