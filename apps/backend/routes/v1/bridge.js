// Running a bridge from this node: the operator's Bridge page. Everything is
// read from or done through Lightning Fork's bridge and, when Lightning Fork
// runs it, the bridge's SHA256 Lightning node (see logic/bridgeOperator.js).
const express = require("express");

const bridgeOperator = require("logic/bridgeOperator.js");
const bridgeSwitch = require("logic/bridgeSwitch.js");
const { ValidationError } = require("models/errors.js");
const { createJsonErrorHandler } = require("middlewares/jsonErrors.js");

const router = express.Router();
const logic = () => bridgeOperator.instance();

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const body = (req) => req.body || {};

// Whatever the bridge's state: a node that has not turned it on gets
// {enabled: false} and the page explains how. A node that does not answer
// gets {unavailable: sentence}, still a 200: the page shows the sentence and
// keeps asking, and the dashboard's GET helper drops an error's body.
router.get("/", handle(async () => {
  try {
    return await logic().overview();
  } catch (error) {
    // The switch still, so a bridge that keeps Lightning Fork from starting
    // can be turned off from here.
    const toggle = await bridgeSwitch.instance().info().catch(() => null);
    return {
      enabled: null,
      toggle,
      unavailable: error instanceof ValidationError && error.statusCode !== 503
        ? error.message
        : "Lightning Fork is not answering about the bridge yet. It may be starting up.",
    };
  }
}));

// On Umbrel, the switch: {enabled: true|false}. Restarts Lightning Fork.
router.post("/enabled", handle((req) => bridgeSwitch.instance().set(body(req).enabled, body(req).node === undefined ? null : body(req).node)));

// A JSON number only: a form post (which a page elsewhere could make) carries
// strings.
router.post("/rate", handle((req) => {
  if (typeof body(req).rate !== "number") {
    throw new ValidationError("The rate is how much BTC (SHA256) one BTCB2 buys: a positive number such as 0.00483.", 400);
  }
  return logic().setRate(body(req).rate);
}));

router.post("/sha256/address", handle(() => logic().depositAddress()));
router.post("/sha256/channel", handle((req) => logic().openChannel({
  peer: body(req).peer,
  amountSat: body(req).amountSat,
})));

// The SHA256 node's recovery phrase. A POST, and only when the request says
// it knows what it is asking for, so a stray GET or a prefetch never puts it
// on a screen.
router.post("/sha256/recovery", handle((req) => {
  if (body(req).confirm !== true) {
    throw new ValidationError("Confirm that you want the recovery phrase shown.", 400);
  }
  return logic().recoveryPhrase();
}));

// The SHA256 node's channel backup, for restoring its channels anywhere.
// Encrypted with that node's seed, as every lnd channel backup is.
router.get("/sha256/channel-backup", async (req, res, next) => {
  try {
    const backup = await logic().channelBackup();
    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Disposition", "attachment; filename=\"sha256-node-channel.backup\"");
    res.send(backup);
  } catch (error) {
    next(error);
  }
});

router.post("/participants", handle((req) => logic().issueCode(body(req).label)));
router.delete("/participants/:rootKeyId", handle((req) => logic().revokeCode(req.params.rootKeyId)));

router.use(createJsonErrorHandler("bridge"));

module.exports = router;
