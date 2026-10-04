// Wording and numbers for running a bridge: the operator's Bridge window.
// What it is for a payer lives in bitcoin-invoices.js.

const BASE = () => `${process.env.VUE_APP_API_BASE_URL}/v1/bridge`;

export function bridgeUrl(path = "") {
  return `${BASE()}${path}`;
}

// What a direction does, from the payer's side.
export const DIRECTION_NAMES = {
  toSHA256: "Paying SHA256 invoices for BTCB2",
  toBLAKE2b: "Paying BLAKE2b invoices for BTC (SHA256)"
};

export function directionName(name) {
  return DIRECTION_NAMES[name] || name;
}

// The steps of getting a bridge going, as the backend reports them
// (logic/bridgeOperator.js checklist): their titles and what each is for.
export const STEPS = {
  node: {
    title: "Your SHA256 Lightning node",
    hint:
      "Lightning Fork runs it for the bridge, created from your existing recovery phrase. There is nothing new to write down."
  },
  fund: {
    title: "Fund it on the SHA256 chain",
    hint:
      "Send coins on the SHA256 chain to the node's deposit address. They pay for its channel."
  },
  channel: {
    title: "Open a channel from it",
    hint:
      "The bridge pays SHA256 invoices out of this channel. Open it to a well-connected node on the SHA256 chain."
  },
  rate: {
    title: "Set your rate",
    hint:
      "How much BTC (SHA256) one BTCB2 buys through your bridge. It has to be renewed before it expires."
  },
  participants: {
    title: "Invite participants",
    hint:
      "Give a bridge code to each person whose node should pay through your bridge."
  },
  serving: {
    title: "Serving",
    hint: ""
  }
};

// A node's state as a short phrase, and how it should look.
export const NODE_STATES = {
  starting: { text: "Starting", variant: "warning" },
  creating_wallet: { text: "Creating its wallet", variant: "warning" },
  syncing: { text: "Catching up with its chain", variant: "warning" },
  ready: { text: "Ready", variant: "success" },
  locked: { text: "Locked", variant: "danger" },
  unreachable: { text: "Not answering", variant: "danger" },
  not_ours: { text: "Not the bridge's node", variant: "danger" },
  error: { text: "Needs attention", variant: "danger" }
};

export function nodeState(state) {
  return NODE_STATES[state] || { text: state || "Unknown", variant: "muted" };
}

// "3 hours" from a number of seconds, for "set 3 hours ago".
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s < 90) {
    return unit(s, "second");
  }
  if (s < 90 * 60) {
    return unit(Math.round(s / 60), "minute");
  }
  if (s < 36 * 3600) {
    return unit(Math.round(s / 3600), "hour");
  }
  return unit(Math.round(s / 86400), "day");
}

// The age of the rate in words, with how it should look.
export function rateAge(overview) {
  if (!overview || overview.rateState === "unset") {
    return { text: "Not set yet", variant: "warning" };
  }
  const now = overview.now;
  const parts = [];
  if (overview.rateSetAt) {
    parts.push(`set ${duration(now - overview.rateSetAt)} ago`);
  }
  if (overview.rateState === "expired") {
    parts.push("expired; the bridge refuses quotes until it is renewed");
    return { text: capitalise(parts.join(", ")), variant: "danger" };
  }
  if (overview.rateExpiresAt) {
    parts.push(`expires in ${duration(overview.rateExpiresAt - now)}`);
  }
  return {
    text: capitalise(parts.join(", ")),
    variant: overview.rateState === "ageing" ? "warning" : "muted"
  };
}

// How the rate compares with the market, from the payer's side: a higher
// rate gives them more BTC (SHA256) for each BTCB2.
export function marketDifference(difference) {
  const d = Number(difference);
  if (difference === null || !Number.isFinite(d)) {
    return "";
  }
  if (Math.abs(d) < 0.0005) {
    return "At the market rate";
  }
  const pct = `${(Math.abs(d) * 100).toLocaleString(undefined, {
    maximumFractionDigits: 2
  })}%`;
  return d > 0
    ? `${pct} above the market: payers get more than the market gives`
    : `${pct} below the market`;
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// A node on the SHA256 chain, as the switch found it (logic/sha256Nodes.js).
export const SHA256_NODE_STATES = {
  sha256: { text: "On the SHA256 chain", variant: "success" },
  blake2b: { text: "On the BLAKE2b chain", variant: "muted" },
  "lightning-fork": {
    text: "Lightning Fork reads it, on the BLAKE2b chain",
    variant: "muted"
  },
  behind: { text: "Still syncing", variant: "warning" },
  "other-network": { text: "Not on mainnet", variant: "muted" },
  "other-chain": { text: "On neither chain", variant: "warning" },
  unreachable: { text: "Not answering", variant: "warning" }
};

export function sha256NodeState(state) {
  return SHA256_NODE_STATES[state] || { text: state, variant: "muted" };
}

// Where a link to the SHA256 chain goes, from the overview's sha256Explorer:
// the Mempool app on that chain (its onion when the page is opened over Tor,
// its address, or its port on this host), or the public explorer.
export function sha256ExplorerBase(explorer) {
  if (!explorer) {
    return "https://mempool.space";
  }
  if (window.location.origin.endsWith(".onion") && explorer.hiddenService) {
    return `http://${explorer.hiddenService}`;
  }
  if (explorer.url) {
    return explorer.url.replace(/\/+$/, "");
  }
  if (explorer.port) {
    return `${window.location.protocol}//${window.location.hostname}:${explorer.port}`;
  }
  return "https://mempool.space";
}
