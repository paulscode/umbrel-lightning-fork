const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const http = require("http");

// Advanced Settings as the page uses it, against the settings the app writes
// at start: Resize Channels off is not saved, so the page must still read it
// as off and save the form, and a form without it must not turn it on.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });
const files = {};
stub("services/disk.js", {
  fileExists: async (p) => p in files,
  readJsonFile: async (p) => JSON.parse(files[p]),
  readUtf8File: async (p) => files[p] || "",
  writeJsonFile: async (p, v) => { files[p] = JSON.stringify(v); },
  writePlainTextFile: async (p, v) => { files[p] = v; },
});
stub("logic/lightning.js", { stopDaemon: async () => {} });

const express = require("express");
const constants = require("utils/const");
const config = require("logic/config.js");
const lndConfMap = require("utils/lndConfMap.js");
const DEFAULT_CONFIG = require("utils/defaultConfig.js");
const router = require("routes/v1/lnd/conf.js");

const app = express();
app.use(express.json());
app.use("/v1/lnd/conf", router);
const server = http.createServer(app);
const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());

async function call(method, body) {
  await listening;
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/v1/lnd/conf/lnd-config`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The form's payload, as the camelCase middleware leaves it.
const toCamel = (settings) => {
  const camel = {};
  for (const [c, key] of Object.entries(lndConfMap)) {
    if (key in settings) camel[c] = settings[key];
  }
  return camel;
};

test("saved off, read as off, and the form saves", async () => {
  await config.writeLndConfig(DEFAULT_CONFIG, {});
  assert.equal("protocol.splice" in JSON.parse(files[constants.JSON_SETTINGS_FILE]).lnd, false);

  const got = await call("GET");
  assert.equal(got.status, 200);
  assert.equal(got.body["protocol.splice"], false);

  const form = toCamel({ ...DEFAULT_CONFIG, ...got.body, alias: "renamed" });
  const saved = await call("POST", { lndConfig: form });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.doesNotMatch(files[constants.UMBREL_LND_CONF_FILEPATH], /protocol\.splice/);

  // A form without the setting at all: off, not refused, not on.
  const { protocolSplice: _omit, ...without } = form;
  const again = await call("POST", { lndConfig: without });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.doesNotMatch(files[constants.UMBREL_LND_CONF_FILEPATH], /protocol\.splice/);
  assert.equal((await call("GET")).body["protocol.splice"], false);
});
