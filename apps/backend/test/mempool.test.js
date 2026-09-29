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
  const { m } = fake({ network: "mainnet", blockHash: BITCOIN });
  // As if chosen by an older dashboard, which did not check.
  await m.select("").catch(() => {});
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
