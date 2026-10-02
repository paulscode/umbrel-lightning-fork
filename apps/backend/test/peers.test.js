// The Peers view's logic: list, connect without a channel, and disconnect,
// against a stub of the lnd service.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// logic/peers.js requires its siblings by bare path, as the app does
// with NODE_PATH set to the backend directory.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const KEY_A = "02" + "aa".repeat(32);
const KEY_B = "03" + "bb".repeat(32);

const calls = [];
let connectError = null;
const stub = {
  getPeers: async () => [
    { pubKey: KEY_A, address: "203.0.113.5:9737", inbound: false },
    { pubKey: KEY_B, address: "198.51.100.7:52011", inbound: true },
  ],
  getOpenChannels: async () => [
    { remotePubkey: KEY_A }, { remotePubkey: KEY_A },
  ],
  getNodeInfo: async (pubkey) => ({
    node: { alias: pubkey === KEY_A ? "alpha" : "", addresses: [] },
  }),
  connectPeer: async (pubKey, hostPort) => {
    calls.push(["connect", pubKey, hostPort]);
    if (connectError) {
      throw connectError;
    }
  },
  disconnectPeer: async (pubKey) => {
    calls.push(["disconnect", pubKey]);
  },
};
const lndPath = require.resolve("services/lnd.js");
require.cache[lndPath] = { id: lndPath, filename: lndPath, loaded: true, exports: stub };

const logic = require("logic/peers.js");

test("peers are listed with alias, direction and channel count", async () => {
  assert.deepEqual(await logic.listPeers(), [
    { pubKey: KEY_A, alias: "alpha", address: "203.0.113.5:9737", inbound: false, channels: 2 },
    { pubKey: KEY_B, alias: "", address: "198.51.100.7:52011", inbound: true, channels: 0 },
  ]);
});

test("connect parses the address and passes lnd a host:port", async () => {
  calls.length = 0;
  assert.deepEqual(await logic.connectPeer(`${KEY_B}@[2001:db8::1]:9737`), { pubKey: KEY_B });
  assert.deepEqual(calls, [["connect", KEY_B, "[2001:db8::1]:9737"]]);

  await assert.rejects(logic.connectPeer("not an address"), /pubkey@host:port/);
  assert.equal(calls.length, 1, "nothing reaches lnd for a bad address");
});

test("already connected is success; other lnd errors are not", async () => {
  connectError = Object.assign(new Error("Unable to connect to peer"), {
    error: { details: "already connected to peer: 03bb...@198.51.100.7:52011" },
  });
  assert.deepEqual(await logic.connectPeer(`${KEY_B}@198.51.100.7`), { pubKey: KEY_B });

  connectError = Object.assign(new Error("Unable to connect to peer"), {
    error: { details: "dial tcp 198.51.100.7:9735: connect: connection refused" },
  });
  await assert.rejects(logic.connectPeer(`${KEY_B}@198.51.100.7`), /Unable to connect/);
  connectError = null;
});

test("disconnect only from a peer this node has no channel with", async () => {
  calls.length = 0;
  assert.deepEqual(await logic.disconnectPeer(KEY_B.toUpperCase()), { pubKey: KEY_B });
  assert.deepEqual(calls, [["disconnect", KEY_B]]);

  await assert.rejects(logic.disconnectPeer(KEY_A), /channel with that peer/);
  await assert.rejects(logic.disconnectPeer("nope"), /public key/);
  assert.equal(calls.length, 1);
});
