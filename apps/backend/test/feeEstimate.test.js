const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// The on-chain fee estimate behind opening a channel and sending: what the
// page gets when the node's floor cannot be read, when lnd's rate sits under
// that floor, and when lnd fails for a reason the page has no name for.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });

const lnd = {
  addresses: 0,
  estimate: async () => ({ feeSat: "154", feerateSatPerByte: "1", satPerVbyte: "1" }),
};
stub("services/lnd.js", {
  generateAddress: async () => { lnd.addresses++; return { address: "bcrt1qestimate" }; },
  estimateFee: (address, amt, conf) => lnd.estimate(address, amt, conf),
  getWalletBalance: async () => ({ confirmedBalance: String(lnd.balance || 0) }),
});
let mempool = async () => ({ result: { mempoolminfee: 0.00001 } });
stub("logic/bitcoind.js", { getMempoolInfo: () => mempool() });

const lightning = require("logic/lightning.js");

test("the node's floor not answering is no reason for no estimate", async () => {
  mempool = async () => { throw new Error("Unable to obtain get mempool info"); };
  const r = await lightning.estimateChannelOpenFee(100000, 0, false);
  for (const level of ["fast", "normal", "slow", "cheapest"]) {
    assert.equal(r[level].feerateSatPerByte, "1", level);
    assert.ok(Number(r[level].feeSat) > 0, level);
  }
  // Nor is a node that hangs.
  mempool = () => new Promise(() => {});
  const started = Date.now();
  const h = await lightning.estimateChannelOpenFee(100000, 0, false);
  assert.ok(Date.now() - started < 7000);
  assert.equal(h.fast.code, undefined);
  mempool = async () => ({ result: { mempoolminfee: 0.00001 } });
});

test("a rate under the node's floor is raised to it, not refused", async () => {
  mempool = async () => ({ result: { mempoolminfee: 0.0000101 } }); // 1.01 sat/vB
  const r = await lightning.estimateChannelOpenFee(100000, 0, false);
  assert.equal(r.fast.code, undefined, "every level still has an estimate");
  assert.equal(r.fast.feerateSatPerByte, "2");
  // 154 at 1 sat/vB is 308 at 2, plus the channel's extra 10 vbytes.
  assert.equal(r.fast.feeSat, String(308 + 10 * 2));
  mempool = async () => ({ result: { mempoolminfee: 0.00001 } });
  const at = await lightning.estimateChannelOpenFee(100000, 0, false);
  assert.equal(at.fast.feerateSatPerByte, "1", "at the floor is fine as it is");
});

test("lnd's own reason is kept when the page has no name for it", () => {
  const withDetails = (details) => ({ error: { details } });
  assert.equal(lightning.handleEstimateFeeError(withDetails("transaction output is dust")).code, "OUTPUT_IS_DUST");
  assert.equal(lightning.handleEstimateFeeError(withDetails("insufficient funds available to construct transaction")).code, "INSUFFICIENT_FUNDS");
  assert.equal(lightning.handleEstimateFeeError(withDetails("invalid address")).code, "INVALID_ADDRESS");
  const other = lightning.handleEstimateFeeError(withDetails("the RPC server is in the process of starting up"));
  assert.equal(other.code, "ESTIMATE_FAILED");
  assert.match(other.text, /in the process of starting up/);
  // An error with no lnd details at all no longer throws inside the handler.
  assert.equal(lightning.handleEstimateFeeError(new Error("deadline exceeded")).code, "ESTIMATE_FAILED");
  assert.equal(lightning.handleEstimateFeeError(undefined).code, "ESTIMATE_FAILED");
});

test("one failing level leaves the others", async () => {
  lnd.estimate = async (a, amt, conf) => {
    if (conf === 1) {
      const e = new Error("x");
      e.error = { details: "insufficient funds available to construct transaction" };
      throw e;
    }
    return { feeSat: "154", feerateSatPerByte: "1", satPerVbyte: "1" };
  };
  const r = await lightning.estimateChannelOpenFee(100000, 0, false);
  assert.equal(r.fast.code, "INSUFFICIENT_FUNDS");
  assert.equal(r.normal.feerateSatPerByte, "1");
  lnd.estimate = async () => ({ feeSat: "154", feerateSatPerByte: "1", satPerVbyte: "1" });
});

test("estimates reuse one address rather than making one a keystroke", async () => {
  const before = lnd.addresses;
  await lightning.estimateChannelOpenFee(100001, 0, false);
  await lightning.estimateChannelOpenFee(100002, 0, false);
  assert.equal(lnd.addresses - before, 0);
  assert.ok(lnd.addresses <= 1);
});

test("sending everything under the node's floor is raised to it, the extra fee out of the amount", async () => {
  const before = lnd.estimate;
  lnd.balance = 100000;
  lnd.estimate = async (address, amt) => {
    if (amt + 154 > lnd.balance) {
      throw { error: { details: "insufficient funds available to construct transaction" } };
    }
    return { feeSat: "154", feerateSatPerByte: "1", satPerVbyte: "1" };
  };
  try {
    mempool = async () => ({ result: { mempoolminfee: 0.00001 } });
    const at = await lightning.estimateFee("bcrt1qx", 0, 6, true);
    assert.equal(at.sweepAmount, 100000 - 154);
    mempool = async () => ({ result: { mempoolminfee: 0.0000101 } }); // 1.01 sat/vB
    const raised = await lightning.estimateFee("bcrt1qx", 0, 6, true);
    assert.equal(raised.code, undefined, "raised, not refused");
    assert.equal(raised.feerateSatPerByte, "2");
    assert.equal(raised.feeSat, "308");
    assert.equal(raised.sweepAmount, 100000 - 308);
  } finally {
    lnd.estimate = before;
    mempool = async () => ({ result: { mempoolminfee: 0.00001 } });
  }
});
