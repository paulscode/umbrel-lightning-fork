const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// Channel resizes: the request checks, the estimate and start mappings, and
// how resize transactions are tagged.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const calls = { estimate: [], splice: [] };
let spliceResult = null;
const TXID = "a".repeat(64);
const OPEN_TXID = "b".repeat(64);
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });
stub("services/lnd.js", {
  estimateSplice: async (o) => {
    calls.estimate.push(o);
    return {
      feeSat: "478", vbytes: "239", satPerVbyte: "2", amountSat: "300000", minSat: "294",
      maxInSat: "999000", maxOutSat: "788000", minSatPerVbyte: "1", feeEstimateSource: "estimate",
      anchorReserveSat: "10000", newCapacitySat: "1300000", newLocalSat: "1099000", lockDepth: 6,
      destinationIsOurs: false, refusalCode: "",
    };
  },
  spliceChannel: async (o) => {
    calls.splice.push(o);
    if (spliceResult instanceof Error) throw spliceResult;
    return spliceResult;
  },
  getOnChainTransactions: async () => [
    { txHash: TXID, amount: "-300478", destAddresses: [], label: "splice:123:in" },
    { txHash: OPEN_TXID, amount: "-1000000", destAddresses: [], label: "" },
  ],
  // The channel was opened by OPEN_TXID and moved by TXID.
  getOpenChannels: async () => [{ channelPoint: `${TXID}:0`, originalChannelPoint: `${OPEN_TXID}:0` }],
  getClosedChannels: async () => [],
  getPendingChannels: async () => ({
    pendingOpenChannels: [], pendingClosingChannels: [], pendingForceClosingChannels: [], waitingCloseChannels: [],
  }),
});
// 144 blocks in 18,720 s: 2.1667 minutes a block.
stub("services/bitcoind.js", {
  getBlockCount: async () => ({ result: 1000 }),
  getBlockHash: async (h) => ({ result: `hash${h}` }),
  getBlock: async (hash) => ({ result: { time: hash === "hash1000" ? 1_000_000 + 18_720 : 1_000_000 } }),
});
const splice = require("logic/splice.js");
const lightning = require("logic/lightning.js");

const base = { channelPoint: `${TXID}:1`, direction: "in", amountSat: 300000, satPerVbyte: 2 };

test("a resize request is checked", () => {
  const ok = splice.spliceOptions(base);
  assert.deepEqual(ok, {
    fundingTxid: TXID, outputIndex: 1, direction: "in", amountSat: 300000, useMax: false,
    satPerVbyte: 2, targetConf: 0, addr: "", forceLowFee: false,
  });
  assert.equal(splice.spliceOptions({ ...base, useMax: true, amountSat: 0 }).amountSat, 0);
  assert.equal(splice.spliceOptions({ ...base, direction: "out", addr: "bcrt1qxyz0123456789abcd" }).addr, "bcrt1qxyz0123456789abcd");
  // An address only for moving out.
  assert.equal(splice.spliceOptions({ ...base, addr: "bcrt1qxyz0123456789abcd" }).addr, "");
  for (const bad of [
    { ...base, channelPoint: "nope" },
    { ...base, channelPoint: `${TXID}:x` },
    { ...base, direction: "sideways" },
    { ...base, amountSat: 0 },
    { ...base, amountSat: -5 },
    { ...base, amountSat: 1.5 },
    { ...base, satPerVbyte: -1 },
    { ...base, targetConf: 5000 },
    { ...base, direction: "out", addr: "<script>" },
  ]) {
    assert.throws(() => splice.spliceOptions(bad), /Invalid|must be/, JSON.stringify(bad));
  }
});

test("an estimate comes back as numbers, with the lock time on this chain's pace", async () => {
  const est = await splice.estimate(base);
  assert.equal(est.feeSat, 478);
  assert.equal(est.maxOutSat, 788000);
  assert.equal(est.lockDepth, 6);
  assert.ok(Math.abs(est.blockMinutes - 2.1667) < 0.001);
  assert.equal(est.lockMinutes, 13);
  assert.equal(calls.estimate.at(-1).direction, "in");
});

test("a started resize says how far it got, or why it stopped", async () => {
  spliceResult = { state: "broadcast", txid: TXID, newChannelPoint: `${TXID}:0` };
  assert.deepEqual(await splice.start(base), { state: "broadcast", txid: TXID, newChannelPoint: `${TXID}:0` });

  // The peer's words: printable ASCII only, at most 160 bytes.
  spliceResult = Object.assign(new Error("stopped"), {
    spliceReason: "no\u0007 way\n" + "x".repeat(300), reasonFromPeer: true,
  });
  const peer = await splice.start(base);
  assert.equal(peer.state, "aborted");
  assert.equal(peer.reasonFromPeer, true);
  assert.equal(peer.reason.length, 160);
  assert.ok(peer.reason.startsWith("no wayxxx"));

  // One of ours stays as it is.
  spliceResult = Object.assign(new Error("stopped"), { spliceReason: "fee_below_floor", reasonFromPeer: false });
  assert.deepEqual(await splice.start(base), { state: "aborted", reason: "fee_below_floor", reasonFromPeer: false });

  // Anything else is an error.
  spliceResult = new Error("peer offline");
  await assert.rejects(splice.start(base), /peer offline/);
});

test("a resize transaction is a resize, and the opening one stays an open", async () => {
  const txs = await lightning.getOnChainTransactions();
  const byHash = Object.fromEntries(txs.map((t) => [t.txHash, t.type]));
  assert.equal(byHash[TXID], "CHANNEL_RESIZE");
  assert.equal(byHash[OPEN_TXID], "CHANNEL_OPEN");
});
