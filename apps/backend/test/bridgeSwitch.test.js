const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBridgeSwitch, sha256ConfWriter } = require("../logic/bridgeSwitch.js");
const { createSha256Nodes, parseNodes } = require("../logic/sha256Nodes.js");

const ACT = { height: 961640, hash: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb" };
const SHA = "00000000000000000001aaaa" + "0".repeat(40);
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
  const sw = createBridgeSwitch({
    platform,
    sha256Nodes: nodes,
    writeSha256Conf: async (text) => { state.confs.push(text); },
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
  assert.match(state.confs[0], /10\.21\.21\.7:9332/);
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
