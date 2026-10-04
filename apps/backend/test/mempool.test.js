// The Mempool app choice and the fee rates read from it, with the apps,
// store, fetcher and clock injected.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createMempool, describeFetchError, relayFloorSatPerVbyte, FEES_PATH, ACTIVATION } = require("../logic/mempool.js");

const APPS = [
  { id: "mempool", name: "Mempool Guide", api: "http://10.0.3.7:8080/", uiUrl: "https://mempool.box.local", hiddenService: "abc.onion" },
  { id: "mempool-pruned", name: "Mempool Pruned", api: "http://10.0.3.9:8080", uiPort: "3032" },
];

function fake({ apps = APPS, answer, fail, network = "regtest", blockHash } = {}) {
  let clock = 1000;
  let state = {};
  const fetched = [];
  const m = createMempool({
    apps: () => apps,
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: {
      read: async () => ({ ...state }),
      write: async next => { state = { ...state, ...next }; },
    },
    fetchJson: async url => {
      fetched.push(url);
      if (fail) { throw new Error(fail); }
      return answer === undefined ? { fastestFee: 15, halfHourFee: 12, hourFee: 8, economyFee: 3, minimumFee: 1 } : answer;
    },
    fetchText: async url => {
      fetched.push(url);
      if (blockHash instanceof Error) { throw blockHash; }
      return blockHash;
    },
    network: () => network,
    now: () => clock,
  });
  return { m, fetched, tick: ms => { clock += ms; }, state: () => state };
}

test("nothing selected: no app, no fees, explorer falls back", async () => {
  const { m, fetched } = fake();
  assert.deepEqual(await m.settings(), {
    selected: "",
    apps: [
      { id: "mempool", name: "Mempool Guide", uiUrl: "https://mempool.box.local", uiPort: "", hiddenService: "abc.onion", chain: "unchecked" },
      { id: "mempool-pruned", name: "Mempool Pruned", uiUrl: "", uiPort: "3032", hiddenService: "", chain: "unchecked" },
    ],
    publicSource: null,
  });
  assert.deepEqual(await m.recommendedFees(), { app: "", name: "", fees: null });
  assert.equal(fetched.length, 0);
  const explorer = await m.explorer();
  assert.equal(explorer.app, "");
  assert.equal(explorer.url, "");
});

test("selecting an app reads its fees from the page's endpoint, once per cache window", async () => {
  const { m, fetched, tick } = fake();
  await m.select("mempool");
  const first = await m.recommendedFees();
  assert.deepEqual(first, {
    app: "mempool",
    name: "Mempool Guide",
    fees: { fastestFee: 15, halfHourFee: 12, hourFee: 8, economyFee: 3, minimumFee: 1 },
  });
  assert.deepEqual(fetched, ["http://10.0.3.7:8080" + FEES_PATH], "the trailing slash is not doubled");
  await m.recommendedFees();
  assert.equal(fetched.length, 1, "served from the cache");
  tick(11000);
  await m.recommendedFees();
  assert.equal(fetched.length, 2, "read again after the cache window");

  const explorer = await m.explorer();
  assert.deepEqual(explorer, { app: "mempool", name: "Mempool Guide", url: "https://mempool.box.local", port: "", hiddenService: "abc.onion" });
});

test("an unknown app is refused; a selection the wrapper stopped offering counts as none", async () => {
  const { m, state } = fake();
  await assert.rejects(m.select("bogus"), /Unknown Mempool app/);
  await m.select("mempool-pruned");
  assert.equal(state().mempoolApp, "mempool-pruned");
  assert.equal(await m.selectedId(), "mempool-pruned");
  await m.select("");
  assert.equal(await m.selectedId(), "");

  const gone = createMempool({
    apps: () => [],
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: { read: async () => ({ mempoolApp: "mempool" }), write: async () => {} },
    fetchJson: async () => { throw new Error("must not be called"); },
    network: () => "regtest",
  });
  assert.equal(await gone.selectedId(), "");
  assert.deepEqual(await gone.recommendedFees(), { app: "", name: "", fees: null });
});

test("a broken answer or an unreachable app is an error, not a fee", async () => {
  for (const answer of [null, "text", {}, { fastestFee: -1 }, { fastestFee: 1e9, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }, { fastestFee: "x", halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }]) {
    const { m } = fake({ answer });
    await m.select("mempool");
    await assert.rejects(m.recommendedFees(), /not/);
  }
  const { m } = fake({ fail: "ECONNREFUSED" });
  await m.select("mempool");
  await assert.rejects(m.recommendedFees(), /ECONNREFUSED/);
});

test("numeric strings are accepted as rates, extra keys ignored", async () => {
  const { m } = fake({ answer: { fastestFee: "20", halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1, extra: true } });
  await m.select("mempool-pruned");
  const { fees } = await m.recommendedFees();
  assert.deepEqual(fees, { fastestFee: 20, halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1 });
});

test("an app that failed is not asked again for a while, then is", async () => {
  let calls = 0;
  let clock = 1000;
  const m = createMempool({
    apps: () => APPS,
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: { read: async () => ({ mempoolApp: "mempool" }), write: async () => {} },
    fetchJson: async () => { calls++; throw Object.assign(new Error("connect ECONNREFUSED 10.0.3.1:8080"), { code: "ECONNREFUSED" }); },
    now: () => clock,
  });
  await assert.rejects(m.recommendedFees(), /ECONNREFUSED/);
  await assert.rejects(m.recommendedFees(), /ECONNREFUSED/);
  assert.equal(calls, 1, "the failure is remembered");
  clock += 31000;
  await assert.rejects(m.recommendedFees(), /ECONNREFUSED/);
  assert.equal(calls, 2, "and forgotten after a while");
});

test("fetch errors are described without the address", () => {
  assert.equal(describeFetchError(Object.assign(new Error("connect ECONNREFUSED 10.0.3.1:8080"), { code: "ECONNREFUSED" })), "refused the connection");
  assert.equal(describeFetchError(Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" })), "did not answer in time");
  assert.equal(describeFetchError(Object.assign(new Error("getaddrinfo EAI_AGAIN host"), { code: "EAI_AGAIN" })), "could not be found on the network");
  assert.equal(describeFetchError({ response: { status: 502 }, message: "Request failed" }), "answered 502");
  assert.equal(describeFetchError(new Error("fastestFee is not a fee rate")), "gave an answer that fastestFee is not a fee rate");
  assert.equal(describeFetchError(new Error("whatever")), "did not answer");
  for (const bad of ["refused the connection", "did not answer in time"]) {
    assert.doesNotMatch(bad, /10\.0\.3\.1/);
  }
});

test("the node's relay floor converts to whole sat/vB without floating-point drift", () => {
  assert.equal(relayFloorSatPerVbyte(0.00001), 1);
  assert.equal(relayFloorSatPerVbyte("0.00001"), 1);
  assert.equal(relayFloorSatPerVbyte(0.00002), 2);
  assert.equal(relayFloorSatPerVbyte(0.000015), 2, "rounded up, not down");
  assert.equal(relayFloorSatPerVbyte(0.00000123), 1);
  assert.equal(relayFloorSatPerVbyte(0), 0);
  assert.equal(relayFloorSatPerVbyte(undefined), 0);
  assert.equal(relayFloorSatPerVbyte("x"), 0);
});

// The chain an app follows, told by block 961640 on mainnet.
const BLAKE2B = ACTIVATION.mainnet.hash;
const BITCOIN = "0000000000000000000186ab4b0a15b0c2f0c3a5c7b1f0a6e3f4f1a2b3c4d5e6";

test("mainnet: an app on the BLAKE2b chain is offered and used", async () => {
  const { m, fetched } = fake({ network: "mainnet", blockHash: BLAKE2B + "\n" });
  const listed = await m.settings();
  assert.deepEqual(listed.apps.map(a => a.chain), ["blake2b", "blake2b"]);
  assert.ok(fetched.includes("http://10.0.3.7:8080/api/block-height/961640"));
  await m.select("mempool");
  assert.equal((await m.recommendedFees()).fees.hourFee, 8);
  assert.equal((await m.explorer()).app, "mempool");
});

test("mainnet: an app on the other chain cannot be chosen", async () => {
  const { m } = fake({ network: "mainnet", blockHash: BITCOIN });
  assert.deepEqual((await m.settings()).apps.map(a => a.chain), ["other", "other"]);
  await assert.rejects(m.select("mempool"), /follows the other chain/);
  assert.equal((await m.settings()).selected, "");
});

test("mainnet: an app chosen before it was known to be on the other chain is not used", async () => {
  // As if chosen by an older dashboard, which did not check.
  const state = { mempoolApp: "mempool" };
  const m2 = createMempool({
    apps: () => APPS,
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: { read: async () => state, write: async () => {} },
    fetchJson: async () => ({ fastestFee: 15, halfHourFee: 12, hourFee: 8, economyFee: 3, minimumFee: 1 }),
    fetchText: async () => BITCOIN,
    network: () => "mainnet",
  });
  await assert.rejects(m2.recommendedFees(), error => {
    assert.match(describeFetchError(error), /follows the other chain/);
    return true;
  });
  assert.equal((await m2.explorer()).app, "", "links fall back rather than point at the other chain");
});

test("mainnet: an app that does not answer the check is not refused, and is asked again later", async () => {
  const { m, fetched, tick } = fake({ network: "mainnet", blockHash: new Error("ECONNREFUSED") });
  assert.deepEqual((await m.settings()).apps.map(a => a.chain), ["unknown", "unknown"]);
  await m.select("mempool-pruned");
  const asked = fetched.filter(u => u.endsWith("/api/block-height/961640")).length;
  await m.settings();
  assert.equal(fetched.filter(u => u.endsWith("/api/block-height/961640")).length, asked, "cached");
  tick(61 * 1000);
  await m.settings();
  assert.ok(fetched.filter(u => u.endsWith("/api/block-height/961640")).length > asked, "asked again");
});

test("mainnet: an answer that is not a block hash is unknown, not other", async () => {
  const { m } = fake({ network: "mainnet", blockHash: "<html>Not found</html>" });
  assert.deepEqual((await m.settings()).apps.map(a => a.chain), ["unknown", "unknown"]);
  await m.select("mempool");
});

test("mainnet: checks already on their way are shared, not repeated", async () => {
  let asked = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const m = createMempool({
    apps: () => APPS,
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: { read: async () => ({}), write: async () => {} },
    fetchJson: async () => ({}),
    fetchText: async () => { asked++; await gate; return BLAKE2B; },
    network: () => "mainnet",
  });
  const both = Promise.all([m.chainOf(APPS[0]), m.chainOf(APPS[0]), m.chainOf(APPS[0])]);
  release();
  assert.deepEqual(await both, ["blake2b", "blake2b", "blake2b"]);
  assert.equal(asked, 1);
});

test("mainnet: a verdict of other chain is checked again after it expires", async () => {
  const { m, fetched, tick } = fake({ network: "mainnet", blockHash: BITCOIN });
  await m.settings();
  const asked = () => fetched.filter(u => u.endsWith("/api/block-height/961640")).length;
  const first = asked();
  tick(9 * 60 * 1000);
  await m.settings();
  assert.equal(asked(), first, "still cached");
  tick(2 * 60 * 1000);
  await m.settings();
  assert.ok(asked() > first, "asked again once the verdict expired");
});

test("the selected app's name is given without asking any app", async () => {
  const { m, fetched } = fake({ network: "mainnet", blockHash: BLAKE2B });
  await m.select("mempool-pruned");
  const before = fetched.length;
  assert.equal(await m.selectedName(), "Mempool Pruned");
  assert.equal(fetched.length, before);
});

test("the SHA256 chain's links go to an app on that chain, else mempool.space", async () => {
  const hashes = { "10.0.3.7": ACTIVATION.mainnet.sha256Hash, "10.0.3.9": BLAKE2B };
  const make = (apps) => createMempool({
    apps: () => apps,
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: { read: async () => ({}), write: async () => {} },
    fetchJson: async () => { throw new Error("not used"); },
    fetchText: async url => hashes[new URL(url).hostname],
    network: () => "mainnet",
  });
  // Main node on the SHA256 chain with its Mempool, the companion with Mempool Pruned.
  assert.deepEqual(await make(APPS).sha256Explorer(), {
    app: "mempool", name: "Mempool Guide", url: "https://mempool.box.local", port: "", hiddenService: "abc.onion", public: false,
  });
  // Only Mempool Pruned, on the BLAKE2b chain: the public explorer.
  const pub = await make([APPS[1]]).sha256Explorer();
  assert.equal(pub.public, true);
  assert.equal(pub.url, "https://mempool.space");
  // No apps at all.
  assert.equal((await make([]).sha256Explorer()).name, "mempool.space");
  // An app on a third chain is no explorer for the SHA256 one.
  hashes["10.0.3.7"] = BITCOIN;
  assert.equal((await make(APPS).sha256Explorer()).public, true);
});

const { PUBLIC_SOURCE, NODE_ONLY } = require("../logic/mempool.js");

function publicFake({ chainHash = BLAKE2B, fees = { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 }, fail = null, choice = undefined, network = "mainnet" } = {}) {
  const asked = [];
  let clock = 1000;
  const m = createMempool({
    apps: () => [],
    fallbackExplorer: () => ({ port: "", hiddenService: "" }),
    badRequest: message => new Error(message),
    store: { read: async () => (choice === undefined ? {} : { mempoolApp: choice }), write: async () => {} },
    fetchJson: async url => { asked.push(url); if (fail) throw fail; return fees; },
    fetchText: async url => { asked.push(url); return chainHash; },
    network: () => network,
    now: () => clock,
  });
  return { m, asked, tick: ms => { clock += ms; } };
}

test("with no app chosen the rates are mempool.guide's, as its page shows them", async () => {
  const { m, asked } = publicFake();
  const r = await m.recommendedFees();
  assert.equal(r.app, PUBLIC_SOURCE.id);
  assert.equal(r.name, "mempool.guide");
  assert.equal(r.public, true);
  assert.deepEqual(r.fees, { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 });
  assert.ok(asked.some(u => u === "https://mempool.guide/api/block-height/961640"), "its chain is checked");
  assert.ok(asked.some(u => u === "https://mempool.guide/api/v1/fees/recommended"));
});

test("mempool.guide not answering means the node's estimate, said so, never an error", async () => {
  const { m } = publicFake({ fail: Object.assign(new Error("timeout"), { code: "ECONNABORTED" }) });
  const r = await m.recommendedFees();
  assert.equal(r.fees, null);
  assert.equal(r.app, "");
  assert.equal(r.name, "mempool.guide");
  assert.match(r.error, /mempool\.guide did not answer in time/);
});

test("mempool.guide on another chain is not used", async () => {
  const { m, asked } = publicFake({ chainHash: BITCOIN });
  const r = await m.recommendedFees();
  assert.equal(r.fees, null);
  assert.match(r.error, /other chain/);
  assert.ok(!asked.some(u => u.endsWith("/fees/recommended")), "no rates fetched from it");
});

test("the node's own estimate alone asks no public site anything", async () => {
  const { m, asked } = publicFake({ choice: NODE_ONLY });
  assert.deepEqual(await m.recommendedFees(), { app: "", name: "", fees: null });
  assert.equal(await m.selectedId(), NODE_ONLY);
  assert.deepEqual(asked, []);
});

test("off mainnet there is no public source", async () => {
  const { m, asked } = publicFake({ network: "regtest" });
  assert.deepEqual(await m.recommendedFees(), { app: "", name: "", fees: null });
  assert.deepEqual(asked, []);
  assert.equal((await m.settings()).publicSource, null);
  assert.equal((await publicFake().m.settings()).publicSource.name, "mempool.guide");
});

test("mempool.guide's rates are cached like an app's", async () => {
  const { m, asked, tick } = publicFake();
  await m.recommendedFees();
  await m.recommendedFees();
  assert.equal(asked.filter(u => u.endsWith("/fees/recommended")).length, 1);
  tick(11000);
  await m.recommendedFees();
  assert.equal(asked.filter(u => u.endsWith("/fees/recommended")).length, 2);
});

test("the node-only choice can be saved", async () => {
  let saved;
  const m = createMempool({
    apps: () => [],
    badRequest: message => new Error(message),
    store: { read: async () => ({}), write: async next => { saved = next; } },
    network: () => "mainnet",
  });
  await m.select(NODE_ONLY);
  assert.deepEqual(saved, { mempoolApp: NODE_ONLY });
  await assert.rejects(m.select("nonsense"), /Unknown Mempool app/);
});
