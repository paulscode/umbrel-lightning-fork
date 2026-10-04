// Errors as {error: "<a sentence for the user>"}, the mobile API's form,
// with `uncertain: true` when a send may have gone through and `code` when
// the refusal has a stable one a client can branch on.
const logger = require("utils/logger.js");
const { LndError } = require("models/errors.js");

const WALLET_LOCKED = "wallet locked, unlock it to enable full RPC access";

function createJsonErrorHandler(label) {
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
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
      logger.error(message, `${label} ${req.method} ${req.path}`, error.stack);
    }
    const out = { error: message };
    if (error.uncertain) {
      out.uncertain = true;
    }
    if (typeof error.refusal === "string") {
      out.code = error.refusal;
    }
    // What a client needs beside the code (a proof, a ceiling, a wait).
    if (error.details && typeof error.details === "object") {
      out.details = error.details;
    }
    res.status(status).json(out);
  };
}

module.exports = { createJsonErrorHandler };
