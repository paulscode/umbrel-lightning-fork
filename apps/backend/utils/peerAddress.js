// Parses the address a user pastes to connect to a Lightning peer:
// <pubkey>@<host>[:<port>], where host is an IPv4 address, a bracketed IPv6
// address, a hostname or a Tor onion. This is what `lncli getinfo` lists as
// uris and what the dashboard shows as a channel's "Connect To".
const { ValidationError } = require("../models/errors.js");

const DEFAULT_PORT = 9735;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
// Letters, digits, dots and hyphens: hostnames, IPv4 and onion addresses.
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const IPV6 = /^[0-9a-f:.]+$/i;

function invalid(message) {
  return new ValidationError(message);
}

function parsePort(text) {
  if (!/^[0-9]{1,5}$/.test(text)) {
    throw invalid("The port must be a number");
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw invalid("The port must be between 1 and 65535");
  }

  return port;
}

// Returns {pubKey, host, port, hostPort}: hostPort is what lnd's ConnectPeer
// takes, with an IPv6 host in brackets.
function parsePeerAddress(input) {
  const text = String(input || "").trim();
  const at = text.indexOf("@");
  if (at < 0) {
    throw invalid("Enter the peer's address as pubkey@host:port");
  }

  const pubKey = text.slice(0, at).toLowerCase();
  if (!PUBKEY.test(pubKey)) {
    throw invalid("The part before @ is not a node public key");
  }

  const rest = text.slice(at + 1);
  let host;
  let port = DEFAULT_PORT;

  if (rest.startsWith("[")) {
    // [ipv6] or [ipv6]:port
    const close = rest.indexOf("]");
    if (close < 0) {
      throw invalid("An IPv6 address must be closed with ]");
    }
    host = rest.slice(1, close);
    const after = rest.slice(close + 1);
    if (after) {
      if (!after.startsWith(":")) {
        throw invalid("Expected :port after the IPv6 address");
      }
      port = parsePort(after.slice(1));
    }
    if (!host || !IPV6.test(host) || !host.includes(":")) {
      throw invalid("That is not an IPv6 address");
    }
  } else if ((rest.match(/:/g) || []).length > 1) {
    // A bare IPv6 address: no port can be told apart from it.
    host = rest;
    if (!IPV6.test(host)) {
      throw invalid("That is not an IPv6 address");
    }
  } else {
    const colon = rest.indexOf(":");
    host = colon < 0 ? rest : rest.slice(0, colon);
    if (colon >= 0) {
      port = parsePort(rest.slice(colon + 1));
    }
    if (!host || host.length > 255 || !NAME.test(host)) {
      throw invalid("The part after @ is not a host name or address");
    }
  }

  const hostPort = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;

  return { pubKey, host, port, hostPort };
}

// host[:port] as lnd takes it for an external address setting: a host name,
// IPv4 address or bracketed IPv6 address, the port 1-65535 if given.
function isHostPort(value) {
  if (typeof value !== "string" || value.length > 300) {
    return false;
  }
  let host = value;
  let port;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) {
      return false;
    }
    host = value.slice(1, close);
    const after = value.slice(close + 1);
    if (after) {
      if (!after.startsWith(":")) {
        return false;
      }
      port = after.slice(1);
    }
    if (!IPV6.test(host) || !host.includes(":")) {
      return false;
    }
  } else {
    const colon = value.indexOf(":");
    if (colon >= 0) {
      host = value.slice(0, colon);
      port = value.slice(colon + 1);
    }
    if (!NAME.test(host)) {
      return false;
    }
  }
  if (port === undefined) {
    return true;
  }
  try {
    parsePort(port);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = { parsePeerAddress, isHostPort, DEFAULT_PORT };
