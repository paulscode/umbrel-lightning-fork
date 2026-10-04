// Turning the bridge on and off from the dashboard, on Umbrel: the dashboard
// owns umbrel-lnd.conf there, as it does for Advanced Settings, and restarts
// Lightning Fork to apply it. (On StartOS the package owns lnd.conf and the
// Bridge action is the switch.)
//
// On means the bridge pays SHA256 invoices through the SHA256 node this app
// runs for it, which reads a node on the SHA256 chain: whichever installed
// node is on that chain (logic/sha256Nodes.js), written into that node's
// config file before Lightning Fork restarts. Without one there is nothing for
// it to read, so the switch says what to install, or what is in the way.
//
// Off stops the bridge taking payments and nothing else. The SHA256 node
// keeps running: it may hold channels, and a node that is not watching its
// channels can be cheated out of them.
const { ValidationError } = require("../models/errors.js");
const { confFor } = require("./sha256Nodes.js");

const RESTART_REFUSED = "Lightning Fork is almost ready, please wait a few seconds and try again.";
const RESTART_APP = "restart the Lightning Fork app (on the Umbrel home screen, right-click its icon, then Restart) so it finds it";
const NONE_INSTALLED = `The bridge's SHA256 node reads a full node on the SHA256 chain, and none is installed. Install Knots (SHA256) Companion from the PaulsCode.Com app store and let it sync, then ${RESTART_APP}, and turn the bridge on here.`;

// Why no installed node can be used, in a sentence.
function unavailableSentence(list) {
  if (!list.length) {
    return NONE_INSTALLED;
  }
  const why = list.map((n) => `${n.name}: ${n.detail}`).join("; ");
  let todo = `Install Knots (SHA256) Companion from the PaulsCode.Com app store and let it sync, then ${RESTART_APP}.`;
  if (list.some((n) => n.state === "behind")) {
    todo = "Wait for it to sync, then try again.";
  } else if (list.some((n) => n.state === "unreachable")) {
    todo = "Check that it is running, then try again; or install Knots (SHA256) Companion.";
  } else if (list.some((n) => n.id === "bitcoin-knots" && n.state === "blake2b")) {
    todo += " Or, if Bitcoin Knots should be your node on the SHA256 chain, pick a version for that chain in its own settings.";
  }
  return `No installed node on the SHA256 chain can be used right now (${why}). ${todo}`;
}

function createBridgeSwitch({
  platform,
  sha256Nodes = null,     // logic/sha256Nodes.js, or null where there are none
  readSettings,           // settings.json: {lnd, bridge}
  writeLndConfig,         // (lnd, bridge) -> writes umbrel-lnd.conf and settings.json
  writeSha256Conf = async () => {}, // the SHA256 node's config file
  readSha256Conf = async () => null,
  removeSha256Conf = async () => {},
  defaultLnd,
  stopDaemon,
  unfinished = async () => null,   // payments not finished, or null if unknown
  lfEnabled = async () => null,    // whether Lightning Fork's bridge is on, or null
  now = () => Date.now(),
}) {
  const umbrel = platform !== "startos";

  // set and reconcile both write the SHA256 node's config: one at a time,
  // so a reconcile between set's writing the new node and saving the choice
  // cannot put the old one back.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function bridgeSettings() {
    const settings = (await readSettings()) || {};
    return settings.bridge || {};
  }

  async function survey(fresh = false) {
    return sha256Nodes ? sha256Nodes.survey({ fresh }) : [];
  }

  // Keep the SHA256 node reading what was chosen, as it is now. A node whose
  // credentials changed (reinstalled, or restored elsewhere) is written
  // again. One that has left the SHA256 chain (Bitcoin Knots switched to a
  // BLAKE2b version in its own settings, say) is not read at all: its config
  // is removed, which stops the SHA256 node, rather than let it follow the
  // wrong chain with live channels. Returns what is wrong, or "".
  async function reconcile(list = null) {
    return serial(() => reconcileNow(list));
  }

  async function reconcileNow(list) {
    if (!umbrel || !sha256Nodes) {
      return { text: "", blocks: false };
    }
    const bridge = await bridgeSettings();
    if (!bridge.sha256Node) {
      return { text: "", blocks: false };
    }
    // Off, the SHA256 node goes on running on what it was given (it may
    // hold channels), so what it reads is kept right then too; but with
    // no config there is nothing running to keep.
    if (bridge.enabled !== true && (await readSha256Conf()) === null) {
      return { text: "", blocks: false };
    }
    const seen = (list || (await survey())).find((n) => n.id === bridge.sha256Node);
    const node = sha256Nodes.byId(bridge.sha256Node);
    if (!seen || !node) {
      // Uninstalled: nothing to read; stop the node rather than let it
      // retry a node that is gone.
      if ((await readSha256Conf()) !== null) {
        await removeSha256Conf();
      }
      return { text: `The node the bridge's node read is no longer installed, so the bridge's node is stopped. ${bridge.enabled === true ? "Choose another below, or reinstall it." : "Reinstall it, or choose another when you turn the bridge on."}`, blocks: true };
    }
    if (seen.state === "sha256") {
      const want = confFor(node);
      if ((await readSha256Conf()) !== want) {
        await writeSha256Conf(want);
      }
      return { text: "", blocks: false };
    }
    if (["blake2b", "other-chain", "other-network", "lightning-fork"].includes(seen.state)) {
      if ((await readSha256Conf()) !== null) {
        await removeSha256Conf();
      }
      return { text: `${seen.name} is ${seen.detail} now, so the bridge's node has been stopped rather than follow it. Choose a node on the SHA256 chain, or put ${seen.name} back on it.`, blocks: true };
    }
    // Behind or not answering: nothing to change, only to say.
    return { text: `${seen.name}: ${seen.detail}.`, blocks: false };
  }

  async function info() {
    if (!umbrel) {
      return null;
    }
    const bridge = await bridgeSettings();
    const list = await survey();
    const problem = await reconcile(list).catch((error) => ({ text: `Could not check the bridge's node: ${error.message}`, blocks: false }));
    const chosen = sha256Nodes ? sha256Nodes.pick(list, bridge.sha256Node) : null;
    return {
      on: bridge.enabled === true,
      toBLAKE2b: bridge.toBLAKE2b === true,
      nodes: list.map((n) => ({ id: n.id, name: n.name, state: n.state, detail: n.detail })),
      // The node in use while on; the one that would be used otherwise.
      chosen: chosen ? chosen.id : null,
      inUse: bridge.enabled === true ? bridge.sha256Node || null : null,
      problem: problem.text,
      problemBlocks: problem.blocks,
      available: !!chosen,
      unavailable: chosen ? "" : unavailableSentence(list),
      backend: chosen ? chosen.name : "",
      pricing: pricingOf(bridge.pricing),
    };
  }

  // The node to turn on with: the one asked for, else the one picked. It must
  // be on the SHA256 chain now, asked afresh rather than from the cache.
  async function nodeFor(nodeId, saved) {
    const list = await survey(true);
    const want = nodeId
      ? list.find((n) => n.id === nodeId)
      : sha256Nodes && sha256Nodes.pick(list, saved);
    if (!want) {
      throw new ValidationError(nodeId ? "That node is not installed." : unavailableSentence(list), 409);
    }
    if (want.state !== "sha256") {
      throw new ValidationError(`${want.name} cannot be the bridge's node on the SHA256 chain: ${want.detail}.`, 409);
    }
    return sha256Nodes.byId(want.id);
  }

  async function set(enabled, nodeId = null) {
    return serial(() => setNow(enabled, nodeId));
  }

  async function setNow(enabled, nodeId) {
    if (!umbrel) {
      throw new ValidationError("On StartOS, turn the bridge on and off with the Bridge action.", 409);
    }
    if (typeof enabled !== "boolean") {
      throw new ValidationError("Say whether the bridge should be on.", 400);
    }
    if (nodeId !== null && typeof nodeId !== "string") {
      throw new ValidationError("Name the node by its id.", 400);
    }

    const settingsNow = (await readSettings()) || {};
    const current = settingsNow.bridge || {};
    const changingNode = enabled && current.enabled === true && !!nodeId && nodeId !== current.sha256Node;

    // Its journal finishes each payment only while the bridge runs: cut
    // off after paying the SHA256 invoice and before claiming the payer's
    // payment, it would cost the operator what the bridge already paid.
    // Moving it to another node restarts the SHA256 node, which lnd
    // survives, but is held to the same rule.
    if (!enabled || changingNode) {
      const open = await unfinished();
      if (open > 0) {
        throw new ValidationError(`${open} ${open === 1 ? "payment" : "payments"} through the bridge ${open === 1 ? "is" : "are"} not finished. ${enabled ? "Change its node" : "Turn the bridge off"} once none is in progress or needs you.`, 409);
      }
    }

    const settings = (await readSettings()) || {};
    const lnd = settings.lnd && Object.keys(settings.lnd).length > 0 ? settings.lnd : defaultLnd;
    const before = settings.bridge || {};
    const next = { ...before, enabled, changedAt: new Date(now()).toISOString() };

    if (enabled) {
      const node = await nodeFor(nodeId, before.sha256Node);
      try {
        await writeSha256Conf(confFor(node));
      } catch (error) {
        throw new ValidationError(`Could not write the bridge node's settings: ${error.message}`, 500);
      }
      next.sha256Node = node.id;
    }

    // Already so, and Lightning Fork agrees: Lightning Fork has nothing new
    // to read. A different node only restarts the SHA256 node, which watches
    // its config file. When Lightning Fork does not agree (written but
    // never applied), apply it again.
    if ((before.enabled === true) === enabled && (await lfEnabled()) === enabled) {
      if (enabled && next.sha256Node !== before.sha256Node) {
        await writeLndConfig(lnd, next);
        return { on: true, restarting: false, node: next.sha256Node };
      }
      return { on: enabled, restarting: false, node: next.sha256Node || null };
    }

    await applyAndRestart(lnd, next, before);
    return { on: enabled, restarting: true, node: next.sha256Node || null };
  }

  // Writes both files and restarts Lightning Fork to read them.
  async function applyAndRestart(lnd, next, before) {
    await writeLndConfig(lnd, next);
    try {
      await stopDaemon();
    } catch (error) {
      const details = String((error && error.error && error.error.details) || (error && error.message) || "");
      if (/wallet locked|not yet ready|in the process of starting/.test(details)) {
        // It is there and will not restart yet: not applied, so put both
        // files back and let the operator try again.
        await writeLndConfig(lnd, before);
        throw new ValidationError(RESTART_REFUSED, 503);
      }
      // Not answering at all: down, or failing to start. Its restart
      // policy starts it again with what was just written, which is how a
      // bridge that keeps it from starting is turned off from here.
    }
  }

  // Whether the bridge also pays BLAKE2b invoices for BTC (SHA256): payers
  // on the SHA256 chain pay the bridge's node, and Lightning Fork pays their
  // invoice from its own channels. Saved while off, for when it is on;
  // applied at once, with a restart, while on.
  async function setDirections(toBLAKE2b) {
    return serial(() => setDirectionsNow(toBLAKE2b));
  }

  async function setDirectionsNow(toBLAKE2b) {
    if (!umbrel) {
      throw new ValidationError("On StartOS, choose the directions with the Bridge action.", 409);
    }
    if (typeof toBLAKE2b !== "boolean") {
      throw new ValidationError("Say whether the bridge should pay BLAKE2b invoices.", 400);
    }
    const settings = (await readSettings()) || {};
    const lnd = settings.lnd && Object.keys(settings.lnd).length > 0 ? settings.lnd : defaultLnd;
    const before = settings.bridge || {};
    if ((before.toBLAKE2b === true) === toBLAKE2b) {
      return { toBLAKE2b, restarting: false };
    }
    // As for turning the whole bridge off: Lightning Fork would finish
    // such a payment all the same, but this is the rule the operator knows.
    if (!toBLAKE2b && before.enabled === true) {
      const open = await unfinished();
      if (open > 0) {
        throw new ValidationError(`${open} ${open === 1 ? "payment" : "payments"} through the bridge ${open === 1 ? "is" : "are"} not finished. Stop paying BLAKE2b invoices once none is in progress or needs you.`, 409);
      }
    }
    const next = { ...before, toBLAKE2b };
    if (before.enabled !== true) {
      await writeLndConfig(lnd, next);
      return { toBLAKE2b, restarting: false };
    }
    await applyAndRestart(lnd, next, before);
    return { toBLAKE2b, restarting: true };
  }

  // Where the rate comes from and the fees: {rateSource: "neoxa"|"fixed",
  // fee, feeToSHA256, feeToBLAKE2b}, fees as fractions, the per-direction
  // ones null for the fee. Saved while off; applied at once, with a
  // restart, while on.
  async function setPricing(pricing) {
    return serial(() => setPricingNow(pricing));
  }

  async function setPricingNow(pricing) {
    if (!umbrel) {
      throw new ValidationError("On StartOS, set the rate source and fees with the Bridge action.", 409);
    }
    const next = validPricing(pricing);
    const settings = (await readSettings()) || {};
    const lnd = settings.lnd && Object.keys(settings.lnd).length > 0 ? settings.lnd : defaultLnd;
    const before = settings.bridge || {};
    const same = JSON.stringify(pricingOf(before.pricing)) === JSON.stringify(next);
    if (same && before.pricing) {
      return { pricing: next, restarting: false };
    }
    const bridge = { ...before, pricing: next };
    if (before.enabled !== true) {
      await writeLndConfig(lnd, bridge);
      return { pricing: next, restarting: false };
    }
    await applyAndRestart(lnd, bridge, before);
    return { pricing: next, restarting: true };
  }

  return { info, set, setDirections, setPricing, reconcile };
}

// Lightning Fork's own defaults, which the Pricing setting starts from.
const DEFAULT_PRICING = { rateSource: "neoxa", fee: 0.015, feeToSHA256: null, feeToBLAKE2b: null };

// The routing budget a fee must clear, and the most it may be (Lightning
// Fork's limits, lnrpc/bridgerpc/config_active.go).
const ROUTING_BUDGET = 0.003;
const MAX_FEE = 0.2;

// A saved pricing, with the defaults for whatever it does not say.
function pricingOf(saved) {
  const p = saved && typeof saved === "object" ? saved : {};
  return {
    rateSource: p.rateSource === "fixed" ? "fixed" : "neoxa",
    fee: typeof p.fee === "number" && p.fee > 0 ? p.fee : DEFAULT_PRICING.fee,
    feeToSHA256: typeof p.feeToSHA256 === "number" && p.feeToSHA256 > 0 ? p.feeToSHA256 : null,
    feeToBLAKE2b: typeof p.feeToBLAKE2b === "number" && p.feeToBLAKE2b > 0 ? p.feeToBLAKE2b : null,
  };
}

// What the form sent, checked: a fee Lightning Fork would refuse keeps it from
// starting.
function validPricing(pricing) {
  if (!pricing || typeof pricing !== "object") {
    throw new ValidationError("Send the rate source and fees.", 400);
  }
  if (pricing.rateSource !== "neoxa" && pricing.rateSource !== "fixed") {
    throw new ValidationError("The rate comes from the market (neoxa) or your own rate (fixed).", 400);
  }
  const fee = (value, name, required) => {
    if (value === null || value === undefined || value === "") {
      if (required) {
        throw new ValidationError(`Enter the ${name}.`, 400);
      }
      return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= ROUTING_BUDGET || n >= MAX_FEE) {
      throw new ValidationError(`The ${name} must be over ${ROUTING_BUDGET * 100}% (the routing budget) and under ${MAX_FEE * 100}%.`, 400);
    }
    return Number(n.toFixed(6));
  };
  return {
    rateSource: pricing.rateSource,
    fee: fee(pricing.fee, "fee", true),
    feeToSHA256: fee(pricing.feeToSHA256, "fee for paying SHA256 invoices", false),
    feeToBLAKE2b: fee(pricing.feeToBLAKE2b, "fee for paying BLAKE2b invoices", false),
  };
}

// The SHA256 node's config file, written whole and readable only by the
// user lnd runs as there (it holds an RPC password).
function sha256ConfWriter(file, uid) {
  const fs = require("fs");
  const path = require("path");
  return async (text) => {
    if (!file) {
      throw new Error("this app has no place for it");
    }
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.promises.writeFile(tmp, text, { mode: 0o600, flag: "wx" });
    if (process.getuid && process.getuid() === 0 && Number.isInteger(uid)) {
      await fs.promises.chown(tmp, uid, uid);
    }
    await fs.promises.rename(tmp, file);
  };
}

function sha256ConfReader(file) {
  const fs = require("fs");
  return async () => {
    try {
      return await fs.promises.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };
}

let singleton = null;
function instance() {
  if (singleton) {
    return singleton;
  }
  const constants = require("../utils/const.js");
  const diskService = require("../services/disk");
  const configLogic = require("./config.js");
  const lightning = require("./lightning.js");
  const { createSha256Nodes, parseNodes } = require("./sha256Nodes.js");
  const nodes = parseNodes(process.env.BRIDGE_SHA256_NODES);
  singleton = createBridgeSwitch({
    platform: constants.IS_STARTOS ? "startos" : "umbrel",
    sha256Nodes: createSha256Nodes({ nodes, lfHost: process.env.BITCOIN_HOST || "" }),
    readSettings: async () => (await diskService.fileExists(constants.JSON_SETTINGS_FILE))
      ? diskService.readJsonFile(constants.JSON_SETTINGS_FILE)
      : {},
    writeLndConfig: configLogic.writeLndConfig,
    writeSha256Conf: sha256ConfWriter(process.env.BRIDGE_SHA256_CONF, Number(process.env.BRIDGE_SHA256_CONF_UID || 1000)),
    readSha256Conf: process.env.BRIDGE_SHA256_CONF ? sha256ConfReader(process.env.BRIDGE_SHA256_CONF) : async () => null,
    removeSha256Conf: async () => require("fs").promises.rm(process.env.BRIDGE_SHA256_CONF, { force: true }),
    defaultLnd: require("../utils/defaultConfig.js"),
    stopDaemon: lightning.stopDaemon,
    unfinished: () => require("./bridgeOperator.js").instance().unfinished(),
    lfEnabled: async () => {
      try {
        return (await require("./bridgeOperator.js").instance().status()).enabled;
      } catch (_) {
        return null;
      }
    },
  });
  return singleton;
}

module.exports = { createBridgeSwitch, instance, unavailableSentence, sha256ConfWriter, sha256ConfReader, pricingOf, validPricing };
