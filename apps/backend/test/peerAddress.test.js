// The address a user pastes to connect to a peer without opening a channel.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePeerAddress } = require("../utils/peerAddress.js");

const KEY = "03" + "ab".repeat(32);

test("pubkey@host[:port] in the forms lnd and the dashboard show", () => {
  assert.deepEqual(parsePeerAddress(`${KEY}@203.0.113.5:9737`),
    { pubKey: KEY, host: "203.0.113.5", port: 9737, hostPort: "203.0.113.5:9737" });
  assert.deepEqual(parsePeerAddress(`${KEY}@node.example.com`),
    { pubKey: KEY, host: "node.example.com", port: 9735, hostPort: "node.example.com:9735" });
  const onion = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion";
  assert.equal(parsePeerAddress(`${KEY}@${onion}:9735`).hostPort, `${onion}:9735`);
  assert.deepEqual(parsePeerAddress(`${KEY}@[2001:db8::1]:9737`),
    { pubKey: KEY, host: "2001:db8::1", port: 9737, hostPort: "[2001:db8::1]:9737" });
  assert.equal(parsePeerAddress(`${KEY}@[2001:db8::1]`).hostPort, "[2001:db8::1]:9735");
  assert.equal(parsePeerAddress(`${KEY}@2001:db8::1`).hostPort, "[2001:db8::1]:9735",
    "a bare IPv6 address takes the default port");
});

test("surrounding space and an upper-case key are accepted", () => {
  const r = parsePeerAddress(`  ${KEY.toUpperCase()}@203.0.113.5  `);
  assert.equal(r.pubKey, KEY);
  assert.equal(r.hostPort, "203.0.113.5:9735");
});

test("anything else is refused with a reason", () => {
  for (const [bad, why] of [
    ["", /pubkey@host:port/],
    [KEY, /pubkey@host:port/],
    [`04${"ab".repeat(32)}@h`, /public key/],
    [`${KEY.slice(0, 60)}@h`, /public key/],
    [`${KEY}@`, /host/],
    [`${KEY}@host:0`, /between 1 and 65535/],
    [`${KEY}@host:65536`, /between 1 and 65535/],
    [`${KEY}@host:abc`, /number/],
    [`${KEY}@host name:9735`, /host/],
    [`${KEY}@-bad.example`, /host/],
    [`${KEY}@[2001:db8::1`, /closed/],
    [`${KEY}@[2001:db8::1]9735`, /:port/],
    [`${KEY}@[not-v6]:9735`, /IPv6/],
    [`${KEY}@host;rm -rf:9735`, /host/],
  ]) {
    assert.throws(() => parsePeerAddress(bad), why, bad);
  }
});
