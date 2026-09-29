// What lnd reports about a node, as the channel details use it.
const test = require("node:test");
const assert = require("node:assert/strict");

const { announcedAddresses, reportsUnifiedSigs } = require("../utils/nodeInfo.js");

test("announced addresses: TCP only, clearnet first, no duplicates", () => {
  const node = {
    addresses: [
      { network: "tcp", addr: "abcdefghijklmnop.onion:9735" },
      { network: "tcp", addr: "203.0.113.5:9735" },
      { network: "tcp", addr: "[2001:db8::1]:9735" },
      { network: "tcp", addr: "203.0.113.5:9735" },
      { network: "unknown network for unrecognized address type", addr: "0a1b2c3d" },
      { network: "tcp", addr: "" },
    ],
  };
  assert.deepEqual(announcedAddresses(node), [
    "203.0.113.5:9735",
    "[2001:db8::1]:9735",
    "abcdefghijklmnop.onion:9735",
  ]);
});

test("announced addresses: none, or no node", () => {
  assert.deepEqual(announcedAddresses({ addresses: [] }), []);
  assert.deepEqual(announcedAddresses({}), []);
  assert.deepEqual(announcedAddresses(null), []);
});

test("unified_sigs is trusted from .13 on, on any base", () => {
  assert.equal(reportsUnifiedSigs("0.21.3-beta-blake2b.12 commit=v0.21.3-beta-blake2b.12"), false);
  assert.equal(reportsUnifiedSigs("0.21.3-beta-blake2b.13 commit="), true);
  assert.equal(reportsUnifiedSigs("0.21.4-beta.rc1-blake2b.13 commit="), true);
  assert.equal(reportsUnifiedSigs("0.21.4-beta-blake2b.21"), true);
  assert.equal(reportsUnifiedSigs("0.21.3-beta commit=v0.21.3-beta"), false);
  assert.equal(reportsUnifiedSigs(""), false);
  assert.equal(reportsUnifiedSigs(undefined), false);
});
