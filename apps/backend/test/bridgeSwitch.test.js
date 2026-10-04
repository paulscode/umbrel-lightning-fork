const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBridgeSwitch, sha256ConfWriter } = require("../logic/bridgeSwitch.js");
const { createSha256Nodes, parseNodes } = require("../logic/sha256Nodes.js");

const { ACTIVATION } = require("../logic/mempool.js");

const ACT = ACTIVATION.mainnet;
const SHA = ACT.sha256Hash;
const COMPANION = "paulscode-knots-sha256|10.21.21.64:19332|umbrel|Sha_pw-B=";
const KNOTS = "bitcoin-knots|10.21.21.7:9332|umbrel|Kn0ts_pw-A=";

function fakeNodes(list, byHost) {
  return createSha256Nodes({
    nodes: parseNodes(list),
    rpc: async (node, method) => {
      const n = byHost[node.host];
      if (!n) {
        throw new Error("connect ECONNREFUSED");
      }
      return method === "getblockchaininfo" ? { chain: "main", blocks: n.blocks ?? 970000 } : n.hash;
    },
    lfHost: "10.21.21.62",
    activation: ACT,
  });
}

const LND = { alias: "mine", "tlsautorefresh": true };

function harness({ platform = "umbrel", nodes = fakeNodes(COMPANION, { "10.21.21.64": { hash: SHA } }), settings = { lnd: LND }, stop = async () => {}, unfinished = async () => 0, lf } = {}) {
  const state = { settings: JSON.parse(JSON.stringify(settings)), writes: [], stops: 0 };
  // Lightning Fork applies what was written at each restart, unless told.
  state.applied = !!(state.settings.bridge && state.settings.bridge.enabled);
  state.confs = [];
  state.conf = null;
  const sw = createBridgeSwitch({
    platform,
    sha256Nodes: nodes,
    writeSha256Conf: async (text) => { state.confs.push(text); state.conf = text; },
    readSha256Conf: async () => state.conf,
    removeSha256Conf: async () => { state.conf = null; state.removed = (state.removed || 0) + 1; },
    readSettings: async () => state.settings,
    writeLndConfig: async (lnd, bridge) => {
      state.writes.push({ lnd, bridge });
      state.settings = { lnd, ...(Object.keys(bridge).length ? { bridge } : {}) };
    },
    defaultLnd: { defaults: true },
    stopDaemon: async () => {
      state.stops++;
      await stop();
      state.applied = !!(state.settings.bridge && state.settings.bridge.enabled);
    },
    unfinished,
    lfEnabled: lf || (async () => state.applied),
    now: () => Date.parse("2026-10-04T10:00:00Z"),
  });
  return { sw, state };
}

test("turning it on writes the bridge section, keeps Advanced Settings, and restarts", async () => {
  const { sw, state } = harness();
  assert.deepEqual(await sw.set(true), { on: true, restarting: true, node: "paulscode-knots-sha256" });
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].lnd, LND, "Advanced Settings untouched");
  assert.deepEqual(state.writes[0].bridge, { enabled: true, changedAt: "2026-10-04T10:00:00.000Z", sha256Node: "paulscode-knots-sha256" });
  assert.match(state.confs[0], /bitcoind\.rpchost=10\.21\.21\.64:19332/);
  assert.equal(state.stops, 1);
  assert.equal((await sw.info()).on, true);

  // Again: nothing to do, no restart.
  assert.deepEqual(await sw.set(true), { on: true, restarting: false, node: "paulscode-knots-sha256" });
  assert.equal(state.stops, 1);

  assert.deepEqual(await sw.set(false), { on: false, restarting: true, node: "paulscode-knots-sha256" });
  assert.equal(state.settings.bridge.enabled, false);
  assert.equal(state.stops, 2);
});

test("a restart that fails puts both files back", async () => {
  const { sw, state } = harness({
    stop: async () => { const e = new Error("x"); e.error = { details: "wallet locked, unlock it to enable full RPC access" }; throw e; },
  });
  await assert.rejects(sw.set(true), (e) => e.statusCode === 503 && /almost ready/.test(e.message));
  assert.equal(state.writes.length, 2);
  assert.deepEqual(state.writes[1], { lnd: LND, bridge: {} });
  assert.equal(state.settings.bridge, undefined);
  assert.equal((await sw.info()).on, false);
});

test("without a node on the SHA256 chain it cannot be turned on, and says what to install", async () => {
  const { sw, state } = harness({ nodes: fakeNodes("", {}) });
  const info = await sw.info();
  assert.equal(info.available, false);
  assert.match(info.unavailable, /Knots \(SHA256\) Companion/);
  await assert.rejects(sw.set(true), (e) => e.statusCode === 409 && /Knots \(SHA256\) Companion/.test(e.message));
  assert.equal(state.writes.length, 0);
  assert.equal(state.stops, 0);
});

test("a node that was never configured gets the default Advanced Settings", async () => {
  const { sw, state } = harness({ settings: {} });
  await sw.set(true);
  assert.deepEqual(state.writes[0].lnd, { defaults: true });
});

test("on StartOS there is no switch here", async () => {
  const { sw, state } = harness({ platform: "startos" });
  assert.equal(await sw.info(), null);
  await assert.rejects(sw.set(true), /Bridge action/);
  assert.equal(state.writes.length, 0);
});

test("only true or false", async () => {
  const { sw } = harness();
  for (const bad of ["true", 1, null, undefined]) {
    await assert.rejects(sw.set(bad), /should be on/, String(bad));
  }
});

test("it is not turned off while payments are unfinished", async () => {
  const { sw, state } = harness({ settings: { lnd: LND, bridge: { enabled: true } }, unfinished: async () => 2 });
  await assert.rejects(sw.set(false), (e) => e.statusCode === 409 && /2 payments .* are not finished/.test(e.message));
  assert.equal(state.writes.length, 0);
  assert.equal(state.stops, 0);

  // Unknown (Lightning Fork not answering) is no reason to refuse.
  const down = harness({ settings: { lnd: LND, bridge: { enabled: true } }, unfinished: async () => null });
  assert.deepEqual(await down.sw.set(false), { on: false, restarting: true, node: null });
});

test("with Lightning Fork down, what was written stands, so a bad bridge can be turned off", async () => {
  const { sw, state } = harness({
    settings: { lnd: LND, bridge: { enabled: true } },
    stop: async () => { const e = new Error("14 UNAVAILABLE: No connection established"); throw e; },
    unfinished: async () => null,
    lf: async () => null,
  });
  assert.deepEqual(await sw.set(false), { on: false, restarting: true, node: null });
  assert.equal(state.writes.length, 1, "not put back");
  assert.equal(state.settings.bridge.enabled, false);
});

test("written but never applied: asking again applies it", async () => {
  const { sw, state } = harness({ settings: { lnd: LND, bridge: { enabled: true } }, lf: async () => false });
  assert.deepEqual(await sw.set(true), { on: true, restarting: true, node: "paulscode-knots-sha256" });
  assert.equal(state.stops, 1);
});

test("the node is the one asked for, and must be on the SHA256 chain now", async () => {
  const byHost = { "10.21.21.64": { hash: SHA }, "10.21.21.7": { hash: ACT.hash } };
  const { sw, state } = harness({ nodes: fakeNodes(`${COMPANION};${KNOTS}`, byHost) });
  const info = await sw.info();
  assert.deepEqual(info.nodes.map((n) => [n.id, n.state]), [["paulscode-knots-sha256", "sha256"], ["bitcoin-knots", "blake2b"]]);
  assert.equal(info.chosen, "paulscode-knots-sha256");

  await assert.rejects(sw.set(true, "bitcoin-knots"), (e) => e.statusCode === 409 && /Bitcoin Knots cannot be .* on the BLAKE2b chain/.test(e.message));
  await assert.rejects(sw.set(true, "bitcoin"), /not installed/);
  assert.equal(state.confs.length, 0);

  // Bitcoin Knots switched to a version for the SHA256 chain: usable, and
  // asked afresh rather than from the minute-long cache.
  byHost["10.21.21.7"].hash = SHA;
  await sw.set(true, "bitcoin-knots");
  assert.match(state.confs[0], /10\.21\.21\.7:9332/);
  assert.equal(state.settings.bridge.sha256Node, "bitcoin-knots");
});

test("changing the node of a running bridge does not restart Lightning Fork", async () => {
  const byHost = { "10.21.21.64": { hash: SHA }, "10.21.21.7": { hash: SHA } };
  const { sw, state } = harness({
    nodes: fakeNodes(`${COMPANION};${KNOTS}`, byHost),
    settings: { lnd: LND, bridge: { enabled: true, sha256Node: "paulscode-knots-sha256" } },
  });
  assert.equal((await sw.info()).inUse, "paulscode-knots-sha256");
  assert.deepEqual(await sw.set(true, "bitcoin-knots"), { on: true, restarting: false, node: "bitcoin-knots" });
  assert.equal(state.stops, 0);
  assert.equal(state.settings.bridge.sha256Node, "bitcoin-knots");
  assert.match(state.conf, /10\.21\.21\.7:9332/);
});

test("why nothing can be used is said, with what to do", async () => {
  const behind = harness({ nodes: fakeNodes(COMPANION, { "10.21.21.64": { blocks: 800000 } }) });
  assert.match((await behind.sw.info()).unavailable, /still syncing.*Wait for it to sync/);
  const knots = harness({ nodes: fakeNodes(KNOTS, { "10.21.21.7": { hash: ACT.hash } }) });
  assert.match((await knots.sw.info()).unavailable, /pick a version for that chain in its own settings/);
  const down = harness({ nodes: fakeNodes(COMPANION, {}) });
  assert.match((await down.sw.info()).unavailable, /Check that it is running/);
});

test("the SHA256 node's config is written whole, private, and replaced cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sha256-conf-"));
  const file = path.join(dir, "bridge-sha256.conf");
  const write = sha256ConfWriter(file, 1000);
  await write("one\n");
  await write("two\n");
  assert.equal(fs.readFileSync(file, "utf8"), "two\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["bridge-sha256.conf"]);
  await assert.rejects(sha256ConfWriter("", 1000)("x"), /no place/);
});

test("while on, the node in use is kept current, and stopped when it leaves the SHA256 chain", async () => {
  const byHost = { "10.21.21.7": { hash: SHA } };
  const nodes = fakeNodes(KNOTS, byHost);
  const { sw, state } = harness({ nodes, settings: { lnd: LND, bridge: { enabled: true, sha256Node: "bitcoin-knots" } } });

  // Restored elsewhere: no config file. Written again.
  assert.equal((await sw.reconcile()).text, "");
  assert.match(state.conf, /10\.21\.21\.7:9332/);
  const writes = state.confs.length;
  assert.equal((await sw.reconcile()).text, "");
  assert.equal(state.confs.length, writes, "unchanged is left alone");

  // Bitcoin Knots switched to a BLAKE2b version in its own settings.
  byHost["10.21.21.7"].hash = ACT.hash;
  await nodes.survey({ fresh: true });
  const problem = await sw.reconcile();
  assert.match(problem.text, /stopped rather than follow it/);
  assert.equal(problem.blocks, true);
  assert.equal(state.conf, null, "the SHA256 node no longer reads it");
  assert.match((await sw.info()).problem, /Bitcoin Knots is on the BLAKE2b chain now/);

  // Not answering: said, nothing changed.
  byHost["10.21.21.7"].hash = SHA;
  await nodes.survey({ fresh: true });
  await sw.reconcile();
  delete byHost["10.21.21.7"];
  await nodes.survey({ fresh: true });
  const before = state.conf;
  const quiet = await sw.reconcile();
  assert.match(quiet.text, /not answering/);
  assert.equal(quiet.blocks, false);
  assert.equal(state.conf, before);
});

test("off, a node never started is left alone, and one still running is kept right", async () => {
  const fresh = harness({ settings: { lnd: LND, bridge: { enabled: false, sha256Node: "paulscode-knots-sha256" } } });
  assert.equal((await fresh.sw.reconcile()).text, "");
  assert.equal(fresh.state.confs.length, 0, "no config is made for a bridge that is off");

  // Off after being on: the SHA256 node goes on running on its config, and
  // a node that has left the SHA256 chain is still not followed.
  const byHost = { "10.21.21.7": { hash: ACT.hash } };
  const ran = harness({ nodes: fakeNodes(KNOTS, byHost), settings: { lnd: LND, bridge: { enabled: false, sha256Node: "bitcoin-knots" } } });
  ran.state.conf = "old";
  assert.match((await ran.sw.reconcile()).text, /stopped rather than follow it/);
  assert.equal(ran.state.conf, null);
});

test("a chosen node that is uninstalled stops being read", async () => {
  const { sw, state } = harness({ nodes: fakeNodes("", {}), settings: { lnd: LND, bridge: { enabled: true, sha256Node: "bitcoin-knots" } } });
  state.conf = "old";
  const p = await sw.reconcile();
  assert.match(p.text, /no longer installed/);
  assert.equal(p.blocks, true);
  assert.equal(state.conf, null);
});

test("a reconcile cannot slip between choosing a node and saving the choice", async () => {
  const byHost = { "10.21.21.64": { hash: SHA }, "10.21.21.7": { hash: SHA } };
  const { sw, state } = harness({
    nodes: fakeNodes(`${COMPANION};${KNOTS}`, byHost),
    settings: { lnd: LND, bridge: { enabled: true, sha256Node: "paulscode-knots-sha256" } },
  });
  await Promise.all([sw.set(true, "bitcoin-knots"), sw.reconcile(), sw.reconcile()]);
  assert.equal(state.settings.bridge.sha256Node, "bitcoin-knots");
  assert.match(state.conf, /10\.21\.21\.7:9332/, "the new node, not the old one put back");
});

test("the node is not changed under unfinished payments", async () => {
  const byHost = { "10.21.21.64": { hash: SHA }, "10.21.21.7": { hash: SHA } };
  const { sw, state } = harness({
    nodes: fakeNodes(`${COMPANION};${KNOTS}`, byHost),
    settings: { lnd: LND, bridge: { enabled: true, sha256Node: "paulscode-knots-sha256" } },
    unfinished: async () => 1,
  });
  await assert.rejects(sw.set(true, "bitcoin-knots"), /Change its node once none/);
  assert.equal(state.confs.length, 0);
});

test("two writes at once both land, the last one standing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sha256-conf-"));
  const file = path.join(dir, "bridge-sha256.conf");
  const write = sha256ConfWriter(file, 1000);
  await Promise.all([write("a\n"), write("b\n")]);
  assert.ok(["a\n", "b\n"].includes(fs.readFileSync(file, "utf8")));
  assert.deepEqual(fs.readdirSync(dir), ["bridge-sha256.conf"]);
});

test("paying BLAKE2b invoices is saved while off and applied with a restart while on", async () => {
  const off = harness({ settings: { lnd: LND, bridge: { enabled: false, sha256Node: "paulscode-knots-sha256" } } });
  assert.deepEqual(await off.sw.setDirections(true), { toBLAKE2b: true, restarting: false });
  assert.equal(off.state.settings.bridge.toBLAKE2b, true);
  assert.equal(off.state.stops, 0);
  assert.equal((await off.sw.info()).toBLAKE2b, true);

  const on = harness({ settings: { lnd: LND, bridge: { enabled: true, sha256Node: "paulscode-knots-sha256" } } });
  assert.deepEqual(await on.sw.setDirections(true), { toBLAKE2b: true, restarting: true });
  assert.equal(on.state.stops, 1);
  assert.deepEqual(await on.sw.setDirections(true), { toBLAKE2b: true, restarting: false }, "already so");
  assert.equal(on.state.stops, 1);
  assert.deepEqual(on.state.settings.lnd, LND);

  await assert.rejects(on.sw.setDirections("yes"), (e) => e.statusCode === 400);
  const startos = harness({ platform: "startos" });
  await assert.rejects(startos.sw.setDirections(true), /Bridge action/);
});

test("it stops paying BLAKE2b invoices only with nothing unfinished", async () => {
  const h = harness({ settings: { lnd: LND, bridge: { enabled: true, toBLAKE2b: true, sha256Node: "paulscode-knots-sha256" } }, unfinished: async () => 2 });
  await assert.rejects(h.sw.setDirections(false), (e) => e.statusCode === 409 && /2 payments/.test(e.message));
  assert.equal(h.state.settings.bridge.toBLAKE2b, true);
  assert.equal(h.state.stops, 0);
});

test("pricing: saved while off, applied with a restart while on, and checked", async () => {
  const { pricingOf, validPricing } = require("../logic/bridgeSwitch.js");
  assert.deepEqual(pricingOf(undefined), { rateSource: "neoxa", fee: 0.015, feeToSHA256: null, feeToBLAKE2b: null });

  const off = harness();
  let res = await off.sw.setPricing({ rateSource: "fixed", fee: 0.012, feeToBLAKE2b: 0.008 });
  assert.equal(res.restarting, false);
  assert.deepEqual(off.state.settings.bridge.pricing, { rateSource: "fixed", fee: 0.012, feeToSHA256: null, feeToBLAKE2b: 0.008 });
  assert.equal(off.state.stops, 0);
  assert.equal((await off.sw.info()).pricing.rateSource, "fixed");

  const on = harness({ settings: { lnd: LND, bridge: { enabled: true, sha256Node: "paulscode-knots-sha256" } } });
  res = await on.sw.setPricing({ rateSource: "neoxa", fee: 0.02 });
  assert.equal(res.restarting, true);
  assert.equal(on.state.stops, 1);
  assert.equal(on.state.settings.bridge.enabled, true);
  // The same again changes nothing and restarts nothing.
  res = await on.sw.setPricing({ rateSource: "neoxa", fee: 0.02 });
  assert.equal(res.restarting, false);
  assert.equal(on.state.stops, 1);

  for (const bad of [
    { rateSource: "coinbase", fee: 0.015 },
    { rateSource: "neoxa" },
    { rateSource: "neoxa", fee: 0.002 },
    { rateSource: "neoxa", fee: 1.5 },
    { rateSource: "neoxa", fee: 0.015, feeToSHA256: -1 },
  ]) {
    assert.throws(() => validPricing(bad), /fee|rate/);
  }
  await assert.rejects(harness({ platform: "startos" }).sw.setPricing({ rateSource: "neoxa", fee: 0.015 }), /StartOS/);
});
