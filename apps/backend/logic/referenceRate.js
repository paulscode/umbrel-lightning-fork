// The market's rate between BTCB2 and bitcoin, against which a service's
// price for paying a Bitcoin invoice is checked before anything is paid.
//
// The rate is Neoxa's BTCB2_BTC market (see tickerRate), in BTC (SHA256) per
// BTCB2, or NonKYC's BTCB2_USDT market over BTC/USD when that is lower: the
// worse of the two for a payer selling BTCB2, which is the one a bridge
// pricing at the worse of two venues trades at, so that its fee alone, not
// the gap between the venues, is what the payer's allowance has to cover. The
// lower venue counts down to MAX_VENUE_GAP under Neoxa and no further, so a
// second venue pushed down cannot open the door to any price either. Without
// NonKYC (it refuses many Tor exits) or a BTC/USD price, Neoxa alone.
//
// A price is accepted when it is no worse for the payer than that rate by
// more than the premium the user allows, widened by how far the market itself
// moved in the last hour (a service that set its rate at the top of a swing
// must not be refused for the swing) and by half the bid/ask spread (a bridge
// prices from the side of the book a swap trades against, which on a wide
// book sits that far from the ticker's middle). The spread is Neoxa's, or
// with NonKYC the rate, the narrower of the two venues': a spread widened on
// the venue that sets the rate, as one order each side can do on a thin book,
// then widens nothing. Held at the floor under Neoxa, the rate is already
// more than the venue gap allows a bridge, and nothing is added for a spread.
// Both widenings are capped, so a market in turmoil or a broken book cannot
// open the door to any price at all.
//
// Without a usable rate nothing is paid: the check is never skipped.
const { ValidationError } = require("../models/errors.js");

const PAIR = "BTCB2_BTC";
const TICKER_URL = `https://neoxa.exchange/api/exchange/ticker/${PAIR}`;
const CANDLES_URL = `https://neoxa.exchange/api/exchange/candles/${PAIR}?interval=5m&limit=12`;
const NONKYC_PAIR = "BTCB2_USDT";
const NONKYC_TICKER_URL = `https://api.nonkyc.io/api/v2/ticker/${NONKYC_PAIR}`;
// BTC/USD for NonKYC's dollar price: CoinGecko's, else mempool.space's.
const COINGECKO_RATES_URL = "https://api.coingecko.com/api/v3/exchange_rates";
const MEMPOOL_PRICES_URL = "https://mempool.space/api/v1/prices";
// How far under Neoxa the second venue may take the rate: the bridge's own
// default bound (bridgerpc.maxvenuegap), past which it does not quote.
const MAX_VENUE_GAP = 0.04;
const TTL_MS = 60 * 1000;
// BTC/USD moves slowly beside BTCB2, and CoinGecko limits how often it is
// asked: once per this long, and a price this old is still used.
const USD_TTL_MS = 5 * 60 * 1000;
const USD_MAX_AGE_MS = 3 * USD_TTL_MS;
// A failed fetch is not retried for this long, so an outage costs one
// request per interval rather than one per payment screen.
const FAILURE_TTL_MS = 15 * 1000;
// How far back the market's own movement counts, and how much it may widen
// what is allowed.
const WINDOW_SECONDS = 60 * 60;
const VOLATILITY_CAP = 0.1;
const HALF_SPREAD_CAP = 0.02;

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

// NonKYC's BTCB2_USDT market in dollars per BTCB2, or null: the middle one of
// its last trade, best bid and best ask, as tickerRate reads Neoxa's. Its
// numbers are strings.
function nonKYCRate(data) {
  if (!data || typeof data !== "object" || (data.ticker_id !== undefined && data.ticker_id !== NONKYC_PAIR)) {
    return null;
  }
  const last = positive(data.last_price);
  const bid = positive(data.bid);
  const ask = positive(data.ask);
  if (!last || !bid || !ask || bid > ask) {
    return last;
  }
  return [last, bid, ask].sort((a, b) => a - b)[1];
}

// Dollars per BTC out of CoinGecko's rate table or mempool.space's prices, or
// null.
function usdOf(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (data.rates && typeof data.rates === "object") {
    return data.rates.usd ? positive(data.rates.usd.value) : null;
  }
  return positive(data.USD);
}

// The rate a payer is checked against: Neoxa's, or the second venue's when
// that is lower, but never more than MAX_VENUE_GAP under Neoxa's; `floored`
// when it is held there.
function worseVenue(neoxa, second) {
  if (!second || second >= neoxa) {
    return { rate: neoxa, source: "Neoxa" };
  }
  const floor = neoxa * (1 - MAX_VENUE_GAP);
  if (second < floor) {
    return { rate: floor, source: "NonKYC", floored: true };
  }
  return { rate: second, source: "NonKYC" };
}

// Half a ticker's bid/ask spread as a fraction of its middle, capped; zero
// without a usable book, which only ever allows less.
function halfSpreadOf(bid, ask) {
  const b = positive(bid);
  const a = positive(ask);
  if (!b || !a || b > a) {
    return 0;
  }
  return Math.min(HALF_SPREAD_CAP, (a - b) / (a + b));
}

// What a price may be above the reference rate: the user's premium, the
// market's movement and half the venue's spread.
function allowance(reference, premium) {
  return premium + reference.volatility + (reference.halfSpread || 0);
}

// The worst rate (outgoing per incoming, bitcoin per BTCB2) a price may
// have and still be accepted.
function minimumRate(reference, premium) {
  return reference.rate / (1 + allowance(reference, premium));
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
  let usd = null; // {value, at} on the monotonic clock
  let usdTried = null;

  async function fetchOne(url) {
    try {
      return await fetchJson(url);
    } catch (error) {
      log(`[reference rate] ${url}: ${error && error.message ? error.message : error}`);
      return null;
    }
  }

  // Dollars per BTC, asked for at most every USD_TTL_MS, or null.
  async function btcUsd() {
    if (usdTried === null || now() - usdTried >= USD_TTL_MS) {
      usdTried = now();
      const value = usdOf(await fetchOne(COINGECKO_RATES_URL)) || usdOf(await fetchOne(MEMPOOL_PRICES_URL));
      if (value) {
        usd = { value, at: now() };
      }
    }
    return usd && now() - usd.at <= USD_MAX_AGE_MS ? usd.value : null;
  }

  async function load() {
    const [ticker, candles, second, dollars] = await Promise.all([
      fetchOne(TICKER_URL),
      fetchOne(CANDLES_URL),
      fetchOne(NONKYC_TICKER_URL),
      btcUsd(),
    ]);
    const neoxa = tickerRate(ticker);
    if (!neoxa) {
      return null;
    }
    const nk = nonKYCRate(second);
    const { rate, source, floored } = worseVenue(neoxa, nk && dollars ? nk / dollars : null);
    // Neoxa's spread, or with NonKYC the rate the narrower of the two, and
    // none at the floor (see the top of this file).
    let halfSpread = halfSpreadOf(ticker.ticker.bestBid, ticker.ticker.bestAsk);
    if (source === "NonKYC") {
      halfSpread = floored ? 0 : Math.min(halfSpread, halfSpreadOf(second.bid, second.ask));
    }
    // The hour's range is Neoxa's, measured against the rate it widens.
    return { rate, volatility: volatilityOf(candles, neoxa, clock()), halfSpread, at: clock(), source };
  }

  // {rate, volatility, halfSpread, at, source}, or a ValidationError with a
  // sentence.
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
  nonKYCRate,
  usdOf,
  worseVenue,
  NONKYC_TICKER_URL,
  COINGECKO_RATES_URL,
  MEMPOOL_PRICES_URL,
  MAX_VENUE_GAP,
  USD_TTL_MS,
  volatilityOf,
  minimumRate,
  allowance,
  halfSpreadOf,
  HALF_SPREAD_CAP,
  TICKER_URL,
  CANDLES_URL,
  VOLATILITY_CAP,
  WINDOW_SECONDS,
  TTL_MS,
  FAILURE_TTL_MS,
};
