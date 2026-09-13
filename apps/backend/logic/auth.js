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
//   accompany every request that is not a GET.
// - The lockout is global rather than per address: behind StartOS's proxy or
//   Tor every visitor has the same address, so a per-address limit would be
//   useless or lock the owner out. It is persisted in the JSON store so a
//   restart does not reset it, and it backs off exponentially from the third
//   failure to a quarter of an hour.
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

// `store` reads and writes the lockout state; `now` is seconds. Both are
// injectable for the tests; the defaults are the JSON store and the clock.
function createAuth({
  getPassword = readPassword,
  now = () => Math.floor(Date.now() / 1000),
  store = {
    read: async () => {
      const {authFailCount, authLockedUntil} = await diskLogic().getJsonStore();
      return {failCount: authFailCount || 0, lockedUntil: authLockedUntil || 0};
    },
    write: ({failCount, lockedUntil}) =>
      diskLogic().updateJsonStore({authFailCount: failCount, authLockedUntil: lockedUntil}),
  },
} = {}) {
  // sessionId -> { csrf, createdAt }
  const sessions = new Map();

  // Whether the dashboard asks for a password at all: whenever a password
  // source is configured, whatever the platform says.
  const passwordConfigured = () =>
    Boolean(constants.DASHBOARD_PASSWORD || constants.DASHBOARD_PASSWORD_FILE);

  // A configured source that yields nothing (file missing, key null) keeps
  // the door shut rather than open.
  const passwordUsable = () => readPasswordFrom(getPassword).length > 0;

  function readPasswordFrom(fn) {
    const password = fn();
    return typeof password === "string" ? password : "";
  }

  function sweepExpired() {
    const cutoff = now() - SESSION_TTL_SEC;
    for (const [id, s] of sessions) {
      if (s.createdAt < cutoff) {
        sessions.delete(id);
      }
    }
  }

  function createSession() {
    sweepExpired();
    const id = crypto.randomBytes(16).toString("hex");
    const csrf = crypto.randomBytes(32).toString("hex");
    sessions.set(id, {csrf, createdAt: now()});
    return {id, csrf};
  }

  // Verify a password under the shared lockout. Refuses while locked, records
  // each failure with backoff from the third, resets on success.
  async function guardedVerify(password) {
    const {failCount, lockedUntil} = await store.read();
    const t = now();
    if (t < lockedUntil) {
      return {ok: false, reason: "locked", retryAfter: lockedUntil - t};
    }
    const expected = readPasswordFrom(getPassword);
    const good = expected.length > 0 && equal(password, expected);
    if (!good) {
      const next = failCount + 1;
      const backoff = next >= 3 ? Math.min(2 ** (next - 2), MAX_BACKOFF_SEC) : 0;
      await store.write({failCount: next, lockedUntil: backoff ? t + backoff : 0});
      return {ok: false, reason: "bad_password", retryAfter: backoff};
    }
    if (failCount || lockedUntil) {
      await store.write({failCount: 0, lockedUntil: 0});
    }
    return {ok: true};
  }

  async function login(password) {
    const r = await guardedVerify(password);
    if (!r.ok) {
      return r;
    }
    const s = createSession();
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
    return {id, ...s};
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
    createSession,
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
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  MAX_BACKOFF_SEC,
  CSRF_HEADER,
};
