const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const http = require("http");

// The mobile API's routes over stubbed logic: what the phone learns from
// /bootstrap and /bitcoin-invoices, and what an error body carries.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });
stub("middlewares/deviceAuth.js", {
  createDeviceAuth: () => (req, res, next) => {
    req.device = { id: "d1", label: "Phone" };
    next();
  },
  createFailureLimiter: () => (req, res, next) => next(),
});
stub("logic/devices.js", { serverId: () => "srv" });
const { ValidationError } = require("models/errors.js");
stub("logic/mobile.js", {
  node: async () => ({ alias: "lf" }),
  quoteBitcoinInvoice: async ({ request }) => ({ source: "service", request, maxIncomingSat: 31000, secondsLeft: 35, minSecondsLeft: 10 }),
  decode: async () => {
    const e = new ValidationError("held", 409);
    e.refusal = "in_progress";
    e.details = { retryAfterSeconds: 7 };
    throw e;
  },
});
let service = null;
stub("logic/bitcoinInvoices.js", {
  instance: () => ({
    get: () => ({ service, premium: 0.05 }),
    status: async () => ({ service, terms: { open: true, rate: 0.0049, spread: 0.01, minSat: 1, maxSat: 150000 }, reference: { rate: 0.005, premiumAllowed: 0.06, serviceWidening: 0.01, source: "Neoxa", volatilityAllowance: 0.01 } }),
  }),
});
stub("logic/price.js", { getSupportedCurrencies: async () => ["USD", "EUR"], getPrice: async () => 1 });
for (const name of ["logic/mobileAccess.js", "logic/lightning.js", "services/lnd.js", "logic/peers.js", "logic/offers.js", "utils/x509.js"]) {
  stub(name, {});
}

const express = require("express");
const router = require("routes/api/v1/mobile.js");
const app = express();
app.use(express.json());
app.use("/api/v1", router);
const server = http.createServer(app);
const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());

async function call(method, route, body) {
  await listening;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("bootstrap names what the dashboard can do and whether a service is set up", async () => {
  service = null;
  let r = await call("GET", "/bootstrap");
  assert.deepEqual(r.body.features, ["bitcoin-invoice", "bitcoin-invoice-quote"]);
  assert.deepEqual(r.body.bitcoinInvoices, { configured: false, label: "", onion: false, premium: 0.05 });
  service = { label: "Alice's bridge", onion: true, url: "https://x.onion:8080", node: "02ab" };
  r = await call("GET", "/bootstrap");
  assert.deepEqual(r.body.bitcoinInvoices, { configured: true, label: "Alice's bridge", onion: true, premium: 0.05 });
  assert.equal(JSON.stringify(r.body).includes("macaroon"), false);
});

test("bitcoin-invoices gives the service's terms, and nothing to ask when there is none", async () => {
  service = null;
  let r = await call("GET", "/bitcoin-invoices");
  assert.equal(r.body.configured, false);
  assert.equal(r.body.terms, null);
  service = { label: "Alice's bridge", onion: false };
  r = await call("GET", "/bitcoin-invoices");
  assert.equal(r.body.terms.open, true);
  assert.equal(r.body.reference.source, "Neoxa");
  assert.equal(r.body.reference.serviceWidening, 0.01, "what the service widened its fee by, inside premiumAllowed");
});

test("an error body carries its code and details", async () => {
  const r = await call("POST", "/decode", { input: "x" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "in_progress");
  assert.deepEqual(r.body.details, { retryAfterSeconds: 7 });
});

test("a firm price for a SHA256 invoice is asked by its request, without a request id", async () => {
  const r = await call("POST", "/quote/bitcoin-invoice", { request: "lnbc1" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { source: "service", request: "lnbc1", maxIncomingSat: 31000, secondsLeft: 35, minSecondsLeft: 10 });
});

test("currencies lists what a price can be given in", async () => {
  const r = await call("GET", "/currencies");
  assert.deepEqual(r.body, { currencies: ["USD", "EUR"] });
});

// The app shows resizes but can't start one: no route of the mobile API
// reaches a splice.
test("the mobile API has no resize actions", () => {
  const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(",")} ${l.route.path}`);
  assert.ok(paths.length > 20, "the routes are read");
  for (const p of paths) {
    assert.doesNotMatch(p, /splice|resize/i, p);
  }
});
