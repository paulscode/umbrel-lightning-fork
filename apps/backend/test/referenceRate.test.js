// The reference rate against Neoxa's answers as they come (unedited
// captures in fixtures/), and against the feed being down or odd.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const ref = require("../logic/referenceRate.js");

const ticker = require(path.join(__dirname, "fixtures", "neoxa-btcb2-btc-ticker.json"));
const candles = require(path.join(__dirname, "fixtures", "neoxa-btcb2-btc-candles.json"));

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
  await r.get();
  assert.equal(calls, 2, "one ticker and one candles fetch for both");
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
