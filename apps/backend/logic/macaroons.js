// The Macaroons view: macaroons made for one app each, with only the access
// it needs, each revocable on its own.
//
// - Each macaroon gets a root key of its own (a random root key id), so
//   revoking it (DeleteMacaroonID) revokes that macaroon and nothing else.
//   The default macaroons (admin, readonly, invoice) use root key id 0, which
//   is never touched here: deleting it would cut off the dashboard itself.
// - Permissions are only those LND lists (ListPermissions): an entity and an
//   action, or one RPC method ("uri"). Nothing LND does not know is baked.
// - An expiry is a time-before caveat added to the baked macaroon, as lncli's
//   --timeout does (utils/macaroon.js); LND checks it on every call.
// - The macaroon is returned once and never kept: only its label, what it
//   allows, when it was made and when it expires are, in a file of their own
//   readable by the dashboard only. A record whose root key id LND no longer
//   lists (deleted with lncli) is dropped.
// - Rotating the root keys (StartOS's Revoke Macaroons action) keeps the ids
//   but gives them new keys, so every macaroon made here stops working while
//   its id is still listed. The node's admin macaroon is rewritten at the same
//   moment, so each record notes which one was current when it was made, and
//   one made under another is shown as possibly no longer working. It is not
//   dropped: that cannot be known for certain, and it stays revocable.
// - With a dashboard password (StartOS, native), making one asks for it
//   again, under the sign-in's own lockout: a session left open, or a stolen
//   cookie, must not be able to mint a credential that outlives it.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { NodeError, ValidationError } = require("models/errors.js");
const macaroon = require("utils/macaroon.js");

const MAX_LABEL = 64;
const MAX_PERMISSIONS = 400;
const MAX_KEYS = 200;
const EXPIRY_DAYS = [1, 7, 30, 90, 365];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROOT_KEY_ID = (1n << 63n) - 1n;

function defaultFile() {
  const store = process.env.JSON_STORE_FILE || "/data/state.json";
  return process.env.MACAROONS_FILE || path.join(path.dirname(store), "macaroons.json");
}

function readFileJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeFileJson(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function cleanLabel(label) {
  return String(label || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_LABEL);
}

// LND's answer to ListPermissions as {pairs, methods}: every entity:action
// some method needs, with the methods it opens, and every method with what
// it needs.
function catalogFrom(response) {
  const map = (response && (response.method_permissions || response.methodPermissions)) || {};
  const pairs = new Map();
  const methods = [];
  for (const [uri, list] of Object.entries(map)) {
    const permissions = ((list && list.permissions) || [])
      .filter((p) => p && typeof p.entity === "string" && typeof p.action === "string")
      .map((p) => ({ entity: p.entity, action: p.action }));
    methods.push({ uri, permissions });
    for (const p of permissions) {
      if (p.entity === "uri") {
        continue;
      }
      const key = `${p.entity}:${p.action}`;
      if (!pairs.has(key)) {
        pairs.set(key, { entity: p.entity, action: p.action, methods: [] });
      }
      pairs.get(key).methods.push(uri);
    }
  }
  methods.sort((a, b) => a.uri.localeCompare(b.uri));
  const list = [...pairs.values()].sort(
    (a, b) => a.entity.localeCompare(b.entity) || a.action.localeCompare(b.action)
  );
  for (const p of list) {
    p.methods.sort();
  }
  return { pairs: list, methods };
}

// The lndconnect URLs whose host is known: a hidden service not yet made,
// or no local name, gives a URL no wallet could use.
function usableConnectUrls(urls) {
  const out = {};
  for (const [mode, url] of Object.entries(urls || {})) {
    const host = /^lndconnect:\/\/([^:/?]*)/.exec(String(url || ""));
    if (host && host[1] && !/^(unset\.onion|undefined|null)$/.test(host[1])) {
      out[mode] = url;
    }
  }
  return Object.keys(out).length ? out : null;
}

function idsFrom(response) {
  const ids = (response && (response.rootKeyIds || response.root_key_ids)) || [];
  return new Set(ids.map((id) => String(id)));
}

// Dependencies are looked up when first used, so that loading this module
// (and its tests) does not load the gRPC client.
function createMacaroons({
  lnd: lndDep = null,
  auth: authDep = null,
  lndConnectUrls = (mac) => require("logic/system.js").getLndConnectUrls(mac),
  adminMacaroon = () => require("logic/disk.js").readLndAdminMacaroon(),
  // StartOS lists the node's addresses itself, and the dashboard has none.
  isStartOS = () => require("utils/const.js").IS_STARTOS,
  file = defaultFile,
  read = readFileJson,
  write = writeFileJson,
  now = Date.now,
  random = crypto.randomBytes,
} = {}) {
  const lnd = new Proxy({}, { get: (_, name) => (lndDep || require("services/lnd.js"))[name] });
  const auth = new Proxy({}, { get: (_, name) => (authDep || require("logic/auth.js"))[name] });
  let queue = Promise.resolve();
  const fileName = () => (typeof file === "function" ? file() : file);

  // One change at a time, so two never write a file missing the other.
  function serial(fn) {
    const run = queue.then(() => fn());
    queue = run.catch(() => {});
    return run;
  }

  function records() {
    const data = read(fileName());
    return data && Array.isArray(data.keys) ? data.keys : [];
  }

  function save(keys) {
    write(fileName(), { keys });
  }

  // A short tag of the node's admin macaroon, or null if it can't be read.
  async function adminTag() {
    try {
      const bytes = await adminMacaroon();
      return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    } catch (error) {
      return null;
    }
  }

  async function catalog() {
    return catalogFrom(await lnd.listPermissions());
  }

  function present(record, currentAdminTag = null) {
    return {
      id: record.id,
      label: record.label,
      permissions: record.permissions,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt || null,
      expired: Boolean(record.expiresAt && record.expiresAt <= now()),
      // Made under another admin macaroon: the root keys were probably
      // rotated since, which revokes it.
      stale: Boolean(record.adminTag && currentAdminTag && record.adminTag !== currentAdminTag),
    };
  }

  // The macaroons made here that LND still honours, newest first.
  function list() {
    return serial(async () => {
      const live = idsFrom(await lnd.listMacaroonIds());
      const keys = records();
      const kept = keys.filter((k) => live.has(k.id));
      if (kept.length !== keys.length) {
        save(kept);
      }
      const tag = await adminTag();
      return kept.map((k) => present(k, tag)).sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  // The permissions asked for, each one LND knows, without repeats.
  function checkPermissions(asked, known) {
    if (!Array.isArray(asked) || asked.length === 0) {
      throw new ValidationError("Choose at least one permission.");
    }
    if (asked.length > MAX_PERMISSIONS) {
      throw new ValidationError("Too many permissions.");
    }
    const pairs = new Set(known.pairs.map((p) => `${p.entity}:${p.action}`));
    const methods = new Set(known.methods.map((m) => m.uri));
    const out = new Map();
    for (const p of asked) {
      const entity = p && typeof p.entity === "string" ? p.entity : "";
      const action = p && typeof p.action === "string" ? p.action : "";
      const ok = entity === "uri" ? methods.has(action) : pairs.has(`${entity}:${action}`);
      if (!ok) {
        throw new ValidationError(`LND has no permission ${entity}:${action}.`);
      }
      out.set(`${entity}:${action}`, { entity, action });
    }
    return [...out.values()];
  }

  // Refused with 403, not 401: the page takes a 401 to mean the session
  // ended and goes back to the sign-in screen.
  async function checkPassword(password) {
    if (!auth.passwordConfigured()) {
      return;
    }
    if (typeof password !== "string" || password.length === 0) {
      throw new ValidationError("Enter your dashboard password to make a macaroon.", 403);
    }
    const r = await auth.guardedVerify(password);
    if (!r.ok) {
      if (r.reason === "locked") {
        throw new ValidationError(
          `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfter || 1)} seconds.`,
          429
        );
      }
      throw new ValidationError("That is not your dashboard password.", 403);
    }
  }

  // A root key id LND has not used: random, never 0.
  function newRootKeyId(taken) {
    for (;;) {
      const id = BigInt("0x" + random(8).toString("hex")) & MAX_ROOT_KEY_ID;
      if (id !== 0n && !taken.has(id.toString())) {
        return id.toString();
      }
    }
  }

  // {label, permissions, expiresInDays, password} -> the macaroon, once.
  function create({ label, permissions, expiresInDays, password } = {}) {
    return serial(async () => {
      const name = cleanLabel(label);
      if (!name) {
        throw new ValidationError("Give the macaroon a name, such as the app it is for.");
      }
      let expiresAt = null;
      if (expiresInDays !== null && expiresInDays !== undefined && expiresInDays !== 0) {
        if (!EXPIRY_DAYS.includes(expiresInDays)) {
          throw new ValidationError("Choose an expiry from the list.");
        }
        expiresAt = now() + expiresInDays * DAY_MS;
      }
      const chosen = checkPermissions(permissions, await catalog());
      await checkPassword(password);

      const live = idsFrom(await lnd.listMacaroonIds());
      const keys = records().filter((k) => live.has(k.id));
      if (keys.length >= MAX_KEYS) {
        throw new ValidationError("Too many macaroons; revoke one first.", 409);
      }

      const id = newRootKeyId(live);
      const baked = await lnd.bakeMacaroon(chosen, id);
      let hex = baked && baked.macaroon;
      try {
        if (typeof hex !== "string" || !/^[0-9a-f]+$/i.test(hex)) {
          throw new NodeError("LND returned no macaroon");
        }
        if (expiresAt) {
          hex = macaroon.addFirstPartyCaveat(hex, macaroon.timeBeforeCaveat(new Date(expiresAt)));
        }
      } catch (error) {
        // Baked but unusable here: its root key must not stay behind.
        await lnd.deleteMacaroonId(id).catch(() => {});
        throw error;
      }

      const record = {
        id,
        label: name,
        permissions: chosen,
        createdAt: now(),
        expiresAt,
        adminTag: await adminTag(),
      };
      try {
        save([...keys, record]);
      } catch (error) {
        // A macaroon nobody could see or revoke here must not stay valid.
        await lnd.deleteMacaroonId(id).catch(() => {});
        throw new NodeError("Unable to record the macaroon, so it was revoked again");
      }

      const bytes = Buffer.from(hex, "hex");
      let lndconnect = null;
      if (!isStartOS()) {
        try {
          lndconnect = usableConnectUrls(await lndConnectUrls(bytes));
        } catch (error) {
          // No addresses to offer; the other formats still work.
        }
      }
      return {
        ...present(record, record.adminTag),
        macaroonHex: hex,
        macaroonBase64: bytes.toString("base64"),
        lndconnect,
      };
    });
  }

  // Revokes a macaroon made here. Only those: the dashboard's own and the
  // bridge's keys are managed where they are made.
  function revoke(id) {
    return serial(async () => {
      const key = String(id || "");
      const keys = records();
      if (!/^[1-9][0-9]{0,19}$/.test(key) || !keys.some((k) => k.id === key)) {
        throw new ValidationError("No such macaroon.", 404);
      }
      await lnd.deleteMacaroonId(key);
      save(keys.filter((k) => k.id !== key));
      return { revoked: key };
    });
  }

  return { catalog, list, create, revoke };
}

module.exports = { createMacaroons, catalogFrom, usableConnectUrls, EXPIRY_DAYS, ...createMacaroons() };
