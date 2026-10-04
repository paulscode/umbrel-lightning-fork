const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// The web's payments list marks those that paid a SHA256 invoice.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });
stub("services/lnd.js", {
  getPayments: async () => ({
    payments: [
      { paymentHash: "aa", paymentRequest: "lnbchold", value: "30000" },
      { paymentHash: "bb", paymentRequest: "lnbcother", value: "10" },
    ],
  }),
});
stub("logic/bitcoinInvoices.js", {
  instance: () => ({
    linkOf: (hash, request) => (hash === "aa" && request === "lnbchold" ? { amountSat: 150, description: "a coffee", serviceLabel: "Alice's bridge" } : null),
  }),
});
const lightning = require("logic/lightning.js");

test("a payment that paid a SHA256 invoice carries what it paid there", async () => {
  const list = await lightning.getPayments();
  assert.deepEqual(list.map((p) => p.paymentHash), ["bb", "aa"], "newest first");
  assert.deepEqual(list[1].bitcoinInvoice, { amountSat: 150, description: "a coffee", serviceLabel: "Alice's bridge" });
  assert.equal(list[0].bitcoinInvoice, undefined);
});
