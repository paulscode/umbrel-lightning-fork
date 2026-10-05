// The calls to a service that pays SHA256 invoices for this node: what it
// would charge now (info), a request to pay one invoice (quote), and how an
// earlier request is going (swap).
//
// A service is reached at the address its code names. On Tor (an onion) the
// calls go through the node's Tor proxy and the certificate is not checked:
// the onion address already authenticates the far end. Anywhere else the
// certificate must be exactly the one the code pins, checked before the
// request, and so the credential, is sent.
//
// Every failure comes back as a ValidationError with `refusal`, a stable
// code, and a sentence for the user that never names the machinery behind
// it. The service's own sentences are not passed on: they are written for
// its operator.
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const { ValidationError } = require("../models/errors.js");

const TIMEOUT_MS = { info: 30 * 1000, quote: 60 * 1000, swap: 30 * 1000 };
const MAX_RESPONSE_BYTES = 1024 * 1024;

// What each of the service's refusal codes means to the person paying, and
// the status the API answers with.
const REFUSALS = {
  disabled: [400, "The service is not paying SHA256 invoices at the moment."],
  unavailable: [503, "The service is not available right now. Try again later."],
  invalid_request: [400, "The service could not read this request."],
  invalid_invoice: [400, "The service could not read this invoice."],
  no_direction: [400, "The service does not pay SHA256 invoices."],
  no_amount: [400, "This invoice does not say how much to pay, so it can't be paid from here."],
  too_small: [400, "This amount is less than the service pays."],
  too_large: [400, "This amount is more than the service pays at once."],
  expires_soon: [400, "This invoice expires too soon to be paid safely."],
  route_budget: [400, "The recipient's node asks for more time than the service can give a payment, so it can't be paid this way."],
  no_route: [400, "The service can't reach this invoice's recipient within its limits, so it can't be paid this way. Nothing was paid."],
  self_payment: [400, "This invoice was made by the service's own node."],
  no_liquidity: [400, "The service can't pay this much right now. Try a smaller amount, or try again later."],
  price_unavailable: [400, "The service has no current price. Try again later."],
  chain_unmeasured: [400, "The service is starting up. Try again in a few minutes."],
  in_progress: [409, "This invoice is already being paid. Check your activity before trying again."],
  already_paid: [409, "This invoice has already been paid."],
  needs_operator: [409, "The service's last attempt at this invoice needs its operator to look at it. Ask them before trying again."],
  limit: [429, "Too many of your payments are waiting at the service. Try again in a minute."],
  not_found: [404, "The service has no record of this payment."],
  internal: [503, "The service ran into a problem. Try again later."],
  not_authorized: [400, "The service did not accept its code. It may have been revoked; ask its operator for a new one."],
  unreachable: [503, "The service is not answering. Try again later."],
  tor_required: [400, "This service can only be reached over Tor, and this node has no Tor proxy."],
  cert_mismatch: [400, "The service did not present the certificate its code names, so nothing was sent to it."],
  invalid_response: [503, "The service sent an answer that could not be read."],
};

function refusal(code, message) {
  const [status, sentence] = REFUSALS[code] || [400, "The service refused this payment."];
  const error = new ValidationError(message || sentence, status);
  error.refusal = REFUSALS[code] ? code : "refused";
  return error;
}

function isRefusal(error) {
  return Boolean(error && error instanceof ValidationError && error.refusal);
}

// The refusal in an error the gateway sent: "<code>: <sentence>", or lnd's
// own authentication error, which carries no code.
function refusalFromBody(status, text) {
  let message = "";
  try {
    const body = JSON.parse(text);
    message = String((body && (body.message || body.error)) || "");
  } catch (error) {
    message = String(text || "");
  }
  const match = /^([a-z_]+): /.exec(message);
  if (match && REFUSALS[match[1]]) {
    return refusal(match[1]);
  }
  if (/macaroon|verification failed|permission denied|signature mismatch|unauthorized/i.test(message) || status === 401 || status === 403) {
    return refusal("not_authorized");
  }
  if (match) {
    return refusal("refused");
  }
  return refusal(status >= 500 ? "internal" : "refused");
}

function fingerprintOf(der) {
  const hex = crypto.createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/../g).join(":");
}

// The node's Tor proxy, for a service at an onion address: Umbrel's, which
// the price feeds use too, or ONION_PROXY_*, which StartOS passes for onions
// only. Kept apart there because the proxy is the Tor package's, which may not
// be installed, and routing the price feeds through it would break them on a
// server that has none.
function torProxy(env = process.env) {
  if (env.TOR_PROXY_IP && env.TOR_PROXY_PORT) {
    return `socks5h://${env.TOR_PROXY_IP}:${env.TOR_PROXY_PORT}`;
  }
  if (env.ONION_PROXY_IP && env.ONION_PROXY_PORT) {
    return `socks5h://${env.ONION_PROXY_IP}:${env.ONION_PROXY_PORT}`;
  }
  return null;
}

let torAgent;
function torAgentFor(proxyUrl) {
  if (!torAgent || torAgent.proxyUrl !== proxyUrl) {
    const { SocksProxyAgent } = require("socks-proxy-agent");
    torAgent = { proxyUrl, agent: new SocksProxyAgent(proxyUrl) };
  }
  return torAgent.agent;
}

// A TLS connection whose certificate is the pinned one, or a refusal. No
// byte of the request is written before the check.
function pinnedConnection({ hostname, port, pin, onSocket }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port,
      servername: net.isIP(hostname) ? undefined : hostname,
      // The pin below is the check: lnd's certificate is self-signed.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    onSocket(socket);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.raw || fingerprintOf(cert.raw) !== pin) {
        socket.destroy();
        reject(refusal("cert_mismatch"));
        return;
      }
      resolve(socket);
    });
    socket.once("error", () => reject(refusal("unreachable")));
  });
}

// One call: {status, text}. Anything that keeps it from being answered is
// "unreachable", short of a certificate that is not the pinned one.
function defaultRequest({ service, method, path, headers, body, timeoutMs, env = process.env }) {
  const url = new URL(service.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || 443;
  let proxyUrl = null;
  if (service.onion) {
    proxyUrl = torProxy(env);
    if (!proxyUrl) {
      return Promise.reject(refusal("tor_required"));
    }
  }
  return new Promise((resolve, reject) => {
    let request = null;
    let socket = null;
    let done = false;
    const finish = (fn, value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const timer = setTimeout(() => {
      if (request) {
        request.destroy();
      }
      if (socket) {
        socket.destroy();
      }
      finish(reject, refusal("unreachable"));
    }, timeoutMs);

    const send = (options) => {
      request = options.createConnection ? http.request(options) : https.request(options);
      request.on("response", (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            finish(reject, refusal("invalid_response"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish(reject, refusal("unreachable")));
      });
      request.on("error", () => finish(reject, refusal("unreachable")));
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    };

    const options = { method, host: hostname, port, path, headers };
    if (proxyUrl) {
      let agent;
      try {
        agent = torAgentFor(proxyUrl);
      } catch (error) {
        finish(reject, refusal("tor_required"));
        return;
      }
      // Tor authenticates the onion; lnd's certificate is self-signed.
      send({ ...options, agent, rejectUnauthorized: false });
      return;
    }
    pinnedConnection({ hostname, port, pin: service.cert, onSocket: (s) => (socket = s) }).then(
      () => {
        if (done) {
          socket.destroy();
          return;
        }
        send({ ...options, createConnection: () => socket });
      },
      (error) => finish(reject, error)
    );
  });
}

function createBridgeClient({ request = defaultRequest } = {}) {
  async function call(service, name, method, path, payload) {
    const headers = { "Grpc-Metadata-macaroon": service.macaroon, Accept: "application/json" };
    let body;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const res = await request({ service, method, path, headers, body, timeoutMs: TIMEOUT_MS[name] });
    if (res.status < 200 || res.status >= 300) {
      throw refusalFromBody(res.status, res.text);
    }
    try {
      const data = JSON.parse(res.text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return data;
      }
    } catch (error) {
      // Falls through to the refusal below.
    }
    throw refusal("invalid_response");
  }

  return {
    info: (service) => call(service, "info", "GET", "/v2/bridge/info"),
    quote: (service, invoice) => call(service, "quote", "POST", "/v2/bridge/quote", { invoice }),
    // The payment hash in hex; the gateway wants bytes as standard base64.
    swap: (service, paymentHash) =>
      call(service, "swap", "POST", "/v2/bridge/swap", { hash: Buffer.from(paymentHash, "hex").toString("base64") }),
  };
}

module.exports = {
  createBridgeClient,
  defaultRequest,
  refusal,
  isRefusal,
  refusalFromBody,
  fingerprintOf,
  torProxy,
  REFUSALS,
  TIMEOUT_MS,
};
