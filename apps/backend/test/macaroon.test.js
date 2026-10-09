// Adding a caveat to a macaroon LND baked, checked against gopkg.in/macaroon.v2
// (the library LND uses): the same macaroon, the same caveat, the same bytes.
const test = require("node:test");
const assert = require("node:assert/strict");
const macaroon = require("../utils/macaroon.js");

// Made with macaroon.New(rootKey, id, "lnd", V2) and one caveat, then the
// time-before caveat added by the Go library.
const BEFORE = "0201036c6e64020f0300016c6e642d69642d62797465730002106c6e642d637573746f6d207065726d73000006207b383caac43a9e3ee69418bf9af36a7358193ea67a9cb75fffe5cb10d72b6d43";
const AFTER = "0201036c6e64020f0300016c6e642d69642d62797465730002106c6e642d637573746f6d207065726d7300022474696d652d6265666f726520323032372d30312d30325430333a30343a30352e3030305a0000062040a482044277fb760fc03832de76dbcc05d0df8a862d6746a3ce86249cdfdd49";

test("a caveat added here matches the Go library's, byte for byte", () => {
  const caveat = macaroon.timeBeforeCaveat(new Date("2027-01-02T03:04:05Z"));
  assert.equal(caveat, "time-before 2027-01-02T03:04:05.000Z");
  assert.equal(macaroon.addFirstPartyCaveat(BEFORE, caveat), AFTER);
});

test("parse and serialize round-trip", () => {
  for (const hex of [BEFORE, AFTER]) {
    const mac = macaroon.parse(Buffer.from(hex, "hex"));
    assert.equal(mac.location.toString(), "lnd");
    assert.equal(macaroon.serialize(mac).toString("hex"), hex);
  }
  assert.equal(macaroon.parse(Buffer.from(AFTER, "hex")).caveats.length, 2);
});

test("anything that is not a whole version 2 macaroon is refused", () => {
  const bad = [
    "",
    "01" + BEFORE.slice(2),
    BEFORE.slice(0, -2),
    BEFORE + "00",
    "0202", // an identifier whose length runs past the end
  ];
  for (const hex of bad) {
    assert.throws(() => macaroon.addFirstPartyCaveat(hex, "time-before x"), /macaroon/, hex);
  }
  assert.throws(() => macaroon.addFirstPartyCaveat(BEFORE, ""), /empty/);
});
