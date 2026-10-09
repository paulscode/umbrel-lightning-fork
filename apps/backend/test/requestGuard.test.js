const test = require("node:test");
const assert = require("node:assert/strict");
const { jsonWrites, trustedProxies, noFraming, defaultGateway } = require("../middlewares/requestGuard.js");

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
  const mw = trustedProxies(["10.21.22.67"], () => "10.21.0.1");
  const from = (remoteAddress, method = "GET", path = "/v1/x") => run(mw, { method, path, socket: { remoteAddress } });
  assert.ok(from("10.21.22.67", "POST").next);
  assert.ok(from("::ffff:10.21.22.67").next);
  // Another app's container, for anything at all.
  assert.equal(from("10.21.22.40").status, 403);
  assert.equal(from("10.21.22.40", "POST", "/v1/lnd/wallet/create").status, 403);
  assert.equal(from("10.21.22.40", "GET", "/").status, 403);
  assert.equal(from("10.21.22.40", "GET", "/v1/lnd/widgets/lightning-wallet").status, 403);
  // umbreld reads the widgets from the host, the gateway; and only those.
  assert.ok(from("10.21.0.1", "GET", "/v1/lnd/widgets/lightning-wallet").next);
  assert.equal(from("10.21.0.1", "POST", "/v1/lnd/widgets/lightning-wallet").status, 403);
  assert.equal(from("10.21.0.1", "GET", "/v1/lnd/wallet/seed").status, 403);
  // The health check says nothing and stays open.
  assert.ok(from("10.21.22.40", "GET", "/ping").next);
});

test("without a known gateway, widgets are refused too", () => {
  const mw = trustedProxies(["10.21.22.67"], () => null);
  assert.equal(run(mw, { method: "GET", path: "/v1/lnd/widgets/x", socket: { remoteAddress: "10.21.0.1" } }).status, 403);
});

test("the gateway is read from the kernel's route table", () => {
  const table = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t00001A0A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    "eth0\t00000000\t01001A0A\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  ].join("\n");
  assert.equal(defaultGateway(table), "10.26.0.1");
  assert.equal(defaultGateway("Iface\tDestination\tGateway\n"), null);
  assert.equal(defaultGateway(""), null);
});

test("without trusted proxies, nothing changes", () => {
  assert.ok(run(trustedProxies([]), { method: "POST", socket: { remoteAddress: "10.0.0.9" } }).next);
});

test("never framed", () => {
  const r = run(noFraming, { method: "GET" });
  assert.equal(r.headers["Content-Security-Policy"], "frame-ancestors 'none'");
  assert.equal(r.headers["X-Frame-Options"], "DENY");
});
