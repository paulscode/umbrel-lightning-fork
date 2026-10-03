// A failure to get an invoice for an offer, or to pay one, as a sentence a
// person can act on. LND's own wording ("request: message names no chain…")
// is for the log, where it goes; the dashboard shows this instead. A node
// that is not answering keeps its 503, so the page can say to wait.
//
// Relative requires, so the tests can load it without the module aliases.
const { LndError, ValidationError } = require("../models/errors.js");

function offerFailure(error, log = console.warn) {
  if (!(error instanceof LndError)) {
    return error;
  }
  const { friendlyPayError } = require("../logic/mobile.js");
  const detail = String((error.error && error.error.details) || "");
  // Only a failure to reach this node means this node is down. The offers
  // service also answers "unavailable" when the offer's node cannot be
  // reached, which is a different sentence.
  if (/failed to connect|connect failed|ECONNREFUSED|no connection established|name resolution|wallet locked|not yet ready|in the process of starting/i.test(detail)) {
    return new ValidationError("Your node is not answering. It may be starting up.", 503);
  }
  log(`[offers] ${error.message}: ${detail}`);
  return new ValidationError(friendlyPayError(error), 400);
}

module.exports = { offerFailure };
