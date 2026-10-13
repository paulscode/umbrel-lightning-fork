const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const http = require("http");

// What hands out a credential that outlasts the session (the admin
// macaroon's lndconnect URLs, the recovery phrase, the SHA256 node's phrase,
// a bridge participant's code) asks for the dashboard password again where
// there is one, as pairing a phone does: a stolen session cookie must not
// get one. Onboarding shows the phrase to the user who just made the wallet.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });

const { createStepUp } = require("logic/stepUp.js");
stub("logic/stepUp.js", createStepUp({
  auth: {
    passwordConfigured: () => true,
    guardedVerify: async (p) => ({ ok: p === "right" }),
  },
}));
const store = { seed: ["abandon"], onboarding: false };
stub("logic/disk.js", { getJsonStore: async () => store });
stub("logic/system.js", { getLndConnectUrls: async () => ({ restLocal: "lndconnect://x" }) });
stub("logic/mempool.js", {});
stub("logic/bridgeOperator.js", {
  instance: () => ({
    issueCode: async (label) => ({ code: "c", label }),
    recoveryPhrase: async () => ({ words: ["w"] }),
  }),
});
stub("logic/bridgeSwitch.js", { instance: () => ({ reconcile: async () => {} }) });

const express = require("express");
const app = express();
app.use(express.json());
app.use("/v1/system", require("routes/v1/system/index.js"));
app.use("/v1/bridge", require("routes/v1/bridge.js"));
app.use(require("middlewares/errorHandling.js"));
const server = http.createServer(app);
const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());

async function post(route, body) {
  await listening;
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const routes = [
  ["/v1/system/lndconnect-urls", {}],
  ["/v1/system/seed", {}],
  ["/v1/bridge/sha256/recovery", { confirm: true }],
  ["/v1/bridge/participants", { label: "a" }],
];

test("each asks for the dashboard password", async () => {
  for (const [route, body] of routes) {
    let r = await post(route, body);
    assert.equal(r.status, 403, `${route}: ${JSON.stringify(r.body)}`);
    r = await post(route, { ...body, password: "wrong" });
    assert.equal(r.status, 403, route);
    r = await post(route, { ...body, password: "right" });
    assert.equal(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
  }
});

test("onboarding shows the recovery phrase without it", async () => {
  store.onboarding = true;
  try {
    const r = await post("/v1/system/seed", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.seed, ["abandon"]);
  } finally {
    store.onboarding = false;
  }
});
