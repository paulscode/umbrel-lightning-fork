const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const { createStepUp } = require("logic/stepUp.js");

function fakeAuth({ configured = true, result = { ok: true } } = {}) {
  const seen = [];
  return {
    seen,
    passwordConfigured: () => configured,
    guardedVerify: async (password) => {
      seen.push(password);
      return result;
    },
  };
}

test("without a dashboard password nothing is asked", async () => {
  const auth = fakeAuth({ configured: false });
  await createStepUp({ auth }).requirePassword(undefined, "pair a phone");
  assert.deepEqual(auth.seen, []);
});

test("a missing password is refused with 403, naming the action", async () => {
  const auth = fakeAuth();
  for (const password of [undefined, "", 42]) {
    await assert.rejects(createStepUp({ auth }).requirePassword(password, "pair a phone"), (e) => {
      assert.equal(e.statusCode || e.status, 403);
      assert.match(e.message, /Enter your dashboard password to pair a phone\./);
      return true;
    });
  }
  assert.deepEqual(auth.seen, []);
});

test("a wrong password is 403 and never 401, which would end the session on the page", async () => {
  const auth = fakeAuth({ result: { ok: false, reason: "wrong" } });
  await assert.rejects(createStepUp({ auth }).requirePassword("nope", "pair a phone"), (e) => {
    assert.equal(e.statusCode || e.status, 403);
    assert.match(e.message, /not your dashboard password/);
    return true;
  });
  assert.deepEqual(auth.seen, ["nope"]);
});

test("the sign-in lockout applies, with its wait", async () => {
  const auth = fakeAuth({ result: { ok: false, reason: "locked", retryAfter: 2.2 } });
  await assert.rejects(createStepUp({ auth }).requirePassword("x", "pair a phone"), (e) => {
    assert.equal(e.statusCode || e.status, 429);
    assert.match(e.message, /Try again in 3 seconds/);
    return true;
  });
});

test("the right password passes", async () => {
  const auth = fakeAuth();
  await createStepUp({ auth }).requirePassword("correct horse", "make a macaroon");
  assert.deepEqual(auth.seen, ["correct horse"]);
});
