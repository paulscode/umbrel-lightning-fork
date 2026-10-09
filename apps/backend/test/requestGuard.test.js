const test = require("node:test");
const assert = require("node:assert/strict");
const { jsonWrites, trustedProxies, noFraming } = require("../middlewares/requestGuard.js");

function run(mw, req) {
  const out = { status: 200, headers: {}, next: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
    set(k, v) { out.headers[k] = v; return this; },
  };
  mw({ headers: {}, path: "/v1/x", socket: {}, ...req }, res, () => { out.next = true; });
  return out;
}

test("a POST must be JSON", () => {
  assert.ok(run(jsonWrites, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" } }).next);
  for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const r = run(jsonWrites, { method: "POST", headers: type ? { "content-type": type } : {} });
    assert.equal(r.status, 415, String(type));
    assert.equal(r.next, false);
  }
  assert.ok(run(jsonWrites, { method: "GET" }).next);
  assert.ok(run(jsonWrites, { method: "DELETE" }).next, "needs a preflight anyway");
});

test("with trusted proxies set, only they reach the API", () => {
  const mw = trustedProxies(["10.21.22.67"]);
  assert.ok(run(mw, { method: "POST", socket: { remoteAddress: "10.21.22.67" } }).next);
  assert.ok(run(mw, { method: "GET", socket: { remoteAddress: "::ffff:10.21.22.67" } }).next);
  assert.equal(run(mw, { method: "GET", socket: { remoteAddress: "10.21.22.40" } }).status, 403);
  assert.equal(run(mw, { method: "POST", path: "/v1/lnd/widgets/x", socket: { remoteAddress: "10.21.22.40" } }).status, 403);
  assert.ok(run(mw, { method: "GET", path: "/v1/lnd/widgets/lightning-wallet", socket: { remoteAddress: "10.21.0.1" } }).next);
  assert.ok(run(mw, { method: "GET", path: "/ping", socket: { remoteAddress: "10.21.0.1" } }).next);
});

test("without trusted proxies, nothing changes", () => {
  assert.ok(run(trustedProxies([]), { method: "POST", socket: { remoteAddress: "10.0.0.9" } }).next);
});

test("never framed", () => {
  const r = run(noFraming, { method: "GET" });
  assert.equal(r.headers["Content-Security-Policy"], "frame-ancestors 'none'");
  assert.equal(r.headers["X-Frame-Options"], "DENY");
});
