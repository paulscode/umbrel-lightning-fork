// The code a service's operator hands out for paying Bitcoin invoices:
// "lfbridge:" and the unpadded base64url of a JSON object naming the
// service's address, its node key, a credential and the certificate to pin.
//
// Everything a payment later trusts is checked here, once, so that nothing
// downstream has to wonder whether a field is there or well formed: the
// node key every request from the service must pay to, an https address
// and, off Tor, the certificate that address must present.
const PREFIX = "lfbridge:";
const MAX_CODE = 16 * 1024;
const MAX_LABEL = 64;
const MAX_MACAROON_HEX = 8192;

class BridgeCodeError extends Error {}

function invalid(message) {
  return new BridgeCodeError(message);
}

function cleanLabel(label) {
  return String(label || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_LABEL);
}

// A colon-separated SHA-256 in the form `openssl x509 -fingerprint -sha256`
// prints, upper case, or null.
function normalizeFingerprint(text) {
  const value = String(text || "").trim().toUpperCase();
  return /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value) ? value : null;
}

function isOnion(hostname) {
  return /\.onion$/i.test(String(hostname || ""));
}

// {v, label, url, node, macaroon, cert, onion} from a code, or a
// BridgeCodeError saying in a sentence what is wrong with it.
function parseBridgeCode(input) {
  const text = String(input || "").trim();
  if (!text) {
    throw invalid("Paste the code the service gave you.");
  }
  if (text.length > MAX_CODE) {
    throw invalid("That is too long to be a service code.");
  }
  if (text.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    throw invalid("That is not a service code. It should start with lfbridge:");
  }
  const body = text.slice(PREFIX.length).replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw invalid("This service code is damaged. Copy it again.");
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (error) {
    throw invalid("This service code is damaged. Copy it again.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw invalid("This service code is damaged. Copy it again.");
  }
  if (data.v !== 1) {
    throw invalid("This service code is for a newer version of the dashboard. Update the dashboard to use it.");
  }

  let url;
  try {
    url = new URL(String(data.url || ""));
  } catch (error) {
    throw invalid("The service code has no valid address.");
  }
  // An address and nothing else: a path, a query or a user name would be
  // somewhere the calls were never meant to go.
  if (url.protocol !== "https:") {
    throw invalid("The service's address must use https.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw invalid("The service's address must be a host and port only.");
  }
  const onion = isOnion(url.hostname);

  const node = String(data.node || "").toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(node)) {
    throw invalid("The service code has no valid node key.");
  }
  const macaroon = String(data.macaroon || "").toLowerCase();
  if (!macaroon || macaroon.length % 2 || macaroon.length > MAX_MACAROON_HEX || !/^[0-9a-f]+$/.test(macaroon)) {
    throw invalid("The service code has no valid credential.");
  }
  let cert = null;
  if (data.cert !== undefined && data.cert !== null && data.cert !== "") {
    cert = normalizeFingerprint(data.cert);
    if (!cert) {
      throw invalid("The service code's certificate fingerprint is not valid.");
    }
  }
  // Off Tor the pinned certificate is all that tells the service from
  // whoever answers at its address.
  if (!cert && !onion) {
    throw invalid("The service code has no certificate fingerprint, which an address outside Tor needs.");
  }

  return {
    v: 1,
    label: cleanLabel(data.label),
    url: url.origin,
    node,
    macaroon,
    cert,
    onion,
  };
}

// The code for a service, the inverse of parseBridgeCode (for tests and
// for showing an operator what they configured).
function encodeBridgeCode({ label, url, node, macaroon, cert }) {
  const data = { v: 1, label, url, node, macaroon };
  if (cert) {
    data.cert = cert;
  }
  return PREFIX + Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

module.exports = { parseBridgeCode, encodeBridgeCode, normalizeFingerprint, isOnion, BridgeCodeError, PREFIX };
