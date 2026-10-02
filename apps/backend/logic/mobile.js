// What the companion app does with the node: balances, telling what the user
// pasted or scanned, sending on-chain and over Lightning, receiving, and a
// short history. Amounts are whole satoshis, times Unix seconds.
//
// The services are passed in so the tests can run without node_modules;
// the default instance at the bottom loads the real ones lazily.
const { ValidationError } = require("../models/errors.js");
const { parseAddress, otherNetwork } = require("../utils/bitcoinAddress.js");

const DEFAULT_INVOICE_EXPIRY = 3600;
const MAX_INVOICE_EXPIRY = 7 * 24 * 3600;
const MAX_MEMO = 640;
const MAX_INPUT = 4096;
const MAX_SAT = 21e6 * 1e8;
const MAX_FEE_RATE = 10000;

// Virtual sizes, for the fee of a sweep, where every confirmed coin is spent
// and the size is known before the node builds the transaction.
const INPUT_VBYTES = { p2wkh: 68, np2wkh: 91, p2tr: 57.5, unknown: 68 };
const OUTPUT_VBYTES = { p2wpkh: 31, p2wsh: 43, p2tr: 43, segwit: 43, p2sh: 32, p2pkh: 34 };
const TX_OVERHEAD_VBYTES = 10.5;
// The node's change output (P2TR).
const CHANGE_VBYTES = 43;
const DUST_SAT = 546;
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
    throw bad("The fee rate must be between 1 and 10000 sat/vB");
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

// A send's failure as the phone should see it: a 400 with a sentence when the
// node said no, a 504 marked uncertain when the call was cut off and the
// money may have moved, so that the phone does not offer to try again as if
// nothing had happened.
function failure(error, message) {
  const code = error && error.error && error.error.code;
  const detail = detailOf(error);
  const cutOff =
    UNCERTAIN_GRPC_CODES.includes(code) ||
    /no final payment status|stream removed|connection (reset|closed)|socket hang up|ECONNRESET|deadline/i.test(detail);
  if (cutOff) {
    const unknown = new ValidationError(
      "Your node did not say whether this went through. Check your activity before trying again.",
      504
    );
    unknown.uncertain = true;
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
  network = () => process.env.LND_NETWORK || "mainnet",
  now = () => Math.floor(Date.now() / 1000),
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
        text = "";
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
    const low = Math.max(floor, Math.ceil(num(rates.low) || floor));
    const medium = Math.max(low, Math.ceil(num(rates.medium) || low));
    const high = Math.max(medium, Math.ceil(num(rates.high) || medium + (rates.medium ? 0 : 1)));
    return {
      source,
      warning,
      minimumSatPerVbyte: floor,
      low: { satPerVbyte: low, label: "Low", eta: "About an hour" },
      medium: { satPerVbyte: medium, label: "Medium", eta: "About 30 minutes" },
      high: { satPerVbyte: high, label: "High", eta: "About 10 minutes" },
    };
  }

  async function decodeBolt11(request) {
    let res;
    try {
      res = await lnd().decodePaymentRequest(request);
    } catch (error) {
      const detail = detailOf(error);
      if (/network/i.test(detail)) {
        throw bad("This invoice is for a different network.");
      }
      throw bad("This is not a valid Lightning invoice.");
    }
    if (!setsBlake2b(res.features)) {
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

  async function decodeOffer(text) {
    let res;
    try {
      res = await offers().decode(text);
    } catch (error) {
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

  async function decodeBip21(text) {
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
        lightning = await decodeBolt11(invoice.trim().replace(/^lightning:/i, "").toLowerCase());
      }
    } catch (error) {
      if (!onchain) {
        throw error;
      }
      lightning = null;
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
  async function decode(input) {
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
      return decode(text);
    }
    if (lower.startsWith("bitcoin:")) {
      return decodeBip21(text);
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
      return decodeBolt11(compactLower);
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

  // The confirmed coins and what the node keeps back for anchor channels'
  // fee bumps, which no send may spend.
  async function spendable() {
    const [coins, balance] = await Promise.all([lnd().listUnspent(), lnd().getWalletBalance()]);
    const utxos = ((coins && coins.utxos) || coins || []).slice();
    utxos.sort((a, b) => num(b.amountSat) - num(a.amountSat));
    return { utxos, reserve: num(balance && balance.reservedBalanceAnchorChan) };
  }

  // The size and fee of sending `amount` at `rate`, choosing coins largest
  // first as the node does, with a change output when one is worth having.
  // Sized here rather than from the node's estimate, whose rate comes back
  // rounded down to whole sat/vB (1.9 reads as 1, nearly doubling the size).
  function planSend(utxos, reserve, amount, rate, destinationType) {
    const base = TX_OVERHEAD_VBYTES + (OUTPUT_VBYTES[destinationType] || 43);
    let vbytes = base;
    let total = 0;
    for (const utxo of utxos) {
      vbytes += inputVbytes(utxo);
      total += num(utxo.amountSat);
      const withChange = Math.ceil((vbytes + CHANGE_VBYTES) * rate);
      const change = total - amount - withChange;
      if (change >= Math.max(DUST_SAT, reserve)) {
        return { feeSat: withChange, vbytes: Math.ceil(vbytes + CHANGE_VBYTES) };
      }
      const noChange = total - amount;
      if (reserve === 0 && noChange >= Math.ceil(vbytes * rate)) {
        // The remainder is too small to keep and goes to the fee.
        return { feeSat: noChange, vbytes: Math.ceil(vbytes) };
      }
    }
    throw bad("Not enough confirmed on-chain funds for this amount and fee.");
  }

  // {amountSat, feeSat, satPerVbyte, totalSat}: what a send would cost, and
  // for a sweep how much would arrive.
  async function estimateOnchain({ address, amountSat, sendAll, satPerVbyte }) {
    const parsed = checkedAddress(address);
    const rate = feeRate(satPerVbyte);
    const { utxos, reserve } = await spendable();
    const totalSat = utxos.reduce((sum, u) => sum + num(u.amountSat), 0);
    if (sendAll) {
      if (!totalSat) {
        throw bad("There are no confirmed on-chain funds to send.");
      }
      let vbytes = TX_OVERHEAD_VBYTES + (OUTPUT_VBYTES[parsed.type] || 43);
      for (const utxo of utxos) {
        vbytes += inputVbytes(utxo);
      }
      // With anchor channels the node keeps their reserve back as change.
      if (reserve > 0) {
        vbytes += CHANGE_VBYTES;
      }
      const feeSat = Math.ceil(vbytes * rate);
      const amount = totalSat - feeSat - reserve;
      if (amount <= DUST_SAT) {
        throw bad("The fee would take the whole balance at this rate.");
      }
      return { amountSat: amount, feeSat, satPerVbyte: rate, totalSat: amount + feeSat, sendAll: true, reservedSat: reserve };
    }
    const amount = satAmount(amountSat);
    const plan = planSend(utxos, reserve, amount, rate, parsed.type);
    return { amountSat: amount, feeSat: plan.feeSat, satPerVbyte: rate, totalSat: amount + plan.feeSat, sendAll: false };
  }

  // The label a send made for request id `requestId` carries, so that the
  // same request after a restart finds the transaction instead of making a
  // second one.
  const sendLabel = (requestId) => `lf-mobile:${requestId}`;

  async function sendOnchain({ address, amountSat, sendAll, satPerVbyte, requestId }) {
    const parsed = checkedAddress(address);
    const rate = feeRate(satPerVbyte);
    const amount = sendAll ? 0 : satAmount(amountSat);
    if (requestId) {
      const txs = await lnd().getOnChainTransactions();
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
      throw failure(error, friendlySendError(error));
    }
  }

  // Pays an invoice or an offer. An amount is needed only when the request
  // leaves it to the payer.
  async function payLightning({ request, amountSat, payerNote }) {
    const target = await decode(request);
    if (target.kind === "unsupported") {
      throw bad(target.message);
    }
    if (target.kind === "onchain") {
      throw bad("This is an on-chain address; send it on-chain.");
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
      const res = await offers().pay({
        offer: target.kind === "offer" ? target.request : undefined,
        invoice: target.kind === "bolt12-invoice" ? target.request : undefined,
        amountSat: amount || undefined,
        payerNote: payerNote ? String(payerNote).slice(0, 500) : undefined,
      });
      return {
        status: "succeeded",
        paymentHash: res.paymentHash,
        preimage: res.paymentPreimage,
        amountSat: Math.round(res.amountSat),
        feeSat: Math.ceil(res.feeSat),
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw failure(error, friendlyPayError(error));
    }
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
    const text = String(memo || "").slice(0, MAX_MEMO);
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
    const text = String(description || "").trim().slice(0, MAX_MEMO);
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

  // The latest on-chain transactions, Lightning payments and settled
  // invoices, newest first.
  async function activity({ limit = 30 } = {}) {
    const max = Math.max(1, Math.min(100, Number(limit) || 30));
    const [txs, payments, invoices] = await Promise.all([
      lnd().getOnChainTransactions().catch(() => []),
      lnd().listRecentPayments(max).catch(() => ({ payments: [] })),
      lnd().getInvoices().catch(() => ({ invoices: [] })),
    ]);
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
      const description = await describePayment(p);
      items.push({
        id: `pay:${p.paymentHash}`,
        kind: "lightning",
        direction: "out",
        amountSat: num(p.valueSat),
        feeSat: num(p.feeSat),
        timestamp: num(p.creationDate) || Math.floor(num(p.creationTimeNs) / 1e9),
        status: status === "SUCCEEDED" ? "complete" : status === "FAILED" ? "failed" : "pending",
        description,
        reference: p.paymentHash,
      });
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
    receiveAddress,
    createInvoice,
    invoiceStatus,
    createOffer,
    activity,
  };
}

module.exports = {
  createMobile,
  btcToSat,
  friendlyPayError,
  friendlySendError,
  ...createMobile({
    lnd: () => require("services/lnd.js"),
    offers: () => require("logic/offers.js"),
    mempool: () => require("logic/mempool.js"),
    bitcoind: () => require("services/bitcoind.js"),
  }),
};
