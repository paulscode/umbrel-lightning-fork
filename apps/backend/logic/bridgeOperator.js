// Running a bridge from this node: what the operator's Bridge page shows and
// does.
//
// The bridge itself lives in Lightning Fork (its bridgerpc sub-server); this
// reads it and drives it through its REST routes. When Lightning Fork runs the
// bridge's SHA256 Lightning node for the operator (bridgerpc.sha256.supervised)
// this also talks to that node directly, with its own admin macaroon, for the
// things an operator does with a node: a deposit address and a channel. The
// bridge never holds that macaroon; it bakes a narrow one of its own.
//
// Nothing here runs unless the page is opened, so a node that never bridges
// pays nothing for it.
const fs = require("fs");
const https = require("https");
const path = require("path");
const { randomBytes } = require("crypto");

const { ValidationError } = require("../models/errors.js");
const { encodeBridgeCode } = require("../utils/bridgeCode.js");

// What a participant's credential may call, and nothing else: the same list
// `lncli bridge code` bakes (cmd/commands/bridgerpc_active.go).
const PARTICIPANT_URIS = [
  "/bridgerpc.Bridge/Info",
  "/bridgerpc.Bridge/Quote",
  "/bridgerpc.Bridge/LookupSwap",
];

// Participants' root key ids start here, clear of the node's own (0) and of
// small numbers an operator may have used by hand; also lncli's.
const FIRST_PARTICIPANT_ROOT_KEY_ID = 1000n;

const REQUEST_TIMEOUT_MS = 20 * 1000;

// The supervised node's ports and layout (lnrpc/bridgerpc and the platform
// packages agree on these).
const SHA256_REST_PORT = 8089;

// An lnd REST client for one node: its certificate is the only CA accepted,
// and its macaroon goes on every call. Read per call, so a regenerated
// certificate or macaroon is picked up without a restart.
function lndRest({ base, certFile, macaroonFile, readFile = fs.promises.readFile }) {
  return async function call(method, route, body) {
    let ca;
    let macaroon;
    try {
      [ca, macaroon] = await Promise.all([readFile(certFile), readFile(macaroonFile)]);
    } catch (error) {
      const e = new ValidationError("This node's credentials for it cannot be read yet.", 503);
      e.code = "credentials";
      e.cause = error;
      throw e;
    }
    const url = new URL(route, base);
    const payload = body === undefined ? null : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        ca,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Grpc-Metadata-macaroon": macaroon.toString("hex"),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 4 * 1024 * 1024) {
            req.destroy(new Error("reply too large"));
          }
        });
        res.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (_) {
            return reject(new Error(`unreadable reply from ${url.pathname}`));
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(data);
          }
          const e = new Error((data && (data.message || data.error)) || `HTTP ${res.statusCode}`);
          e.status = res.statusCode;
          e.grpcCode = data && data.code;
          return reject(e);
        });
      });
      req.on("timeout", () => req.destroy(new Error(`${url.pathname} did not answer in time`)));
      req.on("error", reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  };
}

// A REST error's message without lnd's "code: " prefixes, for a sentence.
function lndMessage(error) {
  const msg = error && error.message ? String(error.message) : String(error);
  // Bridge refusals arrive as "code: sentence".
  const m = msg.match(/^[a-z_]+: (.*)$/s);
  return (m ? m[1] : msg).trim();
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The status lnd reports, in the names the page uses. 64-bit numbers arrive as
// strings in lnd's JSON; amounts here stay well inside a double.
function normaliseStatus(s) {
  const node = s.sha256_node || null;
  return {
    enabled: !!s.enabled,
    directions: s.directions || [],
    refusals: s.refusals || [],
    swapsInFlight: int(s.swaps_in_flight),
    rate: int(s.rate),
    rateSetAt: int(s.rate_set_at),
    rateExpiresAt: int(s.rate_expires_at),
    needsOperator: s.needs_operator || [],
    sha256Node: node && {
      mode: node.mode || "external",
      state: node.state || "",
      detail: node.detail || "",
      identityPubkey: node.identity_pubkey || "",
      uris: node.uris || [],
      synced: !!node.synced_to_chain,
      blockHeight: int(node.block_height),
      onchainConfirmedSat: int(node.onchain_confirmed_sat),
      onchainUnconfirmedSat: int(node.onchain_unconfirmed_sat),
      activeChannels: int(node.active_channels),
      inactiveChannels: int(node.inactive_channels),
      pendingChannels: int(node.pending_channels),
      outboundSat: Math.floor(int(node.outbound_msat) / 1000),
      inboundSat: Math.floor(int(node.inbound_msat) / 1000),
      peers: int(node.peers),
      version: node.version || "",
    },
  };
}

// Where an operator stands, as the steps of getting a bridge going. Each says
// whether it is done and, when it is not, the sentence that says what to do.
// Derived from what the node reports, not remembered: a channel that closes
// puts the step back.
function checklist(status, { participants = null, now = () => Date.now() / 1000, serving = null } = {}) {
  const node = status.sha256Node;
  const supervised = node && node.mode === "supervised";
  const steps = [];

  if (supervised) {
    const ready = node.state === "ready";
    steps.push({
      id: "node",
      done: ready,
      waiting: !ready && ["starting", "creating_wallet", "syncing"].includes(node.state),
      detail: ready ? "" : node.detail,
    });
    const funded = node.onchainConfirmedSat + node.onchainUnconfirmedSat > 0 ||
      node.activeChannels + node.pendingChannels > 0;
    steps.push({ id: "fund", done: funded, detail: "" });
  }

  const hasChannel = !!node && node.activeChannels > 0 && node.outboundSat > 0;
  steps.push({
    id: "channel",
    done: hasChannel,
    waiting: !!node && !hasChannel && node.pendingChannels > 0,
    detail: "",
  });

  const rate = rateState(status, now());
  steps.push({ id: "rate", done: rate === "fresh" || rate === "ageing", detail: "" });

  if (participants !== null) {
    steps.push({ id: "participants", done: participants > 0, detail: "" });
  }

  const s = serving || servingFrom(status, null);
  steps.push({
    id: "serving",
    done: s.directions.length > 0,
    detail: s.directions.length > 0 ? "" : s.reason,
  });

  return steps;
}

// Which directions are taking swaps right now, and when none is, the reason in
// the bridge's own words. From Info, which says per direction; Status lists
// every refusal, including those of directions the operator never turned on,
// so it is only the fallback when Info cannot be read.
function servingFrom(status, directionsInfo) {
  if (directionsInfo && directionsInfo.length) {
    const open = directionsInfo.filter((d) => d.open).map((d) => d.name);
    const closed = directionsInfo.find((d) => !d.open && d.refusal);
    return { directions: open, reason: open.length ? "" : (closed ? closed.refusal : status.refusals[0] || "") };
  }
  const open = status.refusals.length === 0 ? status.directions : [];
  return { directions: open, reason: open.length ? "" : status.refusals[0] || "" };
}

// How current the rate is: "unset", "fresh", "ageing" (past three quarters of
// its life, time to look at it) or "expired" (the bridge refuses quotes).
function rateState(status, now) {
  if (!(status.rate > 0)) {
    return "unset";
  }
  const { rateSetAt: setAt, rateExpiresAt: expiresAt } = status;
  if (!expiresAt) {
    return "fresh";
  }
  if (now >= expiresAt) {
    return "expired";
  }
  return setAt && expiresAt > setAt && now >= setAt + 0.75 * (expiresAt - setAt) ? "ageing" : "fresh";
}

// "pubkey@host:port", as a node URI is written.
function parsePeer(peer) {
  const m = String(peer || "").trim().match(/^([0-9a-fA-F]{66})@([^\s@]+:\d{1,5})$/);
  if (!m) {
    throw new ValidationError("Write the peer as pubkey@host:port.", 400);
  }
  return { pubkey: m[1].toLowerCase(), host: m[2] };
}

// A channel's funding txid, from what lnd's REST API returns for OpenChannelSync.
function fundingTxid(point) {
  if (point && point.funding_txid_str) {
    return point.funding_txid_str;
  }
  if (point && point.funding_txid_bytes) {
    return Buffer.from(point.funding_txid_bytes, "base64").reverse().toString("hex");
  }
  return "";
}

function freshRootKeyId(used, random = randomBytes) {
  const taken = new Set(used.map(String));
  const span = 2n ** 63n - 1n - FIRST_PARTICIPANT_ROOT_KEY_ID;
  for (let i = 0; i < 16; i++) {
    const id = FIRST_PARTICIPANT_ROOT_KEY_ID + random(8).readBigUInt64BE() % span;
    if (!taken.has(id.toString())) {
      return id.toString();
    }
  }
  throw new Error("could not pick an unused root key id");
}

function createBridgeOperator({
  lightningFork,              // lndRest for this node
  sha256Node = null,          // lndRest for the supervised SHA256 node, or null
  reference = null,           // a referenceRate, for the market beside the rate
  participantUrl = null,      // https://<onion>:<port> participants reach, or null
  readLabels = async () => ({}),
  writeLabels = async () => {},
  platform = "umbrel",
  bridgeSwitch = null,        // logic/bridgeSwitch.js, where the page is the switch
  now = () => Date.now() / 1000,
}) {
  async function status() {
    return normaliseStatus(await lightningFork("GET", "/v2/bridge/status"));
  }

  // The SHA256 node Lightning Fork created, read directly while the bridge is
  // off: it keeps running (it may hold channels), and Status says nothing
  // about it then. Null when there is none or it does not answer.
  async function idleNode() {
    if (!sha256Node) {
      return null;
    }
    try {
      const [info, chain, chans] = await Promise.all([
        sha256Node("GET", "/v1/getinfo"),
        sha256Node("GET", "/v1/balance/blockchain"),
        sha256Node("GET", "/v1/balance/channels"),
      ]);
      const sat = (b) => int(b && b.sat);
      return {
        mode: "idle",
        state: "ready",
        detail: "running while the bridge is off, watching its channels",
        identityPubkey: info.identity_pubkey || "",
        uris: info.uris || [],
        synced: !!info.synced_to_chain,
        blockHeight: int(info.block_height),
        onchainConfirmedSat: int(chain.confirmed_balance),
        onchainUnconfirmedSat: int(chain.unconfirmed_balance),
        activeChannels: int(info.num_active_channels),
        inactiveChannels: int(info.num_inactive_channels),
        pendingChannels: int(info.num_pending_channels),
        outboundSat: sat(chans.local_balance),
        inboundSat: sat(chans.remote_balance),
        peers: int(info.num_peers),
        version: info.version || "",
      };
    } catch (_) {
      return null;
    }
  }

  // Whether the SHA256 node is this app's to manage: the one Lightning Fork
  // runs (supervised), or that one still running with the bridge off. Never
  // an LND the operator runs themselves.
  async function ownNode() {
    if (!sha256Node) {
      return false;
    }
    const s = await status();
    if (s.sha256Node && s.sha256Node.mode === "supervised") {
      return true;
    }
    return !s.enabled && !!(await idleNode());
  }

  // Payments the bridge has not finished: in flight, or stopped for the
  // operator. Null when Lightning Fork cannot be asked.
  async function unfinished() {
    try {
      const s = await status();
      return s.enabled ? s.swapsInFlight + s.needsOperator.length : 0;
    } catch (_) {
      return null;
    }
  }

  // One read-modify-write of the labels file at a time.
  let labelsQueue = Promise.resolve();
  function withLabels(fn) {
    const run = labelsQueue.then(async () => {
      const labels = await readLabels();
      const out = await fn(labels);
      await writeLabels(labels);
      return out;
    });
    labelsQueue = run.catch(() => {});
    return run;
  }

  async function participants() {
    let ids = [];
    try {
      const res = await lightningFork("GET", "/v1/macaroon/ids");
      ids = (res.root_key_ids || []).map(String);
    } catch (_) {
      return null;
    }
    const labels = await readLabels();
    return ids
      .filter((id) => BigInt(id) >= FIRST_PARTICIPANT_ROOT_KEY_ID)
      .map((id) => ({ rootKeyId: id, label: labels[id] ? labels[id].label : "", createdAt: labels[id] ? labels[id].createdAt : null }));
  }

  // Everything the page shows, in one call. Each part that can fail on its
  // own (a market that does not answer, a bridge that is not serving yet)
  // fails on its own, so the page always has the parts it can.
  async function overview() {
    const s = await status();
    const [infoRes, market, people, toggle, idle] = await Promise.all([
      s.enabled ? lightningFork("GET", "/v2/bridge/info").catch(() => null) : null,
      s.enabled && reference ? reference.get().catch(() => null) : null,
      s.enabled ? participants() : null,
      bridgeSwitch ? bridgeSwitch.info().catch(() => null) : null,
      s.enabled ? null : idleNode(),
    ]);
    if (idle) {
      s.sha256Node = idle;
    }
    const directionsInfo = infoRes && infoRes.directions ? infoRes.directions.map((d) => ({
      name: d.name,
      open: !!d.open,
      refusal: d.refusal || "",
      spread: Number(d.spread) || 0,
      minSat: Math.ceil(int(d.min_msat) / 1000),
      maxSat: Math.floor(int(d.max_msat) / 1000),
    })) : [];
    const serving = servingFrom(s, directionsInfo);
    return {
      ...s,
      platform,
      toggle,
      directionsInfo,
      serving,
      market: market ? {
        rate: market.rate,
        source: market.source,
        at: market.at,
        // How far the bridge's rate is from it: above 0 gives payers more.
        difference: s.rate > 0 && market.rate > 0 ? s.rate / market.rate - 1 : null,
      } : null,
      rateState: rateState(s, now()),
      now: now(),
      participants: people,
      // On StartOS the package's own actions issue and revoke codes and keep
      // their names; two lists would drift apart.
      manageParticipants: platform !== "startos",
      canIssueCodes: platform !== "startos" && !!participantUrl,
      canManageSha256Node: !!sha256Node && !!s.sha256Node &&
        (s.sha256Node.mode === "supervised" || s.sha256Node.mode === "idle"),
      steps: s.enabled ? checklist(s, { participants: people ? people.length : null, now, serving }) : [],
    };
  }

  async function setRate(rate) {
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0 || r > 1) {
      throw new ValidationError("The rate is how much BTC (SHA256) one BTCB2 buys: a positive number such as 0.00483.", 400);
    }
    try {
      const res = await lightningFork("POST", "/v2/bridge/rate", { rate: r });
      return { rate: Number(res.rate), rateSetAt: int(res.rate_set_at) };
    } catch (error) {
      throw new ValidationError(lndMessage(error), error.status === 400 ? 400 : 502);
    }
  }

  async function requireSha256Node() {
    if (!(await ownNode())) {
      throw new ValidationError("This bridge pays through an LND you run yourself; manage that node with your own tools.", 409);
    }
  }

  async function depositAddress() {
    await requireSha256Node();
    try {
      const res = await sha256Node("GET", "/v1/newaddress?type=UNUSED_TAPROOT_PUBKEY");
      return { address: res.address };
    } catch (error) {
      throw new ValidationError(`The SHA256 node did not give an address: ${lndMessage(error)}`, 502);
    }
  }

  async function openChannel({ peer, amountSat }) {
    await requireSha256Node();
    const { pubkey, host } = parsePeer(peer);
    const amount = Number(amountSat);
    if (!Number.isInteger(amount) || amount < 20000) {
      throw new ValidationError("The channel needs at least 20,000 sats.", 400);
    }
    try {
      // lnd's own timeout, shorter than this client's, so an unreachable
      // peer comes back as lnd's reason rather than as no answer.
      await sha256Node("POST", "/v1/peers", { addr: { pubkey, host }, perm: false, timeout: "15" });
    } catch (error) {
      if (!/already connected/i.test(lndMessage(error))) {
        throw new ValidationError(`Could not reach ${host}: ${lndMessage(error)}`, 502);
      }
    }
    try {
      const point = await sha256Node("POST", "/v1/channels", {
        node_pubkey: Buffer.from(pubkey, "hex").toString("base64"),
        local_funding_amount: String(amount),
      });
      return { txid: fundingTxid(point) };
    } catch (error) {
      throw new ValidationError(`The channel was not opened: ${lndMessage(error)}`, 502);
    }
  }

  async function recoveryPhrase() {
    try {
      const res = await lightningFork("POST", "/v2/bridge/sha256seed", {});
      return {
        mnemonic: res.mnemonic || [],
        extendedMasterKey: res.extended_master_key || "",
        identityPubkey: res.identity_pubkey || "",
        birthday: int(res.birthday),
        derivation: res.derivation || "",
      };
    } catch (error) {
      throw new ValidationError(lndMessage(error), 502);
    }
  }

  // The SHA256 node's channel backup, as lnd writes it to channel.backup:
  // what `lncli restorechanbackup --multi_file` takes. Encrypted with that
  // node's seed.
  async function channelBackup() {
    await requireSha256Node();
    let res;
    try {
      res = await sha256Node("GET", "/v1/channels/backup");
    } catch (error) {
      throw new ValidationError(`The SHA256 node did not give its channel backup: ${lndMessage(error)}`, 502);
    }
    const packed = res && res.multi_chan_backup && res.multi_chan_backup.multi_chan_backup;
    if (!packed) {
      throw new ValidationError("The SHA256 node has no channels to back up yet.", 404);
    }
    return Buffer.from(packed, "base64");
  }

  function requireParticipants() {
    if (platform === "startos") {
      throw new ValidationError("On StartOS, issue and revoke bridge codes with the Bridge Code and Remove Bridge Participant actions.", 409);
    }
  }

  async function issueCode(label) {
    requireParticipants();
    const name = String(label || "").trim();
    if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new ValidationError("Give the participant a name of one line, up to 64 characters.", 400);
    }
    if (!participantUrl) {
      throw new ValidationError("This node has no address participants can reach it at yet.", 409);
    }
    const [info, ids] = await Promise.all([
      lightningFork("GET", "/v1/getinfo"),
      lightningFork("GET", "/v1/macaroon/ids").then((r) => r.root_key_ids || []),
    ]);
    const rootKeyId = freshRootKeyId(ids);
    const baked = await lightningFork("POST", "/v1/macaroon", {
      permissions: PARTICIPANT_URIS.map((uri) => ({ entity: "uri", action: uri })),
      root_key_id: rootKeyId,
    });
    const code = encodeBridgeCode({
      label: name,
      url: participantUrl,
      node: info.identity_pubkey,
      macaroon: baked.macaroon,
    });
    await withLabels((labels) => {
      labels[rootKeyId] = { label: name, createdAt: new Date(now() * 1000).toISOString() };
    });
    return { code, rootKeyId, label: name };
  }

  async function revokeCode(rootKeyId) {
    requireParticipants();
    if (!/^\d{4,20}$/.test(String(rootKeyId)) || BigInt(rootKeyId) < FIRST_PARTICIPANT_ROOT_KEY_ID) {
      throw new ValidationError("That is not a participant's code.", 400);
    }
    await lightningFork("DELETE", `/v1/macaroon/${rootKeyId}`);
    await withLabels((labels) => {
      delete labels[rootKeyId];
    });
    return { revoked: rootKeyId };
  }

  return { overview, status, setRate, depositAddress, openChannel, recoveryPhrase, channelBackup, issueCode, revokeCode, participants, idleNode, unfinished };
}

// The instance the routes use, from the environment.
let singleton = null;
function instance() {
  if (singleton) {
    return singleton;
  }
  const constants = require("../utils/const.js");
  const { createReferenceRate } = require("./referenceRate.js");
  const host = process.env.LND_HOST || "127.0.0.1";
  const lndDir = constants.LND_DIR;
  const sha256Dir = process.env.SHA256_LND_DIR || path.join(lndDir, "sha256-node");
  const sha256Network = process.env.LND_NETWORK || "mainnet";
  const labelsFile = path.join(path.dirname(constants.JSON_STORE_FILE), "bridge-participants.json");
  const onion = constants.LND_REST_HIDDEN_SERVICE;

  singleton = createBridgeOperator({
    lightningFork: lndRest({
      base: `https://${host}:${constants.LND_REST_PORT}`,
      certFile: constants.LND_CERT_FILE,
      macaroonFile: constants.LND_ADMIN_MACAROON_FILE,
    }),
    // Umbrel mounts the node's directory; StartOS hands copies over
    // (SHA256_TLS_FILE, SHA256_MACAROON_FILE) and mounts nothing of it.
    sha256Node: lndRest({
      base: process.env.SHA256_LND_REST || `https://${host}:${SHA256_REST_PORT}`,
      certFile: process.env.SHA256_TLS_FILE || path.join(sha256Dir, "tls.cert"),
      macaroonFile: process.env.SHA256_MACAROON_FILE ||
        path.join(sha256Dir, "data", "chain", "bitcoin", sha256Network, "admin.macaroon"),
    }),
    reference: createReferenceRate(),
    participantUrl: onion && onion !== "unset.onion" && onion !== "notyetset.onion"
      ? `https://${onion}:${process.env.BRIDGE_PARTICIPANT_PORT || constants.LND_REST_PORT}`
      : null,
    readLabels: async () => {
      try {
        return JSON.parse(await fs.promises.readFile(labelsFile, "utf8"));
      } catch (_) {
        return {};
      }
    },
    writeLabels: async (labels) => {
      const tmp = `${labelsFile}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(labels, null, 2), { mode: 0o600 });
      await fs.promises.rename(tmp, labelsFile);
    },
    platform: constants.IS_STARTOS ? "startos" : "umbrel",
    bridgeSwitch: require("./bridgeSwitch.js").instance(),
  });
  return singleton;
}

module.exports = {
  createBridgeOperator,
  lndRest,
  normaliseStatus,
  checklist,
  servingFrom,
  rateState,
  parsePeer,
  fundingTxid,
  freshRootKeyId,
  lndMessage,
  instance,
  PARTICIPANT_URIS,
  FIRST_PARTICIPANT_ROOT_KEY_ID,
};
