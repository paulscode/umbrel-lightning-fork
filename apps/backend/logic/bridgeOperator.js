// Running a bridge from this node: what the operator's Bridge page shows and
// does.
//
// The bridge itself lives in Lightning Fork (its bridgerpc sub-server); this
// reads it and drives it through its REST routes. When Lightning Fork runs the
// bridge's SHA256 Lightning node for the operator (bridgerpc.sha256.supervised)
// this also talks to that node directly, for the things an operator does with a
// node: a deposit address, a channel opened or closed, coins sent away. With
// the narrow operator.macaroon Lightning Fork bakes for this console where it
// can be read, never the bridge's own.
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

// The first of `files` that can be read.
async function readFirst(readFile, files) {
  let last;
  for (const f of files) {
    try {
      return await readFile(f);
    } catch (error) {
      last = error;
      if (error.code !== "ENOENT") {
        break;
      }
    }
  }
  throw last;
}

// An lnd REST client for one node: its certificate is the only CA accepted,
// and its macaroon goes on every call: the first of several that exists, when
// given several, the narrowest first. Read per call, so a regenerated
// certificate or macaroon is picked up without a restart.
//
// { firstMessage: true } is for a streaming call (lnd's REST gateway writes
// one JSON object a line): it answers with the first message and hangs up, as
// `lncli closechannel --block=false` does. What was asked carries on in lnd.
function lndRest({ base, certFile, macaroonFile, readFile = fs.promises.readFile }) {
  const macaroonFiles = [].concat(macaroonFile);
  return async function call(method, route, body, { firstMessage = false } = {}) {
    let ca;
    let macaroon;
    try {
      [ca, macaroon] = await Promise.all([readFile(certFile), readFirst(readFile, macaroonFiles)]);
    } catch (error) {
      const e = new ValidationError("This node's credentials for it cannot be read yet.", 503);
      e.code = "credentials";
      e.cause = error;
      throw e;
    }
    const url = new URL(route, base);
    const payload = body === undefined ? null : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      // Set once a stream's first message has answered.
      let done = false;
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
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        // A stream's message: {"result": ...} or {"error": ...}.
        const settleStream = (line) => {
          done = true;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            return reject(new Error(`unreadable reply from ${url.pathname}`));
          }
          if (msg && msg.error) {
            const e = new Error(msg.error.message || "the call failed");
            e.grpcCode = msg.error.code;
            return reject(e);
          }
          return resolve((msg && msg.result) || {});
        };
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 4 * 1024 * 1024) {
            req.destroy(new Error("reply too large"));
          }
          const nl = raw.indexOf("\n");
          if (firstMessage && ok && !done && nl >= 0) {
            settleStream(raw.slice(0, nl));
            req.destroy();
          }
        });
        res.on("end", () => {
          if (done) {
            return;
          }
          if (firstMessage && ok) {
            return raw.trim() ? settleStream(raw.trim()) : reject(new Error(`${url.pathname} ended without an answer`));
          }
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (_) {
            return reject(new Error(`unreadable reply from ${url.pathname}`));
          }
          if (ok) {
            return resolve(data);
          }
          // A stream that fails before its first message answers
          // {"error": {code, message}}; anything else {code, message}.
          const body = data && data.error && typeof data.error === "object" ? data.error : data;
          const e = new Error((body && (body.message || (typeof body.error === "string" && body.error))) || `HTTP ${res.statusCode}`);
          e.status = res.statusCode;
          e.grpcCode = body && body.code;
          return reject(e);
        });
      });
      req.on("timeout", () => req.destroy(new Error(`${url.pathname} did not answer in time`)));
      req.on("error", (error) => {
        if (!done) {
          reject(error);
        }
      });
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
    // The journal's count of swaps not yet final, in every state; null from
    // a Lightning Fork too old to say it.
    unfinished: s.unfinished === undefined || s.unfinished === null ? null : int(s.unfinished),
    rate: int(s.rate),
    rateSetAt: int(s.rate_set_at),
    rateExpiresAt: int(s.rate_expires_at),
    // Where the rate comes from: "neoxa" (the market, read live) or "fixed"
    // (the operator's own). A Lightning Fork too old to say had only the
    // operator's own.
    rateSource: s.rate_source || "fixed",
    // Following the market: the cross-check's reading (BTCB2_USDC over
    // BTC/USD) and how far the market moved in the last minutes.
    rateCrossCheck: Number(s.rate_cross_check) || 0,
    rateVolatility: Number(s.rate_volatility) || 0,
    // Each direction's fee before the market and the position widen it;
    // null from a Lightning Fork too old to say.
    feeToSHA256: Number(s.fee_to_sha256) || null,
    feeToBLAKE2b: Number(s.fee_to_blake2b) || null,
    needsOperator: s.needs_operator || [],
    // Off with swaps still being finished (Lightning Fork's drain): it
    // quotes nothing, finishes them, and stops.
    draining: !s.enabled && (s.refusals || []).some((r) => /^finishing the swaps/.test(r)),
    // Off with swaps unfinished and no SHA256 node to finish them through.
    stuck: s.enabled ? 0 : (s.refusals || []).reduce((n, r) => {
      const m = /^(\d+) swap\(s\) are unfinished/.exec(r);
      return m ? Number(m[1]) : n;
    }, 0),
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
  if (status.rateSource === "neoxa") {
    // Nothing to set: the step is the market being readable.
    steps.push({ id: "market", done: rate === "market", detail: rate === "market" ? "" : marketRefusal(status) });
  } else {
    steps.push({ id: "rate", done: rate === "fresh" || rate === "ageing", detail: "" });
  }

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

// Lightning Fork's refusals for want of a market rate (lnrpc/bridgerpc
// rateRefusal).
const MARKET_REFUSAL = /^(no rate yet: reading the market|quoting nothing (without a current market rate|while the market))/;

// Why there is no market rate to trade at, or "".
function marketRefusal(status) {
  return (status.refusals || []).find((r) => MARKET_REFUSAL.test(r)) || "";
}

// How current the rate is. Following the market: "market" (read and usable)
// or "market_unavailable" (the bridge quotes nothing; marketRefusal says
// why). The operator's own: "unset", "fresh", "ageing" (past three quarters of
// its life, time to look at it) or "expired" (the bridge refuses quotes).
function rateState(status, now) {
  if (status.rateSource === "neoxa") {
    return status.rate > 0 && !marketRefusal(status) ? "market" : "market_unavailable";
  }
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

// A fee rate as the forms send it: absent, or a whole number of sat/vB.
function feeRate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    throw new ValidationError("The fee rate is a whole number of sats per vbyte.", 400);
  }
  return n;
}

// The SHA256 node's channels as the window lists them, open and pending.
function channelList(open, pending) {
  const sat = (v) => int(v);
  const out = (open.channels || []).map((c) => ({
    channelPoint: c.channel_point,
    remotePubkey: c.remote_pubkey,
    capacitySat: sat(c.capacity),
    localSat: sat(c.local_balance),
    remoteSat: sat(c.remote_balance),
    state: c.active ? "active" : "inactive",
    htlcs: (c.pending_htlcs || []).length,
  }));
  const add = (list, state, extra = () => ({})) => {
    for (const p of list || []) {
      const c = p.channel || {};
      out.push({
        channelPoint: c.channel_point,
        remotePubkey: c.remote_node_pub,
        capacitySat: sat(c.capacity),
        localSat: sat(c.local_balance),
        remoteSat: sat(c.remote_balance),
        state,
        htlcs: 0,
        ...extra(p),
      });
    }
  };
  add(pending.pending_open_channels, "opening");
  add(pending.waiting_close_channels, "closing", (p) => ({ closingTxid: p.closing_txid || "" }));
  add(pending.pending_force_closing_channels, "force-closing", (p) => ({
    closingTxid: p.closing_txid || "",
    blocksTilMaturity: int(p.blocks_til_maturity),
  }));
  return out;
}

// The SHA256 node's channel backup copy, as the window says it: off (no
// target), none yet, failing (with what), or when it was last copied.
function sha256BackupView(st) {
  if (!st) {
    return null;
  }
  if (!st.targets || !st.targets.length) {
    return { state: "off" };
  }
  if (st.state && st.state.failures && st.state.failures.length) {
    return {
      state: "failing",
      detail: st.state.failures.map((f) => `${f.target}: ${f.code}${f.detail ? ` (${f.detail})` : ""}`).join("; "),
    };
  }
  if (st.state && st.state.lastSuccess) {
    return { state: "copied", at: st.state.lastSuccess };
  }
  return { state: st.hasBackup ? "pending" : "none" };
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
  sha256Explorer = null,      // where links to the SHA256 chain go (logic/mempool.js)
  sha256RestorePending = async () => false, // its channel backup and no wallet
  sha256BackupStatus = () => null, // its channel backup's copy off the box (Umbrel)
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

  // The SHA256 node's identity, for its channel backup's folder; null when
  // it does not answer.
  async function sha256Pubkey() {
    if (!sha256Node) {
      return null;
    }
    try {
      return (await sha256Node("GET", "/v1/getinfo")).identity_pubkey || null;
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
    let s;
    try {
      s = await status();
    } catch (_) {
      throw new ValidationError("Lightning Fork is not answering about the bridge yet. It may be starting up.", 503);
    }
    if (s.sha256Node && s.sha256Node.mode === "supervised") {
      return true;
    }
    return !s.enabled && !!(await idleNode());
  }

  // This node's own bridge, as a way to pay a SHA256 invoice: its SHA256
  // node pays it from its own channels, with no swap and no fee (the
  // operator's own coin on both sides). {ready, outboundSat}, or null when
  // there is no such node or it cannot be asked. Never an LND the operator
  // runs themselves: that one is theirs to pay from with their own tools.
  async function ownPayer() {
    if (!sha256Node) {
      return null;
    }
    let s;
    try {
      s = await status();
    } catch (_) {
      return null;
    }
    const node = s.sha256Node && s.sha256Node.mode === "supervised" ? s.sha256Node : (!s.enabled ? await idleNode() : null);
    if (!node) {
      return null;
    }
    return { ready: node.state === "ready" && !!node.synced, outboundSat: int(node.outboundSat) };
  }

  // A SHA256 payment on the bridge's node: {status, preimage, feeSat,
  // valueSat, failureReason} as lnd's router reports it, or null when it has
  // none for the hash.
  function paymentOf(p) {
    return {
      status: String(p.status || ""),
      preimage: /^[0-9a-f]{64}$/i.test(String(p.payment_preimage || "")) && !/^0+$/.test(p.payment_preimage) ? p.payment_preimage.toLowerCase() : "",
      feeSat: int(p.fee_sat),
      valueSat: int(p.value_sat),
      failureReason: String(p.failure_reason || ""),
    };
  }

  // Starts paying `request` from the bridge's SHA256 node, and answers with
  // its first update. The router goes on paying after the answer: what
  // became of it is sha256Payment's.
  async function sha256Pay(request, feeLimitSat) {
    if (!(await ownNode())) {
      throw new ValidationError("This node's bridge has no SHA256 node of its own to pay from.", 409);
    }
    const update = await sha256Node("POST", "/v2/router/send", {
      payment_request: request,
      fee_limit_sat: String(feeLimitSat),
      timeout_seconds: 60,
      no_inflight_updates: false,
    }, { firstMessage: true });
    return paymentOf(update);
  }

  async function sha256Payment(paymentHash) {
    // lnd's REST gateway reads bytes in a path as standard base64, escaped.
    const hash = encodeURIComponent(Buffer.from(String(paymentHash), "hex").toString("base64"));
    try {
      return paymentOf(await sha256Node("GET", `/v2/router/track/${hash}?no_inflight_updates=false`, undefined, { firstMessage: true }));
    } catch (error) {
      if (error.grpcCode === 5 || /not found|unknown payment|isn't initiated/i.test(lndMessage(error))) {
        return null;
      }
      throw error;
    }
  }

  // Payments the bridge has not finished: in flight, waiting, or stopped
  // for the operator; whether it is on, off and finishing them, or not up.
  // A lost one is final and does not count. Null when Lightning Fork
  // cannot be asked.
  async function unfinished() {
    try {
      const s = await status();
      // Lightning Fork could not read its journal: unknown, not none.
      if (s.refusals.some((r) => /whether a swap is unfinished is not known/.test(r))) {
        return null;
      }
      if (s.unfinished !== null) {
        return s.unfinished;
      }
      if (s.stuck) {
        return s.stuck;
      }
      return s.enabled || s.draining ? s.swapsInFlight + s.needsOperator.length : 0;
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
    const [infoRes, market, people, toggle, idle, explorer, restorePending] = await Promise.all([
      s.enabled ? lightningFork("GET", "/v2/bridge/info").catch(() => null) : null,
      s.enabled && reference ? reference.get().catch(() => null) : null,
      s.enabled ? participants() : null,
      bridgeSwitch ? bridgeSwitch.info().catch(() => null) : null,
      s.enabled ? null : idleNode(),
      sha256Explorer ? sha256Explorer().catch(() => null) : null,
      s.enabled ? false : sha256RestorePending().catch(() => false),
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
      sha256Explorer: explorer,
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
      marketRefusal: marketRefusal(s),
      now: now(),
      participants: people,
      // On StartOS the package's own actions issue and revoke codes and keep
      // their names; two lists would drift apart.
      manageParticipants: platform !== "startos",
      canIssueCodes: platform !== "startos" && !!participantUrl,
      // Not while the node it reads is in doubt (left the SHA256 chain,
      // uninstalled): an address or channel there could be on the wrong
      // chain.
      canManageSha256Node: !!sha256Node && !!s.sha256Node &&
        (s.sha256Node.mode === "supervised" || s.sha256Node.mode === "idle") &&
        !(toggle && toggle.problem && toggle.problemBlocks),
      // Restored from a backup with the bridge off: its channels wait for
      // the bridge to be turned on, which recreates its wallet.
      sha256RestorePending: !!restorePending && !idle,
      sha256Backup: s.sha256Node && (s.sha256Node.mode === "supervised" || s.sha256Node.mode === "idle")
        ? sha256BackupView(sha256BackupStatus())
        : null,
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

  async function channels() {
    await requireSha256Node();
    try {
      const [open, pending] = await Promise.all([
        sha256Node("GET", "/v1/channels"),
        sha256Node("GET", "/v1/channels/pending"),
      ]);
      return { channels: channelList(open, pending) };
    } catch (error) {
      throw new ValidationError(`The SHA256 node did not list its channels: ${lndMessage(error)}`, 502);
    }
  }

  // Not while a payment through the bridge is unfinished: it may be
  // riding on this channel, and closing it under one turns a payment the
  // bridge is finishing into one settled on chain.
  async function requireNothingUnfinished(what) {
    const open = await unfinished();
    if (open === null) {
      throw new ValidationError(`Lightning Fork is not answering about the bridge, so whether a payment through it is unfinished is not known. ${what} once it answers.`, 503);
    }
    if (open > 0) {
      throw new ValidationError(`${open} ${open === 1 ? "payment" : "payments"} through the bridge ${open === 1 ? "is" : "are"} not finished. ${what} once none is in progress or needs you.`, 409);
    }
  }

  // Closes one of the SHA256 node's channels: with its peer, or alone
  // (force), which locks the node's share for a while.
  async function closeChannel({ channelPoint, force = false, satPerVbyte = null }) {
    await requireSha256Node();
    const m = String(channelPoint || "").match(/^([0-9a-f]{64}):(\d{1,5})$/);
    if (!m) {
      throw new ValidationError("Name the channel by its channel point (txid:index).", 400);
    }
    if (typeof force !== "boolean") {
      throw new ValidationError("Say whether to force the close.", 400);
    }
    const rate = feeRate(satPerVbyte);
    if (force && rate !== null) {
      throw new ValidationError("A forced close pays the fee its commitment transaction already has; leave the fee rate out.", 400);
    }
    await requireNothingUnfinished("Close the channel");
    const { channels: list } = await channels();
    const chan = list.find((c) => c.channelPoint === channelPoint);
    if (!chan) {
      throw new ValidationError("The bridge node has no such channel.", 404);
    }
    if (chan.state !== "active" && chan.state !== "inactive") {
      throw new ValidationError(chan.state === "opening" ? "The channel is still opening; it can be closed once it is open." : "The channel is already closing.", 409);
    }
    if (!force && chan.state === "inactive") {
      throw new ValidationError("Its peer is not connected, so the channel cannot be closed with it now. Wait for the peer, or force the close.", 409);
    }
    const query = new URLSearchParams();
    if (force) {
      query.set("force", "true");
    } else if (rate !== null) {
      query.set("sat_per_vbyte", String(rate));
    }
    try {
      const update = await sha256Node("DELETE", `/v1/channels/${m[1]}/${m[2]}${query.toString() ? `?${query}` : ""}`, undefined, { firstMessage: true });
      const pendingTxid = update.close_pending && update.close_pending.txid;
      // Asked for, without a closing transaction yet to show: said as
      // under way.
      return pendingTxid
        ? { txid: Buffer.from(pendingTxid, "base64").reverse().toString("hex") }
        : { txid: "", slow: true };
    } catch (error) {
      if (/did not answer in time/.test(error.message)) {
        return { txid: "", slow: true };
      }
      throw new ValidationError(`The channel was not closed: ${lndMessage(error)}`, 502);
    }
  }

  // Sends coins on the SHA256 chain out of the bridge node: an amount, or
  // all of it.
  async function withdraw({ address, amountSat = null, sendAll = false, satPerVbyte = null }) {
    await requireSha256Node();
    const addr = String(address || "").trim();
    if (!/^[A-Za-z0-9]{14,90}$/.test(addr)) {
      throw new ValidationError("That is not an address.", 400);
    }
    if (typeof sendAll !== "boolean") {
      throw new ValidationError("Say whether to send everything.", 400);
    }
    const amount = Number(amountSat);
    if (!sendAll && (!Number.isInteger(amount) || amount < 1)) {
      throw new ValidationError("Give the amount as a whole number of sats.", 400);
    }
    const rate = feeRate(satPerVbyte);
    const req = { addr, ...(sendAll ? { send_all: true } : { amount: String(amount) }) };
    if (rate !== null) {
      req.sat_per_vbyte = String(rate);
    } else {
      req.target_conf = 6;
    }
    try {
      const res = await sha256Node("POST", "/v1/transactions", req);
      return { txid: res.txid || "" };
    } catch (error) {
      throw new ValidationError(`Nothing was sent: ${lndMessage(error)}`, 502);
    }
  }

  async function recoveryPhrase() {
    try {
      const res = await lightningFork("POST", "/v2/bridge/sha256seed", {});
      // The words and the identity they give, which the window shows;
      // not the BIP32 root key lnd also returns, which it does not, and so
      // need not cross to the browser at all.
      return {
        mnemonic: res.mnemonic || [],
        identityPubkey: res.identity_pubkey || "",
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
      throw new ValidationError("On StartOS, issue and revoke bridge codes with the Add Bridge Participant and Remove Bridge Participant actions.", 409);
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
    let info;
    let ids;
    let baked;
    let rootKeyId;
    try {
      [info, ids] = await Promise.all([
        lightningFork("GET", "/v1/getinfo"),
        lightningFork("GET", "/v1/macaroon/ids").then((r) => r.root_key_ids || []),
      ]);
      rootKeyId = freshRootKeyId(ids);
      baked = await lightningFork("POST", "/v1/macaroon", {
        permissions: PARTICIPANT_URIS.map((uri) => ({ entity: "uri", action: uri })),
        root_key_id: rootKeyId,
      });
    } catch (error) {
      throw new ValidationError(`Lightning Fork did not make the code: ${lndMessage(error)}`, 502);
    }
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
    try {
      await lightningFork("DELETE", `/v1/macaroon/${rootKeyId}`);
    } catch (error) {
      throw new ValidationError(`Lightning Fork did not revoke the code: ${lndMessage(error)}`, 502);
    }
    await withLabels((labels) => {
      delete labels[rootKeyId];
    });
    return { revoked: rootKeyId };
  }

  return { overview, status, sha256Pubkey, ownPayer, sha256Pay, sha256Payment, setRate, depositAddress, openChannel, channels, closeChannel, withdraw, recoveryPhrase, channelBackup, issueCode, revokeCode, participants, idleNode, unfinished };
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
    // Umbrel mounts the node's directory and Lightning Fork's, where the
    // console's operator.macaroon is (the node's admin one only until
    // Lightning Fork has baked it); StartOS hands copies over
    // (SHA256_TLS_FILE, SHA256_MACAROON_FILE) and mounts nothing of either.
    sha256Node: lndRest({
      base: process.env.SHA256_LND_REST || `https://${host}:${SHA256_REST_PORT}`,
      certFile: process.env.SHA256_TLS_FILE || path.join(sha256Dir, "tls.cert"),
      macaroonFile: process.env.SHA256_MACAROON_FILE || [
        path.join(lndDir, "data", "chain", "bitcoin", sha256Network, "bridge", "sha256", "operator.macaroon"),
        path.join(sha256Dir, "data", "chain", "bitcoin", sha256Network, "admin.macaroon"),
      ],
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
    sha256Explorer: () => require("./mempool.js").sha256Explorer(),
    sha256RestorePending: async () => {
      const dataDir = path.join(sha256Dir, "data", "chain", "bitcoin", sha256Network);
      const exists = (f) => fs.promises.stat(path.join(dataDir, f)).then((st) => st.size > 0, () => false);
      return (await exists("channel.backup")) && !(await exists("wallet.db"));
    },
    // On StartOS the package copies it and says so in its health check.
    sha256BackupStatus: constants.IS_STARTOS ? () => null : () => require("./channelBackup.js").sha256Status(),
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
  marketRefusal,
  parsePeer,
  fundingTxid,
  channelList,
  sha256BackupView,
  freshRootKeyId,
  lndMessage,
  instance,
  PARTICIPANT_URIS,
  FIRST_PARTICIPANT_ROOT_KEY_ID,
};
