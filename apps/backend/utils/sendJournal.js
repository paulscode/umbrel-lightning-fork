// A record on disk of payments the node cannot look up by itself afterwards
// (an offer's: it has no payment hash until paid), kept by request id: written
// before the payment starts and completed with its outcome. A repeat of the
// request after a restart then answers from here instead of paying again.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function defaultFile() {
  const store = process.env.JSON_STORE_FILE || "/data/state.json";
  return path.join(path.dirname(store), "mobile-sends.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createSendJournal({ file = defaultFile, now = Date.now, read = readJson, write = writeJson } = {}) {
  let entries = null;
  const name = () => (typeof file === "function" ? file() : file);

  function load() {
    if (!entries) {
      entries = read(name()) || {};
    }
    const cutoff = now() - KEEP_MS;
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || entry.at < cutoff) {
        delete entries[key];
      }
    }
    return entries;
  }

  // {state: "started" | "done", outcome?, fingerprint} or null.
  function get(key) {
    return load()[key] || null;
  }

  // Written before the payment starts: if the process dies during it, a
  // repeat finds "started" and does not pay again.
  function start(key, fingerprint) {
    load()[key] = { at: now(), state: "started", fingerprint };
    write(name(), entries);
  }

  function finish(key, outcome) {
    const entry = load()[key];
    if (entry) {
      entry.state = "done";
      entry.outcome = outcome;
      write(name(), entries);
    }
  }

  // The payment did not start (refused before anything was sent).
  function drop(key) {
    if (load()[key]) {
      delete entries[key];
      write(name(), entries);
    }
  }

  return { get, start, finish, drop };
}

module.exports = { createSendJournal };
