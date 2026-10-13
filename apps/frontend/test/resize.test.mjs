// Channel resize wording: refusals, why the buttons can't be used, and a
// resize in progress, loaded from source as in helpers.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const resize = await import(
  `data:text/javascript;base64,${fs
    .readFileSync(new URL("../src/helpers/resize.js", import.meta.url))
    .toString("base64")}`
);

// Every code the node sends, from lnwallet/splice in the fork.
const NODE_CODES = [
  "disabled", "no_unified_sigs", "taproot", "zero_conf", "pending", "closing",
  "not_quiescent", "fee_below_floor", "above_max_size", "above_balance",
  "chain_not_synced", "timeout", "rbf_unsupported", "invalid_commitment",
  "invalid_signatures", "locktime", "internal_error",
  "peer_contribution_unsupported", "peer_misbehaved", "insufficient_funds",
  "below_min", "above_max_out", "peer_offline", "peer_unsupported",
  "too_many_splices", "too_many_aborts", "close_address_set",
  "relay_rejected", "funding_spent_unknown", "peer_disconnected",
];

test("every refusal code the node sends has its own sentence", () => {
  for (const code of NODE_CODES) {
    const text = resize.refusalText(code, { peerName: "Peer" });
    assert.ok(text.length > 0, code);
    assert.ok(!text.includes(`(${code})`), `${code} falls through to the default`);
    assert.ok(!/[–—]/.test(text), `${code} has a dash`);
    assert.ok(!/\bBitcoin\b/.test(text) || /Bitcoin wallet/.test(text), code);
  }
  assert.equal(resize.refusalText(""), "");
  assert.match(resize.refusalText("new_code"), /new_code/);
});

test("a refusal with details is worded by its code", () => {
  const fee = resize.refusalText("fee_below_floor");
  assert.equal(
    resize.refusalText("fee_below_floor: 253 sat/kw replacing 500 sat/kw"),
    fee
  );
  assert.equal(
    resize.refusalText("splice refused: fee_below_floor: 1 sat/vB"),
    fee
  );
  assert.equal(resize.refusalText("splice refused: pending"),
    resize.refusalText("pending"));
  // A peer's own words aren't a code: shown as they are.
  assert.match(resize.refusalText("changed my mind"), /changed my mind/);
});

test("refusals carry their amounts", () => {
  assert.match(resize.refusalText("below_min", { minSat: 25000 }), /25,000 sats/);
  assert.match(resize.refusalText("above_max_out", { maxOutSat: 1180000 }), /1,180,000 sats/);
  assert.match(resize.refusalText("not_quiescent", { peerName: "ACINQ-BTCB2" }), /^ACINQ-BTCB2/);
});

test("the buttons explain why they can't be used, or hide", () => {
  assert.equal(resize.statusText("ok"), "");
  assert.equal(resize.statusText(""), "");
  assert.equal(resize.statusText("closing"), null);
  assert.match(resize.statusText("peer_offline"), /offline/);
  assert.match(resize.statusText("disabled"), /Advanced Settings/);
  assert.match(resize.statusText("disabled", { platform: "startos" }), /StartOS/);
  assert.ok(resize.statusText("something_new").length > 0);
  for (const code of ["peer_not_locked", "peer_not_announcing", "peer_misbehaved", "chain_not_synced"]) {
    assert.notEqual(resize.statusText(code), resize.statusText("something_new"), code);
  }
  assert.match(resize.statusText("peer_not_locked"), /force close/);
});

const pending = (over) => ({
  initiator: "INITIATOR_LOCAL",
  state: "broadcast",
  localDeltaSat: "500000",
  remoteDeltaSat: "0",
  confirmations: 0,
  lockDepth: 6,
  weLocked: false,
  peerLocked: false,
  dead: false,
  ...over,
});

test("a resize in progress says where it is", () => {
  assert.equal(
    resize.pendingText(pending(), { peerName: "P" }),
    "Resizing: +500,000 sats. Waiting for the first confirmation."
  );
  assert.equal(
    resize.pendingText(pending({ confirmations: 2 }), { peerName: "P" }),
    "Resizing: +500,000 sats. 2 of 6 confirmations, about 40 minutes left."
  );
  assert.equal(
    resize.pendingText(pending({ localDeltaSat: "-300640", confirmations: 6, weLocked: true }), { peerName: "P" }),
    "Resizing: -300,640 sats. Confirmed. Waiting for P to finish."
  );
  assert.match(resize.pendingText(pending({ state: "signed" }), { peerName: "P" }), /finish signing/);
  assert.match(resize.pendingText(pending({ dead: true })), /can no longer go through/);
  assert.equal(resize.pendingText(null), "");
});

test("a peer's resize leaves our balance as it is", () => {
  const text = resize.pendingText(
    pending({ initiator: "INITIATOR_REMOTE", localDeltaSat: "0", remoteDeltaSat: "1000000" }),
    { peerName: "ACINQ-BTCB2" }
  );
  assert.match(text, /^ACINQ-BTCB2 is adding 1,000,000 sats on their side\. Your balance doesn't change\./);
  assert.ok(resize.isPeerInitiated(2));
  assert.ok(!resize.isPeerInitiated("INITIATOR_LOCAL"));
});

test("only a locked resize is remembered in the details", () => {
  const time = Date.UTC(2026, 9, 9) / 1000;
  assert.match(resize.lastText({ outcome: "locked", time, initiator: "INITIATOR_LOCAL" }), /^Resized by splicing on .+; the channel kept working\.$/);
  assert.match(resize.lastText({ outcome: "locked", time, initiator: "INITIATOR_REMOTE" }, { peerName: "P" }), /^Resized by P on /);
  assert.equal(resize.lastText({ outcome: "aborted", time }), "");
  assert.match(resize.lastText({ outcome: "dead", time }), /could not go through/);
  assert.equal(resize.lastText(null), "");
});

test("lock times read in minutes, then hours", () => {
  assert.equal(resize.minutesText(1), "1 minute");
  assert.equal(resize.minutesText(60), "60 minutes");
  assert.equal(resize.minutesText(180), "3 hours");
  assert.equal(resize.minutesText(0), "1 minute");
});

test("a fee rate under the floor names the node's minimum, not the network's", () => {
  const text = resize.refusalText("fee_below_floor", { minSatPerVbyte: 12 });
  assert.match(text, /12 sat\/vB/);
  assert.doesNotMatch(text, /network relays/);
});
