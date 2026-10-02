// Phones paired with the dashboard. Each holds a key of its own, revocable
// without touching the others:
//
// - The web page asks for a pairing. That makes a pending device and a
//   one-time enrolment code, valid for five minutes, which the page shows
//   as a QR code with the addresses the phone can reach the node at.
// - The phone claims the code. The device turns active and the phone gets
//   its key, once; only the key's SHA-256 is kept here. The key and the
//   code are random (256 and 192 bits), so a plain hash is enough, and
//   both are compared in constant time.
// - The key is sent as a bearer token on every request until the device is
//   revoked.
//
// Devices live in their own file next to the dashboard's state, written
// whole and atomically, so a backup holds them and a restore keeps phones
// paired.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ENROLL_TTL_MS = 5 * 60 * 1000;
const KEY_PREFIX = "lf_";
const LAST_USED_WRITE_MS = 60 * 1000;
const MAX_LABEL = 64;
const MAX_DEVICES = 50;
// A code whose answer was lost on the way to the phone can be claimed again
// this long after, for a new key; the first is never usable by anyone else
// since only the phone holding the code ever saw it.
const RECLAIM_MS = 2 * 60 * 1000;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function cleanLabel(label) {
  return String(label || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_LABEL);
}

function defaultFile() {
  const store = process.env.JSON_STORE_FILE || "/data/state.json";
  return process.env.DEVICES_FILE || path.join(path.dirname(store), "devices.json");
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

function createDevices({
  file = defaultFile,
  now = Date.now,
  random = crypto.randomBytes,
  read = readFileJson,
  write = writeFileJson,
} = {}) {
  let state = null;
  let queue = Promise.resolve();

  const fileName = () => (typeof file === "function" ? file() : file);

  function load() {
    if (state) {
      return state;
    }
    const data = read(fileName());
    state = {
      serverId: (data && data.serverId) || random(16).toString("hex"),
      devices: (data && Array.isArray(data.devices) ? data.devices : []),
    };
    if (!data) {
      write(fileName(), state);
    }
    return state;
  }

  function save() {
    write(fileName(), state);
  }

  // One change at a time: two pairings or a pairing and a revocation must
  // not each write a file the other's change is missing from.
  function serial(fn) {
    const run = queue.then(() => fn());
    queue = run.catch(() => {});
    return run;
  }

  // Pending devices whose code has expired are dropped when anything looks.
  function sweep() {
    for (const d of state.devices) {
      if (d.status === "active" && d.enrollHash && (!d.claimedAt || now() - d.claimedAt >= RECLAIM_MS)) {
        d.enrollHash = null;
      }
    }
    const before = state.devices.length;
    state.devices = state.devices.filter(
      (d) => d.status !== "pending" || (d.enrollExpires && d.enrollExpires > now())
    );
    return state.devices.length !== before;
  }

  function present(device) {
    return {
      id: device.id,
      label: device.label,
      status: device.status,
      created: device.created,
      lastUsed: device.lastUsed || null,
      lastTransport: device.lastTransport || null,
      enrollExpires: device.status === "pending" ? device.enrollExpires : null,
    };
  }

  function serverId() {
    return load().serverId;
  }

  function list() {
    return serial(() => {
      load();
      if (sweep()) {
        save();
      }
      return state.devices.filter((d) => d.status !== "revoked").map(present);
    });
  }

  // A pending device and its code: {device, enrollCode, enrollExpires}.
  function createPending(label) {
    return serial(() => {
      load();
      sweep();
      const live = state.devices.filter((d) => d.status !== "revoked");
      if (live.length >= MAX_DEVICES) {
        const error = new Error("Too many devices; revoke one first");
        error.statusCode = 409;
        throw error;
      }
      const enrollCode = "e_" + random(24).toString("base64url");
      const device = {
        id: random(6).toString("hex"),
        label: cleanLabel(label),
        status: "pending",
        keyHash: null,
        enrollHash: sha256(enrollCode),
        enrollExpires: now() + ENROLL_TTL_MS,
        created: now(),
        lastUsed: null,
        lastTransport: null,
        revokedAt: null,
      };
      state.devices.push(device);
      save();
      return { device: present(device), enrollCode, enrollExpires: device.enrollExpires };
    });
  }

  // {apiKey, id, label} for a valid code, which is used up; null otherwise.
  function claim(enrollCode, label) {
    return serial(() => {
      load();
      sweep();
      if (typeof enrollCode !== "string" || !enrollCode.startsWith("e_")) {
        return null;
      }
      const hash = sha256(enrollCode);
      const device = state.devices.find(
        (d) =>
          sameHash(d.enrollHash, hash) &&
          (d.status === "pending" || (d.status === "active" && d.claimedAt && now() - d.claimedAt < RECLAIM_MS))
      );
      if (!device) {
        return null;
      }
      const apiKey = `${KEY_PREFIX}${device.id}_${random(32).toString("base64url")}`;
      device.status = "active";
      device.keyHash = sha256(apiKey);
      // Kept briefly so a lost answer can be claimed again; then dropped.
      device.enrollHash = hash;
      device.enrollExpires = null;
      device.claimedAt = device.claimedAt || now();
      const name = cleanLabel(label);
      if (name) {
        device.label = name;
      }
      device.lastUsed = now();
      save();
      return { apiKey, id: device.id, label: device.label };
    });
  }

  // The device a key belongs to, or null. Records when and how it was last
  // used, writing that at most once a minute.
  function verify(apiKey, transport) {
    if (typeof apiKey !== "string" || !apiKey.startsWith(KEY_PREFIX) || apiKey.length > 200) {
      return null;
    }
    load();
    const hash = sha256(apiKey);
    let found = null;
    // Every active key is compared, matched or not, so the time taken does
    // not say which one came close.
    for (const device of state.devices) {
      if (device.status === "active" && sameHash(device.keyHash, hash)) {
        found = device;
      }
    }
    if (!found) {
      return null;
    }
    const at = now();
    const stale = !found.lastUsed || at - found.lastUsed > LAST_USED_WRITE_MS;
    const moved = transport && found.lastTransport !== transport;
    found.lastUsed = at;
    if (transport) {
      found.lastTransport = transport;
    }
    if (stale || moved) {
      serial(() => save()).catch(() => {});
    }
    return { id: found.id, label: found.label };
  }

  function revoke(id) {
    return serial(() => {
      load();
      const device = state.devices.find((d) => d.id === id && d.status !== "revoked");
      if (!device) {
        return false;
      }
      device.status = "revoked";
      device.keyHash = null;
      device.enrollHash = null;
      device.enrollExpires = null;
      device.revokedAt = now();
      save();
      return true;
    });
  }

  function rename(id, label) {
    return serial(() => {
      load();
      const device = state.devices.find((d) => d.id === id && d.status !== "revoked");
      if (!device) {
        return null;
      }
      device.label = cleanLabel(label);
      save();
      return present(device);
    });
  }

  function status(id) {
    load();
    const device = state.devices.find((d) => d.id === id);
    return device ? device.status : null;
  }

  // Forget the cached state, as after a restore.
  function reload() {
    state = null;
  }

  return { serverId, list, createPending, claim, verify, revoke, rename, status, reload };
}

module.exports = { createDevices, ENROLL_TTL_MS, KEY_PREFIX, ...createDevices() };
