// Channel resizes (splices): adding funds to an open channel from the wallet,
// or moving funds out of it to an address, without closing it.
const lndService = require("services/lnd.js");
const bitcoindService = require("services/bitcoind.js");
const ValidationError = require("models/errors.js").ValidationError;
const { createIdempotency } = require("utils/idempotency.js");

const PEER_TEXT_MAX = 160; // eslint-disable-line no-magic-numbers
// A custom fee rate's ceiling, as the mobile API's: a typo of a few zeros
// would otherwise spend the amount on fees.
const MAX_SAT_PER_VBYTE = 10000; // eslint-disable-line no-magic-numbers
// How long a start waits for the node before answering "uncertain".
const START_WAIT_MS = 90 * 1000; // eslint-disable-line no-magic-numbers
const BLOCK_SAMPLE = 144; // eslint-disable-line no-magic-numbers
const BLOCK_MINUTES_TTL_MS = 10 * 60 * 1000; // eslint-disable-line no-magic-numbers

const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));

// A channel point "txid:index".
function parseChannelPoint(channelPoint) {
  const parts = String(channelPoint || "").split(":");
  if (parts.length !== 2 || !/^[0-9a-f]{64}$/i.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    throw new ValidationError("Invalid channel point.");
  }

  return { fundingTxid: parts[0], outputIndex: parseInt(parts[1], 10) };
}

// The options of a resize request, checked.
function spliceOptions(body) {
  const b = body || {};
  const { fundingTxid, outputIndex } = parseChannelPoint(b.channelPoint);
  if (b.direction !== "in" && b.direction !== "out") {
    throw new ValidationError("Direction must be in or out.");
  }
  const useMax = b.useMax === true;
  const amountSat = num(b.amountSat);
  if (!useMax && (!Number.isSafeInteger(amountSat) || amountSat <= 0)) {
    throw new ValidationError("Amount must be a positive whole number of sats.");
  }
  const satPerVbyte = num(b.satPerVbyte);
  if (!Number.isSafeInteger(satPerVbyte) || satPerVbyte < 0) {
    throw new ValidationError("Fee rate must be a whole number of sat/vB.");
  }
  if (satPerVbyte > MAX_SAT_PER_VBYTE) {
    throw new ValidationError(`Fee rate must be at most ${MAX_SAT_PER_VBYTE} sat/vB.`);
  }
  const targetConf = num(b.targetConf);
  if (!Number.isSafeInteger(targetConf) || targetConf < 0 || targetConf > 1008) { // eslint-disable-line no-magic-numbers
    throw new ValidationError("Confirmation target must be a whole number of blocks.");
  }
  const addr = b.direction === "out" ? String(b.addr || "").trim() : "";
  if (addr && !/^[a-z0-9]{14,90}$/i.test(addr)) {
    throw new ValidationError("Invalid address.");
  }

  return {
    fundingTxid,
    outputIndex,
    direction: b.direction,
    amountSat: useMax ? 0 : amountSat,
    useMax,
    satPerVbyte,
    targetConf,
    addr,
    forceLowFee: b.forceLowFee === true,
  };
}

// The peer's text: printable ASCII, at most 160 bytes. It is the peer's to
// write, so it is shown as theirs and never linked.
function peerText(text) {
  return String(text || "")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, PEER_TEXT_MAX);
}

// The recent average time between blocks, in minutes: what a lock depth
// takes on this chain rather than ten minutes a block.
let blockMinutesCache = null;
async function recentBlockMinutes() {
  if (blockMinutesCache && Date.now() - blockMinutesCache.at < BLOCK_MINUTES_TTL_MS) {
    return blockMinutesCache.minutes;
  }
  let minutes = 10; // eslint-disable-line no-magic-numbers
  try {
    const tip = num((await bitcoindService.getBlockCount()).result);
    const from = Math.max(0, tip - BLOCK_SAMPLE);
    if (tip > from) {
      const timeAt = async (height) => {
        const hash = (await bitcoindService.getBlockHash(height)).result;
        return num((await bitcoindService.getBlock(hash)).result.time);
      };
      const span = (await timeAt(tip)) - (await timeAt(from));
      if (span > 0) {
        minutes = span / 60 / (tip - from); // eslint-disable-line no-magic-numbers
      }
    }
  } catch (error) {
    // Without the chain's own pace, ten minutes a block.
  }
  blockMinutesCache = { at: Date.now(), minutes };

  return minutes;
}

// What a resize would cost and allow, with how long it takes to lock.
async function estimate(body) {
  const options = spliceOptions(body);
  const res = await lndService.estimateSplice(options);
  const lockDepth = num(res.lockDepth);
  const blockMinutes = await recentBlockMinutes();

  return {
    feeSat: num(res.feeSat),
    vbytes: num(res.vbytes),
    satPerVbyte: num(res.satPerVbyte),
    amountSat: num(res.amountSat),
    minSat: num(res.minSat),
    maxInSat: num(res.maxInSat),
    maxOutSat: num(res.maxOutSat),
    minSatPerVbyte: num(res.minSatPerVbyte),
    feeEstimateSource: res.feeEstimateSource || "",
    anchorReserveSat: num(res.anchorReserveSat),
    newCapacitySat: num(res.newCapacitySat),
    newLocalSat: num(res.newLocalSat),
    lockDepth,
    destinationIsOurs: !!res.destinationIsOurs,
    refusalCode: res.refusalCode || "",
    blockMinutes,
    lockMinutes: Math.round(lockDepth * blockMinutes),
  };
}

// Starts a resize and answers once it is agreed with the peer, or refused.
async function start(body) {
  const options = spliceOptions(body);
  try {
    const res = await lndService.spliceChannel(options);

    return { state: res.state, txid: res.txid || "", newChannelPoint: res.newChannelPoint || "" };
  } catch (error) {
    if (error && error.spliceReason !== undefined) {
      return {
        state: "aborted",
        reason: error.reasonFromPeer ? peerText(error.spliceReason) : String(error.spliceReason),
        reasonFromPeer: !!error.reasonFromPeer,
      };
    }
    throw error;
  }
}

// Each request id starts one resize: a browser that lost the answer asks
// again with the same id and gets the first start's outcome instead of a
// second resize. An answer the node hasn't given within the wait is
// "uncertain" (the route sends a 504); asking again with the id gives the
// outcome once it is known.
const starts = createIdempotency({ ttlMs: 60 * 60 * 1000 }); // eslint-disable-line no-magic-numbers

async function startOnce(body, { waitMs = START_WAIT_MS } = {}) {
  const { requestId, ...rest } = body || {};
  // Checked first: a bad request is a 400, and never takes the id.
  const fingerprint = JSON.stringify(spliceOptions(rest));
  const outcome = starts.run("dashboard", requestId, () => start(rest), fingerprint);
  let timer;
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: "uncertain" }), waitMs);
  });
  try {
    return await Promise.race([outcome, wait]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  estimate,
  start,
  startOnce,
  MAX_SAT_PER_VBYTE,
  spliceOptions,
  peerText,
  recentBlockMinutes,
};
