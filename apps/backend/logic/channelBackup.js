// Channel backups for the Umbrel app, by the same agent the StartOS package
// runs: rclone copies channel.backup to targets the owner controls (SFTP,
// Nextcloud, Dropbox, Google Drive) whenever it changes, and retrieves it for
// a restore. Umbrel's own backup server is not in the picture: it answers
// 403 to this app, and a fork should not lean on Umbrel's infrastructure.
//
// This module owns the configuration file the agent reads
// (channel-backup.json in the node's data directory, the shape the StartOS
// package writes), runs the agent for the dashboard (the watcher for the
// life of the process; --once for Back up now; --pull for a restore), and
// reads the state file the agent maintains. Secrets never leave this module
// unmasked: the API sees whether a secret is stored, not what it is.
const {spawn, execFile} = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const constants = require("../utils/const.js");

const PROVIDERS = ["sftp", "nextcloud", "dropbox", "gdrive"];
const DEFAULT_FOLDER = "lnd-channel-backups";
const ONCE_TIMEOUT_MS = 110 * 1000;
const PULL_TIMEOUT_MS = 180 * 1000;
const KEYSCAN_TIMEOUT_MS = 40 * 1000;
const WATCHER_RESTART_MS = 10 * 1000;
const IDENTITY_CHECK_MS = 60 * 1000;
const MAX_LINE = 2048;
const MAX_SECRET = 16384;
const MAX_KEY = 32768;
const CONTROL = /[\u0000-\u001f\u007f]/;

const lndDir = () => constants.LND_DIR;
const configPath = () => path.join(lndDir(), "channel-backup.json");
const statePath = () => path.join(lndDir(), ".channel-backup-state.json");
const restoreDir = () => path.join(lndDir(), ".channel-backup-restore");
const backupPath = () => constants.CHANNEL_BACKUP_FILE || path.join(lndDir(), "data/chain/bitcoin/mainnet/channel.backup");

// The bridge's SHA256 node, which this app runs beside LND (sha256-lnd), and
// the second agent that copies its channel.backup to the same targets.
const sha256Dir = () => process.env.SHA256_LND_DIR || path.join(lndDir(), "sha256-node");
const sha256BackupPath = () => path.join(sha256Dir(), "data/chain/bitcoin", process.env.LND_NETWORK || "mainnet", "channel.backup");
const sha256StatePath = () => path.join(lndDir(), ".channel-backup-sha256-state.json");

// ---------- the configuration file

function emptyOauth() {
  return {enabled: false, clientId: "", clientSecret: "", token: null, path: DEFAULT_FOLDER};
}
function emptyNextcloud() {
  return {enabled: false, url: "", user: "", pass: null, insecureTls: false, path: DEFAULT_FOLDER};
}
function emptySftp() {
  return {
    enabled: false, host: "", user: "", port: "22", authType: "password", pass: null, keyPem: null,
    knownHosts: null, hostKeyFingerprints: "", hostKeyVerified: false, path: DEFAULT_FOLDER,
  };
}
function emptyConfig() {
  return {gdrive: null, dropbox: null, nextcloud: null, sftp: null};
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const cfg = emptyConfig();
    for (const p of PROVIDERS) {
      if (parsed && parsed[p] && typeof parsed[p] === "object") {
        cfg[p] = {...(p === "sftp" ? emptySftp() : p === "nextcloud" ? emptyNextcloud() : emptyOauth()), ...parsed[p]};
      }
    }
    return cfg;
  } catch (error) {
    return emptyConfig();
  }
}

function writeConfig(cfg) {
  const bad = validateConfig(cfg);
  if (bad.length) {
    throw new InputError(`These settings would be refused by the backup agent, which would then copy nothing at all: ${bad.join(", ")}. Nothing was saved.`);
  }
  const file = configPath();
  const tmp = `${file}.tmp.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", {mode: 0o600});
  fs.renameSync(tmp, file);
}

// rclone's nextcloud vendor refuses any address that does not end in
// /remote.php/dav/files/USER/, a form neither Nextcloud's own pages nor most
// hosts show. So the address a user opens Nextcloud at is completed to it, as
// the StartOS package does (startos/utils.ts nextcloudDavUrl there). An
// address already in that form is kept, unless it names the previous user
// and the user changed. Throws on an address that is not a URL.
function nextcloudDavUrl(address, user, previousUser) {
  let url;
  try {
    url = new URL(address);
  } catch (error) {
    throw new InputError("Nextcloud: that is not a valid address.");
  }
  if (!user) {
    return address;
  }
  const existing = url.pathname.match(/^(.*\/dav\/files\/)([^/]+)(\/.*)?$/);
  if (existing) {
    let pathUser = "";
    try {
      pathUser = decodeURIComponent(existing[2]);
    } catch (error) {
      // A malformed escape names nobody.
    }
    if (previousUser && previousUser !== user && pathUser === previousUser) {
      url.pathname = `${existing[1]}${encodeURIComponent(user)}${existing[3] || "/"}`;
      return url.toString();
    }
    return address;
  }
  const base = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(remote\.php\/(dav(\/files)?|webdav)|index\.php.*|apps\/.*)$/, "");
  return `${url.origin}${base}/remote.php/dav/files/${encodeURIComponent(user)}/`;
}

// Completes a Nextcloud address saved before completion existed, once, at
// start. A complete address is left alone, so this writes nothing twice.
function completeSavedNextcloud(log = m => console.log(`[channel-backup] ${m}`)) {
  const cfg = readConfig();
  const nc = cfg.nextcloud;
  if (!nc || !nc.url || !nc.user) {
    return false;
  }
  let url;
  try {
    url = nextcloudDavUrl(nc.url, nc.user);
  } catch (error) {
    return false;
  }
  if (url === nc.url) {
    return false;
  }
  cfg.nextcloud = {...nc, url};
  try {
    writeConfig(cfg);
  } catch (error) {
    log(`could not complete the saved Nextcloud address: ${error.message}`);
    return false;
  }
  log("completed the saved Nextcloud address to its WebDAV form");
  return true;
}

// Whether the agent would consider a provider usable (its has_creds).
function ready(provider, t) {
  if (!t) {
    return false;
  }
  switch (provider) {
    case "gdrive":
    case "dropbox":
      return Boolean(t.clientId && t.clientSecret && t.token);
    case "nextcloud":
      return Boolean(t.url && t.user && t.pass);
    case "sftp":
      return Boolean(t.host && t.user && t.hostKeyVerified && (t.authType === "key" ? t.keyPem : t.pass));
    default:
      return false;
  }
}

// The configuration as the dashboard may see it: every secret replaced by
// whether one is stored.
function publicConfig(cfg = readConfig()) {
  const out = {};
  for (const p of PROVIDERS) {
    const t = cfg[p];
    if (!t) {
      out[p] = null;
      continue;
    }
    const base = {enabled: t.enabled, path: t.path || DEFAULT_FOLDER, ready: ready(p, t)};
    if (p === "sftp") {
      out[p] = {
        ...base, host: t.host, user: t.user, port: t.port || "22", authType: t.authType || "password",
        hasPass: Boolean(t.pass), hasKey: Boolean(t.keyPem),
        hostKeyFingerprints: t.hostKeyFingerprints || "", hostKeyVerified: Boolean(t.hostKeyVerified),
        hostKeyKnown: Boolean(t.knownHosts),
      };
    } else if (p === "nextcloud") {
      out[p] = {...base, url: t.url, user: t.user, hasPass: Boolean(t.pass), insecureTls: Boolean(t.insecureTls)};
    } else {
      out[p] = {...base, clientId: t.clientId, hasClientSecret: Boolean(t.clientSecret), hasToken: Boolean(t.token)};
    }
  }
  return out;
}

// ---------- validation

class InputError extends Error {}

function line(value, label, max = MAX_LINE) {
  const v = value === undefined || value === null ? "" : String(value).trim();
  if (v.length > max) {
    throw new InputError(`${label} is too long`);
  }
  if (CONTROL.test(v)) {
    throw new InputError(`${label} contains control characters`);
  }
  return v;
}

// A target on this same server dies with it, and a Tor target needs a proxy
// the agent has no route to; both are the StartOS action's rules.
function hostOf(addr) {
  const s = String(addr || "");
  if (/^[a-z]+:\/\//i.test(s)) {
    try {
      return new URL(s).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch (error) {
      return "";
    }
  }
  return s.replace(/^\[|\]$/g, "").toLowerCase();
}

function rejectLocalOrOnion(addr, label) {
  const host = hostOf(addr);
  if (host.endsWith(".onion")) {
    throw new InputError(`${label}: Tor .onion targets are not supported. Use a clearnet address.`);
  }
  if (host === "localhost" || host === "::1" || host === "::" || host === "0.0.0.0" || host.startsWith("127.") || host.startsWith("::ffff:127.") || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) {
    throw new InputError(`${label}: that address points at ${constants.DEVICE_NOUN}. Point it at a different machine.`);
  }
}

// The agent's own validate_config, in JavaScript: it refuses the whole file
// when any target breaks a rule, and every target would stop being copied,
// so nothing is written that it would refuse.
function validateConfig(cfg) {
  const lineOk = (v, n) => typeof v === "string" && v.length <= n && !CONTROL.test(v);
  const maybeLine = (v, n) => v === null || lineOk(v, n);
  const pathOk = v => lineOk(v, MAX_LINE) && !v.startsWith("/") && !v.startsWith("\\") && !v.split(/[\\/]/).includes("..");
  const oauthOk = t => t === null || (typeof t === "object" && typeof t.enabled === "boolean" && lineOk(t.clientId, MAX_LINE) && lineOk(t.clientSecret, MAX_SECRET) && maybeLine(t.token, 65536) && (t.token === null || (() => { try { const o = JSON.parse(t.token); return o !== null && typeof o === "object" && !Array.isArray(o); } catch (error) { return false; } })()) && pathOk(t.path));
  const nextcloudOk = t => t === null || (typeof t === "object" && typeof t.enabled === "boolean" && lineOk(t.url, MAX_LINE) && (t.url === "" || /^https:\/\//i.test(t.url)) && lineOk(t.user, MAX_LINE) && maybeLine(t.pass, MAX_SECRET) && typeof t.insecureTls === "boolean" && pathOk(t.path));
  const keyOk = v => v === null || (lineOk(v, MAX_KEY) && /^-----BEGIN OPENSSH PRIVATE KEY-----\\n([A-Za-z0-9+/=]{1,70}\\n)+-----END OPENSSH PRIVATE KEY-----$/.test(v));
  const knownHostsOk = v => v === null || (typeof v === "string" && v.length <= 65536 && v.split("\n").every(l => /^\S+ (ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-\S+) [A-Za-z0-9+/]+={0,2}$/.test(l)));
  const sftpOk = t => t === null || (typeof t === "object" && typeof t.enabled === "boolean" && lineOk(t.host, MAX_LINE) && !t.host.startsWith("-") && lineOk(t.user, MAX_LINE) && typeof t.port === "string" && /^[0-9]{1,5}$/.test(t.port) && Number(t.port) >= 1 && Number(t.port) <= 65535 && (t.authType === "password" || t.authType === "key") && maybeLine(t.pass, MAX_SECRET) && keyOk(t.keyPem) && knownHostsOk(t.knownHosts) && typeof t.hostKeyFingerprints === "string" && t.hostKeyFingerprints.length <= 16384 && typeof t.hostKeyVerified === "boolean" && pathOk(t.path));
  const bad = [];
  if (!oauthOk(cfg.gdrive)) bad.push("Google Drive");
  if (!oauthOk(cfg.dropbox)) bad.push("Dropbox");
  if (!nextcloudOk(cfg.nextcloud)) bad.push("Nextcloud");
  if (!sftpOk(cfg.sftp)) bad.push("SFTP");
  return bad;
}

// One thing at a time: a save is a read-modify-write across slow network
// steps, and the agent's one-off runs share a lock the watcher holds too.
function serial() {
  let queue = Promise.resolve();
  return fn => {
    const result = queue.then(fn, fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}
const saving = serial();
const running = serial();

function folder(value) {
  const v = line(value, "Folder") || DEFAULT_FOLDER;
  if (v.startsWith("/") || v.startsWith("\\") || v.split(/[\\/]/).includes("..")) {
    throw new InputError("Folder must be a relative path without '..'");
  }
  return v;
}

function port(value) {
  const v = line(value, "Port") || "22";
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
    throw new InputError("Port must be between 1 and 65535");
  }
  return v;
}

// Accept a full redirect URL, a bare `code=...` fragment, or the raw code.
function extractAuthCode(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    return "";
  }
  const m = s.match(/[?&#]?code=([^&#\s]+)/);
  const code = m ? m[1] : s;
  try {
    return decodeURIComponent(code);
  } catch (error) {
    return code;
  }
}

// rclone refreshes an expired access token on first use, so only the
// refresh token has to be real.
function tokenFromRefresh(refreshToken, google) {
  return JSON.stringify({
    access_token: "DUMMY",
    token_type: google ? "Bearer" : "bearer",
    refresh_token: refreshToken,
    expiry: "2020-01-01T00:00:00Z",
  });
}

// ---------- OAuth: the authorization page, and the code exchange

function authUrl(provider, clientId) {
  const id = line(clientId, "Client ID");
  if (!id) {
    throw new InputError("Enter the client ID first");
  }
  if (provider === "gdrive") {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: id, redirect_uri: "http://localhost", response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file", access_type: "offline", prompt: "consent",
    })}`;
  }
  if (provider === "dropbox") {
    return `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
      client_id: id, response_type: "code", token_access_type: "offline",
    })}`;
  }
  throw new InputError("Unknown provider");
}

function httpsPostForm(host, pathname, form, headers) {
  return new Promise((resolve, reject) => {
    const body = form.toString();
    const req = https.request({
      host, path: pathname, method: "POST", timeout: 30000,
      headers: {"Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body), ...headers},
    }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`${host} answered with something other than JSON`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${host} did not answer in time`)));
    req.on("error", reject);
    req.end(body);
  });
}

async function exchangeCode(provider, clientId, clientSecret, code) {
  const id = line(clientId, "Client ID");
  const secret = line(clientSecret, "Client secret", MAX_SECRET);
  const authCode = extractAuthCode(code);
  if (!id || !secret || !authCode) {
    throw new InputError("Client ID, client secret and the authorization code are all needed");
  }
  if (provider === "gdrive") {
    const r = await httpsPostForm("oauth2.googleapis.com", "/token", new URLSearchParams({
      code: authCode, client_id: id, client_secret: secret, redirect_uri: "http://localhost", grant_type: "authorization_code",
    }));
    if (!r.access_token || !r.refresh_token) {
      throw new InputError("Google did not return valid tokens. Re-copy the full authorization code.");
    }
    return JSON.stringify({
      access_token: r.access_token, token_type: r.token_type || "Bearer", refresh_token: r.refresh_token,
      expiry: new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString(),
    });
  }
  if (provider === "dropbox") {
    const r = await httpsPostForm("api.dropboxapi.com", "/oauth2/token", new URLSearchParams({
      code: authCode, grant_type: "authorization_code",
    }), {Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`});
    if (!r.refresh_token) {
      throw new InputError("Dropbox did not return a refresh token. The code may have expired or already been used; approve the app again and paste the fresh code.");
    }
    return JSON.stringify({
      access_token: r.access_token, token_type: "bearer", refresh_token: r.refresh_token,
      expiry: new Date(Date.now() + (r.expires_in || 14400) * 1000).toISOString(),
    });
  }
  throw new InputError("Unknown provider");
}

// ---------- SFTP: keys and host keys

function run(cmd, args, {input, timeout} = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, {timeout: timeout || 30000, maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
      resolve({exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr)});
    });
    child.stdin.end(input === undefined ? "" : input);
  });
}

async function normalizeKeyPem(raw) {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) {
    return null;
  }
  const begin = "-----BEGIN OPENSSH PRIVATE KEY-----";
  const end = "-----END OPENSSH PRIVATE KEY-----";
  if (!text.startsWith(begin) || !text.endsWith(end)) {
    throw new InputError("SFTP: paste an OpenSSH private key (it starts with -----BEGIN OPENSSH PRIVATE KEY-----)");
  }
  const body = text.slice(begin.length, text.length - end.length).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length > MAX_KEY) {
    throw new InputError("SFTP: that is not a valid OpenSSH private key");
  }
  const lines = [begin];
  for (let i = 0; i < body.length; i += 70) {
    lines.push(body.substring(i, i + 70));
  }
  lines.push(end);
  const normalized = lines.join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-key-"));
  const file = path.join(dir, "key");
  try {
    fs.writeFileSync(file, normalized + "\n", {mode: 0o600});
    // A passphrase-protected key fails with an empty passphrase given, which is the answer we want.
    const check = await run("ssh-keygen", ["-y", "-P", "", "-f", file], {timeout: 10000});
    if (check.exitCode !== 0) {
      throw new InputError("SFTP: that key could not be read. It must be a valid OpenSSH key without a passphrase.");
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
  // Stored with literal \n, the way the StartOS package stores it and the agent expects it.
  return normalized.replace(/\n/g, "\\n");
}

async function scanHostKeys(host, prt) {
  const scan = await run("ssh-keyscan", ["-T", "10", "-p", prt, "--", host], {timeout: KEYSCAN_TIMEOUT_MS});
  const lines = scan.stdout.split("\n").filter(l => l && !l.startsWith("#"));
  if (!lines.length) {
    throw new InputError(`SFTP: ${host}:${prt} did not answer with a host key. Check the address and port, and that the server is reachable from ${constants.DEVICE_NOUN}.`);
  }
  // Only whole key lines from a scan that finished: a cut-off run leaves a
  // pin narrower than the server, which rclone then fails against.
  const wellFormed = scan.exitCode === 0 && lines.every(l => /^\S+ (ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-\S+) [A-Za-z0-9+/]+={0,2}$/.test(l));
  if (!wellFormed) {
    throw new InputError(`SFTP: the host key ${host}:${prt} presented could not be read. Try saving again.`);
  }
  const knownHosts = lines.join("\n");
  const fp = await run("ssh-keygen", ["-lf", "-"], {input: knownHosts + "\n", timeout: 10000});
  const fingerprints = fp.stdout.split("\n").filter(l => l.trim());
  if (fp.exitCode !== 0 || fingerprints.length !== lines.length) {
    throw new InputError(`SFTP: the host key ${host}:${prt} presented could not be read. Try saving again.`);
  }
  return {knownHosts, fingerprints: fingerprints.join("\n")};
}

// ---------- saving one provider's settings

// `input` is what the form sends; blank secrets keep the stored ones and
// `forget` drops them. Returns {config, message, needsHostKeyConfirmation}.
function saveProvider(provider, input = {}) {
  return saving(() => saveProviderNow(provider, input));
}

async function saveProviderNow(provider, input) {
  if (!PROVIDERS.includes(provider)) {
    throw new InputError("Unknown provider");
  }
  const cfg = readConfig();
  const prev = cfg[provider];
  const enabled = Boolean(input.enabled);
  const forget = Boolean(input.forget);
  const label = {sftp: "SFTP", nextcloud: "Nextcloud", dropbox: "Dropbox", gdrive: "Google Drive"}[provider];
  if (forget && enabled) {
    throw new InputError(`${label}: turn it off before forgetting its credentials.`);
  }
  let next;
  let needsHostKeyConfirmation = false;
  let fingerprints = "";

  if (provider === "sftp") {
    const host = line(input.host, "SFTP host");
    if (host.startsWith("-")) {
      throw new InputError("SFTP: the host cannot start with '-'");
    }
    if (host) {
      rejectLocalOrOnion(host, "SFTP");
    }
    const user = line(input.user, "SFTP user");
    const prt = port(input.port);
    const authType = input.authType === "key" ? "key" : "password";
    const pass = forget ? null : line(input.pass, "SFTP password", MAX_SECRET) || (prev && prev.pass) || null;
    const keyPem = forget ? null : (input.keyPem ? await normalizeKeyPem(input.keyPem) : (prev && prev.keyPem) || null);
    // The pin is kept while host and port stay the same; a server that
    // changed its key is re-scanned only on request (rescanHostKey), and
    // then confirmed again.
    const same = prev && prev.host === host && prev.port === prt && prev.knownHosts && !input.rescanHostKey;
    let knownHosts = same ? prev.knownHosts : null;
    fingerprints = same ? prev.hostKeyFingerprints || "" : "";
    let scanned = false;
    if (enabled && host && !knownHosts) {
      const scan = await scanHostKeys(host, prt);
      knownHosts = scan.knownHosts;
      fingerprints = scan.fingerprints;
      scanned = true;
    }
    const hostKeyVerified = !scanned && Boolean(knownHosts) && Boolean(input.hostKeyVerified);
    next = {...emptySftp(), enabled, host, user, port: prt, authType, pass, keyPem, knownHosts, hostKeyFingerprints: fingerprints, hostKeyVerified, path: folder(input.path)};
    needsHostKeyConfirmation = enabled && !hostKeyVerified && Boolean(knownHosts);
  } else if (provider === "nextcloud") {
    const address = line(input.url, "Nextcloud address");
    const user = line(input.user, "Nextcloud user");
    // https whenever set, enabled or not: the app password would otherwise
    // travel in clear text, and the agent refuses the whole file anyway.
    if (address && !/^https:\/\//i.test(address)) {
      throw new InputError("Nextcloud: the address must start with https://");
    }
    if (address) {
      rejectLocalOrOnion(address, "Nextcloud");
    }
    const url = address ? nextcloudDavUrl(address, user, prev && prev.user) : "";
    next = {
      ...emptyNextcloud(), enabled, url, user,
      pass: forget ? null : line(input.pass, "Nextcloud password", MAX_SECRET) || (prev && prev.pass) || null,
      insecureTls: Boolean(input.insecureTls), path: folder(input.path),
    };
  } else {
    const google = provider === "gdrive";
    const clientId = line(input.clientId, "Client ID");
    const clientSecret = forget ? "" : line(input.clientSecret, "Client secret", MAX_SECRET) || (prev && prev.clientSecret) || "";
    // A token belongs to the client that issued it.
    const clientChanged = !prev || clientId !== (prev.clientId || "") || clientSecret !== (prev.clientSecret || "");
    let token = forget || clientChanged ? null : (prev && prev.token) || null;
    const code = extractAuthCode(input.authCode);
    const refresh = line(input.refreshToken, "Refresh token", MAX_SECRET);
    if (code) {
      token = await exchangeCode(provider, clientId, clientSecret, code);
    } else if (refresh) {
      token = tokenFromRefresh(refresh, google);
    }
    next = {...emptyOauth(), enabled, clientId, clientSecret, token, path: folder(input.path)};
  }

  // An enabled target the agent cannot use fails every run and marks the
  // whole backup as failing; the one allowed exception is SFTP waiting for
  // its host key to be confirmed, which the status names as such.
  if (enabled && !ready(provider, next) && !needsHostKeyConfirmation) {
    const missing = provider === "sftp"
      ? "host, user and a password or key"
      : provider === "nextcloud"
        ? "URL, user and password"
        : "client ID, client secret and an authorization";
    throw new InputError(`${label}: to turn it on, provide ${missing}.`);
  }

  cfg[provider] = next;
  writeConfig(cfg);

  let message;
  if (needsHostKeyConfirmation) {
    message = `The SFTP server identified itself as:\n${fingerprints}\nCompare this with your server, then save again with "Host key verified" turned on. Nothing is sent to it until then.`;
  } else if (enabled && !ready(provider, next)) {
    message = `${label} is enabled but not ready: complete its credentials.`;
  } else if (enabled) {
    message = `channel.backup will be copied to ${label} whenever your channels change. Use "Back up now" to check that it works.`;
  } else {
    message = `${label} is off.`;
  }
  return {config: publicConfig(cfg), message, needsHostKeyConfirmation, fingerprints};
}

// ---------- the agent

// The agent keeps each node's copy in <folder>/<sha256 of its identity
// pubkey>/, and learns the pubkey from lncli on StartOS. This image has no
// lncli, so the dashboard hands it over as NODE_PUBKEY; without it the agent
// exits 7. Null until LND answers getinfo, which needs an unlocked wallet.
const PUBKEY = /^0[23][0-9a-f]{64}$/;
let pubkeySource = async () => (await require("services/lnd.js").getInfo()).identityPubkey;
let sha256PubkeySource = async () => require("./bridgeOperator.js").instance().sha256Pubkey();
const PUBKEY_TIMEOUT_MS = 10 * 1000;
function nodePubkey() {
  return pubkeyFrom(pubkeySource);
}
async function pubkeyFrom(source) {
  try {
    // Bounded: a hung LND must not hold up the runs queued behind this.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("getinfo timed out")), PUBKEY_TIMEOUT_MS);
      timer.unref();
    });
    const key = String((await Promise.race([source(), timeout]).finally(() => clearTimeout(timer))) || "").toLowerCase();
    return PUBKEY.test(key) ? key : null;
  } catch (error) {
    return null;
  }
}
// For tests: where the pubkey comes from.
function setPubkeySource(fn) {
  pubkeySource = fn;
}

function setSha256PubkeySource(fn) {
  sha256PubkeySource = fn;
}

// Only what the agent needs: the rest of this process's environment holds
// the wallet password and RPC credentials, which a shell script that runs a
// large third-party binary has no business seeing.
function agentEnv(pubkey) {
  const env = {PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME || "/root", LND_DIR: lndDir()};
  if (constants.CHANNEL_BACKUP_FILE) {
    env.CHANNEL_BACKUP_FILE = constants.CHANNEL_BACKUP_FILE;
  }
  if (pubkey) {
    env.NODE_PUBKEY = pubkey;
  }
  return env;
}

function runAgent(args, timeoutMs) {
  return running(() => runAgentNow(args, timeoutMs));
}

async function runAgentNow(args, timeoutMs) {
  const pubkey = await nodePubkey();
  return new Promise(resolve => {
    const child = spawn("sh", [constants.BACKUP_AGENT, ...args], {env: agentEnv(pubkey), stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.stdout.on("data", c => (stdout += c));
    child.stderr.on("data", c => (stderr += c));
    child.on("close", code => {
      clearTimeout(timer);
      resolve({exitCode: timedOut ? 124 : code, stdout, stderr});
    });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({exitCode: 127, stdout, stderr: String(error.message)});
    });
  });
}

function readState(file = statePath()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      attempt: Number(s.attempt) || 0,
      lastSuccess: typeof s.lastSuccess === "number" ? s.lastSuccess : null,
      failures: Array.isArray(s.failures) ? s.failures.map(f => ({target: String(f.target || ""), code: String(f.code || ""), detail: String(f.detail || "")})) : [],
    };
  } catch (error) {
    return {attempt: 0, lastSuccess: null, failures: []};
  }
}

function status() {
  const cfg = readConfig();
  const targets = PROVIDERS.filter(p => cfg[p] && cfg[p].enabled).map(p => ({provider: p, ready: ready(p, cfg[p])}));
  let backupMtime = null;
  try {
    backupMtime = Math.floor(fs.statSync(backupPath()).mtimeMs / 1000);
  } catch (error) {
    backupMtime = null;
  }
  return {targets, hasBackup: backupMtime !== null, backupMtime, state: readState()};
}

// The same, for the bridge's SHA256 node's copy.
function sha256Status() {
  const cfg = readConfig();
  const targets = PROVIDERS.filter(p => cfg[p] && cfg[p].enabled).map(p => ({provider: p, ready: ready(p, cfg[p])}));
  const hasBackup = (() => {
    try {
      return fs.statSync(sha256BackupPath()).size > 0;
    } catch (error) {
      return false;
    }
  })();
  return {targets, hasBackup, state: readState(sha256StatePath())};
}

async function backupNow() {
  const r = await runAgent(["--once"], ONCE_TIMEOUT_MS);
  const state = readState();
  switch (r.exitCode) {
    case 0:
      return {ok: true, message: "channel.backup was copied to every enabled target.", state};
    case 3:
      return {ok: true, message: "There is no channel.backup to copy yet. LND writes it when your first channel opens.", state};
    case 4:
      return {ok: false, message: "No backup target is enabled. Configure one first.", state};
    case 5:
      return {ok: false, message: "A backup is already running. Try again in a moment.", state};
    case 6:
      return {ok: false, message: "The backup settings could not be read. Try again in a moment.", state};
    case 7:
      return {ok: false, message: "LND has not reported the node's identity yet, which names its folder on each target. Try again once LND is running.", state};
    case 124:
      return {ok: false, message: "The backup did not finish in time. Check that the target is reachable.", state};
    default: {
      const detail = state.failures.map(f => `${f.target}: ${f.code}${f.detail ? ` (${f.detail})` : ""}`).join("; ");
      return {ok: false, message: detail ? `The copy failed: ${detail}` : "The copy failed.", state};
    }
  }
}

// Download each ready target's copy for a restore; the copies land in the
// restore directory, one file per provider.
async function pull() {
  const r = await runAgent(["--pull"], PULL_TIMEOUT_MS);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch (error) {
    parsed = null;
  }
  if (!parsed) {
    const message = r.exitCode === 124
      ? "The targets did not answer in time."
      : r.exitCode === 7
        ? "LND has not reported the node's identity yet, which names its folder on each target. Try again once LND is running."
        : "The backup targets could not be consulted.";
    return {retrieved: [], unreachable: [], message};
  }
  const retrieved = (Array.isArray(parsed.retrieved) ? parsed.retrieved : []).filter(p => PROVIDERS.includes(p)).map(p => {
    let size = 0;
    let mtime = null;
    try {
      const st = fs.statSync(path.join(restoreDir(), p));
      size = st.size;
      mtime = Math.floor(st.mtimeMs / 1000);
    } catch (error) {
      size = 0;
    }
    return {provider: p, size, mtime};
  });
  return {retrieved, unreachable: Array.isArray(parsed.unreachable) ? parsed.unreachable : [], message: null};
}

function pulledBackup(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new InputError("Unknown provider");
  }
  try {
    return fs.readFileSync(path.join(restoreDir(), provider));
  } catch (error) {
    throw new InputError("That copy is no longer here. Ask the backup targets again.");
  }
}

// The watcher: copies channel.backup whenever it or the settings change.
// Started at once, with the node's identity when LND has reported it and
// without it otherwise, in which case the agent records after its grace
// period that it cannot copy; restarted if it ever exits, or when the
// identity appears or changes under it (a wallet created again without
// restarting the app). Ended with the process.
//
// One per node: LND's, and the bridge's SHA256 node's (the same agent with
// that node's file, identity and state).
function createWatcher({identity, env = () => ({})}) {
  let watcher = null;
  let watcherWanted = false;
  let identityTimer = null;
  function start(log = m => console.log(`[channel-backup] ${m}`), {retryMs = WATCHER_RESTART_MS, checkMs = IDENTITY_CHECK_MS} = {}) {
    watcherWanted = true;
    let waiting = false;
    const launch = async () => {
      if (!watcherWanted || watcher) {
        return;
      }
      const pubkey = await identity();
      if (!watcherWanted || watcher) {
        return;
      }
      // Started without the identity too: the agent then copies nothing but
      // records, after its grace period, that it cannot, so the status does
      // not keep showing an old copy as current. check() restarts it with the
      // identity once LND reports it.
      if (!pubkey && !waiting) {
        log("waiting for LND to report the node's identity");
        waiting = true;
      }
      if (pubkey) {
        waiting = false;
      }
      const child = spawn("sh", [constants.BACKUP_AGENT], {env: {...agentEnv(pubkey), ...env()}, stdio: ["ignore", "inherit", "inherit"]});
      child.pubkey = pubkey;
      watcher = child;
      child.on("exit", code => {
        if (watcher === child) {
          watcher = null;
        }
        if (watcherWanted) {
          log(`watcher exited (${code}); restarting in ${retryMs / 1000}s`);
          setTimeout(launch, retryMs).unref();
        }
      });
      child.on("error", error => log(`watcher could not start: ${error.message}`));
    };
    const check = async () => {
      const running = watcher;
      if (!running) {
        return;
      }
      const pubkey = await identity();
      if (pubkey && pubkey !== running.pubkey && watcher === running) {
        log("the node's identity changed; restarting the watcher");
        running.kill("SIGTERM");
      }
    };
    clearInterval(identityTimer);
    identityTimer = setInterval(check, checkMs);
    identityTimer.unref();
    launch();
    return stop;
  }
  function stop() {
    watcherWanted = false;
    clearInterval(identityTimer);
    identityTimer = null;
    if (watcher) {
      watcher.kill("SIGTERM");
    }
  }
  return {start, stop};
}

const lndWatcher = createWatcher({identity: () => nodePubkey()});
function startWatcher(log, opts) {
  return lndWatcher.start(log, opts);
}
function stopWatcher() {
  lndWatcher.stop();
}

// The SHA256 node's, started once that node exists: nothing runs for it on
// an install that never ran a bridge.
const sha256Watcher = createWatcher({
  identity: () => pubkeyFrom(sha256PubkeySource),
  env: () => ({
    CHANNEL_BACKUP_FILE: sha256BackupPath(),
    BACKUP_STATE_FILE: sha256StatePath(),
    BACKUP_LOCK_FILE: path.join(lndDir(), ".channel-backup-sha256.lock"),
    BACKUP_RESTORE_DIR: path.join(lndDir(), ".channel-backup-sha256-restore"),
    BACKUP_WORK_DIR: "/tmp/lnd-channel-backup-sha256",
    BACKUP_LOG_TAG: "sha256-channel-backup",
    // Recreated from the same seed, it writes to the old node's folder:
    // keep what is there before its first copy (the app's backups leave
    // out the record of having done so).
    BACKUP_KEEP_FIRST: "1",
  }),
});
let sha256Waiter = null;
function startSha256Watcher(log = m => console.log(`[sha256-channel-backup] ${m}`), {pollMs = IDENTITY_CHECK_MS, ...opts} = {}) {
  const tryStart = () => {
    if (fs.existsSync(sha256Dir())) {
      clearInterval(sha256Waiter);
      sha256Waiter = null;
      sha256Watcher.start(log, opts);
      return true;
    }
    return false;
  };
  if (!tryStart()) {
    sha256Waiter = setInterval(tryStart, pollMs);
    sha256Waiter.unref();
  }
  return stopSha256Watcher;
}
function stopSha256Watcher() {
  clearInterval(sha256Waiter);
  sha256Waiter = null;
  sha256Watcher.stop();
}

module.exports = {
  PROVIDERS, DEFAULT_FOLDER, InputError,
  readConfig, publicConfig, ready, saveProvider, authUrl, exchangeCode, extractAuthCode, tokenFromRefresh,
  status, sha256Status, readState, backupNow, pull, pulledBackup, startWatcher, stopWatcher, startSha256Watcher, stopSha256Watcher,
  // for tests
  folder, port, line, normalizeKeyPem, scanHostKeys, validateConfig, rejectLocalOrOnion, hostOf,
  setPubkeySource, setSha256PubkeySource, nodePubkey, nextcloudDavUrl, completeSavedNextcloud,
};
