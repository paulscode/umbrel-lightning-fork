const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const http = require("http");

// The dashboard's pairing route: the dashboard password is asked before a
// pairing code is made, since the phone's key outlasts the session.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });

let configured = true;
const verified = [];
stub("logic/auth.js", {
  passwordConfigured: () => configured,
  guardedVerify: async (password) => {
    verified.push(password);
    return password === "correct horse" ? { ok: true } : { ok: false, reason: "wrong" };
  },
});
let created = 0;
stub("logic/devices.js", {
  createPending: async () => {
    created += 1;
    return { device: { id: "aaaaaaaaaaaa", status: "pending" }, enrollCode: "e_x", enrollExpires: Date.now() + 300000 };
  },
});
stub("logic/mobileAccess.js", {
  getListenerProblem: () => "",
  endpoints: () => ({ lanUrl: "https://lan" }),
  rootCaPem: () => "",
});
stub("utils/x509.js", { fingerprint: () => "" });

const express = require("express");
const router = require("routes/v1/devices.js");
const app = express();
app.use(express.json());
app.use("/v1/devices", router);
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
const server = http.createServer(app);
const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());

async function pair(body) {
  await listening;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("no code is made without the dashboard password", async () => {
  configured = true;
  const before = created;
  const missing = await pair({});
  assert.equal(missing.status, 403);
  assert.match(missing.body.error, /pair a phone/);
  const wrong = await pair({ password: "guess" });
  assert.equal(wrong.status, 403);
  assert.equal(created, before);
});

test("the right password makes a code", async () => {
  configured = true;
  const res = await pair({ password: "correct horse" });
  assert.equal(res.status, 201);
  assert.equal(res.body.pairing.code, "e_x");
  assert.equal(verified.at(-1), "correct horse");
});

test("without a dashboard password (Umbrel) pairing asks nothing", async () => {
  configured = false;
  const res = await pair({});
  assert.equal(res.status, 201);
});
