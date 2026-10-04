const test = require("node:test");
const assert = require("node:assert/strict");

const { createBridgeSwitch } = require("../logic/bridgeSwitch.js");

const LND = { alias: "mine", "tlsautorefresh": true };

function harness({ platform = "umbrel", backend = "Knots (SHA256) Companion", settings = { lnd: LND }, stop = async () => {}, unfinished = async () => 0, lf } = {}) {
  const state = { settings: JSON.parse(JSON.stringify(settings)), writes: [], stops: 0 };
  // Lightning Fork applies what was written at each restart, unless told.
  state.applied = !!(state.settings.bridge && state.settings.bridge.enabled);
  const sw = createBridgeSwitch({
    platform,
    sha256Backend: backend,
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
  assert.deepEqual(await sw.set(true), { on: true, restarting: true });
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].lnd, LND, "Advanced Settings untouched");
  assert.deepEqual(state.writes[0].bridge, { enabled: true, changedAt: "2026-10-04T10:00:00.000Z" });
  assert.equal(state.stops, 1);
  assert.equal((await sw.info()).on, true);

  // Again: nothing to do, no restart.
  assert.deepEqual(await sw.set(true), { on: true, restarting: false });
  assert.equal(state.stops, 1);

  assert.deepEqual(await sw.set(false), { on: false, restarting: true });
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
  const { sw, state } = harness({ backend: "" });
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
  assert.deepEqual(await down.sw.set(false), { on: false, restarting: true });
});

test("with Lightning Fork down, what was written stands, so a bad bridge can be turned off", async () => {
  const { sw, state } = harness({
    settings: { lnd: LND, bridge: { enabled: true } },
    stop: async () => { const e = new Error("14 UNAVAILABLE: No connection established"); throw e; },
    unfinished: async () => null,
    lf: async () => null,
  });
  assert.deepEqual(await sw.set(false), { on: false, restarting: true });
  assert.equal(state.writes.length, 1, "not put back");
  assert.equal(state.settings.bridge.enabled, false);
});

test("written but never applied: asking again applies it", async () => {
  const { sw, state } = harness({ settings: { lnd: LND, bridge: { enabled: true } }, lf: async () => false });
  assert.deepEqual(await sw.set(true), { on: true, restarting: true });
  assert.equal(state.stops, 1);
});
