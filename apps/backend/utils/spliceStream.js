// Follows a SpliceChannel stream until the resize is agreed with the peer
// or refused. Kept apart from services/lnd.js so it can be tested without
// the native gRPC module.
const LndError = require("models/errors.js").LndError;

// How long to wait for the peer's signatures once ours went out. Ours go
// first on every resize, and the peer's usually follow at once: answering
// "signed" straight away would say we wait for the peer when it is done.
const SIGNED_GRACE_MS = 15000;

// Resolves { state, txid, newChannelPoint } with state "broadcast" or
// "locked", or "signed" when the peer's signatures haven't come within the
// grace. Rejects with spliceReason and reasonFromPeer when the resize is
// refused, or an LndError when the stream fails before our signatures
// went out. The resize carries on after the stream is let go.
function followSplice(call, { graceMs = SIGNED_GRACE_MS } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let signed = null;
    let timer = null;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      try {
        call.cancel();
      } catch (error) {
        // Already ended.
      }
    };
    const answer = (update) => ({
      state: update.state,
      txid: update.txid || "",
      newChannelPoint: update.new_channel_point || "",
    });

    call.on("data", (update) => {
      if (update.state === "broadcast" || update.state === "locked") {
        finish(() => resolve(answer(update)));
      } else if (update.state === "signed") {
        if (!signed) {
          signed = update;
          timer = setTimeout(() => finish(() => resolve(answer(signed))), graceMs);
        }
      } else if (update.state === "aborted") {
        finish(() =>
          reject(
            Object.assign(new LndError("The resize did not go through", { code: 9, details: update.reason }), {
              spliceReason: update.reason,
              reasonFromPeer: !!update.reason_from_peer,
            })
          )
        );
      }
    });
    // Once our signatures went out the resize can no longer be dropped: a
    // stream that fails after that still answers "signed".
    call.on("error", (error) => {
      if (signed) {
        finish(() => resolve(answer(signed)));
        return;
      }
      // Refused before it started (FAILED_PRECONDITION: "splice refused:
      // code: details"; INVALID_ARGUMENT: a request out of range): an
      // answer, worded by its code, not an error of the node's.
      const refused = error && (error.code === 9 || error.code === 3) && error.details;
      finish(() =>
        reject(
          refused
            ? Object.assign(new LndError("The resize did not go through", error), {
                spliceReason: error.details,
                reasonFromPeer: false,
              })
            : new LndError("Unable to resize the channel", error)
        )
      );
    });
    call.on("end", () => {
      finish(() =>
        signed
          ? resolve(answer(signed))
          : reject(
              new LndError("Unable to resize the channel", {
                code: 4,
                details: "the node ended the request without an answer",
              })
            )
      );
    });
  });
}

module.exports = { followSplice, SIGNED_GRACE_MS };
