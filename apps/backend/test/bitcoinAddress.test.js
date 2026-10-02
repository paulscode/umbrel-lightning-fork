const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAddress, otherNetwork } = require("../utils/bitcoinAddress.js");

test("BIP 173 and BIP 350 mainnet addresses", () => {
  assert.deepEqual(parseAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "mainnet"), {
    address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    type: "p2wpkh",
  });
  assert.equal(
    parseAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "mainnet").type,
    "p2tr"
  );
  assert.equal(
    parseAddress("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "mainnet").type,
    "p2wsh"
  );
});

test("legacy mainnet addresses", () => {
  assert.equal(parseAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "mainnet").type, "p2pkh");
  assert.equal(parseAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "mainnet").type, "p2sh");
  // One character changed: the checksum fails.
  assert.equal(parseAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", "mainnet"), null);
});

test("invalid segwit addresses are refused", () => {
  // Version 1 with a bech32 (not bech32m) checksum.
  assert.equal(parseAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "mainnet"), null);
  // Version 0 with a 16-byte program.
  assert.equal(parseAddress("BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "mainnet"), null);
  // Mixed case.
  assert.equal(parseAddress("bc1qW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "mainnet"), null);
  assert.equal(parseAddress("", "mainnet"), null);
  assert.equal(parseAddress("hello", "mainnet"), null);
});

test("regtest addresses from a Lightning Fork node", () => {
  assert.equal(parseAddress("bcrt1q7x4gvph9j5p7j0mpj95fs7l7dcn6sf6clqq72j", "regtest").type, "p2wpkh");
  assert.equal(
    parseAddress("bcrt1p978kpd00whztymcrsrg5wfve52ulw4cgxevauh8w000fczagw9wqqad2zt", "regtest").type,
    "p2tr"
  );
  // Not mainnet's.
  assert.equal(parseAddress("bcrt1q7x4gvph9j5p7j0mpj95fs7l7dcn6sf6clqq72j", "mainnet"), null);
});

test("an address of another network is named", () => {
  assert.equal(otherNetwork("bcrt1q7x4gvph9j5p7j0mpj95fs7l7dcn6sf6clqq72j", "mainnet"), "regtest");
  assert.equal(otherNetwork("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "mainnet"), "testnet");
  assert.equal(otherNetwork("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "mainnet"), null);
});
