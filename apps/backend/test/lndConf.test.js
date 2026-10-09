const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const http = require("http");

// Advanced Settings' writes: nothing a request sends can add a line of its
// own to the file lnd reads.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });

const written = [];
stub("logic/config.js", {
  normalizeSettings: (s) => s,
  writeLndConfig: async (config) => { written.push(config); },
});
stub("logic/lightning.js", { stopDaemon: async () => {} });
stub("services/disk.js", {
  readJsonFile: async () => ({ lnd: {} }),
  readUtf8File: async () => "",
  writeJsonFile: async () => {},
  writePlainTextFile: async () => {},
});

const express = require("express");
const lndConfig = require("utils/lnd-config.js");
const DEFAULT_CONFIG = require("utils/defaultConfig.js");
const lndConfMap = require("utils/lndConfMap.js");
const router = require("routes/v1/lnd/conf.js");

const app = express();
app.use(express.json());
app.use("/v1/lnd/conf", router);
const server = http.createServer(app);
const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());

// The form's payload as the camelCase middleware leaves it.
const camel = Object.fromEntries(Object.entries(lndConfMap).filter(([, k]) => k in DEFAULT_CONFIG).map(([c, k]) => [c, DEFAULT_CONFIG[k]]));

async function post(lndConfig) {
  await listening;
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/v1/lnd/conf/lnd-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lndConfig }),
  });
  return { status: res.status, body: await res.json() };
}

test("the defaults are accepted as they are", async () => {
  written.length = 0;
  const r = await post({ ...camel });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(written.length, 1);
});

test("a line break in a value is refused, checked or not", async () => {
  for (const extra of [
    { alias: "node\nrpclisten=0.0.0.0:10009" },
    { dbBoltFreelistType: "map\nbitcoind.rpchost=203.0.113.1" },
    { paymentsExpirationGracePeriod: "30m\r" },
  ]) {
    written.length = 0;
    const r = await post({ ...camel, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(written.length, 0);
  }
});

test("a value that is not plain is refused", async () => {
  written.length = 0;
  const r = await post({ ...camel, dbBoltPageSize: { a: 1 } });
  assert.equal(r.status, 400);
  assert.equal(written.length, 0);
});

test("settings the form does not manage are dropped", async () => {
  written.length = 0;
  const r = await post({ ...camel, bitcoindRpchost: "203.0.113.1", constructor: "x" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(written[0]).filter((k) => !(k in DEFAULT_CONFIG)), []);
});

test("generate refuses a line break or a strange key as a last resort", () => {
  assert.throws(() => lndConfig.generate({ alias: "a\nb=c" }), /line break/);
  assert.throws(() => lndConfig.generate({ externalip: ["1.2.3.4", "5.6.7.8\nx=y"] }), /line break/);
  assert.throws(() => lndConfig.generate({ "a b": "c" }), /key/);
  assert.match(lndConfig.generate({ alias: "fine = name" }), /\nalias=fine = name$/);
});
