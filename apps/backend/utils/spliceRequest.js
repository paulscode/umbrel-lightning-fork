// The lnd requests of a channel resize, from the options logic/splice.js
// checks. Kept apart from services/lnd.js so the tests can check them
// against the proto without the native gRPC module.

// EstimateSpliceRequest.
function spliceRequest({ fundingTxid, outputIndex, direction, amountSat, useMax, satPerVbyte, targetConf, addr }) {
  return {
    channel_point: { funding_txid_str: fundingTxid, output_index: outputIndex },
    direction: direction === "out" ? "SPLICE_OUT" : "SPLICE_IN",
    amount_sat: amountSat || 0,
    use_max: !!useMax,
    sat_per_vbyte: satPerVbyte || 0,
    target_conf: targetConf || 0,
    addr: addr || "",
  };
}

// SpliceChannelRequest: the estimate's fields, and whether a rate under the
// node's floor is meant.
function spliceChannelRequest(options) {
  return { ...spliceRequest(options), force_low_fee: !!options.forceLowFee };
}

module.exports = { spliceRequest, spliceChannelRequest };
