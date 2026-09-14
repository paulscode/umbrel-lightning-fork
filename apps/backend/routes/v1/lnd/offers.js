const express = require("express");
const router = express.Router();

const offersLogic = require("logic/offers.js");
const safeHandler = require("utils/safeHandler");
const ValidationError = require("models/errors.js").ValidationError;

const HEX_32 = /^[0-9a-fA-F]{64}$/;
const BOLT12_MAX_LENGTH = 8192;
const MAX_AMOUNT_SAT = 2_100_000_000_000_000; // all the coins
const MAX_TEXT_LENGTH = 1024;
const BAD_REQUEST = 400;

function bad(message) {
  return new ValidationError(message, BAD_REQUEST);
}

function checkOfferId(offerId) {
  if (typeof offerId !== "string" || !HEX_32.test(offerId)) {
    throw bad("Invalid offer id");
  }
}

function checkBolt12(str) {
  if (typeof str !== "string" || !str.trim() || str.length > BOLT12_MAX_LENGTH) {
    throw bad("Invalid BOLT 12 string");
  }
}

function checkAmount(amountSat) {
  if (amountSat === undefined || amountSat === null || amountSat === "") {
    return;
  }
  const n = Number(amountSat);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT_SAT) {
    throw bad("Invalid amount");
  }
}

function checkCount(value, what) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw bad(`Invalid ${what}`);
  }
}

function checkText(value, what) {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    throw bad(`${what} must be text of at most ${MAX_TEXT_LENGTH} characters`);
  }
}

router.get(
  "/",
  safeHandler(async (req, res) => {
    const activeOnly = req.query.activeOnly === "true";
    res.json(await offersLogic.listOffers(activeOnly));
  })
);

router.post(
  "/",
  safeHandler(async (req, res, next) => {
    const { description, amountSat, absoluteExpiry, label, quantityAny } = req.body;
    try {
      if (typeof description !== "string") {
        throw bad("Description must be text");
      }
      checkText(description, "Description");
      checkText(label, "Label");
      checkAmount(amountSat);
      checkCount(absoluteExpiry, "expiry");
    } catch (error) {
      return next(error);
    }
    res.json(
      await offersLogic.createOffer({
        description,
        amountSat: Number(amountSat || 0),
        absoluteExpiry: Number(absoluteExpiry || 0),
        label: typeof label === "string" ? label : "",
        quantityAny: Boolean(quantityAny),
      })
    );
  })
);

router.post(
  "/:offerId/disable",
  safeHandler(async (req, res, next) => {
    try {
      checkOfferId(req.params.offerId);
    } catch (error) {
      return next(error);
    }
    await offersLogic.disableOffer(req.params.offerId);
    res.json({});
  })
);

router.post(
  "/:offerId/enable",
  safeHandler(async (req, res, next) => {
    try {
      checkOfferId(req.params.offerId);
    } catch (error) {
      return next(error);
    }
    await offersLogic.enableOffer(req.params.offerId);
    res.json({});
  })
);

router.get(
  "/decode",
  safeHandler(async (req, res, next) => {
    try {
      checkBolt12(req.query.bolt12);
    } catch (error) {
      return next(error);
    }
    res.json(await offersLogic.decode(req.query.bolt12.trim()));
  })
);

router.post(
  "/fetchInvoice",
  safeHandler(async (req, res, next) => {
    const { offer, amountSat, quantity, payerNote, timeoutSeconds } = req.body;
    try {
      checkBolt12(offer);
      checkAmount(amountSat);
      checkCount(quantity, "quantity");
      checkCount(timeoutSeconds, "timeout");
      checkText(payerNote, "Note");
    } catch (error) {
      return next(error);
    }
    res.json(
      await offersLogic.fetchInvoice({
        offer: offer.trim(),
        amountSat: Number(amountSat || 0),
        quantity: Number(quantity || 0),
        payerNote: typeof payerNote === "string" ? payerNote : "",
        timeoutSeconds: Number(timeoutSeconds || 0),
      })
    );
  })
);

router.post(
  "/pay",
  safeHandler(async (req, res, next) => {
    const { offer, invoice, amountSat, quantity, payerNote, timeoutSeconds } = req.body;
    try {
      if (offer) {
        checkBolt12(offer);
      } else {
        checkBolt12(invoice);
      }
      checkAmount(amountSat);
      checkCount(quantity, "quantity");
      checkCount(timeoutSeconds, "timeout");
      checkText(payerNote, "Note");
    } catch (error) {
      return next(error);
    }
    res.json(
      await offersLogic.pay({
        offer: offer ? offer.trim() : "",
        invoice: invoice ? invoice.trim() : "",
        amountSat: Number(amountSat || 0),
        quantity: Number(quantity || 0),
        payerNote: typeof payerNote === "string" ? payerNote : "",
        timeoutSeconds: Number(timeoutSeconds || 0),
      })
    );
  })
);

router.get(
  "/invoices",
  safeHandler(async (req, res, next) => {
    const offerId = req.query.offerId;
    try {
      if (offerId) {
        checkOfferId(offerId);
      }
    } catch (error) {
      return next(error);
    }
    res.json(await offersLogic.listInvoices(offerId || ""));
  })
);

module.exports = router;
