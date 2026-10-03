// Paying Bitcoin invoices from the dashboard: the service it is done
// through (set from the code its operator gave, shown without its
// credential, removed), the premium over the market rate the user allows,
// and the same decode and pay the mobile API offers, for the web page.
//
// Answers and errors are in the mobile API's form ({error, code?,
// uncertain?}), so one client can handle both.
const express = require("express");

const mobile = require("logic/mobile.js");
const bitcoinInvoices = require("logic/bitcoinInvoices.js");
const { createIdempotency } = require("utils/idempotency.js");
const { createJsonErrorHandler } = require("middlewares/jsonErrors.js");

const router = express.Router();
const once = createIdempotency();
const logic = () => bitcoinInvoices.instance();

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const body = (req) => req.body || {};

router.get("/", handle(() => logic().get()));

// The service's terms now and the market rate, for the settings page.
router.get("/status", handle(() => logic().status()));

router.post("/service", handle((req) => logic().setService(body(req).code)));
router.delete("/service", handle(() => logic().removeService()));

router.post("/premium", handle((req) => logic().setPremium(body(req).premium)));

// The page shows Bitcoin invoices as such.
router.post(
  "/decode",
  handle((req) => mobile.decode(body(req).input, { capabilities: [mobile.BITCOIN_INVOICE_CAPABILITY] }))
);

// As the mobile API's /pay/bitcoin-invoice, request ids and all; the page
// is one client, so they are kept apart from the phones' by scope alone.
router.post(
  "/pay",
  handle((req) => {
    const { requestId, resume, ...params } = body(req);
    const fingerprint = req.path + " " + JSON.stringify(params, Object.keys(params).sort());
    return once.run("web", requestId, ({ recheck }) =>
      mobile.payBitcoinInvoice({
        request: params.request,
        maxIncomingSat: params.maxIncomingSat,
        recheck,
        resume: resume === true,
      }),
      fingerprint
    );
  })
);

router.use(createJsonErrorHandler("bitcoin-invoices"));

module.exports = router;
