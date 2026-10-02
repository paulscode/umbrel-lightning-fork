const test = require("node:test");
const assert = require("node:assert/strict");
const { createMobile, btcToSat } = require("../logic/mobile.js");
const { LndError } = require("../models/errors.js");

const OWN = "02" + "11".repeat(32);
const OTHER = "03" + "22".repeat(32);
const NOW = 1_800_000_000;

function lndError(details) {
  return new LndError("Unable to do it", { details });
}

function harness(overrides = {}) {
  const calls = [];
  const lnd = {
    getInfo: async () => ({ identityPubkey: OWN, alias: "node", syncedToChain: true, blockHeight: "900" }),
    getWalletBalance: async () => ({ confirmedBalance: "150000", unconfirmedBalance: "2000", lockedBalance: "0" }),
    getChannelBalance: async () => ({
      localBalance: { sat: "80000" },
      remoteBalance: { sat: "120000" },
      pendingOpenLocalBalance: { sat: "0" },
    }),
    decodePaymentRequest: async (pr) => {
      if (pr.startsWith("lnbcrt")) {
        throw lndError("invoice not for current active network 'mainnet'");
      }
      if (!pr.startsWith("lnbc")) {
        throw lndError("invalid index of 1");
      }
      return {
        features: pr.includes("stock") ? { 9: { name: "tlv-onion" }, 14: { name: "payment-addr" } } : { 512: { name: "option_blake2b" } },
        destination: pr.includes("self") ? OWN : OTHER,
        paymentHash: "aa".repeat(32),
        numSatoshis: pr.includes("zero") ? "0" : "2500",
        timestamp: String(pr.includes("old") ? NOW - 7200 : NOW - 60),
        expiry: "3600",
        description: "coffee",
      };
    },
    estimateFee: async () => ({ feeSat: "1410", satPerVbyte: "10" }),
    listUnspent: async () => ({
      utxos: [
        { pkScript: "0014" + "00".repeat(20), amountSat: "100000" },
        { pkScript: "5120" + "00".repeat(32), amountSat: "50000" },
      ],
    }),
    sendCoinsAtRate: async (args) => {
      calls.push(["sendCoins", args]);
      return { txid: "bb".repeat(32) };
    },
    sendPayment: async (pr, amt, paymentAmount) => {
      calls.push(["sendPayment", pr, amt, paymentAmount]);
      return { paymentHash: "aa".repeat(32), paymentPreimage: "cc".repeat(32), valueSat: String(amt || 2500), feeSat: "3" };
    },
    newAddress: async (type) => ({ address: type === 2 ? "bc1qreused" : "bc1qfresh" }),
    addInvoiceWithExpiry: async (amount, memo, expiry) => {
      calls.push(["addInvoice", amount, memo, expiry]);
      return { paymentRequest: "lnbc1new", rHash: Buffer.from("dd".repeat(32), "hex") };
    },
    lookupInvoice: async (hash) => {
      if (hash === "ee".repeat(32)) {
        throw lndError("unable to locate invoice");
      }
      return { state: "SETTLED", value: "1000", amtPaidSat: "1000", settleDate: String(NOW), creationDate: String(NOW - 10), expiry: "3600" };
    },
    getOnChainTransactions: async () => [
      { txHash: "t1", amount: "-10500", totalFees: "500", timeStamp: String(NOW - 100), numConfirmations: 3, label: "" },
      { txHash: "t2", amount: "20000", totalFees: "0", timeStamp: String(NOW - 50), numConfirmations: 0, label: "" },
    ],
    listRecentPayments: async () => ({
      payments: [{ paymentHash: "p1", paymentRequest: "lnbc7u1pfoo", valueSat: "700", feeSat: "1", creationDate: String(NOW - 10), status: "SUCCEEDED" }],
    }),
    getInvoices: async () => ({
      invoices: [
        { rHash: Buffer.from("01", "hex"), state: "SETTLED", amtPaidSat: "300", settleDate: String(NOW - 5), memo: "tip" },
        { rHash: Buffer.from("02", "hex"), state: "OPEN", amtPaidSat: "0", creationDate: String(NOW) },
      ],
    }),
    ...overrides.lnd,
  };
  const offers = {
    decode: async (text) => {
      if (text.includes("othernet")) {
        return { type: "offer", forThisChain: false };
      }
      if (text.startsWith("lni1")) {
        return {
          type: "invoice",
          forThisChain: true,
          offer: { description: "pool payout" },
          invoice: { amountSat: 4000, createdAt: NOW - 10, relativeExpiry: 7200, paymentHash: "ff".repeat(32) },
        };
      }
      return {
        type: "offer",
        forThisChain: true,
        valid: true,
        ours: text.includes("ours"),
        offer: { description: "donations", amountSat: text.includes("fixed") ? 5000 : 0, anyAmount: !text.includes("fixed"), issuer: "Alice" },
      };
    },
    pay: async (args) => {
      calls.push(["payOffer", args]);
      return { paymentHash: "ab".repeat(32), paymentPreimage: "cd".repeat(32), amountSat: args.amountSat || 5000, feeSat: 1.2 };
    },
    createOffer: async ({ description, amountSat }) => ({ offer: { bolt12: "lno1made", offerId: "ef".repeat(32) }, created: true, description, amountSat }),
    ...overrides.offers,
  };
  const mempool = {
    recommendedFees: async () => ({ app: "m", name: "Mempool", fees: { fastestFee: 12, halfHourFee: 8.5, hourFee: 5, economyFee: 2, minimumFee: 1 } }),
    ...overrides.mempool,
  };
  const bitcoind = {
    getMempoolInfo: async () => ({ result: { mempoolminfee: 0.00001 } }),
    estimateSmartFee: async (blocks) => ({ result: { feerate: { 2: 0.0002, 6: 0.0001, 24: 0.00004 }[blocks] } }),
    ...overrides.bitcoind,
  };
  const mobile = createMobile({
    lnd: () => lnd,
    offers: () => offers,
    mempool: () => mempool,
    bitcoind: () => bitcoind,
    network: () => overrides.network || "mainnet",
    now: () => NOW,
  });
  return { mobile, calls };
}

test("BIP 21 amounts are exact sats", () => {
  assert.equal(btcToSat("0.00001"), 1000);
  assert.equal(btcToSat("1"), 1e8);
  assert.equal(btcToSat("20999999.99999999"), 2099999999999999);
  assert.equal(btcToSat("0.000000001"), null);
  assert.equal(btcToSat("-1"), null);
  assert.equal(btcToSat("1e3"), null);
});

test("wallet: on-chain and Lightning balances", async () => {
  const { mobile } = harness();
  const w = await mobile.wallet();
  assert.equal(w.onchain.confirmedSat, 150000);
  assert.equal(w.onchain.unconfirmedSat, 2000);
  assert.equal(w.lightning.outboundSat, 80000);
  assert.equal(w.lightning.inboundSat, 120000);
  assert.equal(w.blockHeight, 900);
});

test("fees: the Mempool app's rates, rounded up, never below the floor", async () => {
  const { mobile } = harness();
  const f = await mobile.fees();
  assert.equal(f.source.kind, "mempool");
  assert.deepEqual([f.low.satPerVbyte, f.medium.satPerVbyte, f.high.satPerVbyte], [5, 9, 12]);
  assert.equal(f.minimumSatPerVbyte, 1);
});

test("fees: the node's estimate when the app fails, and the floor when nothing knows", async () => {
  const failing = { recommendedFees: async () => { throw new Error("Mempool did not answer"); } };
  const node = await harness({ mempool: failing }).mobile.fees();
  assert.equal(node.source.kind, "node");
  assert.deepEqual([node.low.satPerVbyte, node.medium.satPerVbyte, node.high.satPerVbyte], [4, 10, 20]);
  assert.match(node.warning, /did not answer/);
  const none = await harness({
    mempool: { recommendedFees: async () => ({ fees: null }) },
    bitcoind: { estimateSmartFee: async () => ({ result: { errors: ["Insufficient data"] } }), getMempoolInfo: async () => ({ result: { mempoolminfee: 0.00003 } }) },
  }).mobile.fees();
  assert.equal(none.source.kind, "minimum");
  assert.ok(none.low.satPerVbyte >= 3);
  assert.ok(none.low.satPerVbyte <= none.medium.satPerVbyte && none.medium.satPerVbyte <= none.high.satPerVbyte);
});

test("decode: addresses, upper case and wrong network", async () => {
  const { mobile } = harness();
  const a = await mobile.decode("  BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4 ");
  assert.equal(a.kind, "onchain");
  assert.equal(a.address, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  assert.equal(a.amountEditable, true);
  await assert.rejects(() => mobile.decode("bcrt1q7x4gvph9j5p7j0mpj95fs7l7dcn6sf6clqq72j"), /for regtest, not mainnet/);
  await assert.rejects(() => mobile.decode("hello there"), /not an address, invoice or offer/);
  await assert.rejects(() => mobile.decode(""), /Nothing to pay/);
});

test("decode: BIP 21, with amount, label and a unified Lightning part", async () => {
  const { mobile } = harness();
  const plain = await mobile.decode("bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.0005&label=Shop");
  assert.equal(plain.kind, "onchain");
  assert.equal(plain.amountSat, 50000);
  assert.equal(plain.amountEditable, false);
  assert.equal(plain.description, "Shop");
  const unified = await mobile.decode(
    "BITCOIN:BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4?amount=0.000025&lightning=LNBC25U1PINV"
  );
  assert.equal(unified.kind, "bolt11");
  assert.equal(unified.fallback.kind, "onchain");
  const withOffer = await mobile.decode("bitcoin:?lno=lno1qfixedoffer");
  assert.equal(withOffer.kind, "offer");
  assert.equal(withOffer.amountSat, 5000);
  await assert.rejects(() => mobile.decode("bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?req-somethingnew=1"), /not support/);
  await assert.rejects(() => mobile.decode("bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=abc"), /amount/);
  // An expired Lightning part falls back to the address.
  const stale = await mobile.decode("bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=lnbcold");
  assert.equal(stale.kind, "onchain");
});

test("decode: BOLT 11 invoices", async () => {
  const { mobile } = harness();
  const inv = await mobile.decode("lightning:LNBC25U1PFOO");
  assert.equal(inv.kind, "bolt11");
  assert.equal(inv.request, "lnbc25u1pfoo");
  assert.equal(inv.amountSat, 2500);
  assert.equal(inv.expired, false);
  assert.equal(inv.ours, false);
  const zero = await mobile.decode("lnbc1zero");
  assert.equal(zero.amountSat, null);
  assert.equal(zero.amountEditable, true);
  assert.equal((await mobile.decode("lnbc1old")).expired, true);
  assert.equal((await mobile.decode("lnbc1self")).ours, true);
  await assert.rejects(() => mobile.decode("lnbcrt1x"), /different network/);
  await assert.rejects(() => mobile.decode("lnbc1stock"), /has not upgraded/);
  await assert.rejects(() => mobile.decode("lnxyz"), /not a valid Lightning invoice/);
});

test("decode: offers, BOLT 12 invoices and what is not supported", async () => {
  const { mobile } = harness();
  const offer = await mobile.decode("lno1qany");
  assert.equal(offer.kind, "offer");
  assert.equal(offer.amountEditable, true);
  assert.equal(offer.issuer, "Alice");
  const inv = await mobile.decode("lni1qinvoice");
  assert.equal(inv.kind, "bolt12-invoice");
  assert.equal(inv.amountSat, 4000);
  await assert.rejects(() => mobile.decode("lno1othernet"), /different network/);
  assert.equal((await mobile.decode("lnr1qreq")).kind, "unsupported");
  assert.match((await mobile.decode("alice@example.com")).message, /Lightning addresses/);
  assert.match((await mobile.decode("LNURL1DP68GURN8GHJ7")).message, /LNURL/);
});

test("on-chain estimate scales the node's size to the chosen rate; a sweep counts every coin", async () => {
  const { mobile } = harness();
  const est = await mobile.estimateOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 10000, satPerVbyte: 5 });
  // Largest coin first: 10.5 + 31 + 68, and a 43 vB change output, at 5.
  assert.equal(est.feeSat, 763);
  assert.equal(est.totalSat, 10763);
  const sweep = await mobile.estimateOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", sendAll: true, satPerVbyte: 2 });
  // 10.5 + 31 + 68 + 57.5 = 167 vB.
  assert.equal(sweep.feeSat, 334);
  assert.equal(sweep.amountSat, 150000 - 334);
  await assert.rejects(() => mobile.estimateOnchain({ address: "nope", amountSat: 1, satPerVbyte: 1 }), /not valid/);
  await assert.rejects(() => mobile.estimateOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 1.5, satPerVbyte: 1 }), /whole number/);
  await assert.rejects(() => mobile.estimateOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 1, satPerVbyte: 0 }), /fee rate/);
});

test("an estimate keeps the anchor reserve back and needs enough coins", async () => {
  const { mobile } = harness({ lnd: { getWalletBalance: async () => ({ confirmedBalance: "150000", reservedBalanceAnchorChan: "10000" }) } });
  const sweep = await mobile.estimateOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", sendAll: true, satPerVbyte: 2 });
  // 167 vB plus the change that keeps the reserve.
  assert.equal(sweep.feeSat, 420);
  assert.equal(sweep.amountSat, 150000 - 420 - 10000);
  await assert.rejects(
    () => mobile.estimateOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 149000, satPerVbyte: 2 }),
    /Not enough confirmed on-chain funds/
  );
});

test("an on-chain send with a request id is labelled, and found again instead of repeated", async () => {
  const sent = [];
  const txs = [];
  const { mobile } = harness({
    lnd: {
      sendCoinsAtRate: async (args) => {
        sent.push(args);
        txs.push({ txHash: "cc".repeat(32), label: args.label, amount: "-1000" });
        return { txid: "cc".repeat(32) };
      },
      getOnChainTransactions: async () => txs,
    },
  });
  const args = { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 1000, satPerVbyte: 2, requestId: "req-abcdef12" };
  const first = await mobile.sendOnchain(args);
  const second = await mobile.sendOnchain(args);
  assert.equal(sent.length, 1, "one transaction");
  assert.equal(sent[0].label, "lf-mobile:req-abcdef12");
  assert.equal(second.txid, first.txid);
});

test("a send cut off before the node answered is uncertain, not failed", async () => {
  const { mobile } = harness({
    lnd: {
      sendPayment: async () => {
        throw new LndError("Unable to send lightning payment", { code: 14, details: "Connection dropped" });
      },
      sendCoinsAtRate: async () => {
        throw new LndError("Unable to send coins", { code: 4, details: "Deadline Exceeded" });
      },
    },
  });
  await assert.rejects(() => mobile.payLightning({ request: "lnbc25u1pfoo" }), (e) => e.statusCode === 504 && e.uncertain === true);
  await assert.rejects(
    () => mobile.sendOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 1000, satPerVbyte: 2 }),
    (e) => e.statusCode === 504 && e.uncertain === true
  );
});

test("a malformed bitcoin: URI is a 400, not a crash", async () => {
  const { mobile } = harness();
  await assert.rejects(() => mobile.decode("bitcoin:%E0%A4%A"), (e) => e.statusCode === 400);
});

test("on-chain send passes the rate and turns node errors into sentences", async () => {
  const { mobile, calls } = harness();
  const res = await mobile.sendOnchain({ address: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", amountSat: 10000, satPerVbyte: 4.2 });
  assert.equal(res.txid, "bb".repeat(32));
  assert.deepEqual(calls[0][1], { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 10000, satPerVbyte: 5, sendAll: false, label: "" });
  const poor = harness({ lnd: { sendCoinsAtRate: async () => { throw lndError("insufficient funds available to construct transaction"); } } });
  await assert.rejects(
    () => poor.mobile.sendOnchain({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amountSat: 10000, satPerVbyte: 4 }),
    /Not enough confirmed on-chain funds/
  );
});

test("paying: invoices with and without amounts, offers, and refusals", async () => {
  const { mobile, calls } = harness();
  const paid = await mobile.payLightning({ request: "lnbc25u1pfoo" });
  assert.equal(paid.status, "succeeded");
  assert.equal(paid.amountSat, 2500);
  assert.deepEqual(calls.pop(), ["sendPayment", "lnbc25u1pfoo", undefined, 2500]);
  await assert.rejects(() => mobile.payLightning({ request: "lnbc1zero" }), /amount/);
  const zero = await mobile.payLightning({ request: "lnbc1zero", amountSat: 777 });
  assert.equal(zero.amountSat, 777);
  await assert.rejects(() => mobile.payLightning({ request: "lnbc1old" }), /expired/);
  await assert.rejects(() => mobile.payLightning({ request: "lnbc1self" }), /made by this node/);
  await assert.rejects(() => mobile.payLightning({ request: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" }), /on-chain/);
  const offer = await mobile.payLightning({ request: "lno1qany", amountSat: 1234, payerNote: "thanks" });
  assert.equal(offer.amountSat, 1234);
  assert.equal(offer.feeSat, 2);
  assert.deepEqual(calls.pop()[1], { offer: "lno1qany", invoice: undefined, amountSat: 1234, payerNote: "thanks" });
  await assert.rejects(() => mobile.payLightning({ request: "lno1qoursany", amountSat: 5 }), /made by this node/);
});

test("payment failures keep the node's reason when there is no sentence for it", async () => {
  const odd = harness({ lnd: { sendPayment: async () => { throw new LndError("Unable to send lightning payment", { details: "something new" }); } } });
  await assert.rejects(() => odd.mobile.payLightning({ request: "lnbc25u1pfoo" }), /Unable to send lightning payment: something new/);
  const old = harness({ lnd: { sendPayment: async () => { throw new LndError("Unable to send lightning payment", { details: "invoice does not set option_blake2b" }); } } });
  await assert.rejects(() => old.mobile.payLightning({ request: "lnbc25u1pfoo" }), /has not upgraded/);
});

test("payment failures read as sentences", async () => {
  const noRoute = harness({ lnd: { sendPayment: async () => { throw new LndError("Unable to send lightning payment: no route found"); } } });
  await assert.rejects(() => noRoute.mobile.payLightning({ request: "lnbc25u1pfoo" }), /No route/);
  const poor = harness({ lnd: { sendPayment: async () => { throw new LndError("Unable to send lightning payment: insufficient balance"); } } });
  await assert.rejects(() => poor.mobile.payLightning({ request: "lnbc25u1pfoo" }), /Not enough Lightning balance/);
});

test("receiving: the unused address, an invoice and its state", async () => {
  const { mobile, calls } = harness();
  assert.equal((await mobile.receiveAddress()).address, "bc1qreused");
  assert.equal((await mobile.receiveAddress({ fresh: true })).address, "bc1qfresh");
  const inv = await mobile.createInvoice({ amountSat: 1000, memo: "coffee" });
  assert.equal(inv.paymentHash, "dd".repeat(32));
  assert.equal(inv.expiresAt, NOW + 3600);
  assert.deepEqual(calls.pop(), ["addInvoice", 1000, "coffee", 3600]);
  const any = await mobile.createInvoice({});
  assert.equal(any.amountSat, null);
  await assert.rejects(() => mobile.createInvoice({ amountSat: 1, expirySeconds: 5 }), /expiry/);
  const status = await mobile.invoiceStatus("aa".repeat(32));
  assert.equal(status.state, "settled");
  assert.equal(status.amountPaidSat, 1000);
  await assert.rejects(() => mobile.invoiceStatus("ee".repeat(32)), (e) => e.statusCode === 404);
  await assert.rejects(() => mobile.invoiceStatus("xyz"), /payment hash/);
});

test("an open invoice past its expiry reads as expired", async () => {
  const { mobile } = harness({
    lnd: { lookupInvoice: async () => ({ state: "OPEN", value: "5", creationDate: String(NOW - 4000), expiry: "3600" }) },
  });
  assert.equal((await mobile.invoiceStatus("aa".repeat(32))).state, "expired");
});

test("offers to receive", async () => {
  const { mobile } = harness();
  const offer = await mobile.createOffer({ description: "tips" });
  assert.equal(offer.offer, "lno1made");
  assert.equal(offer.uri, "bitcoin:?lno=lno1made");
  await assert.rejects(() => mobile.createOffer({ amountSat: 100 }), /description/);
});

test("activity: transactions, payments and settled invoices, newest first", async () => {
  const { mobile } = harness();
  const { items } = await mobile.activity({ limit: 10 });
  assert.deepEqual(items.map((i) => i.id), ["inv:01", "pay:p1", "tx:t2", "tx:t1"]);
  const out = items.find((i) => i.id === "tx:t1");
  assert.equal(out.direction, "out");
  assert.equal(out.amountSat, 10000);
  assert.equal(out.feeSat, 500);
  assert.equal(items.find((i) => i.id === "tx:t2").status, "pending");
  assert.equal(items[0].description, "tip");
  assert.equal(items.find((i) => i.id === "pay:p1").description, "coffee", "from the paid invoice");
});
