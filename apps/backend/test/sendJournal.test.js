const test = require("node:test");
const assert = require("node:assert/strict");
const { createSendJournal } = require("../utils/sendJournal.js");

function harness() {
  let clock = 1_000_000;
  const files = new Map();
  const journal = createSendJournal({
    file: "/j.json",
    now: () => clock,
    read: (f) => (files.has(f) ? JSON.parse(files.get(f)) : {}),
    write: (f, d) => files.set(f, JSON.stringify(d)),
  });
  return { journal, files, tick: (ms) => (clock += ms) };
}

test("started, then done: survives a restart", () => {
  const { journal, files } = harness();
  journal.start("dev:req-1");
  assert.equal(journal.get("dev:req-1").state, "started");
  journal.finish("dev:req-1", { status: "succeeded" });
  const again = createSendJournal({ file: "/j.json", now: () => 1_000_000, read: (f) => JSON.parse(files.get(f)), write: () => {} });
  assert.deepEqual(again.get("dev:req-1").outcome, { status: "succeeded" });
});

test("dropped when nothing was paid; forgotten after a week", () => {
  const { journal, tick } = harness();
  journal.start("a");
  journal.drop("a");
  assert.equal(journal.get("a"), null);
  journal.start("b");
  tick(8 * 24 * 3600 * 1000);
  assert.equal(journal.get("b"), null);
});
