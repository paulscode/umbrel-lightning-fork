// The market's rate between BTCB2 and bitcoin, against which a service's
// price for paying a Bitcoin invoice is checked before anything is paid.
//
// The rate is Neoxa's BTCB2_BTC market (see tickerRate), in BTC (SHA256) per
// BTCB2. A price is
// accepted when it is no worse for the payer than that rate by more than the
// premium the user allows, widened by how far the market itself moved in the
// last hour: a service that set its rate at the top of a swing must not be
// refused for the swing. The widening is capped, so a market in turmoil
// cannot open the door to any price at all.
//
// Without a usable rate nothing is paid: the check is never skipped.
const { ValidationError } = require("../models/errors.js");

const PAIR = "BTCB2_BTC";
const TICKER_URL = `https://neoxa.exchange/api/exchange/ticker/${PAIR}`;
const CANDLES_URL = `https://neoxa.exchange/api/exchange/candles/${PAIR}?interval=5m&limit=12`;
const TTL_MS = 60 * 1000;
// A failed fetch is not retried for this long, so an outage costs one
// request per interval rather than one per payment screen.
const FAILURE_TTL_MS = 15 * 1000;
// How far back the market's own movement counts, and how much it may widen
// what is allowed.
const WINDOW_SECONDS = 60 * 60;
const VOLATILITY_CAP = 0.1;

const UNAVAILABLE = "The market rate to check the service's price against is not available right now, so nothing was paid. Try again in a minute.";

function positive(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

// The market's rate, or null for anything but a well-formed answer for this
// pair: the middle one of the last trade, the best bid and the best ask. On a
// market this thin one trade, made by anyone and at any price the book
// allows, would otherwise be the rate a service's price is judged by; while
// orders stand on both sides it moves nothing. Without a usable book, the
// last trade alone.
function tickerRate(data) {
  if (!data || typeof data !== "object" || data.success !== true || !data.ticker || typeof data.ticker !== "object") {
    return null;
  }
  if (data.pair !== undefined && data.pair !== PAIR) {
    return null;
  }
  const last = positive(data.ticker.lastPrice);
  const bid = positive(data.ticker.bestBid);
  const ask = positive(data.ticker.bestAsk);
  if (!last || !bid || !ask || bid > ask) {
    return last;
  }
  return [last, bid, ask].sort((a, b) => a - b)[1];
}

// The range the market traded in over the last hour, as a fraction of the
// last price, capped. Five-minute buckets without trades are left out of the
// feed, so the twelve it returns can reach further back than an hour; those
// are not counted. Unreadable candles count as no movement, which only ever
// allows less.
function volatilityOf(data, lastPrice, nowSeconds) {
  if (!data || data.success !== true || !Array.isArray(data.candles) || !positive(lastPrice)) {
    return 0;
  }
  let high = null;
  let low = null;
  for (const candle of data.candles) {
    if (!candle || typeof candle !== "object") {
      continue;
    }
    const time = Number(candle.time);
    const h = positive(candle.high);
    const l = positive(candle.low);
    if (!Number.isFinite(time) || time < nowSeconds - WINDOW_SECONDS || time > nowSeconds + WINDOW_SECONDS || !h || !l || l > h) {
      continue;
    }
    high = high === null ? h : Math.max(high, h);
    low = low === null ? l : Math.min(low, l);
  }
  if (high === null) {
    return 0;
  }
  return Math.min(VOLATILITY_CAP, (high - low) / lastPrice);
}

// The worst rate (outgoing per incoming, bitcoin per BTCB2) a price may
// have and still be accepted.
function minimumRate(reference, premium) {
  return reference.rate / (1 + premium + reference.volatility);
}

function defaultFetchJson(url) {
  return require("./price.js").defaultFetchJson(url);
}

function monotonicNow() {
  const { performance } = require("perf_hooks");
  return performance.now();
}

function createReferenceRate({
  fetchJson = defaultFetchJson,
  now = monotonicNow,
  clock = () => Math.floor(Date.now() / 1000),
  log = console.warn,
} = {}) {
  let entry = null;

  async function fetchOne(url) {
    try {
      return await fetchJson(url);
    } catch (error) {
      log(`[reference rate] ${url}: ${error && error.message ? error.message : error}`);
      return null;
    }
  }

  async function load() {
    const [ticker, candles] = await Promise.all([fetchOne(TICKER_URL), fetchOne(CANDLES_URL)]);
    const rate = tickerRate(ticker);
    if (!rate) {
      return null;
    }
    return { rate, volatility: volatilityOf(candles, rate, clock()), at: clock(), source: "Neoxa" };
  }

  // {rate, volatility, at, source}, or a ValidationError with a sentence.
  async function get() {
    if (!entry || (!entry.pending && now() - entry.at >= entry.ttl)) {
      const pending = load()
        .catch(() => null)
        .then((value) => {
          entry = { value, at: now(), ttl: value ? TTL_MS : FAILURE_TTL_MS };
          return value;
        });
      entry = { pending };
    }
    const value = entry.pending ? await entry.pending : entry.value;
    if (!value) {
      const error = new ValidationError(UNAVAILABLE, 503);
      error.refusal = "reference_unavailable";
      throw error;
    }
    return value;
  }

  return { get };
}

module.exports = {
  createReferenceRate,
  tickerRate,
  volatilityOf,
  minimumRate,
  TICKER_URL,
  CANDLES_URL,
  VOLATILITY_CAP,
  WINDOW_SECONDS,
  TTL_MS,
  FAILURE_TTL_MS,
};
