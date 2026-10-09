// Two checks in front of the dashboard's API that do not depend on a sign-in,
// since on Umbrel there is none of the dashboard's own: Umbrel's app proxy
// signs users in before a request gets here.

// Writes come from the dashboard's own page, as JSON. A page on any other
// site can make a browser send a form or plain text here without asking, and
// so can one on another app of the same Umbrel, which the browser counts as
// the same site and sends Umbrel's sign-in cookie to. Neither can send JSON
// without a preflight, which this server never answers. So a POST that is not
// JSON is refused before any route sees it. Other methods than GET, HEAD and
// POST always need a preflight.
function jsonWrites(req, res, next) {
  if (req.method === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      return res.status(415).json({ error: "requests must be JSON" }); // eslint-disable-line no-magic-numbers
    }
  }
  return next();
}

// TRUSTED_PROXY_IPS, when set, names the only addresses requests may come
// from: the proxy in front of the dashboard. Without it every container on
// the platform's app network could reach the API directly, around the
// proxy's sign-in. The home screen widgets are read by the platform itself
// (umbreld, on the host), so they are answered from the network's gateway
// too, and only they: the host reaches this container from that address,
// and no other container can.
function parseList(text) {
  return String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function normalize(address) {
  const a = String(address || "");
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

// The default gateway from a /proc/net/route table: the host, on a Docker
// network. Addresses there are little-endian hex.
function defaultGateway(table) {
  for (const line of String(table || "").split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length > 2 && fields[1] === "00000000" && /^[0-9A-Fa-f]{8}$/.test(fields[2]) && fields[2] !== "00000000") {
      const n = parseInt(fields[2], 16);
      return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join(".");
    }
  }
  return null;
}

function readGateway() {
  try {
    return defaultGateway(require("fs").readFileSync("/proc/net/route", "utf8"));
  } catch (error) {
    return null;
  }
}

function trustedProxies(list = parseList(process.env.TRUSTED_PROXY_IPS), gateway = readGateway) {
  const allowed = new Set(list.map(normalize));
  let widgetSource;
  return (req, res, next) => {
    if (allowed.size === 0) {
      return next();
    }
    const source = normalize(req.socket && req.socket.remoteAddress);
    if (allowed.has(source)) {
      return next();
    }
    // The platform's health check, which says nothing.
    if (req.method === "GET" && req.path === "/ping") {
      return next();
    }
    if (req.method === "GET" && req.path.startsWith("/v1/lnd/widgets/")) {
      if (widgetSource === undefined || widgetSource === null) {
        widgetSource = gateway();
      }
      if (widgetSource && source === widgetSource) {
        return next();
      }
    }
    return res.status(403).json({ error: "forbidden" }); // eslint-disable-line no-magic-numbers
  };
}

// The dashboard is never shown inside another page.
function noFraming(req, res, next) {
  res.set("Content-Security-Policy", "frame-ancestors 'none'");
  res.set("X-Frame-Options", "DENY");
  return next();
}

module.exports = { jsonWrites, trustedProxies, noFraming, parseList, defaultGateway };
