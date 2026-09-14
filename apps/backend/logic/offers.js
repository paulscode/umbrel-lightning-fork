// BOLT 12 offers: what the dashboard shows and does with them. Amounts cross
// the HTTP API in satoshis, as everywhere else in this dashboard, and the
// node in millisatoshis; ids and hashes are hex over HTTP and bytes at the
// node.
const lndService = require("services/lnd.js");

const MSAT_PER_SAT = 1000;

function toHex(byteObject) {
  if (!byteObject) {
    return "";
  }
  if (Buffer.isBuffer(byteObject)) {
    return byteObject.toString("hex");
  }
  if (typeof byteObject === "string") {
    return byteObject;
  }
  return Object.values(byteObject)
    .map((byte) => ("00" + (byte & 0xff).toString(16)).slice(-2)) // eslint-disable-line no-magic-numbers
    .join("");
}

function msatToSat(msat) {
  return Number(msat || 0) / MSAT_PER_SAT;
}

function satToMsat(sat) {
  return Math.round(Number(sat || 0) * MSAT_PER_SAT);
}

// The shape the dashboard uses for an offer, from the node's.
function presentOffer(offer) {
  if (!offer) {
    return null;
  }
  return {
    offerId: toHex(offer.offerId),
    bolt12: offer.bolt12,
    description: offer.description,
    amountSat: msatToSat(offer.amountMsat),
    anyAmount: Number(offer.amountMsat || 0) === 0,
    absoluteExpiry: Number(offer.absoluteExpiry || 0),
    createdAt: Number(offer.createdAt || 0),
    active: Boolean(offer.active),
    invoicesIssued: Number(offer.invoicesIssued || 0),
    label: offer.label,
    issuerId: toHex(offer.issuerId),
    numPaths: Number(offer.numPaths || 0),
    chains: (offer.chains || []).map(toHex),
    issuer: offer.issuer,
    quantityMax: Number(offer.quantityMax || 0),
    quantityAny: Boolean(offer.quantityAny),
  };
}

function presentInvoiceInfo(invoice) {
  if (!invoice) {
    return null;
  }
  return {
    paymentHash: toHex(invoice.paymentHash),
    amountSat: msatToSat(invoice.amountMsat),
    nodeId: toHex(invoice.nodeId),
    createdAt: Number(invoice.createdAt || 0),
    relativeExpiry: Number(invoice.relativeExpiry || 0),
    numPaths: Number(invoice.numPaths || 0),
    payerId: toHex(invoice.payerId),
    signatureValid: Boolean(invoice.signatureValid),
  };
}

async function createOffer({ description, amountSat, absoluteExpiry, label, quantityAny }) {
  const res = await lndService.createOffer({
    description,
    amountMsat: satToMsat(amountSat),
    absoluteExpiry,
    label,
    quantityAny,
  });
  return { offer: presentOffer(res.offer), created: Boolean(res.created) };
}

async function listOffers(activeOnly) {
  const res = await lndService.listOffers(activeOnly);
  return (res.offers || []).map(presentOffer);
}

async function disableOffer(offerId) {
  await lndService.disableOffer(offerId);
}

async function enableOffer(offerId) {
  await lndService.enableOffer(offerId);
}

// Decode any BOLT 12 string. The dashboard uses this to tell what the user
// pasted and to show it before paying.
async function decode(bolt12) {
  const res = await lndService.decodeBolt12(bolt12);
  return {
    type: res.type,
    forThisChain: Boolean(res.forThisChain),
    valid: Boolean(res.valid),
    validationError: res.validationError || "",
    ours: Boolean(res.ours),
    offerId: toHex(res.offerId),
    offer: presentOffer(res.offer),
    invoiceRequest: res.invoiceRequest
      ? {
          payerId: toHex(res.invoiceRequest.payerId),
          amountSat: msatToSat(res.invoiceRequest.amountMsat),
          quantity: Number(res.invoiceRequest.quantity || 0),
          payerNote: res.invoiceRequest.payerNote,
        }
      : null,
    invoice: presentInvoiceInfo(res.invoice),
  };
}

async function fetchInvoice({ offer, amountSat, quantity, payerNote, timeoutSeconds }) {
  const res = await lndService.fetchOfferInvoice({
    offer,
    amountMsat: satToMsat(amountSat),
    quantity,
    payerNote,
    timeoutSeconds,
  });
  return {
    bolt12: res.bolt12,
    invoice: presentInvoiceInfo(res.invoice),
    offerId: toHex(res.offerId),
  };
}

async function pay({ offer, invoice, amountSat, quantity, payerNote, timeoutSeconds }) {
  const res = await lndService.payOffer({
    offer,
    invoice,
    amountMsat: satToMsat(amountSat),
    quantity,
    payerNote,
    timeoutSeconds,
  });
  return {
    bolt12: res.bolt12,
    paymentHash: toHex(res.paymentHash),
    paymentPreimage: toHex(res.paymentPreimage),
    amountSat: msatToSat(res.amountMsat),
    feeSat: msatToSat(res.feeMsat),
  };
}

async function listInvoices(offerId) {
  const res = await lndService.listOfferInvoices(offerId);
  return (res.invoices || []).map((inv) => ({
    paymentHash: toHex(inv.paymentHash),
    offerId: toHex(inv.offerId),
    payerId: toHex(inv.payerId),
    amountSat: msatToSat(inv.amountMsat),
    quantity: Number(inv.quantity || 0),
    createdAt: Number(inv.createdAt || 0),
    bolt12: inv.bolt12,
    state: inv.state,
    amountPaidSat: msatToSat(inv.amountPaidMsat),
  }));
}

module.exports = {
  createOffer,
  listOffers,
  disableOffer,
  enableOffer,
  decode,
  fetchInvoice,
  pay,
  listInvoices,
};
