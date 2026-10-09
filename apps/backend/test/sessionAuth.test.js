// The sign-in gate's middleware: what it lets through without a session.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DASHBOARD_PASSWORD = "correct horse";
process.env.NODE_PATH = require("node:path").join(__dirname, "..");
require("node:module").Module._initPaths();
const sessionAuth = require("../middlewares/sessionAuth.js");

function run(method, path) {
  const out = { status: 200, next: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
    set() { return this; },
  };
  sessionAuth({ method, path, headers: {} }, res, () => { out.next = true; });
  return out;
}

test("without a session, only the sign-in routes and the platform's name get through", () => {
  for (const path of ["/auth/state", "/auth/login", "/system/platform", "/System/Platform/"]) {
    assert.ok(run("GET", path).next, path);
  }
  for (const path of ["/system/info", "/system/platform/x", "/lnd/wallet/balance", "/"]) {
    const r = run("GET", path);
    assert.equal(r.next, false, path);
    assert.equal(r.status, 401, path);
  }
});
