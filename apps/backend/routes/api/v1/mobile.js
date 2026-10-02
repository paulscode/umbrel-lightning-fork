// The mobile API, for the companion app. JSON in and out; amounts in sats,
// times in Unix seconds; every error is {error: "<a sentence for the user>"}.
//
// POST /pair is the only call without a device key: it takes the one-time
// code from the pairing QR and returns the key. Calls that move money take
// an optional requestId; repeating one returns the first outcome instead of
// acting twice (utils/idempotency.js).
const express = require("express");

const devices = require("logic/devices.js");
const mobile = require("logic/mobile.js");
const access = require("logic/mobileAccess.js");
const lightningLogic = require("logic/lightning.js");
const lndService = require("services/lnd.js");
const peersLogic = require("logic/peers.js");
const offersLogic = require("logic/offers.js");
const priceLogic = require("logic/price.js");
const { ValidationError, LndError } = require("models/errors.js");
const { createDeviceAuth, createFailureLimiter } = require("middlewares/deviceAuth.js");
const { createIdempotency } = require("utils/idempotency.js");
const x509 = require("utils/x509.js");
const logger = require("utils/logger.js");

const API_VERSION = 1;
const WALLET_LOCKED = "wallet locked, unlock it to enable full RPC access";

const router = express.Router();
const deviceAuth = createDeviceAuth({ devices: () => devices });
const pairLimiter = createFailureLimiter({ max: 10 });
const once = createIdempotency();

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const body = (req) => req.body || {};

// A JSON true, and nothing else: "false" in a form body is not true.
const yes = (value) => value === true;

// Runs a money-moving call once per request id. The id is bound to the call
// and its parameters, so a reused id cannot answer for a different payment.
function idempotent(req, fn) {
  const { requestId, ...params } = body(req);
  const fingerprint = req.path + " " + JSON.stringify(params, Object.keys(params).sort());
  return once.run(req.device.id, requestId, fn, fingerprint);
}

router.post(
  "/pair",
  handle(async (req, res) => {
    const source = req.socket.remoteAddress || "?";
    const { enrollCode, label, claimNonce } = body(req);
    // A valid code always pairs; a source that keeps failing is told to
    // back off (the codes are 192-bit random, so this is about noise).
    const claimed = await devices.claim(enrollCode, label, claimNonce);
    if (!claimed) {
      if (pairLimiter.blocked(source)) {
        res.status(429);
        return { error: "Too many attempts. Try again later." };
      }
      pairLimiter.fail(source);
      res.status(401);
      return { error: "This pairing code is not valid any more. Start the pairing again from the dashboard." };
    }
    const caPem = access.rootCaPem();
    let node = null;
    try {
      node = await mobile.node();
    } catch (error) {
      node = null;
    }
    return {
      apiKey: claimed.apiKey,
      deviceId: claimed.id,
      label: claimed.label,
      serverId: devices.serverId(),
      apiVersion: API_VERSION,
      caPem,
      caSha256: caPem ? x509.fingerprint(caPem) : null,
      node,
    };
  })
);

router.use(deviceAuth);

router.get(
  "/bootstrap",
  handle(async (req) => ({
    serverId: devices.serverId(),
    apiVersion: API_VERSION,
    deviceId: req.device.id,
    label: req.device.label,
    node: await mobile.node(),
  }))
);

// Where the phone can reach the node and the root it pins, refreshed after
// pairing so a phone that paired over Tor learns the LAN, and the other way
// round.
router.get(
  "/endpoints",
  handle(async (req) => {
    const caPem = access.rootCaPem();
    return {
      ...access.endpoints(req),
      caPem,
      caSha256: caPem ? x509.fingerprint(caPem) : null,
    };
  })
);

router.get("/wallet", handle(() => mobile.wallet()));
router.get("/fees", handle(() => mobile.fees()));
router.post("/decode", handle((req) => mobile.decode(body(req).input)));

router.post(
  "/onchain/estimate",
  handle((req) => {
    const { address, amountSat, sendAll, satPerVbyte } = body(req);
    return mobile.estimateOnchain({ address, amountSat, sendAll: yes(sendAll), satPerVbyte });
  })
);

router.post(
  "/onchain/send",
  handle((req) =>
    idempotent(req, () => {
      const { address, amountSat, sendAll, satPerVbyte, requestId } = body(req);
      return mobile.sendOnchain({ address, amountSat, sendAll: yes(sendAll), satPerVbyte, requestId });
    })
  )
);

router.post(
  "/lightning/pay",
  handle((req) =>
    idempotent(req, ({ recheck }) => {
      const { request, amountSat, payerNote } = body(req);
      return mobile.payLightning({ request, amountSat, payerNote, recheck });
    })
  )
);

router.post("/receive/address", handle((req) => mobile.receiveAddress({ fresh: yes(body(req).fresh) })));

router.post(
  "/receive/invoice",
  handle((req) => {
    const { amountSat, memo, expirySeconds } = body(req);
    return mobile.createInvoice({ amountSat, memo, expirySeconds });
  })
);

router.get("/receive/invoice/:paymentHash", handle((req) => mobile.invoiceStatus(req.params.paymentHash)));

router.post(
  "/receive/offer",
  handle((req) => {
    const { description, amountSat } = body(req);
    return mobile.createOffer({ description, amountSat });
  })
);

router.get("/activity", handle((req) => mobile.activity({ limit: req.query.limit })));

router.get(
  "/price",
  handle(async (req) => {
    const currency = String(req.query.currency || "USD").toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(currency)) {
      throw new ValidationError("Not a currency code");
    }
    // getPrice gives the number, or null while no feed answers.
    const price = await priceLogic.getPrice(currency);
    return { currency, price: typeof price === "number" && price > 0 ? price : null };
  })
);

// The rest of what the dashboard does with channels, peers and offers, in
// the dashboard's own shapes.
router.get("/channels", handle(async () => ({ channels: await lightningLogic.getChannels() })));

router.post(
  "/channels/open",
  handle((req) =>
    idempotent(req, async () => {
      const { pubKey, host, port, amountSat, satPerVbyte, isPrivate } = body(req);
      if (!/^0[23][0-9a-f]{64}$/.test(String(pubKey || ""))) {
        throw new ValidationError("Not a node public key");
      }
      const amount = Number(amountSat);
      if (!Number.isInteger(amount) || amount < 20000 || amount > 21e14) {
        throw new ValidationError("A channel needs at least 20,000 sats");
      }
      const rate = satPerVbyte === undefined || satPerVbyte === null ? undefined : Number(satPerVbyte);
      if (rate !== undefined && (!Number.isFinite(rate) || rate < 1 || rate > 10000)) {
        throw new ValidationError("The fee rate must be between 1 and 10000 sat/vB");
      }
      const p = port === undefined || port === null ? 9735 : Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new ValidationError("The port must be between 1 and 65535");
      }
      // Connect first when given an address; already connected is fine.
      if (host) {
        try {
          await lndService.connectToPeer(pubKey, String(host), p);
        } catch (error) {
          if (!/already connected/i.test(String((error.error && error.error.details) || error.message))) {
            throw error;
          }
        }
      }
      // Once OpenChannelSync answers the channel is funded; nothing after it
      // may fail the call (a repeat with a new id would open a second one).
      try {
        const res = await lndService.openChannel(pubKey, amount, rate === undefined ? undefined : Math.ceil(rate), yes(isPrivate));
        // A ChannelPoint: the txid as a string, or as bytes in reverse order.
        let fundingTxid = (res && res.fundingTxidStr) || null;
        if (!fundingTxid && res && res.fundingTxidBytes) {
          fundingTxid = Buffer.from(Object.values(res.fundingTxidBytes)).reverse().toString("hex");
        }
        return { fundingTxid, outputIndex: res ? Number(res.outputIndex || 0) : null, opening: true };
      } catch (error) {
        const code = error.error && error.error.code;
        if (code === 4 || (code === 14 && !/failed to connect|connect failed/i.test(String(error.error.details)))) {
          const unknown = new ValidationError("Your node did not say whether the channel was opened. Check your channels before trying again.", 504);
          unknown.uncertain = true;
          throw unknown;
        }
        throw error;
      }
    })
  )
);

router.post(
  "/channels/close",
  handle((req) =>
    idempotent(req, async () => {
      const { channelPoint, force } = body(req);
      const match = /^([0-9a-f]{64}):(\d+)$/.exec(String(channelPoint || ""));
      if (!match) {
        throw new ValidationError("Not a channel point (txid:index)");
      }
      try {
        await lightningLogic.closeChannel(match[1], Number(match[2]), yes(force));
      } catch (error) {
        if (error.error && error.error.code === 4) {
          const unknown = new ValidationError("Your node did not say whether the channel is closing. Check your channels before trying again.", 504);
          unknown.uncertain = true;
          throw unknown;
        }
        throw error;
      }
      return { closing: true };
    })
  )
);

router.get("/peers", handle(async () => ({ peers: await peersLogic.listPeers() })));
router.post("/peers/connect", handle((req) => peersLogic.connectPeer(body(req).address)));
router.post("/peers/disconnect", handle((req) => peersLogic.disconnectPeer(body(req).pubKey)));

router.get("/offers", handle(async () => ({ offers: await offersLogic.listOffers(true) })));
router.post(
  "/offers/:offerId/disable",
  handle(async (req) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.offerId)) {
      throw new ValidationError("Not an offer id");
    }
    await offersLogic.disableOffer(req.params.offerId);
    return { disabled: true };
  })
);

router.use((req, res) => {
  res.status(404).json({ error: "No such call" });
});

// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  let status = error.statusCode || 500;
  let message = error.message || "Something went wrong";
  const detail = error.error && error.error.details;
  if (error instanceof LndError) {
    if (detail === WALLET_LOCKED) {
      status = 503;
      message = "The node's wallet is locked.";
    } else if (
      (error.error && (error.error.code === 14 || error.error.code === 4)) ||
      /failed to connect|ECONNREFUSED|waiting to start|in the process of starting/i.test(String(detail || ""))
    ) {
      status = 503;
      message = "The node is not answering. It may be starting up.";
    } else {
      // LND refused: the request, not the server, is at fault.
      status = error.statusCode || 400;
      if (detail) {
        message = `${message}: ${detail}`;
      }
    }
  }
  if (error.type === "entity.parse.failed") {
    status = 400;
    message = "The request is not valid JSON";
  }
  if (status >= 500) {
    logger.error(message, `mobile ${req.method} ${req.path}`, error.stack);
  }
  res.status(status).json(error.uncertain ? { error: message, uncertain: true } : { error: message });
});

module.exports = router;
