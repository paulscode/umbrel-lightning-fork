// Paying Bitcoin invoices end to end: a fake service on a real HTTPS
// listener, speaking the payer API, with behaviour each test sets (honest,
// or wrong in one way), a fake LND that decodes and pays from the same
// ledger, and the dashboard's real logic between them.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const https = require("https");
const x509 = require("../utils/x509.js");
const { encodeBridgeCode } = require("../utils/bridgeCode.js");
const { createBridgeClient, defaultRequest, refusalFromBody } = require("../logic/bitcoinBridge.js");
const { createBitcoinInvoices, estimateFor, PRICE_TOLERANCE } = require("../logic/bitcoinInvoices.js");
const { createReferenceRate } = require("../logic/referenceRate.js");
const { createMobile, BITCOIN_INVOICE_CAPABILITY } = require("../logic/mobile.js");
const { LndError } = require("../models/errors.js");

delete process.env.TOR_PROXY_IP;
delete process.env.TOR_PROXY_PORT;

const NOW = 1_800_000_000;
const OWN = "02" + "11".repeat(32);
const SERVICE_NODE = "03" + "44".repeat(32);
const MACAROON = "0201036c6e64abcdef";
const REFERENCE = 0.005;
const CAPABLE = { capabilities: [BITCOIN_INVOICE_CAPABILITY] };

const authority = x509.createAuthority();
const serverCert = x509.createServerCert({ authority, names: ["127.0.0.1"] });
const PIN = x509.fingerprint(serverCert.certPem);

const sha256 = (hex) => crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

// Invoices both fakes can read, the node's payments and the service's
// swaps, by payment hash.
function createLedger() {
  return { invoices: new Map(), payments: new Map(), swaps: new Map(), counter: 0 };
}

// A Bitcoin invoice (no option_blake2b) for `amountMsat`, its preimage kept
// where the service will find it once it "pays".
function bitcoinInvoice(ledger, { amountMsat = 150000, expiry = 3600, description = "a coffee in Bitcoin" } = {}) {
  const preimage = crypto.randomBytes(32).toString("hex");
  const hash = sha256(preimage);
  const request = `lnbc${ledger.counter++}x${hash.slice(0, 8)}`;
  ledger.invoices.set(request, {
    destination: "02" + "55".repeat(32),
    paymentHash: hash,
    numSatoshis: String(Math.floor(amountMsat / 1000)),
    numMsat: String(amountMsat),
    timestamp: String(NOW - 60),
    expiry: String(expiry),
    description,
    features: { 9: { name: "tlv-onion" }, 14: { name: "payment-addr" } },
    preimage,
  });
  return { request, hash, preimage };
}

// The service. `behave` decides what it does; by default it is honest.
function startService(ledger, behave = {}) {
  const calls = { info: 0, quote: 0, swap: 0, unauthorized: 0, requests: 0 };
  const server = https.createServer({ key: serverCert.keyPem, cert: serverCert.certPem }, (req, res) => {
    calls.requests++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const fail = (status, code, sentence) => send(status, { code: 2, message: `${code}: ${sentence}`, details: [] });
      if (req.headers["grpc-metadata-macaroon"] !== MACAROON) {
        calls.unauthorized++;
        return send(500, { code: 2, message: "verification failed: signature mismatch after caveat verification", details: [] });
      }
      const b = behave;
      const rate = b.rate || 0.0049;
      const spread = b.spread === undefined ? 0.01 : b.spread;
      if (req.method === "GET" && req.url === "/v2/bridge/info") {
        calls.info++;
        return send(200, {
          version: b.version || 1,
          node: b.infoNode || SERVICE_NODE,
          directions: [
            {
              name: "toSHA256",
              open: b.closed ? false : true,
              refusal: b.closed ? "no_liquidity: nothing left" : "",
              refusal_code: b.closed ? "no_liquidity" : "",
              rate,
              rate_set_at: String(NOW - 30),
              spread,
              min_msat: "100000",
              max_msat: "500000000",
            },
          ],
        });
      }
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && req.url === "/v2/bridge/quote") {
        calls.quote++;
        if (b.quoteError) {
          return fail(...b.quoteError);
        }
        const x = ledger.invoices.get(body.invoice);
        if (!x) {
          return fail(400, "invalid_invoice", "neither node can read it");
        }
        const live = ledger.swaps.get(x.paymentHash);
        if (live && live.state === "settled") {
          return fail(409, "already_paid", "settled");
        }
        if (live && !["failed", "aborted", "expired"].includes(live.state)) {
          return fail(409, "in_progress", "a swap for this hash is in progress");
        }
        const out = Number(x.numMsat);
        const incoming = Math.ceil(Math.ceil((out / rate) * (1 + spread)) * (b.amountFactor || 1));
        const y = `lnbcy${ledger.counter++}`;
        ledger.invoices.set(y, {
          destination: b.payee || SERVICE_NODE,
          paymentHash: b.hash || x.paymentHash,
          numSatoshis: String(Math.floor(incoming / 1000)),
          numMsat: String(incoming),
          timestamp: String(ledger.now()),
          expiry: "600",
          description: "swap toSHA256",
          features: b.noBlake2b ? { 9: {}, 14: {} } : { 9: {}, 14: {}, 512: { name: "option_blake2b" } },
        });
        const expiresAt = ledger.now() + (b.expiresIn === undefined ? 120 : b.expiresIn);
        ledger.swaps.set(x.paymentHash, { state: "offered", hold: y, incoming, out, preimage: x.preimage, expiresAt });
        return send(200, {
          hold_invoice: y,
          hash: Buffer.from(x.paymentHash, "hex").toString("base64"),
          incoming_msat: String(incoming),
          outgoing_msat: String(out),
          rate,
          spread,
          cltv_delta: 333,
          direction: "toSHA256",
          expires_at: String(expiresAt),
        });
      }
      if (req.method === "POST" && req.url === "/v2/bridge/swap") {
        calls.swap++;
        if (b.swapDown) {
          req.socket.destroy();
          return undefined;
        }
        const hash = Buffer.from(body.hash, "base64").toString("hex");
        const swap = ledger.swaps.get(hash);
        if (!swap) {
          return fail(404, "not_found", "no swap with that hash");
        }
        const out = { hash: body.hash, state: b.swapState || swap.state, incoming_msat: String(swap.incoming), outgoing_msat: String(swap.out) };
        if (out.state === "settled") {
          out.preimage = Buffer.from(swap.preimage, "hex").toString("base64");
        }
        return send(200, out);
      }
      return send(404, { code: 5, message: "Not Found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `https://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        calls,
        behave,
        code: (extra = {}) => encodeBridgeCode({ label: "Test service", url, node: SERVICE_NODE, macaroon: MACAROON, cert: PIN, ...extra }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function lndError(details, code) {
  return new LndError("Unable to send lightning payment", { details, code });
}

// The node: decodes from the ledger, and pays by `pay(request, decoded)`,
// which by default succeeds and lets the service settle.
function createLnd(ledger, pay) {
  const sends = [];
  const settle = (decoded) => {
    const swap = ledger.swaps.get(decoded.paymentHash);
    const record = {
      paymentHash: decoded.paymentHash,
      paymentRequest: decoded.request,
      status: "SUCCEEDED",
      valueSat: decoded.numSatoshis === "0" ? "0" : String(Math.ceil(Number(decoded.numMsat) / 1000)),
      feeSat: "2",
      paymentPreimage: swap ? swap.preimage : "",
      creationDate: String(ledger.now()),
    };
    ledger.payments.set(decoded.paymentHash, record);
    if (swap) {
      swap.state = "settled";
    }
    return record;
  };
  const lnd = {
    sends,
    getInfo: async () => ({ identityPubkey: OWN }),
    decodePaymentRequest: async (pr) => {
      const decoded = ledger.invoices.get(pr);
      if (!decoded) {
        throw new LndError("Unable to decode payment request", { details: "invalid index of 1" });
      }
      return { ...decoded, preimage: undefined };
    },
    listRecentPayments: async () => ({ payments: [...ledger.payments.values()] }),
    getOnChainTransactions: async () => [],
    getInvoices: async () => ({ invoices: [] }),
    sendPayment: async (pr, amt, paymentAmount, feeLimit) => {
      const decoded = { ...ledger.invoices.get(pr), request: pr };
      sends.push({ pr, amt, paymentAmount, feeLimit });
      if (ledger.payments.get(decoded.paymentHash) && ledger.payments.get(decoded.paymentHash).status !== "FAILED") {
        throw lndError("payment is in transition");
      }
      ledger.payments.set(decoded.paymentHash, { paymentHash: decoded.paymentHash, paymentRequest: pr, status: "IN_FLIGHT", valueSat: String(Math.ceil(Number(decoded.numMsat) / 1000)), creationDate: String(ledger.now()) });
      const record = await (pay || (async (p, d, s) => s(d)))(pr, decoded, settle);
      return { paymentHash: record.paymentHash, paymentPreimage: record.paymentPreimage, valueSat: record.valueSat, feeSat: record.feeSat };
    },
  };
  return lnd;
}

function failPayment(ledger, decoded, details = "incorrect payment details") {
  ledger.payments.set(decoded.paymentHash, {
    paymentHash: decoded.paymentHash,
    paymentRequest: decoded.request,
    valueSat: String(Math.ceil(Number(decoded.numMsat) / 1000)),
    creationDate: String(ledger.now()),
    ...ledger.payments.get(decoded.paymentHash),
    status: "FAILED",
  });
  const swap = ledger.swaps.get(decoded.paymentHash);
  if (swap) {
    swap.state = "failed";
  }
  throw lndError(details);
}

function memoryFiles() {
  const files = {};
  return {
    files,
    read: (f) => (files[f] ? JSON.parse(files[f]) : null),
    write: (f, d) => {
      files[f] = JSON.stringify(d);
    },
  };
}

function referenceFeed({ rate = REFERENCE, down = false, candles = [] } = {}) {
  return createReferenceRate({
    fetchJson: async (url) => {
      if (down) {
        throw new Error("connect ETIMEDOUT");
      }
      return url.includes("ticker")
        ? { success: true, pair: "BTCB2_BTC", ticker: { lastPrice: rate } }
        : { success: true, pair: "BTCB2_BTC", interval: "5m", candles };
    },
    clock: () => NOW,
    log: () => {},
  });
}

// The whole thing, with a service configured unless `configure` is false.
async function world({ behave = {}, pay, reference = {}, configure = true, payWaitMs = 2000, files = memoryFiles(), ledger = createLedger() } = {}) {
  let t = NOW;
  ledger.now = () => t;
  const service = await startService(ledger, behave);
  const lnd = createLnd(ledger, pay);
  const make = () =>
    createBitcoinInvoices({
      settingsFile: "settings.json",
      paymentsFile: "payments.json",
      read: files.read,
      write: files.write,
      bridge: createBridgeClient(),
      reference: referenceFeed(reference),
      now: () => t,
      clock: () => t * 1000,
      log: () => {},
    });
  const invoices = make();
  if (configure) {
    await invoices.setService(service.code());
  }
  const mobileFor = (bi) =>
    createMobile({ lnd: () => lnd, bitcoinInvoices: () => bi, now: () => t, payWaitMs, network: () => "mainnet" });
  return {
    ledger,
    service,
    lnd,
    invoices,
    files,
    mobile: mobileFor(invoices),
    // A dashboard restarted: nothing in memory, the same files.
    restart: () => {
      const fresh = make();
      return { invoices: fresh, mobile: mobileFor(fresh) };
    },
    tick: (s) => {
      t += s;
    },
    close: () => service.close(),
  };
}

const estimateOf = async (w, request) => (await w.mobile.decode(request, CAPABLE)).estimate;

test("the estimate is the quote's formula, rounded up, with the spread as the fee", () => {
  const e = estimateFor(150000, { rate: 0.0049, spread: 0.01 });
  assert.equal(e.incomingMsat, Math.ceil((150000 / 0.0049) * 1.01));
  assert.equal(e.incomingSat, Math.ceil(e.incomingMsat / 1000));
  assert.equal(e.feeSat, Math.ceil(e.incomingSat - 150000 / 0.0049 / 1000));
  assert.equal(e.maxIncomingSat, Math.ceil(e.incomingSat * (1 + PRICE_TOLERANCE)));
  // A sub-sat remainder still rounds up.
  const tiny = estimateFor(1001, { rate: 1, spread: 0 });
  assert.equal(tiny.incomingSat, 2);
  assert.equal(estimateFor(100000, { rate: 1, spread: 0 }).feeSat, 0);
  assert.equal(e.routingFeeLimitSat, Math.max(10, Math.ceil(e.incomingSat * 0.01)));
});

test("settings: a code is checked with the service once, and its credential never shown", async () => {
  const w = await world({ configure: false });
  try {
    assert.equal(w.invoices.get().service, null);
    assert.equal(w.invoices.get().premium, 0.05);
    const set = await w.invoices.setService(w.service.code());
    assert.equal(set.service.label, "Test service");
    assert.equal(set.service.node, SERVICE_NODE);
    assert.equal(set.terms.open, true);
    assert.equal(set.terms.minSat, 100);
    assert.ok(!JSON.stringify(w.invoices.get()).includes(MACAROON), "never the credential");
    assert.ok(w.files.files["settings.json"].includes(MACAROON), "but it is kept");
    // It survives a restart.
    assert.equal(w.restart().invoices.get().service.url, w.service.url);
    w.invoices.setPremium(0.1);
    assert.equal(w.invoices.get().premium, 0.1);
    assert.throws(() => w.invoices.setPremium(0.3), /between 0.5% and 25%/);
    assert.throws(() => w.invoices.setPremium("x"), /between/);
    assert.equal(w.invoices.removeService().service, null);
  } finally {
    await w.close();
  }
});

test("settings: a code for another node, a revoked credential or a garbled code are refused", async () => {
  const w = await world({ configure: false });
  try {
    await assert.rejects(() => w.invoices.setService(w.service.code({ node: "02" + "66".repeat(32) })), (e) => e.refusal === "wrong_node");
    await assert.rejects(() => w.invoices.setService(w.service.code({ macaroon: "0201ff" })), (e) => e.refusal === "not_authorized" && /revoked/.test(e.message));
    await assert.rejects(() => w.invoices.setService("lfbridge:xyz!"), (e) => e.refusal === "invalid_code" && /damaged/.test(e.message));
    w.service.behave.version = 2;
    await assert.rejects(() => w.invoices.setService(w.service.code()), (e) => e.refusal === "unsupported_version");
    assert.equal(w.invoices.get().service, null, "nothing was saved");
  } finally {
    await w.close();
  }
});

test("the client pins the certificate: another one gets nothing, not even the credential", async () => {
  const w = await world({ configure: false });
  try {
    const other = x509.fingerprint(x509.createAuthority().certPem);
    await assert.rejects(() => w.invoices.setService(w.service.code({ cert: other })), (e) => e.refusal === "cert_mismatch");
    assert.equal(w.service.calls.requests, 0, "no request was sent");
  } finally {
    await w.close();
  }
});

test("an onion needs the node's Tor proxy", async () => {
  const service = { url: "https://abcdef.onion:8080", onion: true, macaroon: "02", node: SERVICE_NODE };
  await assert.rejects(
    () => defaultRequest({ service, method: "GET", path: "/v2/bridge/info", headers: {}, timeoutMs: 1000, env: {} }),
    (e) => e.refusal === "tor_required" && /only be reached over Tor/.test(e.message)
  );
  const w = await world({ configure: false });
  try {
    const onion = encodeBridgeCode({ label: "o", url: "https://abcdef.onion:8080", node: SERVICE_NODE, macaroon: MACAROON });
    await assert.rejects(() => w.invoices.setService(onion), (e) => e.refusal === "tor_required");
  } finally {
    await w.close();
  }
});

test("a service that does not answer is unreachable, and its error bodies are read by code", async () => {
  const gone = { url: "https://127.0.0.1:1", onion: false, cert: PIN, macaroon: "02", node: SERVICE_NODE };
  await assert.rejects(() => createBridgeClient().info(gone), (e) => e.refusal === "unreachable" && e.statusCode === 503);
  assert.equal(refusalFromBody(409, JSON.stringify({ message: "in_progress: busy" })).refusal, "in_progress");
  assert.equal(refusalFromBody(429, JSON.stringify({ message: "limit: too many" })).statusCode, 429);
  // Every code the payer API defines is known by name, so none falls back to
  // the generic refusal.
  for (const code of ["disabled", "unavailable", "invalid_request", "invalid_invoice", "no_direction", "no_amount", "too_small", "too_large", "expires_soon", "route_budget", "self_payment", "no_liquidity", "price_unavailable", "chain_unmeasured", "in_progress", "already_paid", "needs_operator", "limit", "not_found", "internal"]) {
    assert.equal(refusalFromBody(400, JSON.stringify({ message: `${code}: x` })).refusal, code, code);
  }
  assert.equal(refusalFromBody(400, JSON.stringify({ message: "something_new: what" })).refusal, "refused");
  assert.equal(refusalFromBody(500, "<html>").refusal, "internal");
  // The service's sentence is not passed on; ours is.
  assert.doesNotMatch(refusalFromBody(400, JSON.stringify({ message: "disabled: the bridge is off" })).message, /bridge/);
});

test("decode: a client that has not declared the capability gets the refusal it always got", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    await assert.rejects(() => w.mobile.decode(x.request), /has not upgraded/);
    await assert.rejects(() => w.mobile.decode(x.request, { capabilities: ["something-else"] }), /has not upgraded/);
    // Nor can it pay one as an ordinary invoice.
    await assert.rejects(() => w.mobile.payLightning({ request: x.request }), /has not upgraded/);
    assert.equal(w.service.calls.quote, 0);
  } finally {
    await w.close();
  }
});

test("decode: a Bitcoin invoice with the service's estimate and the market rate", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const t = await w.mobile.decode(`lightning:${x.request}`, CAPABLE);
    const e = estimateFor(150000, { rate: 0.0049, spread: 0.01 });
    assert.equal(t.kind, "bitcoin-invoice");
    assert.equal(t.amountSat, 150);
    assert.equal(t.paymentHash, x.hash);
    assert.equal(t.description, "a coffee in Bitcoin");
    assert.equal(t.payable, true);
    assert.equal(t.message, null);
    assert.equal(t.estimate.incomingSat, e.incomingSat);
    assert.equal(t.estimate.feeSat, e.feeSat);
    assert.equal(t.estimate.maxIncomingSat, e.maxIncomingSat);
    assert.equal(t.estimate.serviceLabel, "Test service");
    assert.equal(t.estimate.open, true);
    assert.equal(t.reference.rate, REFERENCE);
    assert.equal(t.reference.premiumAllowed, 0.05);
    assert.equal(t.reference.withinLimit, true);
    assert.equal(w.service.calls.quote, 0, "an estimate creates nothing at the service");
    // A unified request with a Bitcoin invoice: no on-chain fallback, its
    // address is the other chain's.
    const uri = await w.mobile.decode(`bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=${x.request}`, CAPABLE);
    assert.equal(uri.kind, "bitcoin-invoice");
    assert.equal(uri.fallback, undefined);
    const old = await w.mobile.decode(`bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=${x.request}`);
    assert.equal(old.kind, "onchain", "unchanged for a client without the capability");
  } finally {
    await w.close();
  }
});

test("decode: no service, no amount, a closed service, the market rate down or exceeded", async () => {
  const none = await world({ configure: false });
  try {
    const t = await none.mobile.decode(bitcoinInvoice(none.ledger).request, CAPABLE);
    assert.equal(t.kind, "bitcoin-invoice");
    assert.equal(t.estimate, null);
    assert.equal(t.payable, false);
    assert.match(t.message, /Paying SHA256 invoices/);
    const zero = await none.mobile.decode(bitcoinInvoice(none.ledger, { amountMsat: 0 }).request, CAPABLE);
    assert.equal(zero.amountSat, null);
    assert.match(zero.message, /does not say how much/);
  } finally {
    await none.close();
  }
  const closed = await world({ behave: {} });
  try {
    closed.service.behave.closed = true;
    closed.tick(60);
    const t = await closed.mobile.decode(bitcoinInvoice(closed.ledger).request, CAPABLE);
    assert.equal(t.estimate.open, false);
    assert.match(t.estimate.refusal, /can't pay this much/);
    assert.equal(t.payable, false);
  } finally {
    await closed.close();
  }
  const down = await world({ reference: { down: true } });
  try {
    const t = await down.mobile.decode(bitcoinInvoice(down.ledger).request, CAPABLE);
    assert.ok(t.estimate);
    assert.match(t.referenceError, /market rate/);
    assert.equal(t.payable, false);
  } finally {
    await down.close();
  }
  const dear = await world({ behave: { rate: 0.004 } });
  try {
    const t = await dear.mobile.decode(bitcoinInvoice(dear.ledger).request, CAPABLE);
    assert.equal(t.reference.withinLimit, false);
    assert.match(t.message, /above the market rate/);
    // Nothing has been attempted yet, so it must not say a payment was stopped.
    assert.match(t.message, /can't be paid from here/);
    assert.doesNotMatch(t.message, /nothing was paid/);
  } finally {
    await dear.close();
  }
});

test("paying: the service's request is checked and paid, and the preimage comes back", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const res = await w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat });
    assert.equal(res.status, "succeeded");
    assert.equal(res.preimage, x.preimage);
    assert.equal(sha256(res.preimage), x.hash);
    assert.equal(res.amountSat, est.incomingSat);
    assert.equal(res.feeSat, 2);
    assert.deepEqual(res.bitcoinInvoice, { amountSat: 150, description: "a coffee in Bitcoin", paymentHash: x.hash });
    assert.equal(w.lnd.sends.length, 1);
    assert.equal(w.lnd.sends[0].feeLimit, Math.max(10, Math.ceil(est.incomingSat * 0.01)));
    assert.equal(w.invoices.lastAttempt(x.hash).state, "succeeded");
    // A repeat answers from the node; a new request is told it is paid.
    const again = await w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat, resume: true });
    assert.equal(again.preimage, x.preimage);
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat }), (e) => e.refusal === "already_paid" && e.statusCode === 409);
    assert.equal(w.service.calls.quote, 1);
    assert.equal(w.lnd.sends.length, 1);
  } finally {
    await w.close();
  }
});

test("activity shows a paid Bitcoin invoice as such, with its proof", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    await w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat });
    const failed = bitcoinInvoice(w.ledger, { description: "refunded" });
    const w2 = w.restart();
    const returned = createMobile({
      lnd: () => ({ ...w.lnd, sendPayment: async (pr) => failPayment(w.ledger, { ...w.ledger.invoices.get(pr), request: pr }) }),
      bitcoinInvoices: () => w2.invoices,
      now: () => NOW,
    });
    await assert.rejects(
      () => returned.payBitcoinInvoice({ request: failed.request, maxIncomingSat: est.maxIncomingSat }),
      (e) => e.refusal === "returned" && /came back. Nothing was paid/.test(e.message)
    );
    const { items } = await w2.mobile.activity({});
    const paid = items.find((i) => i.reference === x.hash);
    assert.equal(paid.kind, "lightning");
    assert.equal(paid.status, "complete");
    assert.equal(paid.amountSat, est.incomingSat);
    assert.equal(paid.feeSat, 2);
    assert.equal(paid.description, "a coffee in Bitcoin", "the Bitcoin invoice's, not the service's");
    assert.deepEqual(paid.bitcoinInvoice, { amountSat: 150, description: "a coffee in Bitcoin", state: "paid" });
    assert.equal(paid.preimage, x.preimage);
    const back = items.find((i) => i.reference === failed.hash);
    assert.equal(back.status, "failed");
    assert.equal(back.bitcoinInvoice.state, "returned");
    assert.equal(back.preimage, undefined);
  } finally {
    await w.close();
  }
});

// Each way a service can answer wrongly, and that nothing is paid after it.
const HOSTILE = [
  ["a different payment hash", { hash: "77".repeat(32) }, "invalid_hold_invoice", /invalid payment request, so nothing was paid/],
  ["another node", { payee: "02" + "99".repeat(32) }, "invalid_hold_invoice", /invalid payment request, so nothing was paid/],
  ["an invoice without option_blake2b", { noBlake2b: true }, "invalid_hold_invoice", /nothing was paid/],
  ["more than the user agreed to", { amountFactor: 1.01 }, "price_changed", /more than the .* you agreed to, so nothing was paid/],
  ["a request about to expire", { expiresIn: 10 }, "hold_expiring", /expire before it could be paid/],
];

for (const [what, behave, code, message] of HOSTILE) {
  test(`a request from the service with ${what} is not paid`, async () => {
    const w = await world();
    try {
      const x = bitcoinInvoice(w.ledger);
      const est = await estimateOf(w, x.request);
      Object.assign(w.service.behave, behave);
      await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat }), (e) => e.refusal === code && message.test(e.message));
      assert.equal(w.lnd.sends.length, 0, "nothing was paid");
      assert.equal(w.invoices.lastAttempt(x.hash).state, "refused");
      // Asking again does not pay that request either.
      await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat, resume: true }));
      assert.equal(w.lnd.sends.length, 0, "still nothing");
    } finally {
      await w.close();
    }
  });
}

test("a price too far from the market rate is not paid, whatever the user agreed to", async () => {
  const w = await world({ behave: { rate: 0.004 } });
  try {
    const x = bitcoinInvoice(w.ledger);
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: 10_000_000 }), (e) => e.refusal === "rate" && /above the market rate/.test(e.message) && /nothing was paid/.test(e.message));
    assert.equal(w.lnd.sends.length, 0);
  } finally {
    await w.close();
  }
  // The market's own movement in the last hour widens what is allowed.
  const swing = await world({ behave: { rate: 0.00455 }, reference: { candles: [{ time: NOW - 600, open: 0.005, high: 0.0052, low: 0.0047, close: 0.005, volume: 1 }] } });
  try {
    const x = bitcoinInvoice(swing.ledger);
    const res = await swing.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: 10_000_000 });
    assert.equal(res.status, "succeeded");
  } finally {
    await swing.close();
  }
});

test("without the market rate nothing is paid", async () => {
  const w = await world({ reference: { down: true } });
  try {
    const x = bitcoinInvoice(w.ledger);
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: 10_000_000 }), (e) => e.refusal === "reference_unavailable" && e.statusCode === 503);
    assert.equal(w.lnd.sends.length, 0);
    assert.equal(w.service.calls.quote, 0, "the service's funds were not tied up for nothing");
  } finally {
    await w.close();
  }
});

test("a payment the service holds is 'on its way'; asking again neither asks the service again nor pays twice", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const w = await world({ payWaitMs: 30, pay: async (pr, d, settle) => { await held; return settle(d); } });
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), (e) => e.statusCode === 504 && e.uncertain && e.recheck && e.refusal === "on_its_way" && /on its way/.test(e.message));
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ ...args, resume: true }), (e) => e.statusCode === 504 && e.uncertain);
    // A new request (another device, a new id) is no different.
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), (e) => e.statusCode === 504 && e.uncertain);
    // The dashboard restarts while it is held: the node says in flight.
    const later = w.restart();
    await assert.rejects(() => later.mobile.payBitcoinInvoice({ ...args, resume: true }), (e) => e.statusCode === 504 && e.uncertain);
    assert.equal(w.service.calls.quote, 1);
    assert.equal(w.lnd.sends.length, 1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    const res = await later.mobile.payBitcoinInvoice({ ...args, resume: true });
    assert.equal(res.preimage, x.preimage);
    assert.equal(w.invoices.lastAttempt(x.hash).state, "succeeded", "the outcome was recorded when it came");
    assert.equal(w.service.calls.quote, 1);
    assert.equal(w.lnd.sends.length, 1);
  } finally {
    await w.close();
  }
});

test("two requests at once for one Bitcoin invoice pay it once", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    const results = await Promise.allSettled([w.mobile.payBitcoinInvoice(args), w.mobile.payBitcoinInvoice(args)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.refusal, "already_paid");
    assert.equal(w.service.calls.quote, 1);
    assert.equal(w.lnd.sends.length, 1);
  } finally {
    await w.close();
  }
});

test("a payment that came back may be tried again: a new quote once the service has ended the last", async () => {
  let attempt = 0;
  const w = await world({
    pay: async (pr, d, settle) => {
      attempt++;
      return attempt === 1 ? failPayment(w.ledger, d) : settle(d);
    },
  });
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), (e) => e.refusal === "returned" && e.statusCode === 400 && !e.uncertain);
    assert.equal(w.invoices.lastAttempt(x.hash).state, "failed");
    const res = await w.mobile.payBitcoinInvoice(args);
    assert.equal(res.status, "succeeded");
    assert.equal(w.service.calls.quote, 2, "the service was asked again");
    assert.equal(w.lnd.sends.length, 2);
    assert.notEqual(w.lnd.sends[0].pr, w.lnd.sends[1].pr);
  } finally {
    await w.close();
  }
});

test("asking again about a payment that came back says so, and starts no new one", async () => {
  const w = await world({ pay: async (pr, d) => failPayment(w.ledger, d) });
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), (e) => e.refusal === "returned");
    for (const again of [{ resume: true }, { recheck: true }]) {
      await assert.rejects(() => w.mobile.payBitcoinInvoice({ ...args, ...again }), (e) => e.refusal === "returned" && !e.uncertain && /came back/.test(e.message));
    }
    assert.equal(w.service.calls.quote, 1, "the service was not asked for a new price");
    assert.equal(w.lnd.sends.length, 1, "nothing more was paid");
  } finally {
    await w.close();
  }
});

test("after a price rise, the estimate is the price still standing, and paying it works", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const first = await estimateOf(w, x.request);
    w.service.behave.amountFactor = 1.01;
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: first.maxIncomingSat }), (e) => e.refusal === "price_changed");
    const again = await estimateOf(w, x.request);
    assert.ok(again.maxIncomingSat > first.maxIncomingSat, "the new estimate covers the standing price");
    const res = await w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: again.maxIncomingSat });
    assert.equal(res.status, "succeeded");
    assert.equal(w.service.calls.quote, 1, "the standing price was the one paid");
  } finally {
    await w.close();
  }
});

test("a payment that came back while the service still waits pays the same request again", async () => {
  let attempt = 0;
  const w = await world({
    pay: async (pr, d, settle) => {
      attempt++;
      if (attempt === 1) {
        // No route: the node's payment failed, the service never saw it.
        w.ledger.payments.set(d.paymentHash, { ...w.ledger.payments.get(d.paymentHash), status: "FAILED" });
        throw lndError("no route found");
      }
      return settle(d);
    },
  });
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), /No route/);
    const res = await w.mobile.payBitcoinInvoice(args);
    assert.equal(res.status, "succeeded");
    assert.equal(w.service.calls.quote, 1, "its request was still good");
    assert.equal(w.lnd.sends[0].pr, w.lnd.sends[1].pr);
  } finally {
    await w.close();
  }
});

test("a payment that came back while the service is still busy with it is not tried again yet", async () => {
  const w = await world({ pay: async (pr, d) => failPayment(w.ledger, d) });
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), (e) => e.refusal === "returned");
    w.service.behave.swapState = "aborting";
    await assert.rejects(() => w.mobile.payBitcoinInvoice(args), (e) => e.refusal === "in_progress" && e.statusCode === 409 && /not finished/.test(e.message));
    assert.equal(w.service.calls.quote, 1);
    assert.equal(w.lnd.sends.length, 1);
  } finally {
    await w.close();
  }
});

test("an attempt written as paying, with no payment on the node, is settled by the service's word", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    const args = { request: x.request, maxIncomingSat: est.maxIncomingSat };
    // The dashboard stopped after writing the attempt, before paying.
    const quoted = await w.invoices.quote(x.request);
    w.invoices.addAttempt({ ...x, amountMsat: 150000, paymentHash: x.hash, request: x.request }, { state: "paying", holdInvoice: quoted.holdInvoice, expiresAt: quoted.expiresAt, hash: quoted.hash });
    // The service cannot be asked: unknown, and nothing is done.
    w.service.behave.swapDown = true;
    const later = w.restart();
    await assert.rejects(() => later.mobile.payBitcoinInvoice({ ...args, resume: true }), (e) => e.statusCode === 504 && e.uncertain);
    assert.equal(w.lnd.sends.length, 0);
    // The service says it is still waiting: that request is paid, once.
    w.service.behave.swapDown = false;
    const res = await later.mobile.payBitcoinInvoice({ ...args, resume: true });
    assert.equal(res.status, "succeeded");
    assert.equal(w.service.calls.quote, 1);
    assert.equal(w.lnd.sends.length, 1);
  } finally {
    await w.close();
  }
});

test("the service's refusals reach the user as codes and sentences", async () => {
  const cases = [
    [[409, "in_progress", "busy"], "in_progress", 409],
    [[409, "already_paid", "settled"], "already_paid", 409],
    [[429, "limit", "too many"], "limit", 429],
    [[400, "too_large", "600000000 msat is outside 100000..500000000"], "too_large", 400],
    [[503, "unavailable", "shutting down"], "unavailable", 503],
  ];
  for (const [quoteError, code, status] of cases) {
    const w = await world();
    try {
      const x = bitcoinInvoice(w.ledger);
      await estimateOf(w, x.request);
      w.service.behave.quoteError = quoteError;
      await assert.rejects(
        () => w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: 100000 }),
        (e) => e.refusal === code && e.statusCode === status && !/bridge|swap/i.test(e.message),
        code
      );
      assert.equal(w.lnd.sends.length, 0);
    } finally {
      await w.close();
    }
  }
});

test("already paid at the service and on this node: a repeat is the payment's outcome", async () => {
  const w = await world();
  try {
    const x = bitcoinInvoice(w.ledger);
    const est = await estimateOf(w, x.request);
    await w.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat });
    // The node's list no longer has it and the record was lost (a restore).
    w.ledger.payments.clear();
    w.files.files["payments.json"] = JSON.stringify({ payments: {} });
    const later = w.restart();
    await assert.rejects(() => later.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: est.maxIncomingSat, resume: true }), (e) => e.refusal === "already_paid");
    assert.equal(w.lnd.sends.length, 1);
  } finally {
    await w.close();
  }
});

test("what is not a payable Bitcoin invoice is refused before the service is asked", async () => {
  const w = await world();
  try {
    const zero = bitcoinInvoice(w.ledger, { amountMsat: 0 });
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: zero.request, maxIncomingSat: 1000 }), (e) => e.refusal === "no_amount");
    w.ledger.invoices.set("lnbcours", { ...w.ledger.invoices.get(zero.request), numMsat: "1000", features: { 512: {} } });
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: "lnbcours", maxIncomingSat: 1000 }), (e) => e.refusal === "not_bitcoin_invoice");
    const old = bitcoinInvoice(w.ledger, { expiry: 30 });
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: old.request, maxIncomingSat: 100000 }), /expired/);
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: old.request }), /most you agree to pay/);
    await assert.rejects(() => w.mobile.payBitcoinInvoice({ request: "hello", maxIncomingSat: 5 }), /not a SHA256 invoice/);
    assert.equal(w.service.calls.quote, 0);
  } finally {
    await w.close();
  }
  const none = await world({ configure: false });
  try {
    const x = bitcoinInvoice(none.ledger);
    await assert.rejects(() => none.mobile.payBitcoinInvoice({ request: x.request, maxIncomingSat: 100000 }), (e) => e.refusal === "no_service" && /Paying SHA256 invoices/.test(e.message));
  } finally {
    await none.close();
  }
});

test("an onion service is reached through Umbrel's Tor proxy, or the onion-only one StartOS passes", () => {
  const { torProxy } = require("../logic/bitcoinBridge.js");
  assert.equal(torProxy({}), null);
  assert.equal(torProxy({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "9050" }), "socks5h://10.21.21.11:9050");
  assert.equal(torProxy({ ONION_PROXY_IP: "10.0.3.1", ONION_PROXY_PORT: "9050" }), "socks5h://10.0.3.1:9050");
  // Umbrel's wins where both are set.
  assert.equal(torProxy({ TOR_PROXY_IP: "a", TOR_PROXY_PORT: "1", ONION_PROXY_IP: "b", ONION_PROXY_PORT: "2" }), "socks5h://a:1");
});

test("what users read names the other chain by its proof of work, never as Bitcoin", () => {
  // Which chain "Bitcoin" means depends on who reads it, so the sentences
  // this feature shows say SHA256.
  const sources = ["../logic/bitcoinInvoices.js", "../logic/bitcoinBridge.js"].map((f) =>
    require("fs").readFileSync(require("path").join(__dirname, f), "utf8")
  );
  for (const src of sources) {
    const strings = src.match(/"[^"\n]*"|`[^`\n]*`/g) || [];
    for (const s of strings) {
      assert.doesNotMatch(s, /Bitcoin invoice|on Bitcoin\b|Bitcoin's Lightning/, s);
    }
  }
});
