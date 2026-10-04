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
    // The SHA256 chain's block at that height (mempool.space and
    // blockstream.info agree, and its header hashes to it). Something that
    // is not the BLAKE2b chain is not therefore the SHA256 chain: a node on
    // a third (a BIP 110 Knots 29.4 follows neither) has neither block.
    sha256Hash: "00000000000000000001d82da6ecccf08e07afa383f9212b0e1b95cc72430c00",
  },
};
// A verdict stands for a while; an app that did not answer is asked again
// sooner.
const CHAIN_CACHE_MS = 10 * 60 * 1000;
const CHAIN_RETRY_MS = 60 * 1000;
const WRONG_CHAIN = "WRONG_CHAIN";
const MAX_BODY_BYTES = 64 * 1024;

// The public explorer for the BLAKE2b chain, whose page most people without
// a Mempool app of their own watch. An operator can choose it like an app:
// the fee rates are then the ones it shows, and the node's own estimate when
// it does not answer. Never by default: asking it tells it the node's
// address. Mainnet only. Checked like any app: its block at the first
// BLAKE2b height must be the BLAKE2b one.
const PUBLIC_SOURCE = {
  id: "mempool.guide",
  name: "mempool.guide",
  api: process.env.PUBLIC_MEMPOOL_API || "https://mempool.guide",
};
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
  if (code === WRONG_CHAIN) return "follows the other chain, not the BLAKE2b one: its fee rates and transactions are the SHA256 chain's. Choose another app, or the node's own estimate";
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
  // The apps seen to have the SHA256 chain's block, not just another.
  const onSha256 = new Set();

  // "blake2b", "other", "unknown" (it did not answer, or not with a block
  // hash) or "unchecked" (a network without a fixed activation block).
  async function chainOf(app) {
    const activation = ACTIVATION[network()];
    if (!activation) {
      return "unchecked";
    }
    const hit = chains.get(app.id);
    if (hit) {
      // A check already on its way is shared, not repeated: a page asks for
      // the settings, the explorer and the fee rates at once.
      if (hit.pending) {
        return hit.pending;
      }
      const ttl = hit.chain === "unknown" ? CHAIN_RETRY_MS : CHAIN_CACHE_MS;
      if (now() - hit.at < ttl) {
        return hit.chain;
      }
    }
    const pending = checkChain(app, activation);
    chains.set(app.id, { pending });
    const chain = await pending;
    chains.set(app.id, { at: now(), chain });
    return chain;
  }

  async function checkChain(app, activation) {
    let chain;
    try {
      const hash = (await fetchText(
        app.api.replace(/\/+$/, "") + `/api/block-height/${activation.height}`
      )).trim().toLowerCase();
      if (activation.sha256Hash && hash === activation.sha256Hash) {
        onSha256.add(app.id);
      } else {
        onSha256.delete(app.id);
      }
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
    return chain;
  }

  const wrongChain = app => {
    const error = new Error(`${app.name} follows the other chain`);
    error.code = WRONG_CHAIN;
    return error;
  };

  // The chosen app's id, or "" for none. A choice naming an app the wrapper
  // no longer offers counts as none.
  // The public source counts only where it applies (mainnet).
  async function selectedId() {
    const state = await store.read();
    const id = typeof state.mempoolApp === "string" ? state.mempoolApp : "";
    if (id === PUBLIC_SOURCE.id) {
      return ACTIVATION[network()] ? id : "";
    }
    return findApp(id) ? id : "";
  }

  async function select(id) {
    const isPublic = id === PUBLIC_SOURCE.id && Boolean(ACTIVATION[network()]);
    const app = id === "" || isPublic ? null : findApp(id);
    if (id !== "" && !isPublic && !app) {
      throw badRequest("Unknown Mempool app");
    }
    if (app && (await chainOf(app)) === "other") {
      throw badRequest(
        `${app.name} follows the other chain, not the BLAKE2b one: its ` +
          "fee rates and transaction links would be the SHA256 chain's. " +
          "It is connected to a node on the SHA256 chain; point it at a " +
          "node on the BLAKE2b chain, or choose another app."
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
    return {
      selected: await selectedId(),
      apps: listed,
      // Offered only where it applies: mainnet, the chain it follows.
      publicSource: ACTIVATION[network()] ? { id: PUBLIC_SOURCE.id, name: PUBLIC_SOURCE.name, url: PUBLIC_SOURCE.api } : null,
    };
  }

  // Where the page sends transaction links. Without an app, the wrapper's
  // explorer setting, which the page resolves to a port on its own host.
  async function explorer() {
    const app = findApp(await selectedId());
    // Links into an app on the other chain would show that chain's version of
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

  // Where links to the SHA256 chain go (the bridge's SHA256 node: its
  // deposit address, its channels' funding transactions). An installed
  // Mempool app that follows that chain, which is the one the dashboard
  // will not use for this chain; else the public mempool.space.
  async function sha256Explorer() {
    for (const app of known()) {
      if ((await chainOf(app)) === "other" && onSha256.has(app.id)) {
        return {
          app: app.id,
          name: app.name,
          url: app.uiUrl || "",
          port: app.uiPort || "",
          hiddenService: app.hiddenService || "",
          public: false,
        };
      }
    }
    return { app: "", name: "mempool.space", url: "https://mempool.space", port: "", hiddenService: "", public: true };
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
    if (id === PUBLIC_SOURCE.id) {
      return publicFees();
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

  // The public source's rates, or, when it does not answer or is not this
  // chain's, why not: the page then shows the node's own estimate and says
  // so. Never thrown: the node's estimate is the answer to a failure here.
  async function publicFees() {
    const none = { app: "", name: "", fees: null };
    if (!ACTIVATION[network()]) {
      return none;
    }
    const failed = (error) => ({
      app: "",
      name: PUBLIC_SOURCE.name,
      fees: null,
      error: `${PUBLIC_SOURCE.name} ${describeFetchError(error)}.`,
    });
    const chain = await chainOf(PUBLIC_SOURCE);
    if (chain === "other") {
      return failed(wrongChain(PUBLIC_SOURCE));
    }
    if (chain !== "blake2b") {
      return failed(new Error("did not say which chain it follows"));
    }
    const hit = cache.get(PUBLIC_SOURCE.id);
    if (hit && hit.fees && now() - hit.at < CACHE_MS) {
      return { app: PUBLIC_SOURCE.id, name: PUBLIC_SOURCE.name, fees: hit.fees, public: true };
    }
    if (hit && hit.error && now() - hit.at < FAILURE_CACHE_MS) {
      return failed(hit.error);
    }
    try {
      const fees = parseFees(await fetchJson(PUBLIC_SOURCE.api.replace(/\/+$/, "") + FEES_PATH));
      cache.set(PUBLIC_SOURCE.id, { at: now(), fees });
      return { app: PUBLIC_SOURCE.id, name: PUBLIC_SOURCE.name, fees, public: true };
    } catch (error) {
      cache.set(PUBLIC_SOURCE.id, { at: now(), error });
      return failed(error);
    }
  }

  // The selected app's name, without asking any app anything: for an error
  // message about it.
  async function selectedName() {
    const app = findApp(await selectedId());
    return app ? app.name : "";
  }

  return { settings, select, explorer, sha256Explorer, recommendedFees, selectedId, selectedName, chainOf };
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
  PUBLIC_SOURCE,
  ...createMempool({ store: defaultStore }),
};
