const express = require("express");
const router = express.Router();
const validator = require("utils/validator.js");
const lightningLogic = require("logic/lightning.js");
const safeHandler = require("utils/safeHandler");
const mempoolLogic = require("logic/mempool.js");
const bitcoindLogic = require("logic/bitcoind.js");

router.get(
  "/",
  safeHandler((req, res) =>
    lightningLogic
      .getOnChainTransactions()
      .then(transactions => res.json(transactions))
  )
);

router.post(
  "/",
  safeHandler((req, res, next) => {
    const addr = req.body.addr;
    const amt = req.body.amt;
    const satPerByte = req.body.satPerByte;
    const sendAll = req.body.sendAll === true;

    try {
      // TODO: addr
      validator.isPositiveInteger(amt);
      validator.isBoolean(sendAll);
      if (satPerByte) {
        validator.isPositiveInteger(satPerByte);
      }
    } catch (error) {
      return next(error);
    }

    return lightningLogic
      .sendCoins(addr, amt, satPerByte, sendAll)
      .then(transaction => res.json(transaction));
  })
);

router.get(
  "/estimateFee",
  safeHandler(async (req, res, next) => {
    const address = req.query.address;
    const amt = req.query.amt; // Denominated in Satoshi
    const confTarget = req.query.confTarget;
    const sweep = req.query.sweep === "true";

    try {
      validator.isAlphanumeric(address);
      validator.isPositiveIntegerOrZero(confTarget);

      if (!sweep) {
        validator.isPositiveInteger(amt);
      }
    } catch (error) {
      return next(error);
    }

    return await lightningLogic
      .estimateFee(address, parseInt(amt, 10), parseInt(confTarget, 10), sweep)
      .then(response => res.json(response));
  })
);

// The fee rates the selected Mempool app recommends, as its own page shows
// them. An app that does not answer is reported, not failed: the page then
// falls back to the node's estimate and says so.
router.get(
  "/mempoolFees",
  safeHandler(async (req, res) => {
    let result;
    try {
      result = await mempoolLogic.recommendedFees();
    } catch (error) {
      const selected = await mempoolLogic.settings();
      const app = selected.apps.find(a => a.id === selected.selected);
      result = {
        app: selected.selected,
        name: app ? app.name : "",
        fees: null,
        error: `${app ? app.name : "The Mempool app"} ${mempoolLogic.describeFetchError(error)}.`,
      };
    }
    // The node's own floor, in sat/vB: a rate under it is refused at
    // broadcast, whatever an app on another node recommends.
    try {
      const info = (await bitcoindLogic.getMempoolInfo()).result;
      const floor = mempoolLogic.relayFloorSatPerVbyte(info && info.mempoolminfee);
      if (floor > 0) {
        result.minRelayFeeSatPerVbyte = floor;
      }
    } catch (error) {
      // Without the node's answer the floor is simply not enforced here.
    }
    res.json(result);
  })
);

module.exports = router;
