// The Macaroons view's logic against a stub of LND: what may be baked, the
// password asked for again, one root key per macaroon, the expiry caveat,
// nothing kept but the record, and revoking only what was made here.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const { createMacaroons, catalogFrom } = require("logic/macaroons.js");
const macaroon = require("utils/macaroon.js");

const BAKED = "0201036c6e64020f0300016c6e642d69642d62797465730002106c6e642d637573746f6d207065726d73000006207b383caac43a9e3ee69418bf9af36a7358193ea67a9cb75fffe5cb10d72b6d43";
const PERMISSIONS = {
  method_permissions: {
    "/lnrpc.Lightning/GetInfo": { permissions: [{ entity: "info", action: "read" }] },
    "/lnrpc.Lightning/AddInvoice": { permissions: [{ entity: "invoices", action: "write" }] },
    "/lnrpc.Lightning/ListInvoices": { permissions: [{ entity: "invoices", action: "read" }] },
    "/lnrpc.Lightning/SendCoins": { permissions: [{ entity: "onchain", action: "write" }] },
    "/lnrpc.Lightning/BakeMacaroon": { permissions: [{ entity: "macaroon", action: "generate" }] },
    "/lnrpc.Lightning/CheckMacaroonPermissions": { permissions: [{ entity: "macaroon", action: "read" }, { entity: "uri", action: "x" }] },
  },
};

function harness({ password = "", verify = () => ({ ok: true }), startOS = false } = {}) {
  let admin = Buffer.from("admin-1");
  let bakedHex = BAKED;
  let clock = 1_800_000_000_000;
  const files = new Map();
  const live = new Set(["0", "777"]);
  const calls = [];
  let failWrite = false;
  let randomBytes = [Buffer.alloc(8), Buffer.from("0000000000000309", "hex"), Buffer.from("00000000000004d2", "hex")];
  const lnd = {
    listPermissions: async () => PERMISSIONS,
    listMacaroonIds: async () => ({ rootKeyIds: [...live] }),
    bakeMacaroon: async (permissions, id) => {
      calls.push(["bake", permissions, id]);
      live.add(id);
      return { macaroon: bakedHex };
    },
    deleteMacaroonId: async (id) => {
      calls.push(["delete", id]);
      live.delete(id);
      return { deleted: true };
    },
  };
  const auth = {
    passwordConfigured: () => Boolean(password),
    guardedVerify: async (p) => verify(p),
  };
  const m = createMacaroons({
    lnd,
    auth,
    lndConnectUrls: async (bytes) => ({
      restLocal: `lndconnect://umbrel.local:8180?macaroon=${bytes.length}`,
      restTor: "lndconnect://unset.onion:8180?macaroon=x",
    }),
    isStartOS: () => startOS,
    adminMacaroon: async () => admin,
    file: "/macaroons.json",
    read: (f) => (files.has(f) ? JSON.parse(files.get(f)) : null),
    write: (f, data) => {
      if (failWrite) {
        throw new Error("disk full");
      }
      files.set(f, JSON.stringify(data));
    },
    now: () => clock,
    random: () => randomBytes.shift() || Buffer.from("0000000000002000", "hex"),
  });
  return {
    m, calls, live, files,
    tick: (ms) => { clock += ms; },
    failWrites: (v) => { failWrite = v; },
    rotate: () => { admin = Buffer.from("admin-2"); },
    bakeReturns: (hex) => { bakedHex = hex; },
    stored: () => JSON.parse(files.get("/macaroons.json") || '{"keys":[]}'),
  };
}

const READ = [{ entity: "info", action: "read" }, { entity: "invoices", action: "read" }];

test("the catalog is what LND lists, without uri pairs", () => {
  const c = catalogFrom(PERMISSIONS);
  assert.deepEqual(c.pairs.map((p) => `${p.entity}:${p.action}`), [
    "info:read", "invoices:read", "invoices:write", "macaroon:generate", "macaroon:read", "onchain:write",
  ]);
  assert.deepEqual(c.pairs.find((p) => p.entity === "invoices" && p.action === "write").methods, ["/lnrpc.Lightning/AddInvoice"]);
  assert.equal(c.methods.length, 6);
});

test("a macaroon gets its own root key, is shown once, and only its record is kept", async () => {
  const h = harness();
  const out = await h.m.create({ label: " BTCPay\n", permissions: [...READ, READ[0]] });
  assert.equal(out.label, "BTCPay");
  // Random ids that are 0 or already in use are skipped.
  const bake = h.calls.find((c) => c[0] === "bake");
  assert.equal(bake[2], "1234");
  assert.deepEqual(bake[1], READ, "deduplicated");
  assert.equal(out.macaroonHex, BAKED, "no expiry, no caveat");
  assert.equal(out.macaroonBase64, Buffer.from(BAKED, "hex").toString("base64"));
  assert.match(out.lndconnect.restLocal, /^lndconnect:\/\/umbrel\.local/);
  assert.equal(out.lndconnect.restTor, undefined, "no onion yet, no URL");
  const text = JSON.stringify(h.stored());
  assert.ok(!text.includes(BAKED) && !text.includes(out.macaroonBase64), "the macaroon is not kept");
  assert.deepEqual((await h.m.list()).map((k) => k.label), ["BTCPay"]);
});

test("an expiry is a time-before caveat LND checks", async () => {
  const h = harness();
  const out = await h.m.create({ label: "a", permissions: READ, expiresInDays: 7 });
  const mac = macaroon.parse(Buffer.from(out.macaroonHex, "hex"));
  const last = mac.caveats[mac.caveats.length - 1].id.toString();
  assert.equal(last, `time-before ${new Date(1_800_000_000_000 + 7 * 86_400_000).toISOString()}`);
  assert.equal(out.expiresAt, 1_800_000_000_000 + 7 * 86_400_000);
  h.tick(8 * 86_400_000);
  assert.equal((await h.m.list())[0].expired, true);
  await assert.rejects(h.m.create({ label: "a", permissions: READ, expiresInDays: 3 }), /expiry/);
});

test("only what LND lists can be granted", async () => {
  const h = harness();
  for (const permissions of [
    [],
    [{ entity: "onchain", action: "read" }],
    [{ entity: "uri", action: "/lnrpc.Lightning/Nope" }],
    [{ entity: "info" }],
    "info:read",
  ]) {
    await assert.rejects(h.m.create({ label: "a", permissions }), /permission/i, JSON.stringify(permissions));
  }
  await assert.rejects(h.m.create({ label: " \n", permissions: READ }), /name/);
  assert.ok(await h.m.create({ label: "one call", permissions: [{ entity: "uri", action: "/lnrpc.Lightning/GetInfo" }] }));
  assert.equal(h.calls.filter((c) => c[0] === "bake").length, 1);
});

test("with a dashboard password, making one asks for it again", async () => {
  const tried = [];
  const h = harness({
    password: "secret",
    verify: (p) => {
      tried.push(p);
      if (p === "secret") return { ok: true };
      if (p === "locked") return { ok: false, reason: "locked", retryAfter: 30 };
      return { ok: false, reason: "bad_password" };
    },
  });
  await assert.rejects(h.m.create({ label: "a", permissions: READ }), (e) => e.statusCode === 403);
  await assert.rejects(h.m.create({ label: "a", permissions: READ, password: "nope" }), (e) => e.statusCode === 403);
  await assert.rejects(h.m.create({ label: "a", permissions: READ, password: "locked" }), (e) => e.statusCode === 429);
  assert.equal(h.calls.length, 0, "nothing baked");
  assert.ok(await h.m.create({ label: "a", permissions: READ, password: "secret" }));
  assert.deepEqual(tried, ["nope", "locked", "secret"]);
});

test("a macaroon that can't be recorded is revoked again", async () => {
  const h = harness();
  h.failWrites(true);
  await assert.rejects(h.m.create({ label: "a", permissions: READ }), /revoked/);
  assert.deepEqual(h.calls.map((c) => c[0]), ["bake", "delete"]);
  assert.ok(!h.live.has("1234"));
});

test("revoking deletes its root key, and only macaroons made here can be revoked", async () => {
  const h = harness();
  const a = await h.m.create({ label: "a", permissions: READ });
  for (const id of ["0", "777", "abc", "", "-1"]) {
    await assert.rejects(h.m.revoke(id), /No such/, id);
  }
  assert.deepEqual(await h.m.revoke(a.id), { revoked: a.id });
  assert.ok(!h.live.has(a.id) && h.live.has("0"));
  assert.deepEqual(await h.m.list(), []);
});

test("a record whose root key LND no longer has is dropped", async () => {
  const h = harness();
  const a = await h.m.create({ label: "a", permissions: READ });
  h.live.delete(a.id); // rotated, or deleted with lncli
  assert.deepEqual(await h.m.list(), []);
  assert.deepEqual(h.stored().keys, []);
});

test("on StartOS no lndconnect URL is offered", async () => {
  const h = harness({ startOS: true });
  const out = await h.m.create({ label: "a", permissions: READ });
  assert.equal(out.lndconnect, null);
  assert.ok(out.macaroonHex);
});

test("after the root keys are rotated, macaroons made before show as possibly dead", async () => {
  const h = harness();
  await h.m.create({ label: "a", permissions: READ });
  assert.equal((await h.m.list())[0].stale, false);
  h.rotate(); // the admin macaroon is rewritten with the root keys
  const [key] = await h.m.list();
  assert.equal(key.stale, true);
  assert.ok(await h.m.revoke(key.id), "still revocable");
});

test("a baked macaroon that can't be finished here is revoked again", async () => {
  const h = harness();
  h.bakeReturns("not hex");
  await assert.rejects(h.m.create({ label: "a", permissions: READ }), /no macaroon/);
  h.bakeReturns("02ff");
  await assert.rejects(h.m.create({ label: "a", permissions: READ, expiresInDays: 1 }), /macaroon/);
  assert.deepEqual(h.calls.filter((c) => c[0] === "delete").length, 2);
  assert.deepEqual(h.stored().keys, []);
});
