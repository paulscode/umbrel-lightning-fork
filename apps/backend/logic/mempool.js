// The Mempool app the operator chose for fee rates and transaction links,
// and the fee rates it recommends. The rates are read from the endpoint the
// app's own fee box reads, /api/v1/fees/recommended, so the dashboard shows
// the numbers the app's page shows: No priority is economyFee, Low is
// hourFee, Medium is halfHourFee and High is fastestFee.
// The module aliases (utils/, models/) are registered by app.js; they are
// required lazily so the tests, which inject their own apps and store, load
// this file on its own.
const constants = () => require("utils/const.js");
const validationError = (message, status) => {
  const { ValidationError } = require("models/errors.js");
  return new ValidationError(message, status);
};

const FEES_PATH = "/api/v1/fees/recommended";
const FEE_KEYS = ["fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee"];
const CACHE_MS = 10 * 1000;
// An app that does not answer is not asked again for a while: every fee
// selector would otherwise wait the full timeout on every estimate.
const FAILURE_CACHE_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SANE_RATE = 100000; // sat/vB; anything above is a broken answer

// The apps are on the LAN or the package bridge, so no proxy is used, and
// no redirect is followed: a redirect could point anywhere.
function defaultFetchJson(url) {
  const axios = require("axios");
  return axios({
    url,
    method: "GET",
    headers: { Accept: "application/json" },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_BODY_BYTES,
    maxBodyLength: MAX_BODY_BYTES,
  }).then(response => response.data);
}

// bitcoind's mempoolminfee, BTC per kvB, as whole sat/vB rounded up: the
// rate under which the node refuses to broadcast. Rounded to satoshis
// before dividing, since 0.00001 * 1e8 is not exactly 1000 in floating
// point and a plain ceil would turn 1 sat/vB into 2.
function relayFloorSatPerVbyte(btcPerKvb) {
  const floor = Number(btcPerKvb);
  if (!Number.isFinite(floor) || floor <= 0) {
    return 0;
  }
  return Math.ceil(Math.round(floor * 1e8) / 1000);
}

// What went wrong, in words for the page, without the address the app was
// asked at.
function describeFetchError(error) {
  const code = error && error.code;
  const status = error && error.response && error.response.status;
  if (status) return `answered ${status}`;
  if (code === "ECONNREFUSED") return "refused the connection";
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") return "did not answer in time";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "could not be found on the network";
  if (error && /not a fee rate|not an object/.test(error.message)) return `gave an answer that ${error.message.replace(/^the answer /, "")}`;
  return "did not answer";
}

function createMempool({
  apps,
  store,
  fetchJson = defaultFetchJson,
  now = Date.now,
  // The wrapper's explorer setting, used when no app is chosen.
  fallbackExplorer = () => ({
    port: constants().EXPLORER_PORT || "",
    hiddenService: constants().EXPLORER_HIDDEN_SERVICE || "",
  }),
  badRequest = message => validationError(message, 400),
} = {}) {
  const known = () => (apps ? apps() : constants().MEMPOOL_APPS);
  const findApp = id => known().find(app => app.id === id) || null;
  const cache = new Map();

  // The chosen app's id, or "" for none. A choice naming an app the wrapper
  // no longer offers counts as none.
  async function selectedId() {
    const state = await store.read();
    const id = typeof state.mempoolApp === "string" ? state.mempoolApp : "";
    return findApp(id) ? id : "";
  }

  async function select(id) {
    if (id !== "" && !findApp(id)) {
      throw badRequest("Unknown Mempool app");
    }
    await store.write({ mempoolApp: id });
  }

  const publicApp = app => ({
    id: app.id,
    name: app.name,
    uiUrl: app.uiUrl || "",
    uiPort: app.uiPort || "",
    hiddenService: app.hiddenService || "",
  });

  async function settings() {
    return { selected: await selectedId(), apps: known().map(publicApp) };
  }

  // Where the page sends transaction links. Without an app, the wrapper's
  // explorer setting, which the page resolves to a port on its own host.
  async function explorer() {
    const app = findApp(await selectedId());
    if (app) {
      return {
        app: app.id,
        name: app.name,
        url: app.uiUrl || "",
        port: app.uiPort || "",
        hiddenService: app.hiddenService || "",
      };
    }
    const fallback = fallbackExplorer();
    return {
      app: "",
      name: "",
      url: "",
      port: fallback.port || "",
      hiddenService: fallback.hiddenService || "",
    };
  }

  function parseFees(data) {
    if (!data || typeof data !== "object") {
      throw new Error("the answer is not an object");
    }
    const fees = {};
    for (const key of FEE_KEYS) {
      const value = Number(data[key]);
      if (!Number.isFinite(value) || value < 0 || value > MAX_SANE_RATE) {
        throw new Error(`${key} is not a fee rate`);
      }
      fees[key] = value;
    }
    return fees;
  }

  // The selected app's recommended rates, cached briefly: a page asks for
  // them each time a fee selector is shown, and the app updates them once
  // a block at most.
  async function recommendedFees() {
    const id = await selectedId();
    if (!id) {
      return { app: "", name: "", fees: null };
    }
    const app = findApp(id);
    const hit = cache.get(id);
    if (hit && hit.fees && now() - hit.at < CACHE_MS) {
      return { app: id, name: app.name, fees: hit.fees };
    }
    if (hit && hit.error && now() - hit.at < FAILURE_CACHE_MS) {
      throw hit.error;
    }
    let fees;
    try {
      fees = parseFees(await fetchJson(app.api.replace(/\/+$/, "") + FEES_PATH));
    } catch (error) {
      cache.set(id, { at: now(), error });
      throw error;
    }
    cache.set(id, { at: now(), fees });
    return { app: id, name: app.name, fees };
  }

  return { settings, select, explorer, recommendedFees, selectedId };
}

// The JSON store, required lazily so the pure parts above load without
// node_modules (the tests inject their own store).
const defaultStore = {
  read: () => require("logic/disk.js").getJsonStore(),
  write: props => require("logic/disk.js").updateJsonStore(props),
};

module.exports = {
  createMempool,
  describeFetchError,
  relayFloorSatPerVbyte,
  FEES_PATH,
  FEE_KEYS,
  ...createMempool({ store: defaultStore }),
};
