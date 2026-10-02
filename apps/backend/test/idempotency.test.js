const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdempotency } = require("../utils/idempotency.js");

test("a repeated request id gets the first outcome without running again", async () => {
  const once = createIdempotency();
  let runs = 0;
  const pay = () => once.run("dev1", "req-00000001", async () => ({ n: ++runs }));
  const [a, b] = await Promise.all([pay(), pay()]);
  assert.deepEqual(a, { n: 1 });
  assert.deepEqual(b, { n: 1 });
  assert.deepEqual(await pay(), { n: 1 });
  assert.equal(runs, 1);
});

test("a failure is kept too, so a retry does not act twice", async () => {
  const once = createIdempotency();
  let runs = 0;
  const fail = () =>
    once.run("dev1", "req-00000002", async () => {
      runs++;
      throw new Error("timed out");
    });
  await assert.rejects(fail, /timed out/);
  await assert.rejects(fail, /timed out/);
  assert.equal(runs, 1);
});

test("ids are per device, and absent ids are not remembered", async () => {
  const once = createIdempotency();
  let runs = 0;
  const fn = async () => ++runs;
  await once.run("a", "req-00000003", fn);
  await once.run("b", "req-00000003", fn);
  await once.run("a", undefined, fn);
  await once.run("a", undefined, fn);
  assert.equal(runs, 4);
});

test("malformed ids are refused and entries expire", async () => {
  let clock = 0;
  const once = createIdempotency({ ttlMs: 1000, now: () => clock });
  await assert.rejects(() => once.run("a", "bad id!", async () => 1), /requestId/);
  let runs = 0;
  await once.run("a", "req-00000004", async () => ++runs);
  clock = 2000;
  await once.run("a", "req-00000004", async () => ++runs);
  assert.equal(runs, 2);
});
