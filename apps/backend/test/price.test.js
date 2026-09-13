// The fiat estimate against the bytes the two services actually send, and
// against each of them being down. The fixtures are unedited captures from the
// live endpoints, so they carry every field those services send rather than
// the ones considered while writing the parsers.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const price = require("../logic/price.js");

const tickers = require(path.join(__dirname, "fixtures", "neoxa-cmc-ticker.json"));
const rates = require(path.join(__dirname, "fixtures", "coingecko-exchange-rates.json"));

test("the live ticker feed yields a dollar price from the pair it is read from", () => {
  assert.ok(Object.keys(tickers).length > 0, "the object is keyed by pair, and every key is data");
  assert.ok(tickers[price.BTCB2_USD_PAIR], "the pair the dollar price is read from");
  const usd = price.btcb2Price(tickers);
  assert.ok(usd !== null && usd > 0, "a real capture must yield a price");
});

test("the live feed still carries untraded pairs, which report zero and must not read as a price", () => {
  const untraded = Object.values(tickers).filter(t => t.last_price === 0);
  assert.ok(untraded.length > 0, "the guard against zero is exercised by real data");
  assert.equal(price.validPrice(0), null);
  assert.equal(price.validPrice(-1), null);
  assert.equal(price.validPrice("NaN"), null);
  assert.equal(price.validPrice(null), null);
  assert.equal(price.validPrice(Infinity), null);
  assert.equal(price.validPrice("173.5"), 173.5);
});

test("a feed without the pair yields no price", () => {
  assert.equal(price.btcb2Price({}), null);
  assert.equal(price.btcb2Price(null), null);
  assert.equal(price.btcb2Price({ BTCB2_USDC: { last_price: 0 } }), null);
  assert.equal(price.btcb2Price([]), null);
});

test("the live rate table yields the dollar quote and the fiat list", () => {
  assert.ok(price.getRate(rates, "USD") > 0, "the divisor the conversion depends on");
  assert.ok(price.getRate(rates, "eur") > 0, "case does not matter");
  assert.equal(price.getRate(rates, "XXX"), null);
  const fiat = price.fiatCurrencies(rates);
  assert.ok(fiat.includes("USD") && fiat.includes("EUR"));
  assert.ok(!fiat.includes("BTC") && !fiat.includes("ETH"), "crypto quotes are not currencies to pick");
  assert.ok(!fiat.includes("XAG") && !fiat.includes("XAU"), "nor are commodities");
  assert.deepEqual(fiat, [...fiat].sort());
});

test("dollars are always offered, and first", () => {
  assert.deepEqual(price.withUsd([]), ["USD"]);
  assert.deepEqual(price.withUsd(["EUR", "USD", "GBP"]), ["USD", "EUR", "GBP"]);
  assert.deepEqual(price.fiatCurrencies(null), []);
});

test("a dollar price is restated by the ratio of two fiat quotes, so the BTC price cancels", () => {
  assert.equal(price.usdToCurrency(100, 50000, 45000), 90);
  assert.equal(price.usdToCurrency(100, 80000, 72000), 100 * (72000 / 80000));
  assert.equal(price.usdToCurrency(null, 50000, 45000), null);
  assert.equal(price.usdToCurrency(100, 0, 45000), null);
  assert.equal(price.usdToCurrency(100, 50000, null), null);
});

function fake({ neoxa = tickers, coingecko = rates } = {}) {
  const calls = [];
  const fetchJson = async url => {
    calls.push(url);
    const body = url === price.NEOXA_TICKER_URL ? neoxa : coingecko;
    if (body instanceof Error) {
      throw body;
    }
    return body;
  };
  let clock = 1_000_000;
  const logic = price.createPriceLogic({ fetchJson, now: () => clock, log: () => {} });
  return { logic, calls, tick: ms => { clock += ms; } };
}

test("with both services up every listed currency has a price", async () => {
  const { logic } = fake();
  const usd = await logic.getPrice("USD");
  assert.equal(usd, price.btcb2Price(tickers));
  const eur = await logic.getPrice("eur");
  assert.equal(eur, usd * (price.getRate(rates, "EUR") / price.getRate(rates, "USD")));
  const currencies = await logic.getSupportedCurrencies();
  assert.equal(currencies[0], "USD");
  assert.ok(currencies.includes("EUR"));
  assert.equal(await logic.getPrice("XXX"), null, "a code the table does not carry");
  assert.equal(await logic.getPrice("BTC"), null, "a crypto quote is not a fiat conversion");
});

test("with Neoxa down there is no price in any currency", async () => {
  const { logic } = fake({ neoxa: new Error("connect ECONNREFUSED") });
  assert.equal(await logic.getPrice("USD"), null);
  assert.equal(await logic.getPrice("EUR"), null);
  assert.ok((await logic.getSupportedCurrencies()).includes("EUR"), "the picker still lists what Coingecko can convert");
});

test("with Coingecko down dollars still work and only dollars are offered", async () => {
  const { logic } = fake({ coingecko: new Error("429 Too Many Requests") });
  assert.equal(await logic.getPrice("USD"), price.btcb2Price(tickers));
  assert.equal(await logic.getPrice("EUR"), null);
  assert.deepEqual(await logic.getSupportedCurrencies(), ["USD"]);
});

test("a feed that answers with something unusable counts as down", async () => {
  const { logic } = fake({ neoxa: "<html>maintenance</html>", coingecko: { unexpected: true } });
  assert.equal(await logic.getPrice("USD"), null);
  assert.deepEqual(await logic.getSupportedCurrencies(), ["USD"]);
});

test("answers are cached, and a failure is retried after its own shorter interval", async () => {
  const { logic, calls, tick } = fake();
  await logic.getPrice("EUR");
  await logic.getPrice("EUR");
  await logic.getPrice("USD");
  assert.equal(calls.filter(u => u === price.NEOXA_TICKER_URL).length, 1, "one ticker fetch within the price TTL");
  assert.equal(calls.filter(u => u === price.COINGECKO_RATES_URL).length, 1, "one rate fetch within the rates TTL");
  tick(price.PRICE_TTL_MS + 1);
  await logic.getPrice("EUR");
  assert.equal(calls.filter(u => u === price.NEOXA_TICKER_URL).length, 2, "refetched once the price TTL passed");
  assert.equal(calls.filter(u => u === price.COINGECKO_RATES_URL).length, 1, "rates are still fresh");

  const down = fake({ neoxa: new Error("timeout") });
  await down.logic.getPrice("USD");
  await down.logic.getPrice("USD");
  assert.equal(down.calls.length, 1, "an outage is not retried on every poll");
  down.tick(price.FAILURE_TTL_MS + 1);
  await down.logic.getPrice("USD");
  assert.equal(down.calls.length, 2, "but it is retried after the failure interval");
});
