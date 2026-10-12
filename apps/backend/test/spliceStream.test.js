const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const { followSplice } = require("utils/spliceStream.js");

// A SpliceChannel stream the test drives.
function stream() {
  const call = new EventEmitter();
  call.cancelled = false;
  call.cancel = () => {
    call.cancelled = true;
  };
  return call;
}

test("our signatures then the broadcast: the answer is the broadcast", async () => {
  const call = stream();
  const answer = followSplice(call, { graceMs: 1000 });
  call.emit("data", { state: "signed", txid: "t" });
  call.emit("data", { state: "broadcast", txid: "t", new_channel_point: "t:0" });
  assert.deepEqual(await answer, { state: "broadcast", txid: "t", newChannelPoint: "t:0" });
  assert.ok(call.cancelled);
});

test("the peer's signatures slow to come: signed, after the grace", async () => {
  const call = stream();
  const answer = followSplice(call, { graceMs: 20 });
  call.emit("data", { state: "negotiating" });
  call.emit("data", { state: "signed", txid: "t" });
  assert.equal((await answer).state, "signed");
});

test("a stream failing after our signatures still answers signed", async () => {
  const call = stream();
  const answer = followSplice(call, { graceMs: 1000 });
  call.emit("data", { state: "signed", txid: "t" });
  call.emit("error", new Error("cancelled"));
  assert.equal((await answer).state, "signed");
});

test("refused: the reason, and whether it is the peer's", async () => {
  const call = stream();
  const answer = followSplice(call, { graceMs: 1000 });
  call.emit("data", { state: "aborted", reason: "no thanks", reason_from_peer: true });
  await assert.rejects(answer, (err) => err.spliceReason === "no thanks" && err.reasonFromPeer === true);
});

test("a stream that ends before our signatures is an error", async () => {
  const call = stream();
  const answer = followSplice(call, { graceMs: 1000 });
  call.emit("end");
  await assert.rejects(answer, (err) => err.spliceReason === undefined);
});
