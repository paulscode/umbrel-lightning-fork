// Shared wording and numbers for paying Bitcoin invoices: the settings
// screen and the Lightning wallet's send screen show them the same way.

const BASE = () => `${process.env.VUE_APP_API_BASE_URL}/v1/bitcoin-invoices`;

export function bitcoinInvoicesUrl(path = "") {
  return `${BASE()}${path}`;
}

// The dashboard says this whenever it explains what the feature is.
export const BITCOIN_INVOICES_EXPLAINED =
  "Pay invoices from Bitcoin's Lightning network. A service pays them for you; you pay it on this chain, and your payment only completes if the Bitcoin invoice is paid.";

// A fraction as a percentage, e.g. 0.0525 -> "5.25%".
export function percent(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) {
    return "";
  }
  return `${(Math.round(n * 10000) / 100).toLocaleString(undefined, {
    maximumFractionDigits: 2
  })}%`;
}

export function sats(n) {
  return `${Number(n).toLocaleString()} ${Number(n) === 1 ? "sat" : "sats"}`;
}

// A rate is Bitcoin paid out per BTCB2 paid in.
export function rateText(rate) {
  const r = Number(rate);
  if (!(r > 0)) {
    return "";
  }
  return `1 BTCB2 = ${r.toLocaleString(undefined, {
    maximumSignificantDigits: 6
  })} BTC`;
}

// The same rate the other way round, which is easier to picture.
export function costPerBitcoinSat(rate) {
  const r = Number(rate);
  if (!(r > 0)) {
    return "";
  }
  return `1 Bitcoin sat costs about ${(1 / r).toLocaleString(undefined, {
    maximumFractionDigits: 2
  })} BTCB2 sats`;
}

// How far a price is from the market rate, in words.
export function marketComparison(reference) {
  if (!reference || !Number.isFinite(Number(reference.premium))) {
    return "";
  }
  const p = Number(reference.premium);
  const allowed = percent(reference.premiumAllowed);
  if (Math.abs(p) < 0.0005) {
    return `At the market rate (up to ${allowed} above it is allowed)`;
  }
  return p > 0
    ? `${percent(p)} above the market rate (up to ${allowed} is allowed)`
    : `${percent(-p)} below the market rate`;
}

export function shortKey(key) {
  const k = String(key || "");
  return k.length > 20 ? `${k.slice(0, 10)}…${k.slice(-10)}` : k;
}

// An id for one attempt at a payment, so that asking again after a lost
// answer finds that payment rather than starting another.
export function newRequestId() {
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `web-${Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Whether an invoice LND decoded is from a node without the BLAKE2b
// chain's rules (feature bit 512/513), which in practice makes it a
// Bitcoin invoice. Without any features it is not judged.
export function looksLikeBitcoinInvoice(decoded) {
  const features = decoded && decoded.features;
  if (!features || typeof features !== "object") {
    return false;
  }
  const bits = Object.keys(features).map(Number);
  if (!bits.length) {
    return false;
  }
  return !bits.includes(512) && !bits.includes(513);
}
