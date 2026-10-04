const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { parseNodes, probe, confFor, createSha256Nodes, jsonRpc } = require("../logic/sha256Nodes.js");

const ACT = { height: 961640, hash: "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb" };
const SHA = "00000000000000000001aaaa" + "0".repeat(40);

// A fake RPC: what each host says.
function chains(byHost) {
  return async (node, method, params) => {
    const n = byHost[node.host];
    if (!n || n.down) {
      throw new Error("connect ECONNREFUSED");
    }
    if (method === "getblockchaininfo") {
      return { chain: n.chain || "main", blocks: n.blocks ?? 970000 };
    }
    if (method === "getblockhash") {
      assert.deepEqual(params, [ACT.height]);
      return n.hash;
    }
    throw new Error(`unexpected ${method}`);
  };
}

const KNOTS = "bitcoin-knots|10.21.21.7:9332|umbrel|Kn0ts_pw-A=";
const CORE = "bitcoin|10.21.21.8:8332|umbrel|C0re";
const SHA256C = "paulscode-knots-sha256|10.21.21.64:19332|umbrel|Sha_pw-B=";
const B2B_COMPANION_IP = "10.21.21.62";

test("the list from exports.sh is read, and anything malformed dropped", () => {
  const nodes = parseNodes(`${KNOTS};${SHA256C};bad;x|y|z|w;a|host:99999999|u|p`);
  assert.deepEqual(nodes.map((n) => [n.id, n.name, n.host, n.port]), [
    ["bitcoin-knots", "Bitcoin Knots", "10.21.21.7", 9332],
    ["paulscode-knots-sha256", "Knots (SHA256) Companion", "10.21.21.64", 19332],
  ]);
  assert.deepEqual(parseNodes(""), []);
  assert.deepEqual(parseNodes(undefined), []);
});

test("each node is told by its block at the activation height", async () => {
  const [knots] = parseNodes(KNOTS);
  const at = (byHost, lfHost = "") => probe(knots, { rpc: chains(byHost), activation: ACT, lfHost });
  const host = knots.host;
  assert.equal((await at({ [host]: { hash: SHA } })).state, "sha256");
  assert.equal((await at({ [host]: { hash: ACT.hash } })).state, "blake2b");
  const behind = await at({ [host]: { blocks: 900000 } });
  assert.equal(behind.state, "behind");
  assert.match(behind.detail, /900,000/);
  assert.equal((await at({ [host]: { chain: "test" } })).state, "other-network");
  assert.equal((await at({ [host]: { down: true } })).state, "unreachable");
  // The node Lightning Fork reads is never offered, whatever it says.
  const lf = await at({ [host]: { hash: SHA } }, host);
  assert.equal(lf.state, "lightning-fork");
});

test("Umbrel setup 1: Knots on the SHA256 chain, the BLAKE2b Companion", async () => {
  const s = createSha256Nodes({
    nodes: parseNodes(KNOTS),
    rpc: chains({ "10.21.21.7": { hash: SHA } }),
    lfHost: B2B_COMPANION_IP,
    activation: ACT,
  });
  const list = await s.survey();
  assert.equal(s.pick(list, null).id, "bitcoin-knots");
});

test("Umbrel setup 2: Knots on the BLAKE2b chain, the SHA256 Companion", async () => {
  const s = createSha256Nodes({
    nodes: parseNodes(`${SHA256C};${KNOTS}`),
    rpc: chains({ "10.21.21.7": { hash: ACT.hash }, "10.21.21.64": { hash: SHA } }),
    lfHost: "10.21.21.7",
    activation: ACT,
  });
  const list = await s.survey();
  assert.deepEqual(list.map((n) => n.state), ["sha256", "lightning-fork"]);
  assert.equal(s.pick(list, null).id, "paulscode-knots-sha256");
});

test("Umbrel setup 3: both companions", async () => {
  const s = createSha256Nodes({
    nodes: parseNodes(SHA256C),
    rpc: chains({ "10.21.21.64": { hash: SHA } }),
    lfHost: B2B_COMPANION_IP,
    activation: ACT,
  });
  assert.equal(s.pick(await s.survey(), null).id, "paulscode-knots-sha256");
});

test("a choice is kept while it fits, and replaced when it no longer does", async () => {
  const byHost = { "10.21.21.8": { hash: SHA }, "10.21.21.64": { hash: SHA } };
  let t = 0;
  const s = createSha256Nodes({ nodes: parseNodes(`${SHA256C};${CORE}`), rpc: chains(byHost), lfHost: B2B_COMPANION_IP, activation: ACT, now: () => t });
  assert.equal(s.pick(await s.survey(), "bitcoin").id, "bitcoin");
  byHost["10.21.21.8"].down = true;
  // Cached for a minute, then asked again.
  assert.equal(s.pick(await s.survey(), "bitcoin").id, "bitcoin");
  t = 61 * 1000;
  assert.equal(s.pick(await s.survey(), "bitcoin").id, "paulscode-knots-sha256");
  assert.equal(s.pick(await s.survey({ fresh: true }), "bitcoin").id, "paulscode-knots-sha256");
});

test("the config lines name the node and its credentials", () => {
  const [n] = parseNodes(SHA256C);
  const text = confFor(n);
  assert.match(text, /^\[Bitcoind\]$/m);
  assert.match(text, /^bitcoind\.rpchost=10\.21\.21\.64:19332$/m);
  assert.match(text, /^bitcoind\.rpcuser=umbrel$/m);
  assert.match(text, /^bitcoind\.rpcpass=Sha_pw-B=$/m);
});

test("the RPC client speaks bitcoind's JSON-RPC with basic auth", async (t) => {
  let seen;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(raw) };
      if (req.headers.authorization !== "Basic " + Buffer.from("u:p").toString("base64")) {
        res.writeHead(401);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "ok", error: null, id: seen.body.id }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const node = { host: "127.0.0.1", port: server.address().port, user: "u", pass: "p" };
  assert.equal(await jsonRpc(node, "getblockhash", [961640]), "ok");
  assert.equal(seen.body.method, "getblockhash");
  assert.deepEqual(seen.body.params, [961640]);
  await assert.rejects(jsonRpc({ ...node, pass: "wrong" }, "getblockchaininfo"), /refused the RPC credentials/);
});
