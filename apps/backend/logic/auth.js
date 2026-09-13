// Dashboard sign-in for platforms that put nothing in front of the dashboard
// (StartOS), after the pattern Pickhash uses: a single password, server-side
// sessions in a cookie with a per-session CSRF token, and a global, persisted
// login lockout.
//
// - The password is the platform's: DASHBOARD_PASSWORD, or the JSON file named
//   by DASHBOARD_PASSWORD_FILE ({"password": "..."}), read on every attempt so
//   the platform can change it without a restart. It is compared in constant
//   time. Nothing here stores or hashes it: the platform holds it and shows it
//   to the owner on request.
// - Sessions live in this process (single user, zero dependencies); a restart
//   means signing in again. The CSRF token is bound to the session and must
//   accompany every request that is not a GET. A session remembers a
//   fingerprint of the password it was opened with, and ends the moment the
//   password changes: changing the password is what an owner does on
//   suspecting a leak, and it must cut off whoever holds a session.
// - The lockout is global rather than per address: behind StartOS's proxy or
//   Tor every visitor has the same address, so a per-address limit would be
//   useless or lock the owner out. It is persisted in the JSON store so a
//   restart does not reset it, and it backs off exponentially from the third
//   failure to a quarter of an hour. Attempts are verified one at a time, so
//   a burst of parallel guesses cannot read the counter before it is
//   written. The lockout is tied to the password's fingerprint too, so a new
//   password starts the counter afresh: that is the owner's way out of a
//   lockout somebody else caused. If the counter cannot be written, the
//   attempt is refused rather than allowed uncounted.
const crypto = require("crypto");
const fs = require("fs");

// Relative, not through module-alias, and the JSON store required only when
// first used: this module loads under plain node, so the tests run without
// the app's dependencies installed.
const constants = require("../utils/const.js");
const diskLogic = () => require("./disk");

const SESSION_COOKIE = "lightning_fork_session";
const SESSION_TTL_SEC = 12 * 3600;
const MAX_BACKOFF_SEC = 15 * 60;
const CSRF_HEADER = "x-csrf-token";

function readPassword() {
  if (constants.DASHBOARD_PASSWORD_FILE) {
    try {
      const {password} = JSON.parse(fs.readFileSync(constants.DASHBOARD_PASSWORD_FILE, "utf8"));
      return typeof password === "string" ? password : "";
    } catch (error) {
      return "";
    }
  }
  return constants.DASHBOARD_PASSWORD || "";
}

function equal(supplied, expected) {
  const a = Buffer.from(String(supplied), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) {
    // Spend the same time on a wrong length as on a wrong character.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// What is remembered about a password without remembering it.
function fingerprint(password) {
  return crypto.createHash("sha256").update(String(password), "utf8").digest("hex");
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

// `store` reads and writes the lockout state; `now` is seconds; `log` takes
// a line. All injectable for the tests; the defaults are the JSON store, the
// clock and the console.
function createAuth({
  getPassword = readPassword,
  now = () => Math.floor(Date.now() / 1000),
  log = message => console.warn(`[auth] ${message}`),
  store = {
    read: async () => {
      const {authFailCount, authLockedUntil, authPasswordFingerprint} = await diskLogic().getJsonStore();
      return {
        failCount: authFailCount || 0,
        lockedUntil: authLockedUntil || 0,
        fingerprint: authPasswordFingerprint || "",
      };
    },
    write: ({failCount, lockedUntil, fingerprint: fp}) =>
      diskLogic().updateJsonStore({
        authFailCount: failCount,
        authLockedUntil: lockedUntil,
        authPasswordFingerprint: fp,
      }),
  },
} = {}) {
  // sessionId -> { csrf, createdAt, fingerprint }
  const sessions = new Map();
  // Attempts run one at a time (see guardedVerify).
  let queue = Promise.resolve();

  // Whether the dashboard asks for a password at all: whenever a password
  // source is configured, whatever the platform says.
  const passwordConfigured = () =>
    Boolean(constants.DASHBOARD_PASSWORD || constants.DASHBOARD_PASSWORD_FILE);

  function currentPassword() {
    const password = getPassword();
    return typeof password === "string" ? password : "";
  }

  // A configured source that yields nothing (file missing, key null) keeps
  // the door shut rather than open.
  const passwordUsable = () => currentPassword().length > 0;

  function sweepExpired() {
    const cutoff = now() - SESSION_TTL_SEC;
    for (const [id, s] of sessions) {
      if (s.createdAt < cutoff) {
        sessions.delete(id);
      }
    }
  }

  function createSession(password) {
    sweepExpired();
    const id = crypto.randomBytes(16).toString("hex");
    const csrf = crypto.randomBytes(32).toString("hex");
    sessions.set(id, {csrf, createdAt: now(), fingerprint: fingerprint(password)});
    return {id, csrf};
  }

  // The lockout state for the password in force: a different password than
  // the one the failures were counted against starts from zero. `stored` is
  // what the store holds, so a success can tell whether there is anything
  // to clear.
  async function lockState(expected) {
    const stored = await store.read();
    const counts = !stored.fingerprint || stored.fingerprint === fingerprint(expected);
    return {
      failCount: counts ? stored.failCount : 0,
      lockedUntil: counts ? stored.lockedUntil : 0,
      stored,
    };
  }

  async function verifyUnderLockout(password) {
    const expected = currentPassword();
    if (expected.length === 0) {
      // Not the visitor's fault, and not a guess to count: without a
      // password nobody can sign in, and the owner's own attempts while the
      // file is unreadable must not lock them out once it is back.
      return {ok: false, reason: "not_configured", retryAfter: 0};
    }
    const {failCount, lockedUntil, stored} = await lockState(expected);
    const t = now();
    if (t < lockedUntil) {
      return {ok: false, reason: "locked", retryAfter: lockedUntil - t};
    }
    const good = equal(password, expected);
    if (!good) {
      const next = failCount + 1;
      const backoff = next >= 3 ? Math.min(2 ** (next - 2), MAX_BACKOFF_SEC) : 0;
      try {
        await store.write({
          failCount: next,
          lockedUntil: backoff ? t + backoff : 0,
          fingerprint: fingerprint(expected),
        });
      } catch (error) {
        // A failure that cannot be counted is refused as if locked, for the
        // longest interval: better a shut door than unlimited guessing.
        log(`could not record a failed sign-in (${error && error.message ? error.message : error}); refusing attempts`);
        return {ok: false, reason: "locked", retryAfter: MAX_BACKOFF_SEC};
      }
      return {ok: false, reason: "bad_password", retryAfter: backoff};
    }
    if (stored.failCount || stored.lockedUntil || stored.fingerprint) {
      try {
        await store.write({failCount: 0, lockedUntil: 0, fingerprint: ""});
      } catch (error) {
        log(`could not clear the sign-in counter (${error && error.message ? error.message : error})`);
      }
    }
    return {ok: true, password: expected};
  }

  // Verify a password under the shared lockout: one attempt at a time, so a
  // burst of parallel guesses cannot all read the counter before any of
  // them writes it. Refuses while locked, records each failure with backoff
  // from the third, resets on success. Does not create a session.
  function guardedVerify(password) {
    const run = () => verifyUnderLockout(password);
    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function login(password) {
    const r = await guardedVerify(password);
    if (!r.ok) {
      return r;
    }
    const s = createSession(r.password);
    return {ok: true, id: s.id, csrf: s.csrf};
  }

  function sessionFromReq(req) {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) {
      return null;
    }
    const s = sessions.get(id);
    if (!s) {
      return null;
    }
    if (now() - s.createdAt > SESSION_TTL_SEC) {
      sessions.delete(id);
      return null;
    }
    if (s.fingerprint !== fingerprint(currentPassword())) {
      // The password changed since this session was opened.
      sessions.delete(id);
      return null;
    }
    return {id, csrf: s.csrf, createdAt: s.createdAt};
  }

  function logout(req) {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (id) {
      sessions.delete(id);
    }
  }

  // Secure only when asked: StartOS serves the dashboard over its own TLS on
  // the LAN, but plain http over Tor, where a Secure cookie would never be
  // stored and sign-in would loop.
  function cookieHeader(id) {
    const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
    return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}${secure}`;
  }

  function clearCookieHeader() {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  function csrfOk(session, req) {
    const header = req.headers[CSRF_HEADER];
    if (!session || !header) {
      return false;
    }
    return equal(String(header), String(session.csrf));
  }

  return {
    passwordConfigured,
    passwordUsable,
    guardedVerify,
    login,
    logout,
    sessionFromReq,
    cookieHeader,
    clearCookieHeader,
    csrfOk,
    sessionCount: () => sessions.size,
  };
}

module.exports = {
  ...createAuth(),
  createAuth,
  readPassword,
  equal,
  fingerprint,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  MAX_BACKOFF_SEC,
  CSRF_HEADER,
};
