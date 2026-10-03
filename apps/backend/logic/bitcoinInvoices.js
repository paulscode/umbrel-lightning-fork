// Paying SHA256 invoices (the SHA256 chain's) from this node, through a
// service someone else runs: the service answers with an invoice on this
// chain for the same payment hash, held until it has paid the Bitcoin
// invoice. It can only collect by paying, and the preimage this node gets
// back is the proof.
//
// This module keeps the one service the user configured, and the record of
// what was asked of it, and decides whether what the service sends back may
// be paid. The paying itself is logic/mobile.js's, beside every other send.
//
// Both are kept in files of their own next to the dashboard's state, written
// whole and atomically, so a backup holds them: the service in
// bitcoin-invoices.json (its credential is a secret, so the file is
// private and the credential never leaves this process), the attempts in
// bitcoin-invoice-payments.json, by payment hash.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ValidationError } = require("../models/errors.js");
const { parseBridgeCode, BridgeCodeError } = require("../utils/bridgeCode.js");
const { createBridgeClient, refusal, REFUSALS } = require("./bitcoinBridge.js");
const { createReferenceRate, minimumRate } = require("./referenceRate.js");

const DIRECTION = "toSHA256";
const DEFAULT_PREMIUM = 0.05;
const MIN_PREMIUM = 0.005;
const MAX_PREMIUM = 0.25;
// How much more than the estimate a payment may cost, for the service's
// spread moving between the estimate and the quote. The estimate shows the
// ceiling it gives, and the payment is held to the ceiling the user saw.
const PRICE_TOLERANCE = 0.005;
// The least time a request from the service must have left to be paid.
const MIN_HOLD_SECONDS = 20;
// What a payment to the service may spend on routing: 1%, at least 10 sats.
const ROUTING_FEE_FRACTION = 0.01;
const ROUTING_FEE_FLOOR_SAT = 10;
const INFO_TTL_MS = 30 * 1000;
const MAX_RECORDS = 500;

// The service's states after which an attempt has ended without paying,
// and before which it has not started on the payment.
const ENDED_STATES = ["failed", "aborted", "expired"];
const WAITING_STATES = ["quoted", "offered"];

const NO_SERVICE = "To pay SHA256 invoices, add a service in the dashboard's settings, under Paying SHA256 invoices.";
const NO_AMOUNT = "This SHA256 invoice does not say how much to pay. Only SHA256 invoices with an amount can be paid from here; ask for one with an amount.";
const INVALID_HOLD = "The service returned an invalid payment request, so nothing was paid. Do not use this service again until its operator has looked into it.";

function dataDir() {
  return path.dirname(process.env.JSON_STORE_FILE || "/data/state.json");
}

function readFileJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeFileJson(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function refuse(code, message, status = 400) {
  const error = new ValidationError(message, status);
  error.refusal = code;
  return error;
}

const sat = (msat) => Math.ceil(msat / 1000);

function percent(fraction) {
  return `${Math.round(fraction * 1000) / 10}%`;
}

function premiumValue(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n < MIN_PREMIUM || n > MAX_PREMIUM) {
    throw new ValidationError(`The premium must be between ${percent(MIN_PREMIUM)} and ${percent(MAX_PREMIUM)}.`);
  }
  return Math.round(n * 10000) / 10000;
}

// The direction this node uses out of an info answer, with its numbers
// read and checked; anything unreadable is the service's fault.
function directionOf(info) {
  const list = info && Array.isArray(info.directions) ? info.directions : [];
  const d = list.find((x) => x && x.name === DIRECTION);
  if (!d) {
    return null;
  }
  const rate = Number(d.rate);
  const spread = Number(d.spread || 0);
  const minMsat = Number(d.min_msat || 0);
  const maxMsat = Number(d.max_msat || 0);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(spread) || spread < 0 || !Number.isFinite(minMsat) || !Number.isFinite(maxMsat)) {
    throw refusal("invalid_response");
  }
  return {
    open: d.open === true,
    refusalCode: String(d.refusal_code || ""),
    rate,
    spread,
    minMsat,
    maxMsat,
    rateSetAt: Number(d.rate_set_at) || null,
  };
}

// What a quote would charge if nothing moves in between, as the service
// computes it: incoming = ceil(out / rate * (1 + spread)).
function estimateFor(outMsat, { rate, spread }) {
  const incomingMsat = Math.ceil((outMsat / rate) * (1 + spread));
  const incomingSat = sat(incomingMsat);
  // The part of the cost that is the spread, rounding included.
  const atRateSat = outMsat / rate / 1000;
  const feeSat = Math.max(0, Math.ceil(incomingSat - atRateSat - 1e-9));
  return {
    incomingMsat,
    incomingSat,
    feeSat,
    maxIncomingSat: Math.ceil(incomingSat * (1 + PRICE_TOLERANCE)),
    routingFeeLimitSat: routingFeeLimit(incomingSat),
  };
}

function routingFeeLimit(amountSat) {
  return Math.max(ROUTING_FEE_FLOOR_SAT, Math.ceil(amountSat * ROUTING_FEE_FRACTION));
}

// A refusal for an amount outside the service's bounds, with the bounds.
function boundsRefusal(code, d) {
  const [, sentence] = REFUSALS[code];
  const range = d && d.maxMsat ? ` It pays between ${sat(d.minMsat).toLocaleString("en-US")} and ${Math.floor(d.maxMsat / 1000).toLocaleString("en-US")} sats.` : "";
  return refuse(code, sentence + range);
}

function createBitcoinInvoices({
  settingsFile = () => process.env.BITCOIN_INVOICES_FILE || path.join(dataDir(), "bitcoin-invoices.json"),
  paymentsFile = () => path.join(dataDir(), "bitcoin-invoice-payments.json"),
  read = readFileJson,
  write = writeFileJson,
  bridge = createBridgeClient(),
  reference = createReferenceRate(),
  now = () => Math.floor(Date.now() / 1000),
  clock = Date.now,
  log = console.warn,
} = {}) {
  const name = (file) => (typeof file === "function" ? file() : file);
  let settings = null;
  let records = null;
  let infoCache = null;

  function loadSettings() {
    if (!settings) {
      const data = read(name(settingsFile)) || {};
      settings = {
        service: data.service && typeof data.service === "object" ? data.service : null,
        premium: Number.isFinite(Number(data.premium)) && data.premium !== null ? Number(data.premium) : DEFAULT_PREMIUM,
      };
    }
    return settings;
  }

  function saveSettings() {
    write(name(settingsFile), settings);
  }

  // The configured service with its credential, for the calls; or null.
  function service() {
    return loadSettings().service;
  }

  function premium() {
    const p = loadSettings().premium;
    return p >= MIN_PREMIUM && p <= MAX_PREMIUM ? p : DEFAULT_PREMIUM;
  }

  // The settings as the dashboard shows them: never the credential.
  function get() {
    const s = service();
    return {
      service: s
        ? { label: s.label, url: s.url, node: s.node, onion: Boolean(s.onion), cert: s.cert || null, addedAt: s.addedAt || null }
        : null,
      premium: premium(),
      premiumMin: MIN_PREMIUM,
      premiumMax: MAX_PREMIUM,
    };
  }

  // The service's current terms, asked at most every half minute.
  async function info(s = service()) {
    const key = `${s.url} ${s.node} ${s.macaroon}`;
    if (infoCache && infoCache.key === key && clock() - infoCache.at < INFO_TTL_MS) {
      return infoCache.value;
    }
    const raw = await bridge.info(s);
    if (String(raw.node || "").toLowerCase() !== s.node) {
      throw refuse("wrong_node", "The service answered with a different node than its code names, so it can't be used.");
    }
    const value = { version: Number(raw.version), direction: directionOf(raw) };
    infoCache = { key, at: clock(), value };
    return value;
  }

  // Adds the service a code describes, after asking it once that the code
  // works and that it is the node the code names.
  async function setService(code) {
    let parsed;
    try {
      parsed = parseBridgeCode(code);
    } catch (error) {
      if (error instanceof BridgeCodeError) {
        throw refuse("invalid_code", error.message);
      }
      throw error;
    }
    infoCache = null;
    const answer = await info(parsed);
    if (answer.version !== 1) {
      throw refuse("unsupported_version", "This service uses a newer version than this dashboard knows. Update the dashboard to use it.");
    }
    if (!answer.direction) {
      throw refuse("no_direction", REFUSALS.no_direction[1]);
    }
    loadSettings().service = { ...parsed, addedAt: now() };
    saveSettings();
    return { ...get(), terms: termsOf(answer.direction) };
  }

  function removeService() {
    loadSettings().service = null;
    infoCache = null;
    saveSettings();
    return get();
  }

  function setPremium(value) {
    loadSettings().premium = premiumValue(value);
    saveSettings();
    return get();
  }

  function termsOf(d) {
    return {
      open: d.open,
      refusal: d.open ? null : openRefusal(d),
      rate: d.rate,
      spread: d.spread,
      minSat: sat(d.minMsat),
      maxSat: Math.floor(d.maxMsat / 1000),
    };
  }

  function openRefusal(d) {
    return (REFUSALS[d.refusalCode] && REFUSALS[d.refusalCode][1]) || REFUSALS.disabled[1];
  }

  // The service's terms now and the reference rate, for the settings page.
  async function status() {
    const s = service();
    if (!s) {
      return { service: null };
    }
    const out = { service: get().service };
    try {
      const answer = await info(s);
      out.terms = answer.direction ? termsOf(answer.direction) : null;
    } catch (error) {
      out.error = error.message;
    }
    try {
      const ref = await reference.get();
      out.reference = { rate: ref.rate, volatilityAllowance: ref.volatility, premiumAllowed: premium() + ref.volatility, at: ref.at, source: ref.source };
    } catch (error) {
      out.referenceError = error.message;
    }
    return out;
  }

  // What paying a SHA256 invoice of `amountMsat` would cost, for the
  // payment screen: {estimate, reference, referenceError, message}, where
  // `message` says why it can't be paid now, if it can't.
  async function describe({ amountMsat, expired }) {
    if (!amountMsat) {
      return { estimate: null, message: NO_AMOUNT };
    }
    const s = service();
    if (!s) {
      return { estimate: null, message: NO_SERVICE };
    }
    let d;
    try {
      d = (await info(s)).direction;
    } catch (error) {
      if (error instanceof ValidationError) {
        return { estimate: null, message: error.message };
      }
      throw error;
    }
    if (!d) {
      return { estimate: null, message: REFUSALS.no_direction[1] };
    }
    const est = estimateFor(amountMsat, d);
    const estimate = {
      incomingSat: est.incomingSat,
      feeSat: est.feeSat,
      maxIncomingSat: est.maxIncomingSat,
      routingFeeLimitSat: est.routingFeeLimitSat,
      rate: d.rate,
      spread: d.spread,
      minSat: sat(d.minMsat),
      maxSat: Math.floor(d.maxMsat / 1000),
      serviceLabel: s.label,
      open: d.open,
    };
    let message = null;
    if (!d.open) {
      estimate.refusal = openRefusal(d);
      message = estimate.refusal;
    } else if (d.minMsat && amountMsat < d.minMsat) {
      message = boundsRefusal("too_small", d).message;
    } else if (d.maxMsat && amountMsat > d.maxMsat) {
      message = boundsRefusal("too_large", d).message;
    }
    const out = { estimate };
    try {
      const ref = await reference.get();
      const allowed = premium() + ref.volatility;
      const effective = amountMsat / est.incomingMsat;
      const withinLimit = effective >= minimumRate(ref, premium());
      out.reference = {
        rate: ref.rate,
        premiumAllowed: allowed,
        premium: ref.rate / effective - 1,
        withinLimit,
        source: ref.source,
      };
      if (!withinLimit && !message) {
        message = rateRefusal(ref, effective, true).message;
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      out.referenceError = error.message;
      message = message || error.message;
    }
    if (expired) {
      message = "This request has expired.";
    }
    out.message = message;
    return out;
  }

  // `beforePaying`: said while the user is still looking at the price, when
  // nothing has been attempted, rather than after a payment was stopped.
  function rateRefusal(ref, effective, beforePaying = false) {
    const over = ref.rate / effective - 1;
    const outcome = beforePaying ? "so it can't be paid from here" : "so nothing was paid";
    return refuse(
      "rate",
      `The service's price is ${percent(over)} above the market rate, more than the ${percent(premium() + ref.volatility)} allowed, ${outcome}. You can change what is allowed in the dashboard's settings, under Paying SHA256 invoices.`
    );
  }

  // Asks the service to pay a SHA256 invoice: {holdInvoice, expiresAt,
  // incomingMsat, outgoingMsat, hash}. The answer is not trusted for
  // anything; checkHold decides.
  async function quote(request) {
    const s = service();
    if (!s) {
      throw refuse("no_service", NO_SERVICE);
    }
    let raw;
    try {
      raw = await bridge.quote(s, request);
    } catch (error) {
      if (error.refusal === "too_small" || error.refusal === "too_large") {
        const d = infoCache && infoCache.value && infoCache.value.direction;
        throw boundsRefusal(error.refusal, d);
      }
      throw error;
    }
    const holdInvoice = String(raw.hold_invoice || "").trim();
    const expiresAt = Number(raw.expires_at);
    if (!holdInvoice || holdInvoice.length > 4096 || !Number.isFinite(expiresAt)) {
      log("[bitcoin invoices] the service's quote is incomplete");
      throw refuse("invalid_hold_invoice", INVALID_HOLD);
    }
    return {
      holdInvoice,
      expiresAt,
      hash: raw.hash ? Buffer.from(String(raw.hash), "base64").toString("hex") : "",
      incomingMsat: Number(raw.incoming_msat) || null,
      outgoingMsat: Number(raw.outgoing_msat) || null,
      rate: Number(raw.rate) || null,
      spread: Number(raw.spread) || 0,
    };
  }

  // What the service says about the payment for `paymentHash`: its state
  // and preimage, or {state: "not_found"}. Throws when it can't be asked.
  async function swapState(paymentHash) {
    const s = service();
    if (!s) {
      throw refuse("no_service", NO_SERVICE);
    }
    try {
      const raw = await bridge.swap(s, paymentHash);
      const preimage = raw.preimage ? Buffer.from(String(raw.preimage), "base64").toString("hex") : "";
      return { state: String(raw.state || ""), preimage };
    } catch (error) {
      if (error.refusal === "not_found") {
        return { state: "not_found", preimage: "" };
      }
      throw error;
    }
  }

  // The checks a request from the service must pass before a sat of it is
  // paid, against the SHA256 invoice `x` and the request `y`, both as this
  // node decoded them:
  // - the same payment hash, so the service can only collect by paying x;
  // - payable to the service's own node key, from the code;
  // - an invoice of this chain (option_blake2b);
  // - no more than the user agreed to (`maxIncomingSat`);
  // - a price within what the user allows of the market rate;
  // - time left to pay it.
  // Throws a refusal; nothing is paid after one.
  async function checkHold({ x, y, quoted, maxIncomingSat }) {
    const s = service();
    if (!s) {
      throw refuse("no_service", NO_SERVICE);
    }
    if (y.paymentHash !== x.paymentHash || (quoted.hash && quoted.hash !== x.paymentHash)) {
      log(`[bitcoin invoices] the service's request is for a different payment hash than ${x.paymentHash}`);
      throw refuse("invalid_hold_invoice", INVALID_HOLD);
    }
    if (String(y.destination || "").toLowerCase() !== s.node) {
      log(`[bitcoin invoices] the service's request for ${x.paymentHash} pays ${y.destination}, not ${s.node}`);
      throw refuse("invalid_hold_invoice", INVALID_HOLD);
    }
    if (!y.blake2b) {
      log(`[bitcoin invoices] the service's request for ${x.paymentHash} does not set option_blake2b`);
      throw refuse("invalid_hold_invoice", INVALID_HOLD);
    }
    if (!(y.amountMsat > 0)) {
      log(`[bitcoin invoices] the service's request for ${x.paymentHash} names no amount`);
      throw refuse("invalid_hold_invoice", INVALID_HOLD);
    }
    if (y.amountMsat > maxIncomingSat * 1000) {
      const error = refuse(
        "price_changed",
        `The service now asks ${sat(y.amountMsat).toLocaleString("en-US")} sats, more than the ${maxIncomingSat.toLocaleString("en-US")} you agreed to, so nothing was paid. Check the new price and try again.`,
        409
      );
      error.incomingSat = sat(y.amountMsat);
      throw error;
    }
    const ref = await reference.get();
    const effective = x.amountMsat / y.amountMsat;
    if (effective < minimumRate(ref, premium())) {
      throw rateRefusal(ref, effective);
    }
    // Last, since fetching the market rate can take a while over Tor.
    const expiresAt = Math.min(y.expiresAt, quoted.expiresAt);
    if (expiresAt - now() < MIN_HOLD_SECONDS) {
      throw refuse("hold_expiring", "The service's request would expire before it could be paid, so nothing was paid. Try again.");
    }
    return { reference: ref, effective };
  }

  // The market rate, or a refusal: asked before the service is, so that
  // without it the service's funds are not tied up by a quote for nothing.
  function referenceRate() {
    return reference.get();
  }

  // The attempts, by the SHA256 invoice's payment hash.
  function loadRecords() {
    if (!records) {
      const data = read(name(paymentsFile));
      records = data && data.payments && typeof data.payments === "object" ? data.payments : {};
    }
    return records;
  }

  function saveRecords() {
    const all = loadRecords();
    const hashes = Object.keys(all);
    if (hashes.length > MAX_RECORDS) {
      hashes
        .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
        .slice(0, hashes.length - MAX_RECORDS)
        .forEach((h) => delete all[h]);
    }
    write(name(paymentsFile), { payments: all });
  }

  // {at, request, amountMsat, description, attempts: [{at, holdInvoice,
  // expiresAt, amountMsat, state, ...}]} or null. An attempt's state is
  // "quoted" (asked, not checked yet), "refused" (failed a check, never
  // paid), "paying" (written just before the payment starts), "failed"
  // (the node's payment came back) or "succeeded".
  function record(paymentHash) {
    return loadRecords()[paymentHash] || null;
  }

  function lastAttempt(paymentHash) {
    const r = record(paymentHash);
    return r && r.attempts.length ? r.attempts[r.attempts.length - 1] : null;
  }

  function addAttempt(x, attempt) {
    const all = loadRecords();
    const r = all[x.paymentHash] || {
      at: now(),
      request: x.request,
      amountMsat: x.amountMsat,
      description: x.description || "",
      attempts: [],
    };
    r.at = now();
    r.attempts.push({ at: now(), ...attempt });
    // A handful is plenty: only the last is ever acted on.
    r.attempts = r.attempts.slice(-10);
    all[x.paymentHash] = r;
    saveRecords();
    return r.attempts[r.attempts.length - 1];
  }

  function updateAttempt(paymentHash, changes) {
    const attempt = lastAttempt(paymentHash);
    if (attempt) {
      Object.assign(attempt, changes);
      saveRecords();
    }
    return attempt;
  }

  return {
    get,
    service,
    premium,
    setService,
    removeService,
    setPremium,
    status,
    describe,
    quote,
    swapState,
    checkHold,
    referenceRate,
    record,
    lastAttempt,
    addAttempt,
    updateAttempt,
  };
}

// The dashboard's one instance, made when first used.
let shared = null;
function instance() {
  if (!shared) {
    shared = createBitcoinInvoices();
  }
  return shared;
}

module.exports = {
  instance,
  createBitcoinInvoices,
  estimateFor,
  routingFeeLimit,
  directionOf,
  premiumValue,
  DEFAULT_PREMIUM,
  MIN_PREMIUM,
  MAX_PREMIUM,
  PRICE_TOLERANCE,
  MIN_HOLD_SECONDS,
  ENDED_STATES,
  WAITING_STATES,
  NO_SERVICE,
  NO_AMOUNT,
  INVALID_HOLD,
};
