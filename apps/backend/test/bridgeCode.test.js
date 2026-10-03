const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBridgeCode, encodeBridgeCode, BridgeCodeError } = require("../utils/bridgeCode.js");

const NODE = "02" + "e9".repeat(32);
const CERT = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, "0").toUpperCase()).join(":");
const BASE = { label: "Paul's service", url: "https://bridge.example.com:8080", node: NODE, macaroon: "0201036c6e64", cert: CERT };

function code(data) {
  return "lfbridge:" + Buffer.from(JSON.stringify(data)).toString("base64url");
}

test("a valid code reads back as it was written", () => {
  const parsed = parseBridgeCode(encodeBridgeCode(BASE));
  assert.deepEqual(parsed, { v: 1, label: "Paul's service", url: "https://bridge.example.com:8080", node: NODE, macaroon: "0201036c6e64", cert: CERT, onion: false });
  // Surrounding space, upper-case hex and a lower-case fingerprint are fine.
  const loose = parseBridgeCode(`  ${code({ v: 1, ...BASE, node: NODE.toUpperCase(), cert: CERT.toLowerCase() })}\n`);
  assert.equal(loose.node, NODE);
  assert.equal(loose.cert, CERT);
});

test("an onion needs no certificate; anywhere else does", () => {
  const onion = parseBridgeCode(code({ v: 1, url: "https://abcdefxyz.onion:8080", node: NODE, macaroon: "02ab" }));
  assert.equal(onion.onion, true);
  assert.equal(onion.cert, null);
  assert.throws(() => parseBridgeCode(code({ v: 1, url: "https://bridge.example.com", node: NODE, macaroon: "02ab" })), /certificate fingerprint/);
});

test("codes that are not valid are refused with a sentence", () => {
  const cases = [
    ["", /Paste the code/],
    ["lnbc1foo", /not a service code/],
    ["lfbridge:!!!", /damaged/],
    ["lfbridge:" + Buffer.from("not json").toString("base64url"), /damaged/],
    [code({ ...BASE, v: 2 }), /newer version/],
    [code({ ...BASE }), /newer version/],
    [code({ v: 1, ...BASE, node: "04" + "e9".repeat(32) }), /node key/],
    [code({ v: 1, ...BASE, node: "02" + "e9".repeat(31) }), /node key/],
    [code({ v: 1, ...BASE, macaroon: "xyz" }), /credential/],
    [code({ v: 1, ...BASE, macaroon: "abc" }), /credential/],
    [code({ v: 1, ...BASE, url: "http://bridge.example.com" }), /https/],
    [code({ v: 1, ...BASE, url: "https://bridge.example.com/v2/bridge" }), /host and port only/],
    [code({ v: 1, ...BASE, url: "https://user:pw@bridge.example.com" }), /host and port only/],
    [code({ v: 1, ...BASE, url: "not a url" }), /valid address/],
    [code({ v: 1, ...BASE, cert: "AB:CD" }), /fingerprint is not valid/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parseBridgeCode(input), (e) => e instanceof BridgeCodeError && message.test(e.message), input);
  }
});
