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

// The same for paying, where a call cut off partway (cancelled, a deadline,
// the connection dropped, a payment still in flight) leaves it unknown
// whether the payment went through. That must not read as a failure, which
// invites paying again.
const UNCERTAIN_GRPC_CODES = [1, 4, 14];
function offerPayFailure(error, log = console.warn) {
  if (!(error instanceof LndError)) {
    return error;
  }
  const code = error.error && error.error.code;
  const detail = String((error.error && error.error.details) || "");
  const notReached = /failed to connect|connect failed|ECONNREFUSED|no connection established|name resolution/i.test(detail);
  const cutOff =
    (UNCERTAIN_GRPC_CODES.includes(code) && !notReached && !/destination is unreachable|names no way to reach/i.test(detail)) ||
    /in flight|in transition|no final payment status|stream removed|connection (reset|closed)|socket hang up|ECONNRESET|deadline/i.test(detail);
  if (cutOff) {
    log(`[offers] payment outcome unknown: ${error.message}: ${detail}`);
    const unknown = new ValidationError(
      "Your node did not say whether this payment went through. Check your transactions before trying again.",
      504
    );
    unknown.uncertain = true;
    return unknown;
  }
  return offerFailure(error, log);
}

module.exports = { offerFailure, offerPayFailure };
