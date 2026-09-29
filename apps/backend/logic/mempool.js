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

// Which chain a Mempool app follows, told by the one block the two chains
// cannot agree on: the first BLAKE2b block. A Mempool app on the other chain
// (the official app over a Bitcoin Core or pre-fork Knots node, say) answers
// every request happily, with fee rates and transactions from the wrong
// chain, so reaching it proves nothing. The test networks have no fixed
// activation block, and are not checked.
const ACTIVATION = {
  mainnet: {
    height: 961640,
    hash: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb",
  },
};
// A verdict stands for a while; an app that did not answer is asked again
// sooner.
const CHAIN_CACHE_MS = 10 * 60 * 1000;
const CHAIN_RETRY_MS = 60 * 1000;
const WRONG_CHAIN = "WRONG_CHAIN";
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
  if (code === WRONG_CHAIN) return "follows the other chain, not the BLAKE2b one: its fee rates and transactions are Bitcoin's. Choose another app, or the node's own estimate";
  if (error && /not a fee rate|not an object/.test(error.message)) return `gave an answer that ${error.message.replace(/^the answer /, "")}`;
  return "did not answer";
}

// A plain text answer, as the block-height endpoint gives.
function defaultFetchText(url) {
  const axios = require("axios");
  return axios({
    url,
    method: "GET",
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_BODY_BYTES,
    maxBodyLength: MAX_BODY_BYTES,
    responseType: "text",
    transformResponse: [data => data],
  }).then(response => String(response.data));
}

function createMempool({
  apps,
  store,
  fetchJson = defaultFetchJson,
  fetchText = defaultFetchText,
  // The network the node runs on, which decides the block to check.
  network = () => process.env.LND_NETWORK || "mainnet",
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
  const chains = new Map();

  // "blake2b", "other", "unknown" (it did not answer, or not with a block
  // hash) or "unchecked" (a network without a fixed activation block).
  async function chainOf(app) {
    const activation = ACTIVATION[network()];
    if (!activation) {
      return "unchecked";
    }
    const hit = chains.get(app.id);
    if (hit) {
      const ttl = hit.chain === "unknown" ? CHAIN_RETRY_MS : CHAIN_CACHE_MS;
      if (now() - hit.at < ttl) {
        return hit.chain;
      }
    }
    let chain;
    try {
      const hash = (await fetchText(
        app.api.replace(/\/+$/, "") + `/api/block-height/${activation.height}`
      )).trim().toLowerCase();
      if (hash === activation.hash) {
        chain = "blake2b";
      } else if (/^[0-9a-f]{64}$/.test(hash)) {
        chain = "other";
      } else {
        chain = "unknown";
      }
    } catch (error) {
      chain = "unknown";
    }
    chains.set(app.id, { at: now(), chain });
    return chain;
  }

  const wrongChain = app => {
    const error = new Error(`${app.name} follows the other chain`);
    error.code = WRONG_CHAIN;
    return error;
  };

  // The chosen app's id, or "" for none. A choice naming an app the wrapper
  // no longer offers counts as none.
  async function selectedId() {
    const state = await store.read();
    const id = typeof state.mempoolApp === "string" ? state.mempoolApp : "";
    return findApp(id) ? id : "";
  }

  async function select(id) {
    const app = id === "" ? null : findApp(id);
    if (id !== "" && !app) {
      throw badRequest("Unknown Mempool app");
    }
    if (app && (await chainOf(app)) === "other") {
      throw badRequest(
        `${app.name} follows the other chain, not the BLAKE2b one: its ` +
          "fee rates and transaction links would be Bitcoin's. It is " +
          "connected to a Bitcoin node that has not upgraded; point it at " +
          "a BLAKE2b node, or choose another app."
      );
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
    const listed = await Promise.all(
      known().map(async app => ({ ...publicApp(app), chain: await chainOf(app) }))
    );
    return { selected: await selectedId(), apps: listed };
  }

  // Where the page sends transaction links. Without an app, the wrapper's
  // explorer setting, which the page resolves to a port on its own host.
  async function explorer() {
    const app = findApp(await selectedId());
    // Links into an app on the other chain would show Bitcoin's version of
    // a transaction, or none: fall back as if no app were chosen.
    if (app && (await chainOf(app)) !== "other") {
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
    if ((await chainOf(app)) === "other") {
      throw wrongChain(app);
    }
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

  return { settings, select, explorer, recommendedFees, selectedId, chainOf };
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
  ACTIVATION,
  ...createMempool({ store: defaultStore }),
};
