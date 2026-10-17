// The reference rate against Neoxa's answers as they come (unedited
// captures in fixtures/), and against the feed being down or odd.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const ref = require("../logic/referenceRate.js");

const ticker = require(path.join(__dirname, "fixtures", "neoxa-btcb2-btc-ticker.json"));
const candles = require(path.join(__dirname, "fixtures", "neoxa-btcb2-btc-candles.json"));
const nonKYC = require(path.join(__dirname, "fixtures", "nonkyc-btcb2-usdt-ticker.json"));
const coinGecko = require(path.join(__dirname, "fixtures", "coingecko-exchange-rates.json"));
const mempool = require(path.join(__dirname, "fixtures", "mempool-prices.json"));

test("the live ticker yields the last trade's rate", () => {
  const rate = ref.tickerRate(ticker);
  assert.ok(rate > 0 && rate < 1, "bitcoin per BTCB2");
  assert.equal(rate, ticker.ticker.lastPrice);
});

test("a ticker that is not a good answer for the pair yields nothing", () => {
  assert.equal(ref.tickerRate(null), null);
  assert.equal(ref.tickerRate({ success: false, ticker: { lastPrice: 0.005 } }), null);
  assert.equal(ref.tickerRate({ success: true, pair: "BTCB2_USDC", ticker: { lastPrice: 0.005 } }), null);
  assert.equal(ref.tickerRate({ success: true, ticker: { lastPrice: 0 } }), null);
  assert.equal(ref.tickerRate({ success: true, ticker: { lastPrice: "abc" } }), null);
  assert.equal(ref.tickerRate("<html>"), null);
});

test("the live candles give the last hour's range, capped", () => {
  const last = ref.tickerRate(ticker);
  const latest = Math.max(...candles.candles.map((c) => c.time));
  const v = ref.volatilityOf(candles, last, latest + 300);
  assert.ok(v >= 0 && v <= ref.VOLATILITY_CAP);
  // Hours later none of them count.
  assert.equal(ref.volatilityOf(candles, last, latest + 5 * 3600), 0);
  const wild = { success: true, candles: [{ time: 1000, high: 0.01, low: 0.001 }] };
  assert.equal(ref.volatilityOf(wild, 0.005, 1000), ref.VOLATILITY_CAP);
  const calm = { success: true, candles: [{ time: 1000, high: 0.0051, low: 0.0049 }, { time: 700, high: "x", low: 0.001 }] };
  assert.ok(Math.abs(ref.volatilityOf(calm, 0.005, 1000) - 0.04) < 1e-12, "a bad candle is left out");
  assert.equal(ref.volatilityOf({ success: false }, 0.005, 1000), 0);
});

test("the minimum rate widens with the premium and the market's movement", () => {
  assert.ok(Math.abs(ref.minimumRate({ rate: 0.005, volatility: 0 }, 0.05) - 0.005 / 1.05) < 1e-15);
  assert.ok(Math.abs(ref.minimumRate({ rate: 0.005, volatility: 0.02 }, 0.05) - 0.005 / 1.07) < 1e-15);
});

test("the rate is cached; with Neoxa down there is none, and that is an error", async () => {
  let calls = 0;
  let t = 0;
  let down = false;
  const r = ref.createReferenceRate({
    fetchJson: async (url) => {
      calls++;
      if (down) {
        throw new Error("socket hang up");
      }
      return url.includes("ticker") ? ticker : candles;
    },
    now: () => t,
    clock: () => Math.max(...candles.candles.map((c) => c.time)),
    log: () => {},
  });
  const first = await r.get();
  assert.equal(first.rate, ticker.ticker.lastPrice);
  const fetched = calls;
  await r.get();
  assert.equal(calls, fetched, "one set of fetches for both");
  down = true;
  t += ref.TTL_MS;
  await assert.rejects(() => r.get(), (e) => e.statusCode === 503 && e.refusal === "reference_unavailable" && /nothing was paid/.test(e.message));
  // Candles that fail alone allow no movement, which only allows less.
  const noCandles = ref.createReferenceRate({
    fetchJson: async (url) => {
      if (url.includes("candles")) {
        throw new Error("down");
      }
      return ticker;
    },
    log: () => {},
  });
  assert.equal((await noCandles.get()).volatility, 0);
  const garbage = ref.createReferenceRate({ fetchJson: async () => ({ success: true, ticker: {} }), log: () => {} });
  await assert.rejects(() => garbage.get(), /not available/);
});

test("one trade far from the book does not move the rate", () => {
  const book = (lastPrice, bestBid, bestAsk) => ({ success: true, pair: "BTCB2_BTC", ticker: { lastPrice, bestBid, bestAsk } });
  // A trade 30% under a book of 0.00488..0.0049: the bid is the rate.
  assert.equal(ref.tickerRate(book(0.0034, 0.00488, 0.0049)), 0.00488);
  assert.equal(ref.tickerRate(book(0.009, 0.00488, 0.0049)), 0.0049);
  // Inside the book, the trade itself.
  assert.equal(ref.tickerRate(book(0.00489, 0.00488, 0.0049)), 0.00489);
  // No usable book: the last trade.
  assert.equal(ref.tickerRate(book(0.0048, 0, 0)), 0.0048);
  assert.equal(ref.tickerRate(book(0.0048, 0.005, 0.004)), 0.0048);
});

test("NonKYC's live ticker and both BTC/USD sources are read", () => {
  assert.equal(ref.nonKYCRate(nonKYC), Number(nonKYC.last_price));
  assert.equal(ref.nonKYCRate({ ticker_id: "XYZ_USDT", last_price: "1" }), null);
  assert.equal(ref.nonKYCRate({ ticker_id: "BTCB2_USDT", last_price: "x" }), null);
  assert.equal(ref.nonKYCRate(null), null);
  assert.equal(ref.usdOf(coinGecko), coinGecko.rates.usd.value);
  assert.equal(ref.usdOf(mempool), mempool.USD);
  assert.equal(ref.usdOf({ rates: {} }), null);
  assert.equal(ref.usdOf("<html>"), null);
});

test("the worse venue for the payer, down to the bridge's bound under Neoxa", () => {
  assert.deepEqual(ref.worseVenue(0.006, null), { rate: 0.006, source: "Neoxa" });
  assert.deepEqual(ref.worseVenue(0.006, 0.0062), { rate: 0.006, source: "Neoxa" });
  assert.deepEqual(ref.worseVenue(0.006, 0.00582), { rate: 0.00582, source: "NonKYC" });
  // 10% under: no further than 4%, and said to be held there.
  const far = ref.worseVenue(0.006, 0.0054);
  assert.ok(Math.abs(far.rate - 0.006 * (1 - ref.MAX_VENUE_GAP)) < 1e-15 && far.source === "NonKYC" && far.floored);
});

// A fake market: Neoxa's ticker at `neoxa`, NonKYC's at `usdt` dollars, and
// BTC/USD from whichever sources are up.
function venues({ neoxa = 0.006, usdt = null, coinGeckoUsd = 85000, mempoolUsd = null } = {}) {
  const asked = {};
  const fetchJson = async (url) => {
    asked[url] = (asked[url] || 0) + 1;
    if (url === ref.TICKER_URL) {
      return { success: true, pair: "BTCB2_BTC", ticker: { lastPrice: neoxa } };
    }
    if (url === ref.NONKYC_TICKER_URL && usdt) {
      return { ticker_id: "BTCB2_USDT", last_price: String(usdt), bid: String(usdt), ask: String(usdt) };
    }
    if (url === ref.COINGECKO_RATES_URL && coinGeckoUsd) {
      return { rates: { btc: { value: 1 }, usd: { value: coinGeckoUsd } } };
    }
    if (url === ref.MEMPOOL_PRICES_URL && mempoolUsd) {
      return { time: 1, USD: mempoolUsd };
    }
    if (url === ref.CANDLES_URL) {
      return { success: true, candles: [] };
    }
    throw new Error("connect ECONNREFUSED");
  };
  return { asked, fetchJson };
}

test("NonKYC lower than Neoxa is the rate a payer is checked against", async () => {
  // 0.00582: 3% under.
  const v = venues({ usdt: 0.00582 * 85000 });
  const r = ref.createReferenceRate({ fetchJson: v.fetchJson, log: () => {} });
  const got = await r.get();
  assert.ok(Math.abs(got.rate - 0.00582) < 1e-12);
  assert.equal(got.source, "NonKYC");

  // NonKYC higher, or not answering: Neoxa.
  for (const usdt of [0.0062 * 85000, null]) {
    const w = venues({ usdt });
    const g = await ref.createReferenceRate({ fetchJson: w.fetchJson, log: () => {} }).get();
    assert.equal(g.rate, 0.006);
    assert.equal(g.source, "Neoxa");
  }

  // Without any BTC/USD, NonKYC cannot be compared: Neoxa.
  const noUsd = venues({ usdt: 0.00582 * 85000, coinGeckoUsd: null });
  assert.equal((await ref.createReferenceRate({ fetchJson: noUsd.fetchJson, log: () => {} }).get()).rate, 0.006);
});

test("BTC/USD is CoinGecko's at most every five minutes, else mempool.space's", async () => {
  let t = 0;
  const v = venues({ usdt: 0.00582 * 85000, coinGeckoUsd: null, mempoolUsd: 85000 });
  const r = ref.createReferenceRate({ fetchJson: v.fetchJson, now: () => t, log: () => {} });
  assert.ok(Math.abs((await r.get()).rate - 0.00582) < 1e-12, "mempool.space's price serves");
  for (let i = 0; i < 9; i++) {
    t += ref.TTL_MS;
    await r.get();
  }
  // Ten reference reads over nine minutes: BTC/USD asked twice.
  assert.equal(v.asked[ref.TICKER_URL], 10);
  assert.equal(v.asked[ref.COINGECKO_RATES_URL], 2);
  assert.equal(v.asked[ref.MEMPOOL_PRICES_URL], 2);
});

test("half the spread of the venue the rate is from, capped", async () => {
  assert.ok(Math.abs(ref.halfSpreadOf(0.00495, 0.00505) - 0.01) < 1e-12);
  assert.equal(ref.halfSpreadOf(0.004, 0.006), ref.HALF_SPREAD_CAP);
  assert.equal(ref.halfSpreadOf(0.005, 0.004), 0, "a crossed book");
  assert.equal(ref.halfSpreadOf(undefined, 0.005), 0);
  assert.ok(Math.abs(ref.minimumRate({ rate: 0.005, volatility: 0.02, halfSpread: 0.01 }, 0.05) - 0.005 / 1.08) < 1e-15);
  assert.equal(ref.allowance({ volatility: 0.02 }, 0.05), 0.07);

  // From Neoxa's ticker, and from NonKYC's when that is the rate.
  const neoxaBook = async (url) => {
    if (url === ref.TICKER_URL) {
      return { success: true, pair: "BTCB2_BTC", ticker: { lastPrice: 0.006, bestBid: 0.00597, bestAsk: 0.00603 } };
    }
    if (url === ref.NONKYC_TICKER_URL) {
      return { ticker_id: "BTCB2_USDT", last_price: "494.7", bid: "489.75", ask: "499.65" };
    }
    if (url === ref.COINGECKO_RATES_URL) {
      return { rates: { usd: { value: 85000 } } };
    }
    throw new Error("down");
  };
  const got = await ref.createReferenceRate({ fetchJson: neoxaBook, log: () => {} }).get();
  assert.equal(got.source, "NonKYC");
  // NonKYC's is 1%, Neoxa's 0.5%: the narrower.
  assert.ok(Math.abs(got.halfSpread - 0.005) < 1e-12, `${got.halfSpread}`);
  const alone = await ref.createReferenceRate({ fetchJson: (url) => (url === ref.NONKYC_TICKER_URL ? Promise.reject(new Error("403")) : neoxaBook(url)), log: () => {} }).get();
  assert.equal(alone.source, "Neoxa");
  assert.ok(Math.abs(alone.halfSpread - 0.005) < 1e-12, `${alone.halfSpread}`);
});

// NonKYC pushed down and its book widened, in a quiet hour: the rate is held
// 4% under Neoxa and nothing is added for NonKYC's spread on top, where the
// floor and the spread's cap together let a price 11.5% over Neoxa through.
// Short of the floor, NonKYC's spread counts only as far as Neoxa's.
test("a spread widened on NonKYC widens nothing", async () => {
  const market = (usdt, bid, ask) => async (url) => {
    if (url === ref.TICKER_URL) {
      return { success: true, pair: "BTCB2_BTC", ticker: { lastPrice: 0.006, bestBid: 0.00597, bestAsk: 0.00603 } };
    }
    if (url === ref.NONKYC_TICKER_URL) {
      return { ticker_id: "BTCB2_USDT", last_price: String(usdt), bid: String(bid), ask: String(ask) };
    }
    if (url === ref.COINGECKO_RATES_URL) {
      return { rates: { usd: { value: 85000 } } };
    }
    throw new Error("down");
  };
  // 10% under Neoxa, with a 10% spread.
  const pushed = await ref.createReferenceRate({ fetchJson: market(459, 436, 482), log: () => {} }).get();
  assert.equal(pushed.source, "NonKYC");
  assert.equal(pushed.halfSpread, 0);
  const over = 0.006 / ref.minimumRate(pushed, 0.05) - 1;
  assert.ok(over < 0.096, `a price ${over} over Neoxa is accepted`);

  // 3% under, with a 6% spread: Neoxa's 0.5%.
  const wide = await ref.createReferenceRate({ fetchJson: market(494.7, 480, 510), log: () => {} }).get();
  assert.equal(wide.source, "NonKYC");
  assert.ok(Math.abs(wide.halfSpread - 0.005) < 1e-12, `${wide.halfSpread}`);
});
