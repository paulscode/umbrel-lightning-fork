const test = require("node:test");
const assert = require("node:assert/strict");
const { createDevices, ENROLL_TTL_MS } = require("../logic/devices.js");

function harness() {
  let clock = 1_700_000_000_000;
  const files = new Map();
  const devices = createDevices({
    file: "/devices.json",
    now: () => clock,
    read: (f) => (files.has(f) ? JSON.parse(files.get(f)) : null),
    write: (f, data) => files.set(f, JSON.stringify(data)),
  });
  return {
    devices,
    files,
    tick: (ms) => {
      clock += ms;
    },
    stored: () => JSON.parse(files.get("/devices.json")),
  };
}

test("a code pairs once and its key then authenticates", async () => {
  const { devices, stored } = harness();
  const { device, enrollCode } = await devices.createPending("");
  assert.equal(device.status, "pending");
  assert.match(enrollCode, /^e_[A-Za-z0-9_-]{32}$/);
  const claimed = await devices.claim(enrollCode, "Pixel 8");
  assert.match(claimed.apiKey, new RegExp(`^lf_${device.id}_[A-Za-z0-9_-]{43}$`));
  assert.equal(claimed.label, "Pixel 8");
  assert.deepEqual(devices.verify(claimed.apiKey, "lan"), { id: device.id, label: "Pixel 8" });
  // Neither the key nor the code is stored, only hashes.
  const text = JSON.stringify(stored());
  assert.ok(!text.includes(claimed.apiKey));
  assert.ok(!text.includes(enrollCode));
});

test("a code whose answer was lost can be claimed again briefly, by the same phone, for a new key", async () => {
  const { devices, tick } = harness();
  const { enrollCode } = await devices.createPending("");
  const nonce = "n".repeat(32);
  const first = await devices.claim(enrollCode, "Phone", nonce);
  tick(30_000);
  assert.equal(await devices.claim(enrollCode, "Thief"), null, "without the nonce: no");
  assert.equal(await devices.claim(enrollCode, "Thief", "x".repeat(32)), null, "another nonce: no");
  const again = await devices.claim(enrollCode, "Phone", nonce);
  assert.equal(again.id, first.id, "the same device");
  assert.notEqual(again.apiKey, first.apiKey);
  assert.equal(devices.verify(first.apiKey), null, "the first key is replaced");
  assert.ok(devices.verify(again.apiKey));
  tick(3 * 60_000);
  assert.equal(await devices.claim(enrollCode, "x", nonce), null, "and then the code is spent");
  assert.equal((await devices.list()).length, 1);
});

test("a wrong or malformed key is refused", async () => {
  const { devices } = harness();
  const { enrollCode } = await devices.createPending("");
  const { apiKey } = await devices.claim(enrollCode, "");
  assert.equal(devices.verify(apiKey.slice(0, -1) + (apiKey.endsWith("A") ? "B" : "A")), null);
  assert.equal(devices.verify("kvc_abc_def"), null);
  assert.equal(devices.verify(undefined), null);
  assert.equal(devices.verify("lf_" + "x".repeat(300)), null);
});

test("an expired code cannot be claimed and the pending device goes", async () => {
  const { devices, tick } = harness();
  const { enrollCode } = await devices.createPending("");
  tick(ENROLL_TTL_MS + 1);
  assert.equal(await devices.claim(enrollCode, ""), null);
  assert.deepEqual(await devices.list(), []);
});

test("revoking a device stops its key at once, and only its key", async () => {
  const { devices } = harness();
  const a = await devices.claim((await devices.createPending("")).enrollCode, "A");
  const b = await devices.claim((await devices.createPending("")).enrollCode, "B");
  assert.equal(await devices.revoke(a.id), true);
  assert.equal(devices.verify(a.apiKey), null);
  assert.equal(devices.verify(b.apiKey).label, "B");
  assert.equal(await devices.revoke(a.id), false, "already revoked");
  assert.deepEqual((await devices.list()).map((d) => d.label), ["B"]);
});

test("renaming keeps the key; labels are cleaned", async () => {
  const { devices } = harness();
  const a = await devices.claim((await devices.createPending("")).enrollCode, "  Phone\u0007  ");
  assert.equal(a.label, "Phone");
  const renamed = await devices.rename(a.id, "x".repeat(100));
  assert.equal(renamed.label.length, 64);
  assert.ok(devices.verify(a.apiKey));
  assert.equal(await devices.rename("nope", "x"), null);
});

test("last use is recorded, written at most once a minute", async () => {
  const { devices, files, tick } = harness();
  const a = await devices.claim((await devices.createPending("")).enrollCode, "A");
  const writes = () => files.get("/devices.json");
  devices.verify(a.apiKey, "lan");
  await new Promise((r) => setImmediate(r));
  const before = writes();
  tick(5_000);
  devices.verify(a.apiKey, "lan");
  await new Promise((r) => setImmediate(r));
  assert.equal(writes(), before, "same transport, within a minute: no write");
  tick(61_000);
  devices.verify(a.apiKey, "lan");
  await new Promise((r) => setImmediate(r));
  const list = await devices.list();
  assert.equal(list[0].lastTransport, "lan");
  assert.notEqual(writes(), before);
  devices.verify(a.apiKey, "tor");
  await new Promise((r) => setImmediate(r));
  assert.equal((await devices.list())[0].lastTransport, "tor");
});

test("the server id is made once and kept", async () => {
  const { devices, files } = harness();
  const id = devices.serverId();
  assert.match(id, /^[0-9a-f]{32}$/);
  const again = createDevices({
    file: "/devices.json",
    read: (f) => JSON.parse(files.get(f)),
    write: () => {},
  });
  assert.equal(again.serverId(), id);
});

test("parallel pairings each land in the file", async () => {
  const { devices, stored } = harness();
  await Promise.all([devices.createPending("a"), devices.createPending("b"), devices.createPending("c")]);
  assert.equal(stored().devices.length, 3);
});

test("a claim without a nonce can't be repeated", async () => {
  const { devices } = harness();
  const { enrollCode } = await devices.createPending("");
  assert.ok(await devices.claim(enrollCode, "Old phone"));
  assert.equal(await devices.claim(enrollCode, "Old phone"), null);
});

test("closing the pairing screen removes only a device that has not paired", async () => {
  const { devices } = harness();
  const pending = await devices.createPending("");
  const paired = await devices.createPending("");
  const { apiKey } = await devices.claim(paired.enrollCode, "Phone");
  assert.equal(await devices.revoke(paired.device.id, { pendingOnly: true }), false);
  assert.ok(devices.verify(apiKey), "the phone that just paired keeps working");
  assert.equal(await devices.revoke(pending.device.id, { pendingOnly: true }), true);
});
