// What the companion app does with the node: balances, telling what the user
// pasted or scanned, sending on-chain and over Lightning, receiving, and a
// short history. Amounts are whole satoshis, times Unix seconds.
//
// The services are passed in so the tests can run without node_modules;
// the default instance at the bottom loads the real ones lazily.
const { ValidationError } = require("../models/errors.js");
const { parseAddress, otherNetwork } = require("../utils/bitcoinAddress.js");
const {
  routingFeeLimit,
  MIN_HOLD_SECONDS,
  ENDED_STATES,
  WAITING_STATES,
  NO_AMOUNT,
  NO_SERVICE,
  INVALID_HOLD,
} = require("./bitcoinInvoices.js");

const DEFAULT_INVOICE_EXPIRY = 3600;
const MAX_INVOICE_EXPIRY = 7 * 24 * 3600;
// lnd allows 639 bytes of BOLT 11 description; count bytes, not characters.
const MAX_MEMO_BYTES = 639;

function clip(text, maxBytes = MAX_MEMO_BYTES) {
  let out = String(text || "");
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = Array.from(out).slice(0, -1).join("");
  }
  return out;
}
const MAX_INPUT = 4096;
const MAX_SAT = 21e6 * 1e8;
// The node's sweeper refuses rates above 1000 sat/vB by default.
const MAX_FEE_RATE = 1000;

// Virtual sizes, for the fee of a sweep, where every confirmed coin is spent
// and the size is known before the node builds the transaction.
const INPUT_VBYTES = { p2wkh: 68, np2wkh: 91, p2tr: 57.5, unknown: 68 };
const OUTPUT_VBYTES = { p2wpkh: 31, p2wsh: 43, p2tr: 43, segwit: 43, p2sh: 32, p2pkh: 34 };
const TX_OVERHEAD_VBYTES = 10.5;
// The node's change output (P2TR).
const CHANGE_VBYTES = 43;
// The dust limit of the node's P2TR change at the relay floor; change below
// it goes to the fee.
const CHANGE_DUST_SAT = 330;
// The smallest amount worth sending to any address type.
const MIN_SEND_SAT = 546;
// gRPC codes after which a send may or may not have happened: the call was
// cut off, not answered.
const UNCERTAIN_GRPC_CODES = [1, 4, 14];

function bad(message) {
  return new ValidationError(message);
}

const num = (value) => {
  const n = Number(value === undefined || value === null ? 0 : String(value));
  return Number.isFinite(n) ? n : 0;
};

function toHex(bytes) {
  if (!bytes) {
    return "";
  }
  if (typeof bytes === "string") {
    return bytes;
  }
  if (Buffer.isBuffer(bytes)) {
    return bytes.toString("hex");
  }
  return Buffer.from(Object.values(bytes)).toString("hex");
}

// The gRPC detail behind an LndError, which says what actually went wrong.
function detailOf(error) {
  return String((error && error.error && error.error.details) || (error && error.message) || "");
}

function satAmount(value, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return allowZero ? 0 : null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SAT) {
    throw bad("The amount must be a whole number of sats");
  }
  if (n === 0 && !allowZero) {
    throw bad("The amount must be more than zero");
  }
  return n;
}

function feeRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > MAX_FEE_RATE) {
    throw bad("The fee rate must be between 1 and 1000 sat/vB");
  }
  return Math.ceil(n);
}

// BIP 21 amounts are decimal bitcoin; sats as an exact integer, or null.
function btcToSat(text) {
  if (!/^\d{1,8}(\.\d{1,8})?$/.test(String(text || ""))) {
    return null;
  }
  const [whole, frac = ""] = String(text).split(".");
  return Number(whole) * 1e8 + Number((frac + "00000000").slice(0, 8));
}

// BTC per kvB, as bitcoind reports rates, to sat/vB. Through whole sats per
// kvB first, so 0.00001 is 1 and not 1.0000000000000002.
function btcPerKvbToSatPerVb(value) {
  return Math.round(Number(value) * 1e8) / 1000;
}

const NOT_UPGRADED =
  "This request is from a Lightning node that has not upgraded to the BLAKE2b chain's rules, so it can't be paid from here.";

// Whether a decoded invoice sets option_blake2b (bit 512 or 513), which every
// invoice for this chain does. Unknown (no feature map) counts as set; the
// node checks again when paying.
function setsBlake2b(features) {
  if (!features || typeof features !== "object") {
    return true;
  }
  const bits = Object.keys(features).map(Number);
  if (!bits.length) {
    return true;
  }
  return bits.includes(512) || bits.includes(513);
}

// The same, for an invoice that must be for this chain (a request from the
// service that pays SHA256 invoices): unknown counts as not set.
function surelySetsBlake2b(features) {
  if (!features || typeof features !== "object") {
    return false;
  }
  const bits = Object.keys(features).map(Number);
  return bits.includes(512) || bits.includes(513);
}

// The capability a client declares to be shown SHA256 invoices as such
// (kind "bitcoin-invoice") rather than refused: a client that does not
// know the kind would take one for an ordinary invoice.
const BITCOIN_INVOICE_CAPABILITY = "bitcoin-invoice";

function capable(options, capability) {
  const list = options && options.capabilities;
  return Boolean(list && typeof list.includes === "function" && list.includes(capability));
}

// An invoice's amount in millisatoshis: num_msat where the node gives it,
// else whole sats.
function msatOf(res) {
  return num(res.numMsat) || num(res.numSatoshis) * 1000;
}

function refuse(code, message, status = 400) {
  const error = new ValidationError(message, status);
  error.refusal = code;
  return error;
}

// A send's failure as the phone should see it: a 400 with a sentence when the
// node said no, a 504 marked uncertain when the call was cut off and the
// money may have moved, so that the phone does not offer to try again as if
// nothing had happened.
// LND did not answer (down, starting, wallet locked): not the input's fault.
function unavailable(error) {
  const code = error && error.error && error.error.code;
  return code === 14 || code === 4 || /wallet locked|waiting to start|not yet ready|in the process of starting/i.test(detailOf(error));
}

// The answer to a repeat that cannot find out more yet: still uncertain,
// and asked again next time.
function stillUncertain() {
  const unknown = new ValidationError(
    "Your node can't say yet whether this went through. Check again in a little while, or look at your activity.",
    504
  );
  unknown.uncertain = true;
  unknown.recheck = true;
  return unknown;
}

function failure(error, message, { resume = false } = {}) {
  const code = error && error.error && error.error.code;
  const detail = detailOf(error);
  // Never got to LND: nothing was sent by this call. On a repeat, though,
  // the first call may have: the answer stays uncertain.
  if (code === 14 && /failed to connect|connect failed|ECONNREFUSED|no connection established|name resolution/i.test(detail)) {
    return resume ? stillUncertain() : new ValidationError("Your node is not answering. It may be starting up.", 503);
  }
  if (/payment is in transition|already in flight/i.test(detail)) {
    return stillUncertain();
  }
  const cutOff =
    UNCERTAIN_GRPC_CODES.includes(code) ||
    /no final payment status|stream removed|connection (reset|closed)|socket hang up|ECONNRESET|deadline/i.test(detail);
  if (cutOff) {
    const unknown = new ValidationError(
      "Your node did not say whether this went through. Check your activity before trying again.",
      504
    );
    unknown.uncertain = true;
    // Asking again re-checks rather than replaying this answer.
    unknown.recheck = true;
    return unknown;
  }
  return bad(message);
}

function unsupported(message) {
  return { kind: "unsupported", message };
}

function friendlyPayError(error) {
  const detail = detailOf(error).toLowerCase();
  const rules = [
    [/option_blake2b/, NOT_UPGRADED],
    // Paying an offer: getting an invoice from the node that made it.
    [/no invoice arrived in time/, "The offer's node did not answer in time. It may be offline or hard to reach; try again later."],
    [/issuer refused/, "The offer's node refused to give an invoice for this payment."],
    [/names no way to reach/, "This offer gives no way to reach the node that made it."],
    [/destination is unreachable/, "The offer's node cannot be reached right now. It may be offline; try again later."],
    [/below the offer's amount/, "That is less than this offer asks for."],
    [/offer has no amount/, "This offer has no amount. Enter how much to pay."],
    [/offer does not take a quantity|offer needs a quantity|above the offer's maximum/, "This offer's quantity does not fit this payment."],
    [/unsupported chain|names no chain|not a supported chain/, "This offer is for a different network."],
    [/self-payments not allowed|self payment/, "That request was made by this node."],
    [/invoice expired|expired/, "This request has expired."],
    [/already paid|invoice is already paid|payment.*already.*succeeded/, "This has already been paid."],
    [/already in flight|payment is in transition/, "This payment is already on its way."],
    [/insufficient balance|insufficient local balance|insufficient_balance/, "Not enough Lightning balance to send this."],
    [/no route|unable to find a path|no_route/, "No route to the recipient was found."],
    [/timed out|timeout/, "The payment timed out. It may still complete; check your activity before trying again."],
    [/not for current active network|different network|for this chain/, "This request is for a different network."],
    [/incorrect payment details|incorrect_payment_details/, "The recipient refused the payment details."],
  ];
  for (const [re, message] of rules) {
    if (re.test(detail)) {
      return message;
    }
  }
  const raw = String((error && error.error && error.error.details) || "");
  const base = (error && error.message) || "The payment failed";
  return raw && !base.includes(raw) ? `${base}: ${raw}` : base;
}

function friendlySendError(error) {
  const detail = detailOf(error).toLowerCase();
  if (/reserved wallet balance/.test(detail)) {
    return "That would leave less than your node keeps on-chain to close its channels safely. Send less.";
  }
  if (/insufficient funds/.test(detail)) {
    return "Not enough confirmed on-chain funds for this amount and fee.";
  }
  if (/dust/.test(detail)) {
    return "That amount is too small to send on-chain.";
  }
  if (/fee.*(too low|not met)|min relay fee|mempool min fee/.test(detail)) {
    return "That fee rate is below what the network accepts. Choose a higher one.";
  }
  if (/invalid address|decode address|unknown address|checksum/.test(detail)) {
    return "That address is not valid for this network.";
  }
  return (error && error.message) || "The transaction could not be sent.";
}

function createMobile({
  lnd,
  offers,
  mempool,
  bitcoind,
  bitcoinInvoices,
  network = () => process.env.LND_NETWORK || "mainnet",
  now = () => Math.floor(Date.now() / 1000),
  // How long a payment of a SHA256 invoice is waited for before the answer
  // is "on its way": the service holds the payment until it has paid.
  payWaitMs = 90 * 1000,
} = {}) {
  let ownPubkey = null;
  // Descriptions of paid invoices, by payment hash: a payment does not carry
  // its invoice's description, so it is read from the invoice once.
  const descriptions = new Map();

  async function describePayment(p) {
    const hash = p.paymentHash;
    if (descriptions.has(hash)) {
      return descriptions.get(hash);
    }
    let text = "";
    const request = String(p.paymentRequest || "");
    if (request.toLowerCase().startsWith("ln") && !request.toLowerCase().startsWith("lni")) {
      try {
        text = (await lnd().decodePaymentRequest(request)).description || "";
      } catch (error) {
        // Not remembered: a node that was briefly away is asked again.
        return "";
      }
    }
    if (descriptions.size > 2000) {
      descriptions.clear();
    }
    descriptions.set(hash, text);
    return text;
  }

  async function info() {
    const res = await lnd().getInfo();
    ownPubkey = res.identityPubkey;
    return res;
  }

  async function node() {
    const res = await info();
    return {
      alias: res.alias || "",
      pubkey: res.identityPubkey,
      color: res.color || "",
      version: res.version || "",
      network: network(),
      syncedToChain: Boolean(res.syncedToChain),
      syncedToGraph: Boolean(res.syncedToGraph),
      blockHeight: num(res.blockHeight),
      activeChannels: num(res.numActiveChannels),
      peers: num(res.numPeers),
    };
  }

  // The two balances the app shows, and what is on its way into each.
  async function wallet() {
    const [chain, channels, state] = await Promise.all([
      lnd().getWalletBalance(),
      lnd().getChannelBalance(),
      info(),
    ]);
    const local = channels.localBalance ? num(channels.localBalance.sat) : num(channels.balance);
    const remote = channels.remoteBalance ? num(channels.remoteBalance.sat) : 0;
    const pendingLocal = channels.pendingOpenLocalBalance
      ? num(channels.pendingOpenLocalBalance.sat)
      : num(channels.pendingOpenBalance);
    return {
      onchain: {
        confirmedSat: num(chain.confirmedBalance),
        unconfirmedSat: num(chain.unconfirmedBalance),
        lockedSat: num(chain.lockedBalance),
        reservedSat: num(chain.reservedBalanceAnchorChan),
      },
      lightning: {
        outboundSat: local,
        inboundSat: remote,
        pendingOutboundSat: pendingLocal,
      },
      syncedToChain: Boolean(state.syncedToChain),
      blockHeight: num(state.blockHeight),
      updatedAt: now(),
    };
  }

  // Low, medium and high fee rates in whole sat/vB: the Mempool app's
  // hour, half-hour and next-block rates when one is set up and answers,
  // the node's own estimates otherwise, never under the relay floor.
  async function fees() {
    let source = null;
    let rates = null;
    let warning = null;
    try {
      const res = await mempool().recommendedFees();
      if (res && res.fees) {
        source = { kind: "mempool", name: res.name || "Mempool" };
        rates = { low: res.fees.hourFee, medium: res.fees.halfHourFee, high: res.fees.fastestFee };
      }
    } catch (error) {
      warning = `${error.message || "The Mempool app did not answer"}; using the node's estimate.`;
    }
    if (!rates) {
      const targets = { low: 24, medium: 6, high: 2 };
      const estimates = {};
      for (const [key, blocks] of Object.entries(targets)) {
        try {
          const res = await bitcoind().estimateSmartFee(blocks);
          const result = res && (res.result || res);
          if (result && result.feerate > 0) {
            estimates[key] = btcPerKvbToSatPerVb(result.feerate);
          }
        } catch (error) {
          // A node that has not seen enough blocks has no estimate yet.
        }
      }
      if (Object.keys(estimates).length) {
        source = { kind: "node", name: "Bitcoin node" };
        rates = estimates;
      }
    }
    let floor = 1;
    try {
      const res = await bitcoind().getMempoolInfo();
      const mempoolMinFee = res && (res.result || res).mempoolminfee;
      if (mempoolMinFee > 0) {
        floor = Math.max(1, Math.ceil(btcPerKvbToSatPerVb(mempoolMinFee)));
      }
    } catch (error) {
      // Without the node's floor, 1 sat/vB stands.
    }
    if (!rates) {
      source = { kind: "minimum", name: "Relay minimum" };
      warning = warning || "No fee estimate is available yet; these are the lowest rates the network relays.";
      rates = {};
    }
    // Never above what a send accepts.
    const cap = (v) => Math.min(MAX_FEE_RATE, v);
    const low = cap(Math.max(floor, Math.ceil(num(rates.low) || floor)));
    const medium = cap(Math.max(low, Math.ceil(num(rates.medium) || low)));
    const high = cap(Math.max(medium, Math.ceil(num(rates.high) || medium + (rates.medium ? 0 : 1))));
    return {
      source,
      warning,
      minimumSatPerVbyte: floor,
      low: { satPerVbyte: low, label: "Low", eta: "About an hour" },
      medium: { satPerVbyte: medium, label: "Medium", eta: "About 30 minutes" },
      high: { satPerVbyte: high, label: "High", eta: "About 10 minutes" },
    };
  }

  async function decodeBolt11(request, options = {}) {
    let res;
    try {
      res = await lnd().decodePaymentRequest(request);
    } catch (error) {
      const detail = detailOf(error);
      if (unavailable(error)) {
        throw error;
      }
      if (/network/i.test(detail)) {
        throw bad("This invoice is for a different network.");
      }
      throw bad("This is not a valid Lightning invoice.");
    }
    if (!setsBlake2b(res.features)) {
      if (capable(options, BITCOIN_INVOICE_CAPABILITY)) {
        return bitcoinInvoiceTarget(request, res);
      }
      throw bad(NOT_UPGRADED);
    }
    const created = num(res.timestamp);
    const expiry = num(res.expiry) || DEFAULT_INVOICE_EXPIRY;
    const amountSat = num(res.numSatoshis);
    if (!ownPubkey) {
      await info().catch(() => {});
    }
    return {
      kind: "bolt11",
      request,
      amountSat: amountSat || null,
      amountEditable: !amountSat,
      description: res.description || "",
      destination: res.destination,
      paymentHash: res.paymentHash,
      createdAt: created,
      expiresAt: created + expiry,
      expired: created + expiry <= now(),
      ours: Boolean(ownPubkey && res.destination === ownPubkey),
    };
  }

  // A SHA256 invoice, for a client that can pay one through the service
  // the user configured: what it costs, or why it can't be paid now.
  async function bitcoinInvoiceTarget(request, res) {
    const created = num(res.timestamp);
    const expiresAt = created + (num(res.expiry) || DEFAULT_INVOICE_EXPIRY);
    const amountMsat = msatOf(res);
    const expired = expiresAt <= now();
    const paymentHash = String(res.paymentHash || "").toLowerCase();
    const described = await bitcoinInvoices().describe({ amountMsat, expired, paymentHash });
    return {
      kind: "bitcoin-invoice",
      request,
      amountSat: amountMsat ? Math.ceil(amountMsat / 1000) : null,
      amountEditable: false,
      description: res.description || "",
      destination: res.destination,
      paymentHash: res.paymentHash,
      createdAt: created,
      expiresAt,
      expired,
      ours: false,
      ...described,
      payable: !described.message,
    };
  }

  async function decodeOffer(text) {
    let res;
    try {
      res = await offers().decode(text);
    } catch (error) {
      if (unavailable(error)) {
        throw error;
      }
      throw bad("This is not a valid offer.");
    }
    if (!res.forThisChain) {
      throw bad("This offer is for a different network.");
    }
    if (res.type === "offer") {
      if (!res.valid) {
        throw bad(`This offer cannot be paid: ${res.validationError || "it is not valid"}.`);
      }
      const offer = res.offer || {};
      return {
        kind: "offer",
        request: text,
        amountSat: offer.anyAmount ? null : Math.ceil(offer.amountSat),
        amountEditable: Boolean(offer.anyAmount),
        description: offer.description || "",
        issuer: offer.issuer || "",
        expiresAt: offer.absoluteExpiry || null,
        expired: Boolean(offer.absoluteExpiry && offer.absoluteExpiry <= now()),
        ours: Boolean(res.ours),
      };
    }
    if (res.type === "invoice") {
      const invoice = res.invoice || {};
      const expiresAt = invoice.createdAt ? invoice.createdAt + (invoice.relativeExpiry || 7200) : null;
      return {
        kind: "bolt12-invoice",
        request: text,
        amountSat: Math.ceil(invoice.amountSat || 0) || null,
        amountEditable: false,
        description: (res.offer && res.offer.description) || "",
        issuer: (res.offer && res.offer.issuer) || "",
        paymentHash: invoice.paymentHash || "",
        expiresAt,
        expired: Boolean(expiresAt && expiresAt <= now()),
        ours: Boolean(res.ours),
      };
    }
    return unsupported("This is a request to be paid by an offer, not something to pay.");
  }

  function decodeAddress(text, extra = {}) {
    const parsed = parseAddress(text, network());
    if (!parsed) {
      return null;
    }
    if (parsed.type === "segwit") {
      throw bad("This address uses a newer kind of output your node can't send to yet.");
    }
    return {
      kind: "onchain",
      request: parsed.address,
      address: parsed.address,
      addressType: parsed.type,
      amountSat: extra.amountSat || null,
      amountEditable: !extra.amountSat,
      description: extra.message || extra.label || "",
      label: extra.label || "",
    };
  }

  async function decodeBip21(text, options = {}) {
    const rest = text.slice("bitcoin:".length);
    const q = rest.indexOf("?");
    let addressPart;
    try {
      addressPart = decodeURIComponent(q < 0 ? rest : rest.slice(0, q));
    } catch (error) {
      throw bad("This payment request is not valid.");
    }
    const params = new URLSearchParams(q < 0 ? "" : rest.slice(q + 1));
    const get = (name) => {
      for (const [k, v] of params) {
        if (k.toLowerCase() === name) {
          return v;
        }
      }
      return null;
    };
    for (const [k] of params) {
      if (k.toLowerCase().startsWith("req-") && !["req-pop"].includes(k.toLowerCase())) {
        throw bad("This payment request needs a feature this wallet does not support.");
      }
    }
    const amountText = get("amount");
    const amountSat = amountText === null ? null : btcToSat(amountText);
    if (amountText !== null && amountSat === null) {
      throw bad("The amount in this payment request is not valid.");
    }
    const onchain = addressPart
      ? decodeAddress(addressPart, { amountSat, label: get("label") || "", message: get("message") || "" })
      : null;
    if (addressPart && !onchain) {
      const other = otherNetwork(addressPart, network());
      throw bad(other ? `This address is for ${other}, not ${network()}.` : "The address in this payment request is not valid.");
    }
    // A unified request: pay over Lightning when it offers a way, with the
    // address kept as the alternative.
    let lightning = null;
    const offer = get("lno");
    const invoice = get("lightning");
    try {
      if (offer) {
        lightning = await decodeOffer(offer.trim());
      } else if (invoice) {
        lightning = await decodeBolt11(invoice.trim().replace(/^lightning:/i, "").toLowerCase(), options);
      }
    } catch (error) {
      if (!onchain) {
        throw error;
      }
      lightning = null;
    }
    // A SHA256 invoice's address is a Bitcoin address: coins of this chain
    // sent there would not reach the recipient as they expect. No fallback.
    if (lightning && lightning.kind === "bitcoin-invoice") {
      return lightning;
    }
    if (lightning && lightning.kind !== "unsupported" && !lightning.expired && !lightning.ours) {
      return { ...lightning, fallback: onchain };
    }
    if (onchain) {
      return onchain;
    }
    throw bad("This payment request has nothing this wallet can pay.");
  }

  // What the user pasted or scanned, and how it can be paid. Throws a
  // ValidationError, with a sentence for the user, for anything else.
  // `options.capabilities`: what the client can show beyond the kinds every
  // client knows (BITCOIN_INVOICE_CAPABILITY).
  async function decode(input, options = {}) {
    let text = String(input || "").trim();
    if (!text) {
      throw bad("Nothing to pay. Paste or scan an address, invoice or offer.");
    }
    if (text.length > MAX_INPUT) {
      throw bad("That is too long to be a payment request.");
    }
    const lower = text.toLowerCase();
    if (lower.startsWith("lightning:")) {
      text = text.slice("lightning:".length).trim();
      return decode(text, options);
    }
    if (lower.startsWith("bitcoin:")) {
      return decodeBip21(text, options);
    }
    const compact = text.replace(/\s+/g, "");
    const compactLower = compact.toLowerCase();
    if (compactLower.startsWith("lno1") || compactLower.startsWith("lni1")) {
      return decodeOffer(compact);
    }
    if (compactLower.startsWith("lnr1")) {
      return unsupported("This is a request to be paid by an offer, not something to pay.");
    }
    if (compactLower.startsWith("lnurl")) {
      return unsupported("LNURL is not supported yet. Ask for an invoice or an offer instead.");
    }
    if (/^[^@\s/]+@[^@\s/]+\.[a-z]{2,}$/i.test(text)) {
      return unsupported("Lightning addresses are not supported yet. Ask for an invoice or an offer instead.");
    }
    const address = decodeAddress(compact);
    if (address) {
      return address;
    }
    if (compactLower.startsWith("ln")) {
      return decodeBolt11(compactLower, options);
    }
    const other = otherNetwork(compact, network());
    if (other) {
      throw bad(`This address is for ${other}, not ${network()}.`);
    }
    throw bad("This is not an address, invoice or offer this wallet can pay.");
  }

  function checkedAddress(address) {
    const parsed = parseAddress(address, network());
    if (!parsed) {
      throw bad("That address is not valid for this network.");
    }
    return parsed;
  }

  function inputVbytes(utxo) {
    // By the script, which old and new nodes report alike.
    const script = String(utxo.pkScript || "");
    const key = script.startsWith("5120") ? "p2tr" : script.startsWith("a914") ? "np2wkh" : script.startsWith("0014") ? "p2wkh" : "unknown";
    return INPUT_VBYTES[key];
  }

  // The confirmed coins, the wallet's whole balance (unconfirmed coins
  // count toward the reserve check), and what the node keeps back for
  // anchor channels' fee bumps.
  async function spendable() {
    const [coins, balance] = await Promise.all([lnd().listUnspent(), lnd().getWalletBalance()]);
    const utxos = ((coins && coins.utxos) || coins || []).slice();
    utxos.sort((a, b) => num(b.amountSat) - num(a.amountSat));
    return {
      utxos,
      reserve: num(balance && balance.reservedBalanceAnchorChan),
      walletTotal: num(balance && balance.confirmedBalance) + num(balance && balance.unconfirmedBalance),
    };
  }

  function reserveRefusal(reserve, unit) {
    return bad(
      `That would leave less than the ${reserve} ${unit} your node keeps on-chain to close its channels safely. Send less.`
    );
  }

  // The size and fee of sending `amount` at `rate`, as the node builds it:
  // coins largest first until they cover the amount and a fee that assumes
  // a change output; change below dust goes to the fee. Then lnd's reserve
  // check: what stays in the wallet (every other coin, unconfirmed too, plus
  // the change) must cover the anchor reserve, or the send is refused.
  // Sized here rather than from the node's estimate, whose rate comes back
  // rounded down to whole sat/vB (1.9 reads as 1, nearly doubling the size).
  function planSend({ utxos, reserve, walletTotal }, amount, rate, destinationType) {
    let vbytes = TX_OVERHEAD_VBYTES + (OUTPUT_VBYTES[destinationType] || 43);
    let total = 0;
    for (const utxo of utxos) {
      vbytes += inputVbytes(utxo);
      total += num(utxo.amountSat);
      const withChange = Math.ceil((vbytes + CHANGE_VBYTES) * rate);
      const change = total - amount - withChange;
      if (change < 0) {
        continue;
      }
      const keptChange = change >= CHANGE_DUST_SAT ? change : 0;
      const feeSat = keptChange ? withChange : total - amount;
      if (reserve > 0 && walletTotal - total + keptChange < reserve) {
        throw reserveRefusal(reserve, "sats");
      }
      return { feeSat, vbytes: Math.ceil(vbytes + (keptChange ? CHANGE_VBYTES : 0)) };
    }
    throw bad("Not enough confirmed on-chain funds for this amount and fee.");
  }

  // {amountSat, feeSat, satPerVbyte, totalSat}: what a send would cost, and
  // for a sweep how much would arrive.
  async function estimateOnchain({ address, amountSat, sendAll, satPerVbyte }) {
    const parsed = checkedAddress(address);
    const rate = feeRate(satPerVbyte);
    const wallet = await spendable();
    const { utxos, reserve } = wallet;
    const totalSat = utxos.reduce((sum, u) => sum + num(u.amountSat), 0);
    if (sendAll) {
      if (!totalSat) {
        throw bad("There are no confirmed on-chain funds to send.");
      }
      let vbytes = TX_OVERHEAD_VBYTES + (OUTPUT_VBYTES[parsed.type] || 43);
      for (const utxo of utxos) {
        vbytes += inputVbytes(utxo);
      }
      // A sweep spends the confirmed coins. With anchor channels, lnd keeps
      // their reserve back as change only if what stays (the unconfirmed
      // coins) does not already cover it.
      const keepReserve = reserve > 0 && wallet.walletTotal - totalSat < reserve;
      if (keepReserve) {
        vbytes += CHANGE_VBYTES;
      }
      const feeSat = Math.ceil(vbytes * rate);
      const kept = keepReserve ? reserve : 0;
      const amount = totalSat - feeSat - kept;
      if (amount <= MIN_SEND_SAT) {
        throw bad("The fee would take the whole balance at this rate.");
      }
      return { amountSat: amount, feeSat, satPerVbyte: rate, totalSat: amount + feeSat, sendAll: true, reservedSat: kept };
    }
    const amount = satAmount(amountSat);
    if (amount < MIN_SEND_SAT) {
      throw bad(`That amount is too small to send on-chain (the least is ${MIN_SEND_SAT} sats).`);
    }
    const plan = planSend(wallet, amount, rate, parsed.type);
    return { amountSat: amount, feeSat: plan.feeSat, satPerVbyte: rate, totalSat: amount + plan.feeSat, sendAll: false };
  }

  // The label a send made for request id `requestId` carries, so that the
  // same request after a restart finds the transaction instead of making a
  // second one.
  const sendLabel = (requestId) => `lf-mobile:${requestId}`;

  // `resume`: the phone asks again about a send it sent before (a retry
  // after an uncertain answer, or a send the app was killed during). The
  // label then says whether it went out; if LND cannot be asked, the answer
  // stays uncertain rather than "not sent".
  async function sendOnchain({ address, amountSat, sendAll, satPerVbyte, requestId, resume = false }) {
    const parsed = checkedAddress(address);
    const rate = feeRate(satPerVbyte);
    const amount = sendAll ? 0 : satAmount(amountSat);
    if (requestId) {
      let txs;
      try {
        txs = await lnd().getOnChainTransactions();
      } catch (error) {
        if (resume) {
          throw stillUncertain();
        }
        throw error;
      }
      const sent = (txs || []).find((tx) => tx.label === sendLabel(requestId));
      if (sent) {
        return { txid: sent.txHash, satPerVbyte: rate };
      }
    }
    try {
      const res = await lnd().sendCoinsAtRate({
        address: parsed.address,
        amountSat: amount,
        satPerVbyte: rate,
        sendAll: Boolean(sendAll),
        label: requestId ? sendLabel(requestId) : "",
      });
      return { txid: res.txid, satPerVbyte: rate };
    } catch (error) {
      throw failure(error, friendlySendError(error), { resume });
    }
  }

  // Pays an invoice or an offer. An amount is needed only when the request
  // leaves it to the payer.
  // `recheck`: this is the same request asked about again after an uncertain
  // answer; an invoice found paid is then this payment's outcome. A fresh
  // request for an invoice already paid is refused as such.
  // `resume` (or `recheck`, the same after an uncertain answer in this
  // process): the phone asks again about a payment it sent before.
  // - BOLT 11 and BOLT 12 invoices: the payment is looked up by its hash
  //   first. Paid: that is the answer. In flight: still uncertain. Not
  //   found or failed: it never went through, and is paid now.
  // - Offers: their invoice, and so their hash, is fetched anew each time,
  //   so they are tracked in the send journal (`journal`) from before the
  //   payment starts; a resume answers from it, and never pays a second
  //   invoice. Started without an outcome: uncertain for good.
  async function payLightning({ request, amountSat, payerNote, recheck = false, resume = false, journal = null }) {
    const again = recheck || resume;
    let target;
    try {
      target = await decode(request);
    } catch (error) {
      if (again && !(error instanceof ValidationError)) {
        throw stillUncertain();
      }
      throw error;
    }
    if (target.kind === "unsupported") {
      throw bad(target.message);
    }
    if (target.kind === "onchain") {
      throw bad("This is an on-chain address; send it on-chain.");
    }
    if (again && target.kind !== "offer" && target.paymentHash) {
      let found;
      try {
        found = await lookPayment(target.paymentHash);
      } catch (error) {
        throw stillUncertain();
      }
      if (found && found.state === "succeeded") {
        return found.result;
      }
      if (found && found.state === "in_flight") {
        throw stillUncertain();
      }
    }
    if (again && target.kind === "offer" && journal) {
      const entry = journal.get();
      if (entry && entry.state === "done") {
        return entry.outcome;
      }
      if (entry) {
        const unknown = stillUncertain();
        // No way to learn more: asking again would only repeat this.
        unknown.recheck = false;
        throw unknown;
      }
    }
    if (target.expired) {
      throw bad("This request has expired.");
    }
    if (target.ours) {
      throw bad("That request was made by this node.");
    }
    const amount = target.amountEditable ? satAmount(amountSat) : null;
    if (target.amountEditable && !amount) {
      throw bad("Enter the amount to send.");
    }
    try {
      if (target.kind === "bolt11") {
        const res = await lnd().sendPayment(target.request, amount || undefined, amount || target.amountSat);
        return {
          status: "succeeded",
          paymentHash: res.paymentHash,
          preimage: res.paymentPreimage,
          amountSat: num(res.valueSat) || amount || target.amountSat,
          feeSat: num(res.feeSat),
        };
      }
      if (target.kind === "offer" && journal) {
        journal.start();
      }
      const res = await offers().pay({
        offer: target.kind === "offer" ? target.request : undefined,
        invoice: target.kind === "bolt12-invoice" ? target.request : undefined,
        amountSat: amount || undefined,
        payerNote: payerNote ? String(payerNote).slice(0, 500) : undefined,
      });
      const result = {
        status: "succeeded",
        paymentHash: res.paymentHash,
        preimage: res.paymentPreimage,
        amountSat: Math.round(res.amountSat),
        feeSat: Math.ceil(res.feeSat),
      };
      if (target.kind === "offer" && journal) {
        journal.finish(result);
      }
      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      const result = failure(error, friendlyPayError(error), { resume: again });
      if (target.kind === "offer") {
        if (result.uncertain) {
          // Never sent again: the journal says it started.
          result.recheck = false;
        } else if (journal) {
          // The node refused it: nothing was paid, and a new try may pay.
          journal.drop();
        }
      }
      throw result;
    }
  }

  // A payment by hash: {state: "succeeded", result} | {state: "in_flight"}
  // | {state: "failed"} | null when the node has none.
  async function lookPayment(paymentHash) {
    const res = await lnd().listRecentPayments(500);
    const p = ((res && res.payments) || []).find((x) => x.paymentHash === paymentHash);
    if (!p) {
      return null;
    }
    const status = String(p.status).toUpperCase();
    if (status === "SUCCEEDED") {
      return {
        state: "succeeded",
        result: {
          status: "succeeded",
          paymentHash: p.paymentHash,
          preimage: p.paymentPreimage,
          amountSat: num(p.valueSat),
          feeSat: num(p.feeSat),
        },
      };
    }
    return { state: status === "FAILED" ? "failed" : "in_flight" };
  }

  // Paying SHA256 invoices through the service (logic/bitcoinInvoices.js).
  //
  // The service's request carries the SHA256 invoice's payment hash, and
  // the node pays any one hash at most once (a hash in flight or paid is
  // refused), so however often this is asked, at most one payment can go
  // through. What is kept here is about not starting what need not be:
  // one attempt at a time per SHA256 invoice (`hashLocks`, `inFlight`),
  // and an attempt on disk, written before its payment starts, that a later
  // call resumes rather than asking the service again.
  const hashLocks = new Map();
  const inFlight = new Set();

  function withHashLock(hash, fn) {
    const run = (hashLocks.get(hash) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    hashLocks.set(hash, tail);
    tail.then(() => {
      if (hashLocks.get(hash) === tail) {
        hashLocks.delete(hash);
      }
    });
    return run;
  }

  function alreadyPaid() {
    return refuse("already_paid", "This invoice has already been paid.", 409);
  }

  // The answer while a payment is still held by the service, which keeps it
  // until it has paid the SHA256 invoice. Asking again finds out more.
  function onItsWay() {
    const waiting = new ValidationError(
      "Your payment is on its way and the SHA256 invoice is being paid. Check your activity in a little while.",
      504
    );
    waiting.uncertain = true;
    waiting.recheck = true;
    // Told apart from an uncertain answer: this one is known to be under way.
    waiting.refusal = "on_its_way";
    return waiting;
  }

  function friendlyBitcoinPayError(error) {
    if (/incorrect payment details|incorrect_payment_details/i.test(detailOf(error))) {
      return "The service could not pay the SHA256 invoice, and your payment came back. Nothing was paid.";
    }
    return friendlyPayError(error);
  }

  // A SHA256 invoice as this node reads it, for paying. Only one that is
  // not for this chain and names an amount.
  async function readBitcoinInvoice(request) {
    const text = String(request || "").trim().replace(/^lightning:/i, "").replace(/\s+/g, "").toLowerCase();
    if (!text.startsWith("ln") || text.length > MAX_INPUT) {
      throw bad("This is not a SHA256 invoice.");
    }
    let res;
    try {
      res = await lnd().decodePaymentRequest(text);
    } catch (error) {
      if (unavailable(error)) {
        throw error;
      }
      throw bad("This is not a valid Lightning invoice.");
    }
    if (setsBlake2b(res.features)) {
      throw refuse("not_bitcoin_invoice", "This invoice is for this chain. Pay it as an ordinary Lightning invoice.");
    }
    const amountMsat = msatOf(res);
    if (!amountMsat) {
      throw refuse("no_amount", NO_AMOUNT);
    }
    const created = num(res.timestamp);
    return {
      request: text,
      paymentHash: String(res.paymentHash || "").toLowerCase(),
      amountMsat,
      description: res.description || "",
      destination: res.destination,
      expiresAt: created + (num(res.expiry) || DEFAULT_INVOICE_EXPIRY),
    };
  }

  // The service's request as this node reads it. One it cannot read is
  // the service's fault, unless the node is not answering.
  async function readHold(request) {
    let res;
    try {
      res = await lnd().decodePaymentRequest(request);
    } catch (error) {
      if (unavailable(error)) {
        throw error;
      }
      throw refuse("invalid_hold_invoice", INVALID_HOLD);
    }
    const created = num(res.timestamp);
    return {
      request,
      paymentHash: String(res.paymentHash || "").toLowerCase(),
      destination: String(res.destination || "").toLowerCase(),
      blake2b: surelySetsBlake2b(res.features),
      amountMsat: msatOf(res),
      expiresAt: created + (num(res.expiry) || DEFAULT_INVOICE_EXPIRY),
    };
  }

  function bitcoinPaid(result, x) {
    return {
      ...result,
      bitcoinInvoice: {
        amountSat: Math.ceil(x.amountMsat / 1000),
        description: x.description || "",
        paymentHash: x.paymentHash,
      },
    };
  }

  // Pays a SHA256 invoice through the service, at no more than
  // `maxIncomingSat` (the ceiling the user was shown with the estimate).
  // `recheck`/`resume` as for payLightning: the caller asks again about a
  // payment it started before.
  //
  // In order: the node's own payment for the hash first (paid: that is the
  // answer to a repeat; in flight: uncertain); then the attempt on record,
  // with the service's view of it; only once the last attempt has ended
  // without paying is the service asked anew. Its request is paid only
  // after every check in bitcoinInvoices.checkHold passes.
  async function payBitcoinInvoice({ request, maxIncomingSat, recheck = false, resume = false }) {
    const again = recheck || resume;
    const max = satAmount(maxIncomingSat);
    if (!max) {
      throw bad("Say the most you agree to pay for this invoice.");
    }
    let x;
    try {
      x = await readBitcoinInvoice(request);
    } catch (error) {
      if (again && !(error instanceof ValidationError)) {
        throw stillUncertain();
      }
      throw error;
    }
    return withHashLock(x.paymentHash, () => payBitcoinLocked(x, max, again));
  }

  async function payBitcoinLocked(x, max, again) {
    const hash = x.paymentHash;
    const service = bitcoinInvoices();
    if (inFlight.has(hash)) {
      throw stillUncertain();
    }
    let found;
    try {
      found = await lookPayment(hash);
    } catch (error) {
      if (again) {
        throw stillUncertain();
      }
      throw error;
    }
    if (found && found.state === "succeeded") {
      if (service.lastAttempt(hash) && service.lastAttempt(hash).state !== "succeeded") {
        service.updateAttempt(hash, { state: "succeeded", outcome: found.result });
      }
      if (again) {
        return bitcoinPaid(found.result, x);
      }
      throw alreadyPaid();
    }
    if (found && found.state === "in_flight") {
      throw stillUncertain();
    }

    // The node has no payment for the hash in flight or paid.
    let last = service.lastAttempt(hash);
    if (last && last.state === "succeeded" && last.outcome) {
      // Paid, and older than the node's list of payments.
      if (again) {
        return bitcoinPaid(last.outcome, x);
      }
      throw alreadyPaid();
    }
    // What the service says about the last attempt, if there was one and
    // it can be asked (null: it could not).
    let theirs;
    if (last && service.service()) {
      try {
        theirs = await service.swapState(hash);
      } catch (error) {
        theirs = null;
      }
    }
    const ended = theirs && (ENDED_STATES.includes(theirs.state) || theirs.state === "not_found");
    const waiting = theirs && WAITING_STATES.includes(theirs.state);
    if (theirs && theirs.state === "settled") {
      throw alreadyPaid();
    }
    if (last && last.state === "paying") {
      if (found && found.state === "failed") {
        service.updateAttempt(hash, { state: "failed", endedAt: now() });
      } else if (ended) {
        // Written as starting, yet the node has no payment and the service
        // has given up: it never started.
        service.updateAttempt(hash, { state: "failed", endedAt: now() });
      } else if (!waiting) {
        // Written as starting, and the node has no payment for it. Either
        // the dashboard stopped before it began, or it is older than the
        // node's list of payments. Without the service's word, unknown.
        throw stillUncertain();
      }
    }
    // Asking again finds out what became of a payment; it never starts
    // another. One that came back is answered as such, and a new attempt
    // is the user's to make.
    if (again && last && service.lastAttempt(hash).state === "failed") {
      throw refuse(
        "returned",
        "The service could not pay the SHA256 invoice, and your payment came back. Nothing was paid; you can try again."
      );
    }
    if (x.expiresAt <= now()) {
      throw bad("This request has expired.");
    }
    if (!service.service()) {
      throw refuse("no_service", NO_SERVICE);
    }

    // The service's last request, while it is still waiting to be paid and
    // has time left; else a new one, once the last attempt has ended.
    last = service.lastAttempt(hash);
    let quoted = null;
    if (
      last &&
      last.holdInvoice &&
      !last.invalid &&
      last.state !== "succeeded" &&
      last.expiresAt - now() >= MIN_HOLD_SECONDS &&
      (waiting || theirs === null)
    ) {
      quoted = { holdInvoice: last.holdInvoice, expiresAt: last.expiresAt, hash: last.hash || "" };
    } else if (last && theirs && !ended && !waiting) {
      throw refuse(
        "in_progress",
        "The service has not finished with the last attempt to pay this invoice. Try again in a few minutes.",
        409
      );
    }
    if (!quoted) {
      await service.referenceRate();
      try {
        quoted = await service.quote(x.request);
      } catch (error) {
        if (error.refusal === "already_paid") {
          const mine = await lookPayment(hash).catch(() => null);
          if (again && mine && mine.state === "succeeded") {
            return bitcoinPaid(mine.result, x);
          }
          throw alreadyPaid();
        }
        if (error.refusal === "in_progress" && last && last.expiresAt > now()) {
          const seconds = Math.max(1, last.expiresAt - now());
          throw refuse(
            "in_progress",
            `The service is still holding its last price for this invoice. Try again in ${seconds} seconds.`,
            409
          );
        }
        throw error;
      }
      service.addAttempt(x, {
        state: "quoted",
        holdInvoice: quoted.holdInvoice,
        expiresAt: quoted.expiresAt,
        hash: quoted.hash,
        quotedIncomingMsat: quoted.incomingMsat,
        quotedOutgoingMsat: quoted.outgoingMsat,
        rate: quoted.rate,
        spread: quoted.spread,
      });
    }

    let y;
    try {
      y = await readHold(quoted.holdInvoice);
      await service.checkHold({ x, y, quoted, maxIncomingSat: max });
    } catch (error) {
      if (error.refusal) {
        service.updateAttempt(hash, {
          state: "refused",
          reason: error.refusal,
          invalid: error.refusal === "invalid_hold_invoice",
        });
      }
      throw error;
    }

    const amountSat = Math.ceil(y.amountMsat / 1000);
    service.updateAttempt(hash, { state: "paying", amountMsat: y.amountMsat, maxIncomingSat: max, startedAt: now() });
    inFlight.add(hash);
    const payment = Promise.resolve()
      .then(() => lnd().sendPayment(y.request, undefined, amountSat, routingFeeLimit(amountSat)))
      .then(
        (res) => {
          const result = {
            status: "succeeded",
            paymentHash: res.paymentHash || hash,
            preimage: res.paymentPreimage,
            amountSat: num(res.valueSat) || amountSat,
            feeSat: num(res.feeSat),
          };
          // Paid whatever happens to the record: a disk that will not
          // take it must not turn the payment into an error. A repeat
          // finds it in the node's own payments.
          try {
            service.updateAttempt(hash, { state: "succeeded", outcome: result });
          } catch (error) {
            console.warn(`[bitcoin invoices] paid ${hash}, but could not record it: ${error.message}`);
          }
          return result;
        },
        (error) => {
          if (/already paid|already succeeded/i.test(detailOf(error))) {
            // The node paid this hash before, by a payment its list no
            // longer shows.
            throw alreadyPaid();
          }
          const result = failure(error, friendlyBitcoinPayError(error), { resume: again });
          if (!result.uncertain) {
            // The node's payment came back: nothing was paid, and a new
            // attempt may be made once the service has ended this one.
            service.updateAttempt(hash, { state: "failed", endedAt: now(), reason: result.message });
            result.refusal = "returned";
          }
          throw result;
        }
      )
      .finally(() => inFlight.delete(hash));

    let timer;
    const WAITED = {};
    const waited = new Promise((resolve) => {
      timer = setTimeout(resolve, payWaitMs, WAITED);
    });
    const outcome = await Promise.race([payment.then((result) => ({ result }), (error) => ({ error })), waited]);
    clearTimeout(timer);
    if (outcome === WAITED) {
      // Still held. The payment goes on, and its outcome is recorded when
      // it comes; asking again finds it.
      payment.catch(() => {});
      throw onItsWay();
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return bitcoinPaid(outcome.result, x);
  }

  // An address to receive on-chain. The last unused one unless `fresh`.
  async function receiveAddress({ fresh } = {}) {
    const res = await lnd().newAddress(fresh ? 0 : 2);
    return { address: res.address, type: "p2wpkh", uri: `bitcoin:${res.address}` };
  }

  async function createInvoice({ amountSat, memo, expirySeconds }) {
    const amount = satAmount(amountSat, { allowZero: true });
    const expiry = expirySeconds === undefined ? DEFAULT_INVOICE_EXPIRY : Number(expirySeconds);
    if (!Number.isInteger(expiry) || expiry < 60 || expiry > MAX_INVOICE_EXPIRY) {
      throw bad("The expiry must be between a minute and a week");
    }
    const text = clip(memo);
    const res = await lnd().addInvoiceWithExpiry(amount, text, expiry);
    const created = now();
    return {
      paymentRequest: res.paymentRequest,
      paymentHash: toHex(res.rHash),
      amountSat: amount || null,
      memo: text,
      createdAt: created,
      expiresAt: created + expiry,
      uri: `lightning:${res.paymentRequest}`,
    };
  }

  async function invoiceStatus(paymentHash) {
    if (!/^[0-9a-f]{64}$/.test(String(paymentHash || ""))) {
      throw bad("Not a payment hash");
    }
    let res;
    try {
      res = await lnd().lookupInvoice(paymentHash);
    } catch (error) {
      if (/unable to locate|not found/i.test(detailOf(error))) {
        const missing = bad("No such invoice");
        missing.statusCode = 404;
        throw missing;
      }
      throw error;
    }
    const created = num(res.creationDate);
    const expiresAt = created + (num(res.expiry) || DEFAULT_INVOICE_EXPIRY);
    let state = String(res.state || (res.settled ? "SETTLED" : "OPEN")).toLowerCase();
    if (state === "open" && expiresAt <= now()) {
      state = "expired";
    }
    return {
      paymentHash,
      state,
      amountSat: num(res.value) || null,
      amountPaidSat: num(res.amtPaidSat),
      settledAt: num(res.settleDate) || null,
      expiresAt,
    };
  }

  async function createOffer({ description, amountSat }) {
    const text = clip(String(description || "").trim());
    const amount = satAmount(amountSat, { allowZero: true });
    if (amount && !text) {
      throw bad("An offer with an amount needs a description");
    }
    const res = await offers().createOffer({ description: text, amountSat: amount || 0 });
    const offer = res.offer || res;
    return {
      offer: offer.bolt12,
      offerId: offer.offerId,
      amountSat: amount || null,
      description: text,
      uri: `bitcoin:?lno=${offer.bolt12}`,
    };
  }

  // The SHA256 invoice a payment paid through the service, by the
  // attempts on record: {amountSat, description}, or null.
  function bitcoinInvoiceOf(p) {
    let record = null;
    try {
      record = bitcoinInvoices().record(p.paymentHash);
    } catch (error) {
      return null;
    }
    if (!record) {
      return null;
    }
    const request = String(p.paymentRequest || "").toLowerCase();
    const paid = record.attempts.some(
      (a) => a.holdInvoice && (request ? String(a.holdInvoice).toLowerCase() === request : ["paying", "failed", "succeeded"].includes(a.state))
    );
    if (!paid) {
      return null;
    }
    return { amountSat: Math.ceil(num(record.amountMsat) / 1000), description: record.description || "" };
  }

  // The latest on-chain transactions, Lightning payments and settled
  // invoices, newest first.
  async function activity({ limit = 30 } = {}) {
    const max = Math.max(1, Math.min(100, Number(limit) || 30));
    const settled = await Promise.allSettled([
      lnd().getOnChainTransactions(),
      lnd().listRecentPayments(max),
      lnd().getInvoices(),
    ]);
    // If LND answered none of them, that is an error, not an empty history.
    if (settled.every((r) => r.status === "rejected")) {
      throw settled[0].reason;
    }
    const value = (i, fallback) => (settled[i].status === "fulfilled" ? settled[i].value : fallback);
    const txs = value(0, []);
    const payments = value(1, { payments: [] });
    const invoices = value(2, { invoices: [] });
    // Descriptions, a few at a time. A payment that paid a SHA256 invoice
    // is described by that invoice, not by the service's request.
    const paymentList = (payments && payments.payments) || [];
    const linked = new Map();
    for (const p of paymentList) {
      const link = bitcoinInvoiceOf(p);
      if (link) {
        linked.set(p.paymentHash, link);
      }
    }
    const descriptionsByHash = new Map();
    const toDescribe = paymentList.filter((p) => !linked.has(p.paymentHash));
    for (let i = 0; i < toDescribe.length; i += 8) {
      const chunk = toDescribe.slice(i, i + 8);
      const texts = await Promise.all(chunk.map((p) => describePayment(p)));
      chunk.forEach((p, k) => descriptionsByHash.set(p.paymentHash, texts[k]));
    }
    const items = [];
    for (const tx of txs || []) {
      const amount = num(tx.amount);
      const fee = num(tx.totalFees);
      const out = amount < 0;
      const label = String(tx.label || "");
      items.push({
        id: `tx:${tx.txHash}`,
        kind: "onchain",
        direction: out ? "out" : "in",
        amountSat: out ? Math.max(0, -amount - fee) : amount,
        feeSat: out ? fee : 0,
        timestamp: num(tx.timeStamp),
        status: num(tx.numConfirmations) > 0 ? "confirmed" : "pending",
        confirmations: num(tx.numConfirmations),
        description: /openchannel/.test(label) ? "Channel opened" : /closechannel|sweep/.test(label) ? "Channel closed" : "",
        reference: tx.txHash,
      });
    }
    for (const p of (payments && payments.payments) || []) {
      const status = String(p.status || "").toUpperCase();
      const link = linked.get(p.paymentHash);
      const item = {
        id: `pay:${p.paymentHash}`,
        kind: "lightning",
        direction: "out",
        amountSat: num(p.valueSat),
        feeSat: num(p.feeSat),
        timestamp: num(p.creationDate) || Math.floor(num(p.creationTimeNs) / 1e9),
        status: status === "SUCCEEDED" ? "complete" : status === "FAILED" ? "failed" : "pending",
        description: link ? link.description : descriptionsByHash.get(p.paymentHash) || "",
        reference: p.paymentHash,
      };
      if (link) {
        // What it cost here is amountSat and feeSat; what it paid there,
        // and the preimage that proves it.
        item.bitcoinInvoice = {
          amountSat: link.amountSat,
          description: link.description,
          state: status === "SUCCEEDED" ? "paid" : status === "FAILED" ? "returned" : "pending",
        };
        if (status === "SUCCEEDED" && p.paymentPreimage) {
          item.preimage = p.paymentPreimage;
        }
      }
      items.push(item);
    }
    for (const inv of (invoices && invoices.invoices) || []) {
      const state = String(inv.state || "");
      if (state !== "SETTLED" && !inv.settled) {
        continue;
      }
      items.push({
        id: `inv:${toHex(inv.rHash)}`,
        kind: "lightning",
        direction: "in",
        amountSat: num(inv.amtPaidSat),
        feeSat: 0,
        timestamp: num(inv.settleDate) || num(inv.creationDate),
        status: "complete",
        description: inv.memo || "",
        reference: toHex(inv.rHash),
      });
    }
    items.sort((a, b) => b.timestamp - a.timestamp);
    return { items: items.slice(0, max) };
  }

  return {
    node,
    wallet,
    fees,
    decode,
    estimateOnchain,
    sendOnchain,
    payLightning,
    payBitcoinInvoice,
    receiveAddress,
    createInvoice,
    invoiceStatus,
    createOffer,
    activity,
  };
}

module.exports = {
  createMobile,
  BITCOIN_INVOICE_CAPABILITY,
  clip,
  btcToSat,
  friendlyPayError,
  friendlySendError,
  ...createMobile({
    lnd: () => require("services/lnd.js"),
    offers: () => require("logic/offers.js"),
    mempool: () => require("logic/mempool.js"),
    bitcoind: () => require("services/bitcoind.js"),
    bitcoinInvoices: () => require("logic/bitcoinInvoices.js").instance(),
  }),
};
