const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const http = require("http");

// The bridge routes over stubbed logic: what each accepts and refuses, and
// what reaches the page when Lightning Fork does not answer.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
process.env.DASHBOARD_PLATFORM = "startos"; // no background reconcile here

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });

const calls = [];
let overview = async () => ({ enabled: true });
const operator = {
  overview: () => overview(),
  setRate: async (rate) => { calls.push(["rate", rate]); return { rate }; },
  openChannel: async (a) => { calls.push(["channel", a]); return { txid: "ab" }; },
  recoveryPhrase: async () => { calls.push(["recovery"]); return { mnemonic: ["w"] }; },
  channelBackup: async () => Buffer.from([1, 2, 3]),
  channels: async () => ({ channels: [] }),
  closeChannel: async (a) => { calls.push(["close", a]); return { txid: "cd" }; },
  withdraw: async (a) => { calls.push(["withdraw", a]); return { txid: "ef" }; },
};
stub("logic/bridgeOperator.js", { instance: () => operator });
const toggle = { on: true, nodes: [] };
stub("logic/bridgeSwitch.js", {
  instance: () => ({
    info: async () => toggle,
    set: async (enabled, node) => { calls.push(["enabled", enabled, node]); return { on: enabled }; },
    setDirections: async (toBLAKE2b) => { calls.push(["directions", toBLAKE2b]); return { toBLAKE2b }; },
    reconcile: async () => ({ text: "" }),
  }),
});

const express = require("express");
const router = require("routes/v1/bridge.js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/v1/bridge", router);
const server = http.createServer(app);
const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
let base;
test.before(async () => {
  await listening;
  base = `http://127.0.0.1:${server.address().port}/v1/bridge`;
});

async function call(method, route, body, form = false) {
  const res = await fetch(base + route, {
    method,
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

test("Lightning Fork not answering is a 200 with a sentence and the switch", async () => {
  overview = async () => { throw new Error("connect ECONNREFUSED"); };
  const r = await call("GET", "/");
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, null);
  assert.match(r.body.unavailable, /not answering/);
  assert.deepEqual(r.body.toggle, toggle, "so a bridge that keeps it down can be turned off");
  overview = async () => ({ enabled: true });
});

test("the rate and a channel's amount are JSON numbers, never form strings", async () => {
  calls.length = 0;
  assert.equal((await call("POST", "/rate", { rate: "0.005" })).status, 400);
  assert.equal((await call("POST", "/rate", { rate: "0.005" }, true)).status, 400);
  assert.equal((await call("POST", "/sha256/channel", { peer: "p", amountSat: "500000" })).status, 400);
  assert.equal((await call("POST", "/sha256/channel", { peer: "p", amountSat: "500000" }, true)).status, 400);
  assert.deepEqual(calls, [], "nothing reached the logic");
  assert.equal((await call("POST", "/rate", { rate: 0.005 })).status, 200);
  assert.equal((await call("POST", "/sha256/channel", { peer: "p", amountSat: 500000 })).status, 200);
  assert.deepEqual(calls.map((c) => c[0]), ["rate", "channel"]);
});

test("the recovery phrase only on a request that says it means it", async () => {
  calls.length = 0;
  assert.equal((await call("POST", "/sha256/recovery", {})).status, 400);
  assert.equal((await call("POST", "/sha256/recovery", { confirm: "true" }, true)).status, 400);
  assert.equal((await call("GET", "/sha256/recovery")).status, 404);
  assert.deepEqual(calls, []);
  const r = await call("POST", "/sha256/recovery", { confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.mnemonic, ["w"]);
});

test("the switch passes the node asked for", async () => {
  calls.length = 0;
  await call("POST", "/enabled", { enabled: true, node: "bitcoin-knots" });
  await call("POST", "/enabled", { enabled: false });
  assert.deepEqual(calls, [["enabled", true, "bitcoin-knots"], ["enabled", false, null]]);
});

test("the channel backup downloads as a file", async () => {
  const r = await call("GET", "/sha256/channel-backup");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="sha256-node-channel.backup"/);
  assert.deepEqual([...r.body], [1, 2, 3]);
});

test("closing a channel and sending coins take JSON types, never form strings", async () => {
  calls.length = 0;
  const cp = `${"ab".repeat(32)}:1`;
  assert.equal((await call("POST", "/sha256/channels/close", { channelPoint: cp, force: "true" })).status, 400);
  assert.equal((await call("POST", "/sha256/channels/close", { channelPoint: cp, force: "true" }, true)).status, 400);
  assert.equal((await call("POST", "/sha256/channels/close", { channelPoint: cp, satPerVbyte: "5" })).status, 400);
  assert.equal((await call("POST", "/sha256/withdraw", { address: "bc1q", amountSat: "5000" })).status, 400);
  assert.equal((await call("POST", "/sha256/withdraw", { address: "bc1q", sendAll: "true" }, true)).status, 400);
  assert.deepEqual(calls, [], "nothing reached the logic");

  assert.equal((await call("POST", "/sha256/channels/close", { channelPoint: cp })).body.txid, "cd");
  assert.equal((await call("POST", "/sha256/withdraw", { address: "bc1q", sendAll: true })).body.txid, "ef");
  assert.equal((await call("GET", "/sha256/channels")).status, 200);
  assert.deepEqual(calls, [
    ["close", { channelPoint: cp, force: false, satPerVbyte: undefined }],
    ["withdraw", { address: "bc1q", amountSat: undefined, sendAll: true, satPerVbyte: undefined }],
  ]);
});

test("the directions switch passes what it was given to the switch", async () => {
  calls.length = 0;
  assert.equal((await call("POST", "/directions", { toBLAKE2b: true })).status, 200);
  assert.deepEqual(calls, [["directions", true]]);
});
