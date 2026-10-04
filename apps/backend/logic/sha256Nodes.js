// The nodes on the SHA256 chain the bridge's SHA256 Lightning node could
// read, on Umbrel.
//
// People run the two chains as their main node on one and a companion on the
// other, either way round, or as two companions. So the node for the SHA256
// side may be Knots (SHA256) Companion, or the main node itself: Bitcoin
// Knots (which follows either chain, by the version picked in its own
// settings) or Bitcoin Node. exports.sh hands over every installed one with
// its RPC credentials (BRIDGE_SHA256_NODES); this asks each which chain it
// follows, by the one block the two chains cannot agree on, and offers only
// those on the SHA256 chain, never the node Lightning Fork itself reads.
//
// The chosen one is written into a small lnd config file the bridge's SHA256
// node reads (BRIDGE_SHA256_CONF), which restarts it when it changes.
const http = require("http");

const { ACTIVATION } = require("./mempool.js");

const NAMES = {
  "paulscode-knots-sha256": "Knots (SHA256) Companion",
  "bitcoin-knots": "Bitcoin Knots",
  bitcoin: "Bitcoin Node",
};

const REQUEST_TIMEOUT_MS = 5 * 1000;
const SURVEY_CACHE_MS = 60 * 1000;

// "id|host:port|user|password;..." as exports.sh writes it. Anything that
// does not have exactly that shape is dropped, not guessed at.
function parseNodes(text) {
  return String(text || "")
    .split(";")
    .map((entry) => entry.split("|"))
    .filter((p) => p.length === 4 && p.every(Boolean))
    // As exports.sh checks too: they go into an lnd config file.
    .filter((p) => /^[A-Za-z0-9._-]+$/.test(p[0]) && /^[A-Za-z0-9_=-]+$/.test(p[2]) && /^[A-Za-z0-9_=-]+$/.test(p[3]))
    .map(([id, address, user, pass]) => {
      const m = address.match(/^([0-9A-Za-z.-]+):(\d{1,5})$/);
      return m ? { id, name: NAMES[id] || id, host: m[1], port: Number(m[2]), user, pass } : null;
    })
    .filter(Boolean);
}

// One JSON-RPC call to a bitcoind.
function jsonRpc(node, method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "1.0", id: "lightning-fork", method, params });
    const req = http.request({
      host: node.host,
      port: node.port,
      method: "POST",
      path: "/",
      auth: `${node.user}:${node.pass}`,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
        if (raw.length > 256 * 1024) {
          req.destroy(new Error("reply too large"));
        }
      });
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error("it refused the RPC credentials"));
        }
        try {
          const out = JSON.parse(raw);
          if (out.error) {
            return reject(new Error(out.error.message || "RPC error"));
          }
          return resolve(out.result);
        } catch (_) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("it did not answer in time")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// What a node is, for the bridge: "sha256" is the only state it can be
// used in.
//   sha256          follows the SHA256 chain
//   blake2b         follows the BLAKE2b chain
//   lightning-fork  is the node Lightning Fork reads (so BLAKE2b, or wrong)
//   behind          has not reached the first BLAKE2b block, so cannot tell
//   other-network   is not on mainnet
//   other-chain     follows a third chain (neither block at that height)
//   unreachable     did not answer, or refused
async function probe(node, { rpc = jsonRpc, activation = ACTIVATION.mainnet, lfHost = "" } = {}) {
  const out = { id: node.id, name: node.name, state: "unreachable", detail: "", height: null };
  if (lfHost && node.host === lfHost) {
    return { ...out, state: "lightning-fork", detail: "Lightning Fork reads it, on the BLAKE2b chain" };
  }
  let info;
  try {
    info = await rpc(node, "getblockchaininfo");
  } catch (error) {
    return { ...out, detail: `not answering: ${error.message}` };
  }
  out.height = Number(info.blocks) || 0;
  if (info.chain !== "main") {
    return { ...out, state: "other-network", detail: `on ${info.chain}, not mainnet` };
  }
  if (out.height < activation.height) {
    return {
      ...out,
      state: "behind",
      detail: `still syncing (block ${out.height.toLocaleString("en-US")}); which chain it follows shows from block ${activation.height.toLocaleString("en-US")}`,
    };
  }
  let hash;
  try {
    hash = await rpc(node, "getblockhash", [activation.height]);
  } catch (error) {
    return { ...out, detail: `not answering: ${error.message}` };
  }
  if (hash === activation.hash) {
    return { ...out, state: "blake2b", detail: "on the BLAKE2b chain" };
  }
  // Positively the SHA256 chain, not merely not the BLAKE2b one.
  if (!activation.sha256Hash || hash === activation.sha256Hash) {
    return { ...out, state: "sha256", detail: "on the SHA256 chain" };
  }
  return { ...out, state: "other-chain", detail: "on neither chain: its block at the first BLAKE2b height is neither chain's (a Bitcoin Knots 29.4, perhaps)" };
}

// The lnd config lines for the bridge's SHA256 node to read `node`.
function confFor(node) {
  return [
    "# Written by the Lightning Fork dashboard: the node on the SHA256 chain",
    `# the bridge's SHA256 Lightning node reads (${node.name}).`,
    "[Bitcoind]",
    `bitcoind.rpchost=${node.host}:${node.port}`,
    `bitcoind.rpcuser=${node.user}`,
    `bitcoind.rpcpass=${node.pass}`,
    "",
  ].join("\n");
}

function createSha256Nodes({ nodes = [], rpc = jsonRpc, lfHost = "", activation = ACTIVATION.mainnet, now = () => Date.now() } = {}) {
  let cached = null;
  let pending = null;

  // Every candidate and what it is. Asked again after a minute, or at once
  // when `fresh`.
  async function survey({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < SURVEY_CACHE_MS) {
      return cached.list;
    }
    // Callers at the same moment share one round of questions.
    if (!pending) {
      pending = Promise.all(nodes.map((n) => probe(n, { rpc, activation, lfHost })))
        .then((list) => {
          cached = { at: now(), list };
          return list;
        })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  // The node to use: the one chosen before while it is still on the SHA256
  // chain, else the first that is. Null when none is.
  function pick(list, savedId) {
    const usable = list.filter((n) => n.state === "sha256");
    return usable.find((n) => n.id === savedId) || usable[0] || null;
  }

  function byId(id) {
    return nodes.find((n) => n.id === id) || null;
  }

  return { survey, pick, byId, count: () => nodes.length };
}

module.exports = { parseNodes, probe, confFor, createSha256Nodes, jsonRpc, NAMES };
