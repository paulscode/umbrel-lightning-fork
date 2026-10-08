// How a phone reaches the mobile API and how it knows it is talking to this
// node, for the pairing QR code.
//
// StartOS: the API is served with the dashboard, on its LAN addresses
// (HTTPS, signed by the server's root CA) and its onion. The package writes
// the dashboard's current addresses to a file (MOBILE_ENDPOINTS_FILE) and
// hands over LND's certificate chain, issued by the same root
// (MOBILE_CA_FILE); the phone pins that root.
//
// Umbrel: nothing in front of the app terminates TLS on the LAN, and the
// app proxy wants an Umbrel login. So the dashboard serves the API alone on
// a port of its own, MOBILE_TLS_PORT, with a certificate from an authority
// it makes and keeps (utils/x509.js); the store publishes that port on the
// LAN as MOBILE_PUBLIC_PORT and gives it an onion. The onion is read from
// Tor's hostname file (MOBILE_ONION_FILE) when it is asked for, since Tor
// writes it after the app first starts; MOBILE_ONION is the fallback.
const fs = require("fs");
const path = require("path");
const x509 = require("../utils/x509.js");

function dataDir() {
  return path.dirname(process.env.JSON_STORE_FILE || "/data/state.json");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return null;
  }
}

function writeSecret(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function ownTlsEnabled(env = process.env) {
  return Boolean(env.MOBILE_TLS_PORT);
}

// The authority the dashboard made, made now if there is none.
function ensureAuthority(dir = dataDir()) {
  const certFile = path.join(dir, "mobile-ca.pem");
  const keyFile = path.join(dir, "mobile-ca.key");
  const certPem = readText(certFile);
  const keyPem = readText(keyFile);
  if (certPem && keyPem) {
    return { certPem, keyPem };
  }
  // Half an authority is not replaced: every paired phone pins the old one,
  // and a new one would cut them all off without a word.
  if (certPem || keyPem) {
    throw new Error(`${certPem ? keyFile : certFile} is missing; restore it, or remove ${certPem ? certFile : keyFile} as well to start a new authority (phones then pair again)`);
  }
  const authority = x509.createAuthority();
  writeSecret(keyFile, authority.keyPem);
  writeSecret(certFile, authority.certPem);
  return authority;
}

// The server certificate for `names`, reissued when the names change or it
// is within a month of expiring. Returns {key, cert} for tls.createServer,
// the cert followed by the authority so a phone can pin it by fingerprint
// on first contact.
function ensureServerCert(names, dir = dataDir(), now = new Date()) {
  const authority = ensureAuthority(dir);
  const certFile = path.join(dir, "mobile-server.pem");
  const keyFile = path.join(dir, "mobile-server.key");
  const namesFile = path.join(dir, "mobile-server.json");
  const wanted = Array.from(new Set(names.filter(Boolean).map((n) => n.toLowerCase()))).sort();
  let certPem = readText(certFile);
  let keyPem = readText(keyFile);
  let fresh = false;
  try {
    const had = JSON.parse(readText(namesFile) || "null");
    const cert = certPem && new (require("crypto").X509Certificate)(certPem);
    const monthLeft = cert && new Date(cert.validTo).getTime() - now.getTime() > 30 * 24 * 3600 * 1000;
    const issued = cert && cert.checkIssued(new (require("crypto").X509Certificate)(authority.certPem));
    fresh = Boolean(had && JSON.stringify(had) === JSON.stringify(wanted) && monthLeft && issued && keyPem);
  } catch (error) {
    fresh = false;
  }
  if (!fresh) {
    const issued = x509.createServerCert({ authority, names: wanted.length ? wanted : ["lightning-fork"], now });
    certPem = issued.certPem;
    keyPem = issued.keyPem;
    writeSecret(keyFile, keyPem);
    writeSecret(certFile, certPem);
    writeSecret(namesFile, JSON.stringify(wanted));
  }
  return { key: keyPem, cert: certPem + authority.certPem, caPem: authority.certPem };
}

// The root certificate the phone should trust, or null.
function rootCaPem(env = process.env, dir = dataDir()) {
  if (ownTlsEnabled(env)) {
    const pem = readText(path.join(dir, "mobile-ca.pem"));
    return pem || ensureAuthority(dir).certPem;
  }
  if (env.MOBILE_CA_FILE) {
    const chain = x509.splitPem(readText(env.MOBILE_CA_FILE));
    const last = chain[chain.length - 1];
    if (!last) {
      return null;
    }
    // Only a self-signed certificate is a root: LND's own certificate on
    // a platform without one is not.
    try {
      const cert = new (require("crypto").X509Certificate)(last);
      if (chain.length > 1 && cert.subject === cert.issuer && cert.checkIssued(cert)) {
        return last;
      }
    } catch (error) {
      return null;
    }
  }
  return null;
}

function hostOf(hostHeader) {
  const host = String(hostHeader || "").trim().toLowerCase();
  if (host.startsWith("[")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  return host.replace(/:\d+$/, "");
}

const ONION_RE = /^[a-z2-7]{56}\.onion$/;

// The onion in front of the API's own listener (Umbrel), or null.
function ownOnion(env = process.env) {
  const candidates = [env.MOBILE_ONION_FILE ? readText(env.MOBILE_ONION_FILE) : null, env.MOBILE_ONION];
  for (const value of candidates) {
    const onion = String(value || "").trim().toLowerCase();
    if (ONION_RE.test(onion)) {
      return onion;
    }
  }
  return null;
}

const isIpv4 = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

function readEndpointsFile(env) {
  if (!env.MOBILE_ENDPOINTS_FILE) {
    return null;
  }
  try {
    return JSON.parse(readText(env.MOBILE_ENDPOINTS_FILE) || "null");
  } catch (error) {
    return null;
  }
}

function first(list, predicate) {
  return (Array.isArray(list) ? list : []).find((u) => typeof u === "string" && predicate(u)) || null;
}

// {onionUrl, lanUrl, lanIp}: where the phone can reach the API. `req` is
// the web page's request for the pairing (or the phone's own request for
// its addresses).
function endpoints(req, env = process.env) {
  const requestHost = hostOf(req && req.headers && req.headers.host);
  const requestHostPort = String((req && req.headers && req.headers.host) || "").toLowerCase();
  if (ownTlsEnabled(env)) {
    // Umbrel: the API's own port, on the server's LAN name and IP. The IP
    // comes from the host (exports.sh), since a phone may not resolve a
    // .local name; the page's own host is used when it is one of the two.
    const port = env.MOBILE_PUBLIC_PORT || env.MOBILE_TLS_PORT;
    const domain = (env.DEVICE_DOMAIN_NAME || "").toLowerCase();
    const hostIp = (env.MOBILE_LAN_IP || "").trim();
    let lanUrl = domain ? `https://${domain}:${port}` : null;
    let lanIp = isIpv4(hostIp) ? `https://${hostIp}:${port}` : null;
    // Not a loopback address: a page opened on the machine itself
    // (127.0.0.1, a plain Linux install) says nothing a phone could use.
    if (requestHost && isIpv4(requestHost) && !requestHost.startsWith("127.")) {
      lanIp = `https://${requestHost}:${port}`;
    } else if (requestHost && !requestHost.endsWith(".onion") && requestHost !== "localhost" && requestHost.endsWith(".local")) {
      lanUrl = `https://${requestHost}:${port}`;
    }
    const onion = ownOnion(env);
    return {
      onionUrl: onion ? `https://${onion}` : null,
      lanUrl,
      lanIp,
    };
  }
  // StartOS: the addresses the package lists. The page's own address is
  // preferred only when it is one of them: a page opened at a domain with
  // its own certificate, or over the plain-HTTP port, would hand the phone
  // an address its pinned root does not serve.
  const file = readEndpointsFile(env);
  if (!file) {
    // No list (an older package): the page's own address, when it was
    // reached over HTTPS (StartOS's proxy says so) or is an onion.
    const proto = String((req && req.headers && req.headers["x-forwarded-proto"]) || "").toLowerCase();
    if (requestHost.endsWith(".onion")) {
      return { onionUrl: `http://${requestHostPort}`, lanUrl: null, lanIp: null };
    }
    if (proto === "https" && requestHost && requestHost !== "localhost") {
      const url = `https://${requestHostPort}`;
      return isIpv4(requestHost) ? { onionUrl: null, lanUrl: null, lanIp: url } : { onionUrl: null, lanUrl: url, lanIp: null };
    }
    return { onionUrl: null, lanUrl: null, lanIp: null };
  }
  const lanList = (Array.isArray(file.lan) ? file.lan : []).filter((u) => typeof u === "string" && u.startsWith("https://"));
  const ipList = (Array.isArray(file.ip) ? file.ip : []).filter(
    (u) => typeof u === "string" && u.startsWith("https://") && isIpv4(hostOf(u.replace(/^https:\/\//, "").split("/")[0]))
  );
  const onions = (Array.isArray(file.onion) ? file.onion : []).filter((u) => typeof u === "string" && /\.onion(:\d+)?\/?$/.test(u));
  // An http onion needs no certificate: Tor authenticates the node.
  const onionUrl = onions.find((u) => u.startsWith("http://")) || onions[0] || null;
  const own = `https://${requestHostPort}`;
  const lanUrl = lanList.includes(own) ? own : lanList[0] || null;
  const lanIp = ipList.includes(own) ? own : ipList[0] || null;
  return { onionUrl, lanUrl, lanIp };
}

// The mobile listener's state where the dashboard runs one (Umbrel): null
// when fine, else why it is not serving, for the pairing screen to say.
let listenerProblem = null;
function setListenerProblem(problem) {
  listenerProblem = problem || null;
}
function getListenerProblem(env = process.env) {
  return ownTlsEnabled(env) ? listenerProblem : null;
}

module.exports = {
  setListenerProblem,
  getListenerProblem,
  ownTlsEnabled,
  ensureAuthority,
  ensureServerCert,
  rootCaPem,
  ownOnion,
  endpoints,
  hostOf,
};
