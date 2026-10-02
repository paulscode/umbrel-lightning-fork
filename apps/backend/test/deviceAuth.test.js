const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeviceAuth, createFailureLimiter, transportOf } = require("../middlewares/deviceAuth.js");

function call(mw, headers, remoteAddress = "10.0.0.5") {
  return new Promise((resolve) => {
    const req = { headers, socket: { remoteAddress } };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body, req });
      },
    };
    mw(req, res, () => resolve({ status: "next", req }));
  });
}

const devices = () => ({
  verify: (token, transport) => (token === "lf_good" ? { id: "dev1", label: "P", transport } : null),
});

test("a valid key passes and names the device", async () => {
  const mw = createDeviceAuth({ devices });
  const out = await call(mw, { authorization: "Bearer lf_good", host: "x.local" });
  assert.equal(out.status, "next");
  assert.equal(out.req.device.id, "dev1");
});

test("a missing or wrong key is 401, and many failures 429; a valid key still passes", async () => {
  let clock = 0;
  const mw = createDeviceAuth({ devices, limiter: createFailureLimiter({ max: 3, now: () => clock }) });
  assert.equal((await call(mw, {})).status, 401);
  assert.equal((await call(mw, { authorization: "Bearer lf_bad" })).status, 401);
  assert.equal((await call(mw, { authorization: "Basic abc" })).status, 401);
  assert.equal((await call(mw, { authorization: "Bearer lf_bad" })).status, 429);
  assert.equal((await call(mw, { authorization: "Bearer lf_good" })).status, "next");
  assert.equal((await call(mw, { authorization: "Bearer lf_bad" }, "10.0.0.6")).status, 401, "per source");
  clock = 10 * 60 * 1000;
  assert.equal((await call(mw, { authorization: "Bearer lf_bad" })).status, 401, "the window passes");
});

test("transport is read off the host", () => {
  assert.equal(transportOf({ headers: { host: "abcdef.onion" } }), "tor");
  assert.equal(transportOf({ headers: { host: "ABCDEF.ONION:443" } }), "tor");
  assert.equal(transportOf({ headers: { host: "umbrel.local:7157" } }), "lan");
});
