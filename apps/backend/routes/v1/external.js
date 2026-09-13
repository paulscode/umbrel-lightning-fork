const express = require("express");
const router = express.Router();

const priceLogic = require("logic/price.js");
const safeHandler = require("utils/safeHandler");
const constants = require("utils/const.js");

// BTCB2 in one currency, {"EUR": 123.4}, or 502 when no quote can be had
// right now (see logic/price.js for where it comes from and what can be down).
router.get(
  "/price",
  safeHandler(async (req, res) => {
    const currency = String(req.query.currency || "USD").trim().toUpperCase();
    const price = await priceLogic.getPrice(currency);
    if (price === null) {
      return res.status(constants.STATUS_CODES.BAD_GATEWAY).json();
    }
    return res.status(constants.STATUS_CODES.OK).json({ [currency]: price });
  })
);

// The currencies a quote can be given in at the moment: always USD, the rest
// while the conversion table is reachable.
router.get(
  "/currencies",
  safeHandler(async (req, res) => res.json(await priceLogic.getSupportedCurrencies()))
);

module.exports = router;
