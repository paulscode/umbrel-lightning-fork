// The fiat estimate, the way Sparrow BLAKE2b does it.
//
// BTCB2 trades on neoxa.exchange, and its deepest dollar market there is
// BTCB2_USDC, so that pair's last trade is the dollar price; USDC is treated
// as a dollar. It is not BTCB2_BTC times an outside BTC price, the obvious
// construction: Neoxa's own BTC market is thin enough to drift a few percent
// from the wider market, and multiplying by an outside price counts that gap
// twice. Other currencies borrow a conversion from Coingecko's rate
// table, the ratio of its BTC-in-currency quote to its BTC-in-dollars quote.
// That cancels BTC out entirely, so Coingecko's opinion of what bitcoin (the
// other chain's coin) is worth cannot reach the result.
//
// With Neoxa unreachable there is no price at all; with Coingecko unreachable
// dollars still work and the other currencies do not. A pair that has never
// traded reports zero, and zero shown as a price reads as "worth nothing"
// rather than "unknown", so it is treated as absent. Both feeds are cached so
// a page that polls does not turn into a request per second.
const NEOXA_TICKER_URL = "https://neoxa.exchange/api/v1/cmc/ticker";
const COINGECKO_RATES_URL = "https://api.coingecko.com/api/v3/exchange_rates";
const BTCB2_USD_PAIR = "BTCB2_USDC";
const USD = "USD";

const PRICE_TTL_MS = 60 * 1000;
const RATES_TTL_MS = 10 * 60 * 1000;
// A failed fetch is not retried for this long, so an outage costs one
// request per interval rather than one per page poll.
const FAILURE_TTL_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const HEADERS = {
  "User-Agent": "Mozilla/4.0 (compatible; MSIE 9.0; Windows NT 6.1)",
  Accept: "*/*",
};

// A traded price, or null for one that is not.
function validPrice(lastPrice) {
  const price = Number(lastPrice);
  if (lastPrice === null || lastPrice === undefined || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  return price;
}

// BTCB2 in dollars out of the ticker feed (an object keyed by pair), or null
// if the feed does not carry a usable one.
function btcb2Price(tickers) {
  if (!tickers || typeof tickers !== "object") {
    return null;
  }
  const ticker = tickers[BTCB2_USD_PAIR];
  return ticker ? validPrice(ticker.last_price) : null;
}

// A rate table entry by currency code, whatever case the table uses.
function rateEntry(rates, currencyCode) {
  if (!rates || !rates.rates || typeof rates.rates !== "object" || !currencyCode) {
    return null;
  }
  const wanted = String(currencyCode).toLowerCase();
  const key = Object.keys(rates.rates).find(k => k.toLowerCase() === wanted);
  return key === undefined ? null : rates.rates[key];
}

// What Coingecko says one bitcoin is worth in a currency, used only as one
// half of a ratio.
function getRate(rates, currencyCode) {
  const rate = rateEntry(rates, currencyCode);
  return rate ? validPrice(rate.value) : null;
}

// The fiat currencies in a rate table that carry a usable quote: what the
// picker offers beside dollars, and exactly what getPrice can answer for.
function fiatCurrencies(rates) {
  if (!rates || !rates.rates || typeof rates.rates !== "object") {
    return [];
  }
  const codes = Object.keys(rates.rates)
    .filter(code => {
      const entry = rates.rates[code];
      return entry && entry.type === "fiat" && validPrice(entry.value) !== null;
    })
    .map(code => code.toUpperCase())
    .filter(code => /^[A-Z]{3}$/.test(code));
  return [...new Set(codes)].sort();
}

// The convertible currencies with dollars first: dollars need nothing but
// Neoxa, so a Coingecko outage must not take away the one currency that
// still works.
function withUsd(converted) {
  const currencies = [USD];
  for (const currency of converted) {
    if (!currencies.includes(currency)) {
      currencies.push(currency);
    }
  }
  return currencies;
}

// A dollar price restated in another currency, or null if any input is
// missing or unusable: a dollar figure wearing another currency's symbol is
// worse than no figure.
function usdToCurrency(btcb2Usd, btcPerUsd, btcPerCurrency) {
  if ([btcb2Usd, btcPerUsd, btcPerCurrency].some(v => validPrice(v) === null)) {
    return null;
  }
  return btcb2Usd * (btcPerCurrency / btcPerUsd);
}

// The real fetch: axios, through Umbrel's Tor proxy when one is configured,
// as the upstream price request was. One agent for the process, on both
// schemes, and no redirects followed: a redirect to plain http would
// otherwise leave Tor. Required lazily so the pure functions above load
// without node_modules (the tests inject their own fetcher).
let torAgent;
function proxyAgent() {
  if (torAgent === undefined) {
    torAgent = null;
    if (process.env.TOR_PROXY_IP && process.env.TOR_PROXY_PORT) {
      const { SocksProxyAgent } = require("socks-proxy-agent");
      torAgent = new SocksProxyAgent(`socks5h://${process.env.TOR_PROXY_IP}:${process.env.TOR_PROXY_PORT}`);
    }
  }
  return torAgent;
}

function defaultFetchJson(url) {
  const axios = require("axios");
  const agent = proxyAgent() || undefined;
  return axios({
    url,
    method: "GET",
    httpAgent: agent,
    httpsAgent: agent,
    headers: HEADERS,
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
  }).then(response => response.data);
}

// A clock that only moves forward: the cache must not freeze because the
// wall clock stepped back, which a board without an RTC does at boot.
function monotonicNow() {
  const { performance } = require("perf_hooks");
  return performance.now();
}

function createPriceLogic({ fetchJson = defaultFetchJson, now = monotonicNow, log = console.warn } = {}) {
  // url -> {value, at, ttl} once settled, or {pending} while a fetch is out,
  // so concurrent callers share one request rather than stampede the feed.
  const cache = new Map();

  function cached(url, ttl) {
    const entry = cache.get(url);
    if (entry) {
      if (entry.pending) {
        return entry.pending;
      }
      if (now() - entry.at < entry.ttl) {
        return Promise.resolve(entry.value);
      }
    }
    const pending = (async () => {
      let value = null;
      try {
        value = await fetchJson(url);
      } catch (error) {
        log(`[price] ${url}: ${error && error.message ? error.message : error}`);
        value = null;
      }
      cache.set(url, { value, at: now(), ttl: value === null ? FAILURE_TTL_MS : ttl });
      return value;
    })();
    cache.set(url, { pending });
    return pending;
  }

  const getBtcb2Usd = async () => btcb2Price(await cached(NEOXA_TICKER_URL, PRICE_TTL_MS));
  const getCoinGeckoRates = () => cached(COINGECKO_RATES_URL, RATES_TTL_MS);

  // BTCB2 in `currency`, or null when either feed the answer needs is down
  // or does not carry the currency.
  async function getPrice(currency) {
    const code = String(currency || USD).toUpperCase();
    const btcb2Usd = await getBtcb2Usd();
    if (btcb2Usd === null) {
      return null;
    }
    if (code === USD) {
      return btcb2Usd;
    }
    const rates = await getCoinGeckoRates();
    if (!fiatCurrencies(rates).includes(code)) {
      return null;
    }
    return usdToCurrency(btcb2Usd, getRate(rates, USD), getRate(rates, code));
  }

  async function getSupportedCurrencies() {
    return withUsd(fiatCurrencies(await getCoinGeckoRates()));
  }

  return { getPrice, getSupportedCurrencies };
}

module.exports = {
  ...createPriceLogic(),
  createPriceLogic,
  validPrice,
  btcb2Price,
  getRate,
  fiatCurrencies,
  withUsd,
  usdToCurrency,
  BTCB2_USD_PAIR,
  NEOXA_TICKER_URL,
  COINGECKO_RATES_URL,
  PRICE_TTL_MS,
  RATES_TTL_MS,
  FAILURE_TTL_MS,
};
