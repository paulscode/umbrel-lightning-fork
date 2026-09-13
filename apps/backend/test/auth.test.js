// The sign-in gate: sessions, the CSRF token and the global lockout, with the
// password source, clock and lockout store injected.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DASHBOARD_PASSWORD = "correct horse";
const auth = require("../logic/auth.js");

function fake({ password = "correct horse" } = {}) {
  let clock = 1_000_000;
  let state = { failCount: 0, lockedUntil: 0 };
  const writes = [];
  const a = auth.createAuth({
    getPassword: () => password,
    now: () => clock,
    store: {
      read: async () => ({ ...state }),
      write: async (next) => { state = { ...next }; writes.push({ ...next }); },
    },
  });
  return { a, tick: (s) => { clock += s; }, state: () => state, writes };
}

const reqWith = (cookie, headers = {}) => ({ headers: { cookie, ...headers } });

test("the right password opens a session; the cookie carries it and the CSRF token is bound to it", async () => {
  const { a } = fake();
  const r = await a.login("correct horse");
  assert.equal(r.ok, true);
  assert.match(r.id, /^[0-9a-f]{32}$/);
  assert.match(r.csrf, /^[0-9a-f]{64}$/);
  const cookie = a.cookieHeader(r.id);
  assert.match(cookie, new RegExp(`^${auth.SESSION_COOKIE}=${r.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.SESSION_TTL_SEC}$`));
  const session = a.sessionFromReq(reqWith(`other=1; ${auth.SESSION_COOKIE}=${r.id}`));
  assert.equal(session.csrf, r.csrf);
  assert.equal(a.csrfOk(session, reqWith("", { [auth.CSRF_HEADER]: r.csrf })), true);
  assert.equal(a.csrfOk(session, reqWith("", { [auth.CSRF_HEADER]: "0".repeat(64) })), false);
  assert.equal(a.csrfOk(session, reqWith("")), false);
});

test("a wrong password, a wrong length and an empty one are refused in the same way", async () => {
  const { a } = fake();
  const reasons = [];
  for (const attempt of ["correct horsf", "short", "", "correct horse battery staple"]) {
    const r = await a.login(attempt);
    assert.equal(r.ok, false);
    reasons.push(r.reason);
  }
  // The third failure starts the lockout, so the fourth is refused as locked
  // before its password is even looked at.
  assert.deepEqual(reasons, ["bad_password", "bad_password", "bad_password", "locked"]);
  assert.equal(a.sessionCount(), 0);
});

test("a configured source that yields no password keeps the door shut", async () => {
  const { a } = fake({ password: "" });
  assert.equal(a.passwordUsable(), false);
  const r = await a.login("");
  assert.equal(r.ok, false);
});

test("from the third failure the lockout backs off, persists, and clears on success", async () => {
  const { a, tick, state, writes } = fake();
  assert.equal((await a.login("no")).retryAfter, 0);
  assert.equal((await a.login("no")).retryAfter, 0);
  const third = await a.login("no");
  assert.equal(third.reason, "bad_password");
  assert.equal(third.retryAfter, 2, "2^(3-2) seconds after the third failure");
  assert.equal(state().failCount, 3);
  assert.ok(state().lockedUntil > 0, "the lockout is written to the store, so a restart keeps it");

  const locked = await a.login("correct horse");
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "locked", "even the right password waits out the lockout");
  assert.equal(locked.retryAfter, 2);

  tick(3);
  const fourth = await a.login("no");
  assert.equal(fourth.retryAfter, 4, "doubling");
  tick(5);
  const ok = await a.login("correct horse");
  assert.equal(ok.ok, true);
  assert.deepEqual(state(), { failCount: 0, lockedUntil: 0 });
  assert.ok(writes.length >= 5);
});

test("the backoff is capped", async () => {
  const { a, tick } = fake();
  let last = 0;
  for (let i = 0; i < 16; i += 1) {
    const r = await a.login("no");
    last = r.retryAfter;
    tick(last + 1);
  }
  assert.equal(last, auth.MAX_BACKOFF_SEC);
});

test("sessions expire, and logout ends one at once", async () => {
  const { a, tick } = fake();
  const r = await a.login("correct horse");
  const req = reqWith(`${auth.SESSION_COOKIE}=${r.id}`);
  assert.ok(a.sessionFromReq(req));
  tick(auth.SESSION_TTL_SEC + 1);
  assert.equal(a.sessionFromReq(req), null, "past its lifetime");

  const again = await a.login("correct horse");
  const req2 = reqWith(`${auth.SESSION_COOKIE}=${again.id}`);
  assert.ok(a.sessionFromReq(req2));
  a.logout(req2);
  assert.equal(a.sessionFromReq(req2), null);
  assert.match(a.clearCookieHeader(), /Max-Age=0/);
});

test("an unknown or malformed cookie is no session", async () => {
  const { a } = fake();
  assert.equal(a.sessionFromReq(reqWith(`${auth.SESSION_COOKIE}=deadbeef`)), null);
  assert.equal(a.sessionFromReq(reqWith("")), null);
  assert.equal(a.sessionFromReq({ headers: {} }), null);
  assert.deepEqual(auth.parseCookies("a=1; b=2=3;;c"), { a: "1", b: "2=3" });
});
