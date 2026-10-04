const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
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
  PARTICIPANT_URIS,
} = require("../logic/bridgeOperator.js");
const { parseBridgeCode } = require("../utils/bridgeCode.js");

const NODE = "02" + "ab".repeat(32);
const PEER = "03" + "cd".repeat(32);

// What lncli bridge status prints for a supervised bridge, in lnd's JSON.
function lndStatus(overrides = {}, node = {}) {
  return {
    enabled: true,
    directions: ["toSHA256"],
    refusals: [],
    swaps_in_flight: 0,
    rate: 0.005,
    rate_set_at: "1791000000",
    rate_expires_at: "1791086400",
    needs_operator: [],
    sha256_node: {
      mode: "supervised",
      state: "ready",
      detail: "ready",
      identity_pubkey: NODE,
      uris: [`${NODE}@10.0.0.2:9739`],
      synced_to_chain: true,
      block_height: 969800,
      onchain_confirmed_sat: "0",
      onchain_unconfirmed_sat: "0",
      active_channels: 1,
      inactive_channels: 0,
      pending_channels: 0,
      outbound_msat: "1500000000",
      inbound_msat: "250000000",
      peers: 3,
      version: "0.21.4-beta",
      ...node,
    },
    ...overrides,
  };
}

// A fake node: answers by method and path, and records what it was asked.
function fakeNode(routes) {
  const calls = [];
  const call = async (method, route, body) => {
    calls.push({ method, route, body });
    const handler = routes[`${method} ${route}`];
    if (!handler) {
      const e = new Error(`no route ${method} ${route}`);
      e.status = 404;
      throw e;
    }
    return typeof handler === "function" ? handler(body) : handler;
  };
  call.calls = calls;
  return call;
}

test("lnd's status is read into the page's names, 64-bit strings as numbers", () => {
  const s = normaliseStatus(lndStatus());
  assert.equal(s.rate, 0.005);
  assert.equal(s.rateSetAt, 1791000000);
  assert.equal(s.sha256Node.mode, "supervised");
  assert.equal(s.sha256Node.outboundSat, 1500000);
  assert.equal(s.sha256Node.inboundSat, 250000);
  assert.equal(s.sha256Node.synced, true);

  const off = normaliseStatus({ enabled: false, refusals: ["the bridge is not enabled on this node"] });
  assert.equal(off.enabled, false);
  assert.equal(off.sha256Node, null);
  assert.equal(off.rate, 0);
});

test("a new supervised bridge starts its checklist at the node", () => {
  const s = normaliseStatus(lndStatus(
    { rate: 0, rate_set_at: "0", rate_expires_at: "0", refusals: ["no rate has been set yet"] },
    { state: "creating_wallet", detail: "creating the SHA256 node's wallet", active_channels: 0, outbound_msat: "0" },
  ));
  const steps = checklist(s, { participants: 0, now: () => 1791000100 });
  assert.deepEqual(steps.map((x) => x.id), ["node", "fund", "channel", "rate", "participants", "serving"]);
  assert.deepEqual(steps.map((x) => x.done), [false, false, false, false, false, false]);
  assert.equal(steps[0].waiting, true, "the node is on its way, not stuck");
  assert.match(steps[0].detail, /creating/);
  assert.match(steps[5].detail, /no rate/);
});

test("the checklist follows what the nodes say, not what was done before", () => {
  const running = normaliseStatus(lndStatus());
  let steps = checklist(running, { participants: 2, now: () => 1791000100 });
  assert.ok(steps.every((x) => x.done), JSON.stringify(steps));

  // A channel that is still confirming is waited on, not missing.
  const opening = normaliseStatus(lndStatus({}, {
    active_channels: 0, pending_channels: 1, outbound_msat: "0", onchain_confirmed_sat: "0",
  }));
  steps = checklist(opening, { participants: 2, now: () => 1791000100 });
  const channel = steps.find((x) => x.id === "channel");
  assert.equal(channel.done, false);
  assert.equal(channel.waiting, true);
  assert.equal(steps.find((x) => x.id === "fund").done, true, "a pending channel was funded");

  // An expired rate puts the rate step back.
  steps = checklist(running, { participants: 2, now: () => 1791086401 });
  assert.equal(steps.find((x) => x.id === "rate").done, false);

  // Participants are left out when they cannot be counted.
  steps = checklist(running, { participants: null, now: () => 1791000100 });
  assert.equal(steps.find((x) => x.id === "participants"), undefined);
});

test("an external node's checklist has no node or funding steps", () => {
  const s = normaliseStatus(lndStatus({}, { mode: "external" }));
  const steps = checklist(s, { participants: 1, now: () => 1791000100 });
  assert.deepEqual(steps.map((x) => x.id), ["channel", "rate", "participants", "serving"]);
});

test("a rate is unset, fresh, ageing past three quarters of its life, then expired", () => {
  const at = (rate, setAt, expiresAt, now) => rateState({ rate, rateSetAt: setAt, rateExpiresAt: expiresAt }, now);
  assert.equal(at(0, 0, 0, 100), "unset");
  assert.equal(at(0.005, 1000, 2000, 1000), "fresh");
  assert.equal(at(0.005, 1000, 2000, 1749), "fresh");
  assert.equal(at(0.005, 1000, 2000, 1750), "ageing");
  assert.equal(at(0.005, 1000, 2000, 1999), "ageing");
  assert.equal(at(0.005, 1000, 2000, 2000), "expired");
  assert.equal(at(0.005, 1000, 0, 99999), "fresh", "a rate with no expiry never ages");
});

test("an ageing rate still counts as set; an expired one does not", () => {
  const steps = (now) => checklist(normaliseStatus(lndStatus()), { participants: 1, now: () => now });
  // lndStatus: set at 1791000000, expires at 1791086400.
  assert.equal(steps(1791080000).find((x) => x.id === "rate").done, true);
  assert.equal(steps(1791086400).find((x) => x.id === "rate").done, false);
});

test("a peer is pubkey@host:port and nothing else", () => {
  assert.deepEqual(parsePeer(` ${PEER.toUpperCase()}@node.example:9735 `), { pubkey: PEER, host: "node.example:9735" });
  for (const bad of ["", PEER, `${PEER}@host`, `${PEER.slice(2)}@host:1`, `${PEER}@ho st:1`, `${PEER}@a@b:1`]) {
    assert.throws(() => parsePeer(bad), /pubkey@host:port/, bad);
  }
});

test("a funding txid reads from either form lnd returns", () => {
  assert.equal(fundingTxid({ funding_txid_str: "aa" }), "aa");
  const txid = "11".repeat(31) + "22";
  const bytes = Buffer.from(txid, "hex").reverse().toString("base64");
  assert.equal(fundingTxid({ funding_txid_bytes: bytes }), txid);
  assert.equal(fundingTxid({}), "");
});

test("a participant's root key id is fresh and never a small or taken one", () => {
  const id = freshRootKeyId(["0", "1000"]);
  assert.ok(BigInt(id) >= 1000n);
  // A random draw that lands on a taken id is drawn again.
  const draws = [Buffer.alloc(8), Buffer.from("0000000000000005", "hex")];
  const again = freshRootKeyId(["1000"], () => draws.shift());
  assert.equal(again, "1005");
});

test("bridge refusals are shown without their code", () => {
  assert.equal(lndMessage(new Error("invalid_request: a rate must be positive")), "a rate must be positive");
  assert.equal(lndMessage(new Error("plain words")), "plain words");
});

test("the overview has every part it can get, even when one fails", async () => {
  const lf = fakeNode({
    "GET /v2/bridge/status": lndStatus(),
    "GET /v1/macaroon/ids": { root_key_ids: ["0", "1234567"] },
  });
  const op = createBridgeOperator({
    lightningFork: lf,
    sha256Node: fakeNode({}),
    reference: { get: async () => { throw new Error("market down"); } },
    readLabels: async () => ({ 1234567: { label: "Alice", createdAt: "2026-10-01T00:00:00Z" } }),
    participantUrl: "https://abc.onion:8080",
    now: () => 1791000100,
  });
  const o = await op.overview();
  assert.equal(o.enabled, true);
  assert.equal(o.rateState, "fresh");
  assert.equal(o.market, null, "a market that did not answer is absent, not an error");
  assert.deepEqual(o.directionsInfo, [], "Info failing is absent, not an error");
  assert.deepEqual(o.participants, [{ rootKeyId: "1234567", label: "Alice", createdAt: "2026-10-01T00:00:00Z" }]);
  assert.equal(o.canIssueCodes, true);
  assert.equal(o.canManageSha256Node, true);
  assert.ok(o.steps.length > 0);
});

test("the market rate comes with how far the bridge's rate is from it", async () => {
  const op = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus(), "GET /v2/bridge/info": { directions: [] }, "GET /v1/macaroon/ids": { root_key_ids: [] } }),
    reference: { get: async () => ({ rate: 0.004, source: "Neoxa", at: 1791000000, volatility: 0.01 }) },
    now: () => 1791000100,
  });
  const o = await op.overview();
  assert.equal(o.market.source, "Neoxa");
  assert.ok(Math.abs(o.market.difference - 0.25) < 1e-9, String(o.market.difference));
  assert.equal(o.market.volatility, undefined, "only what the page uses");
});

test("a node that does not bridge is asked for its status and nothing else", async () => {
  const lf = fakeNode({ "GET /v2/bridge/status": { enabled: false, refusals: ["the bridge is not enabled on this node"] } });
  const op = createBridgeOperator({ lightningFork: lf, reference: { get: async () => assert.fail("asked the market") } });
  const o = await op.overview();
  assert.equal(o.enabled, false);
  assert.deepEqual(o.steps, []);
  assert.deepEqual(lf.calls.map((c) => c.route), ["/v2/bridge/status"]);
});

test("setting the rate checks it and passes it on", async () => {
  const lf = fakeNode({ "POST /v2/bridge/rate": (b) => ({ rate: b.rate, rate_set_at: "1791000000" }) });
  const op = createBridgeOperator({ lightningFork: lf });
  assert.deepEqual(await op.setRate("0.0049"), { rate: 0.0049, rateSetAt: 1791000000 });
  for (const bad of [0, -1, "x", 2, NaN, null]) {
    await assert.rejects(op.setRate(bad), /positive number/, String(bad));
  }
  assert.equal(lf.calls.length, 1);
});

test("the SHA256 node's deposit address is an unused taproot one", async () => {
  const sha = fakeNode({ "GET /v1/newaddress?type=UNUSED_TAPROOT_PUBKEY": { address: "bc1pexample" } });
  const op = createBridgeOperator({ lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus() }), sha256Node: sha });
  assert.deepEqual(await op.depositAddress(), { address: "bc1pexample" });

  const external = createBridgeOperator({ lightningFork: fakeNode({}) });
  await assert.rejects(external.depositAddress(), /your own tools/);
});

test("opening a channel connects first, and an existing connection is fine", async () => {
  const txid = "ab".repeat(32);
  const sha = fakeNode({
    "POST /v1/peers": () => { throw new Error("already connected to peer: " + PEER); },
    "POST /v1/channels": { funding_txid_str: txid },
  });
  const op = createBridgeOperator({ lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus() }), sha256Node: sha });
  assert.deepEqual(await op.openChannel({ peer: `${PEER}@node.example:9735`, amountSat: 500000 }), { txid });
  const open = sha.calls.find((c) => c.route === "/v1/channels");
  assert.equal(Buffer.from(open.body.node_pubkey, "base64").toString("hex"), PEER);
  assert.equal(open.body.local_funding_amount, "500000");

  await assert.rejects(op.openChannel({ peer: `${PEER}@node.example:9735`, amountSat: 1000 }), /20,000/);
  const unreachable = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus() }),
    sha256Node: fakeNode({ "POST /v1/peers": () => { throw new Error("dial tcp: i/o timeout"); } }),
  });
  await assert.rejects(unreachable.openChannel({ peer: `${PEER}@node.example:9735`, amountSat: 500000 }), /Could not reach node.example:9735/);
});

test("a bridge code carries a macaroon for exactly the participant's calls", async () => {
  let saved = {};
  const lf = fakeNode({
    "GET /v1/getinfo": { identity_pubkey: NODE },
    "GET /v1/macaroon/ids": { root_key_ids: ["0"] },
    "POST /v1/macaroon": () => ({ macaroon: "0201" + "ff".repeat(40) }),
  });
  const op = createBridgeOperator({
    lightningFork: lf,
    participantUrl: "https://abcdefghijklmnop.onion:8080",
    readLabels: async () => ({ ...saved }),
    writeLabels: async (l) => { saved = l; },
    now: () => 1791000000,
  });
  const { code, rootKeyId, label } = await op.issueCode("  Alice  ");
  assert.equal(label, "Alice");
  const bake = lf.calls.find((c) => c.route === "/v1/macaroon");
  assert.deepEqual(bake.body.permissions, PARTICIPANT_URIS.map((uri) => ({ entity: "uri", action: uri })));
  assert.equal(bake.body.root_key_id, rootKeyId);
  assert.ok(BigInt(rootKeyId) >= 1000n);

  const parsed = parseBridgeCode(code);
  assert.equal(parsed.label, "Alice");
  assert.equal(parsed.node, NODE);
  assert.equal(parsed.url, "https://abcdefghijklmnop.onion:8080");
  assert.equal(saved[rootKeyId].label, "Alice");

  await assert.rejects(op.issueCode("two\nlines"), /one line/);
  const noAddress = createBridgeOperator({ lightningFork: lf });
  await assert.rejects(noAddress.issueCode("Bob"), /no address/);
});

test("revoking deletes the root key and the label, and only a participant's", async () => {
  let saved = { 1234567: { label: "Alice" } };
  const lf = fakeNode({ "DELETE /v1/macaroon/1234567": {} });
  const op = createBridgeOperator({
    lightningFork: lf,
    readLabels: async () => ({ ...saved }),
    writeLabels: async (l) => { saved = l; },
  });
  assert.deepEqual(await op.revokeCode("1234567"), { revoked: "1234567" });
  assert.deepEqual(saved, {});
  for (const bad of ["0", "999", "abc", "1; drop"]) {
    await assert.rejects(op.revokeCode(bad), /not a participant/, bad);
  }
});

// The REST client against a real TLS server: the node's certificate is the
// only CA, and the macaroon goes along as lnd expects it.
test("lndRest pins the node's certificate and sends the macaroon", async (t) => {
  let openssl = true;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch (_) {
    openssl = false;
  }
  if (!openssl) {
    t.skip("no openssl to make a certificate with");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-op-"));
  const key = path.join(dir, "tls.key");
  const cert = path.join(dir, "tls.cert");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const macaroonFile = path.join(dir, "admin.macaroon");
  fs.writeFileSync(macaroonFile, Buffer.from([2, 1, 3]));

  let seen = null;
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen = { method: req.method, url: req.url, macaroon: req.headers["grpc-metadata-macaroon"], body: raw };
      if (req.url === "/v2/bridge/rate") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ code: 3, message: "invalid_request: a rate must be positive" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `https://127.0.0.1:${server.address().port}`;

  const call = lndRest({ base, certFile: cert, macaroonFile });
  assert.deepEqual(await call("GET", "/v2/bridge/status"), { enabled: true });
  assert.equal(seen.macaroon, "020103");

  await assert.rejects(call("POST", "/v2/bridge/rate", { rate: -1 }), (e) => e.status === 400 && /rate must be positive/.test(e.message));
  assert.equal(seen.body, JSON.stringify({ rate: -1 }));

  // Another certificate is not trusted.
  const otherKey = path.join(dir, "other.key");
  const otherCert = path.join(dir, "other.cert");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", otherKey, "-out", otherCert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const wrong = lndRest({ base, certFile: otherCert, macaroonFile });
  await assert.rejects(wrong("GET", "/v2/bridge/status"));

  // Missing credentials are a 503 with a sentence, not a crash.
  const missing = lndRest({ base, certFile: cert, macaroonFile: path.join(dir, "nope") });
  await assert.rejects(missing("GET", "/v2/bridge/status"), (e) => e.statusCode === 503);
});

test("the SHA256 node's channel backup is the packed bytes lnd exports", async () => {
  const packed = Buffer.from([1, 2, 3, 250]);
  const op = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus() }),
    sha256Node: fakeNode({ "GET /v1/channels/backup": { multi_chan_backup: { multi_chan_backup: packed.toString("base64") } } }),
  });
  assert.deepEqual(await op.channelBackup(), packed);

  const empty = createBridgeOperator({ lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus() }), sha256Node: fakeNode({ "GET /v1/channels/backup": {} }) });
  await assert.rejects(empty.channelBackup(), (e) => e.statusCode === 404 && /no channels/.test(e.message));

  const external = createBridgeOperator({ lightningFork: fakeNode({}) });
  await assert.rejects(external.channelBackup(), /your own tools/);
});

test("on StartOS codes are the package's to issue and revoke", async () => {
  const lf = fakeNode({
    "GET /v2/bridge/status": lndStatus(),
    "GET /v1/macaroon/ids": { root_key_ids: ["0", "5000"] },
  });
  const op = createBridgeOperator({ lightningFork: lf, platform: "startos", participantUrl: "https://x.onion:8080" });
  const o = await op.overview();
  assert.equal(o.manageParticipants, false);
  assert.equal(o.canIssueCodes, false);
  assert.equal(o.participants.length, 1, "still listed and counted");
  await assert.rejects(op.issueCode("Alice"), /Bridge Code/);
  await assert.rejects(op.revokeCode("5000"), /Remove Bridge Participant/);
  assert.ok(!lf.calls.some((c) => c.method !== "GET"), "nothing baked or deleted");

  const umbrel = createBridgeOperator({ lightningFork: lf, participantUrl: "https://x.onion:8080" });
  const u = await umbrel.overview();
  assert.equal(u.manageParticipants, true);
  assert.equal(u.canIssueCodes, true);
});

test("what is serving comes from Info per direction, not from every refusal", async () => {
  // As the lab's supervised bridge reports it: toBLAKE2b configured but off,
  // toSHA256 on and out of liquidity.
  const status = lndStatus({
    refusals: [
      "toBLAKE2b is configured but not enabled",
      "toSHA256 has 0 msat of outbound capacity against a 1000000 msat minimum swap",
    ],
  });
  const info = {
    directions: [{
      name: "toSHA256", open: false, refusal_code: "no_liquidity",
      refusal: "outgoing inventory is below its floor", spread: 0.01,
      min_msat: "1000000", max_msat: "150000000",
    }],
  };
  const op = createBridgeOperator({
    lightningFork: fakeNode({
      "GET /v2/bridge/status": status,
      "GET /v2/bridge/info": info,
      "GET /v1/macaroon/ids": { root_key_ids: [] },
    }),
    now: () => 1791000100,
  });
  const o = await op.overview();
  assert.deepEqual(o.serving, { directions: [], reason: "outgoing inventory is below its floor" });
  assert.deepEqual(o.directionsInfo[0], { name: "toSHA256", open: false, refusal: "outgoing inventory is below its floor", spread: 0.01, minSat: 1000, maxSat: 150000 });
  const step = o.steps.find((x) => x.id === "serving");
  assert.equal(step.done, false);
  assert.equal(step.detail, "outgoing inventory is below its floor");

  // Open: serving, whatever another direction's refusal says.
  info.directions[0].open = true;
  const open = await op.overview();
  assert.deepEqual(open.serving, { directions: ["toSHA256"], reason: "" });
  assert.equal(open.steps.find((x) => x.id === "serving").done, true);
});

test("without Info, serving falls back to the status's refusals", () => {
  const s = normaliseStatus(lndStatus({ refusals: ["no rate has been set yet"] }));
  assert.deepEqual(servingFrom(s, []), { directions: [], reason: "no rate has been set yet" });
  assert.deepEqual(servingFrom(normaliseStatus(lndStatus()), null), { directions: ["toSHA256"], reason: "" });
});

const idleRoutes = {
  "GET /v1/getinfo": { identity_pubkey: PEER, uris: [], synced_to_chain: true, block_height: 900, num_active_channels: 1, num_inactive_channels: 0, num_pending_channels: 0, num_peers: 2, version: "0.21.4-beta" },
  "GET /v1/balance/blockchain": { confirmed_balance: "5000", unconfirmed_balance: "0" },
  "GET /v1/balance/channels": { local_balance: { sat: "700000" }, remote_balance: { sat: "300000" } },
  "GET /v1/channels/backup": { multi_chan_backup: { multi_chan_backup: Buffer.from([9]).toString("base64") } },
};

test("with the bridge off, a SHA256 node still running is shown and its backup can be had", async () => {
  const op = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": { enabled: false, refusals: [] } }),
    sha256Node: fakeNode(idleRoutes),
  });
  const o = await op.overview();
  assert.equal(o.enabled, false);
  assert.equal(o.sha256Node.mode, "idle");
  assert.equal(o.sha256Node.outboundSat, 700000);
  assert.equal(o.sha256Node.activeChannels, 1);
  assert.equal(o.canManageSha256Node, true);
  assert.deepEqual(await op.channelBackup(), Buffer.from([9]));

  // None created: nothing shown, nothing to manage.
  const none = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": { enabled: false, refusals: [] } }),
    sha256Node: fakeNode({}),
  });
  const n = await none.overview();
  assert.equal(n.sha256Node, null);
  assert.equal(n.canManageSha256Node, false);
});

test("an LND the operator runs is never managed from here, even when credentials exist", async () => {
  const op = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus({}, { mode: "external" }) }),
    sha256Node: fakeNode(idleRoutes),
  });
  await assert.rejects(op.depositAddress(), (e) => e.statusCode === 409);
  await assert.rejects(op.channelBackup(), (e) => e.statusCode === 409);
});

test("unfinished payments count those in flight and those that need the operator", async () => {
  const op = createBridgeOperator({
    lightningFork: fakeNode({ "GET /v2/bridge/status": lndStatus({ swaps_in_flight: 2, needs_operator: ["swap ab: paid, not claimed"] }) }),
  });
  assert.equal(await op.unfinished(), 3);
  const off = createBridgeOperator({ lightningFork: fakeNode({ "GET /v2/bridge/status": { enabled: false } }) });
  assert.equal(await off.unfinished(), 0);
  const down = createBridgeOperator({ lightningFork: fakeNode({}) });
  assert.equal(await down.unfinished(), null);
});

test("codes issued at once all keep their names", async () => {
  let saved = {};
  let n = 0;
  const lf = fakeNode({
    "GET /v1/getinfo": { identity_pubkey: NODE },
    "GET /v1/macaroon/ids": { root_key_ids: [] },
    "POST /v1/macaroon": () => ({ macaroon: "0201" + "ee".repeat(40) }),
  });
  const op = createBridgeOperator({
    lightningFork: lf,
    participantUrl: "https://abcdefghijklmnop.onion:8080",
    // Slow storage, so unsynchronised writes would overlap.
    readLabels: async () => { await new Promise((r) => setTimeout(r, 5)); return { ...saved }; },
    writeLabels: async (l) => { await new Promise((r) => setTimeout(r, 5)); saved = l; n++; },
  });
  const issued = await Promise.all(["A", "B", "C", "D"].map((l) => op.issueCode(l)));
  assert.equal(Object.keys(saved).length, 4);
  for (const i of issued) {
    assert.equal(saved[i.rootKeyId].label, i.label);
  }
  assert.equal(n, 4);
});
