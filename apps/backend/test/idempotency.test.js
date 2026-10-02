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

test("a reused id with different parameters is refused", async () => {
  const once = createIdempotency();
  let runs = 0;
  await once.run("dev", "req-00000005", async () => ++runs, "/lightning/pay {\"request\":\"a\"}");
  await assert.rejects(
    () => once.run("dev", "req-00000005", async () => ++runs, "/lightning/pay {\"request\":\"b\"}"),
    (e) => e.statusCode === 422
  );
  assert.equal(runs, 1);
});

test("an outcome marked recheck is asked anew; others are kept", async () => {
  const once = createIdempotency();
  let runs = 0;
  const cut = () =>
    once.run("dev", "req-00000006", async () => {
      runs++;
      const e = new Error("cut off");
      e.recheck = runs === 1;
      throw e;
    });
  await assert.rejects(cut);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(cut);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(cut);
  assert.equal(runs, 2, "re-asked once, then the second (not recheck) outcome is kept");
});

test("the re-run after a recheck is told it is one", async () => {
  const once = createIdempotency();
  const seen = [];
  const call = () =>
    once.run("dev", "req-00000007", async ({ recheck }) => {
      seen.push(recheck);
      if (seen.length === 1) {
        const e = new Error("cut off");
        e.recheck = true;
        throw e;
      }
      return "paid";
    }, "fp");
  await assert.rejects(call);
  await new Promise((r) => setImmediate(r));
  assert.equal(await call(), "paid");
  assert.deepEqual(seen, [false, true]);
});
