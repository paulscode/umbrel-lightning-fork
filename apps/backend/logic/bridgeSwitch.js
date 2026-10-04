// Turning the bridge on and off from the dashboard, on Umbrel: the dashboard
// owns umbrel-lnd.conf there, as it does for Advanced Settings, and restarts
// Lightning Fork to apply it. (On StartOS the package owns lnd.conf and the
// Bridge action is the switch.)
//
// On means the bridge pays SHA256 invoices through the SHA256 node this app
// runs for it, which reads a node on the SHA256 chain: Knots (SHA256)
// Companion from the same app store, found by exports.sh and handed over as
// BRIDGE_SHA256_BACKEND. Without one there is nothing for that node to read,
// so the switch says what to install instead.
//
// Off stops the bridge taking payments and nothing else. The SHA256 node
// keeps running: it may hold channels, and a node that is not watching its
// channels can be cheated out of them.
const { ValidationError } = require("../models/errors.js");

const RESTART_REFUSED = "Lightning Fork is almost ready, please wait a few seconds and try again.";

function createBridgeSwitch({
  platform,
  sha256Backend,          // the SHA256 chain node's name, or "" when none
  readSettings,           // settings.json: {lnd, bridge}
  writeLndConfig,         // (lnd, bridge) -> writes umbrel-lnd.conf and settings.json
  defaultLnd,
  stopDaemon,
  unfinished = async () => null,   // payments not finished, or null if unknown
  lfEnabled = async () => null,    // whether Lightning Fork's bridge is on, or null
  now = () => Date.now(),
}) {
  const umbrel = platform !== "startos";

  async function bridgeSettings() {
    const settings = (await readSettings()) || {};
    return settings.bridge || {};
  }

  async function info() {
    if (!umbrel) {
      return null;
    }
    const bridge = await bridgeSettings();
    return {
      on: bridge.enabled === true,
      available: !!sha256Backend,
      unavailable: sha256Backend
        ? ""
        : "The bridge's SHA256 node reads a full node on the SHA256 chain, and none is installed. Install Knots (SHA256) Companion from the PaulsCode.Com app store and let it sync, then restart Lightning Fork (so it finds it) and turn the bridge on here.",
      backend: sha256Backend || "",
    };
  }

  async function set(enabled) {
    if (!umbrel) {
      throw new ValidationError("On StartOS, turn the bridge on and off with the Bridge action.", 409);
    }
    if (typeof enabled !== "boolean") {
      throw new ValidationError("Say whether the bridge should be on.", 400);
    }
    if (enabled && !sha256Backend) {
      throw new ValidationError((await info()).unavailable, 409);
    }

    // Its journal finishes each payment only while the bridge runs: cut
    // off after paying the SHA256 invoice and before claiming the payer's
    // payment, it would cost the operator what the bridge already paid.
    if (!enabled) {
      const open = await unfinished();
      if (open > 0) {
        throw new ValidationError(`${open} ${open === 1 ? "payment" : "payments"} through the bridge ${open === 1 ? "is" : "are"} not finished. Turn the bridge off once none is in progress or needs you.`, 409);
      }
    }

    const settings = (await readSettings()) || {};
    const lnd = settings.lnd && Object.keys(settings.lnd).length > 0 ? settings.lnd : defaultLnd;
    const before = settings.bridge || {};
    // Already so, and Lightning Fork agrees: nothing to do. When it does not
    // (the config was written but never applied), apply it again.
    if ((before.enabled === true) === enabled && (await lfEnabled()) === enabled) {
      return { on: enabled, restarting: false };
    }

    await writeLndConfig(lnd, { ...before, enabled, changedAt: new Date(now()).toISOString() });
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
    return { on: enabled, restarting: true };
  }

  return { info, set };
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
  singleton = createBridgeSwitch({
    platform: constants.IS_STARTOS ? "startos" : "umbrel",
    sha256Backend: process.env.BRIDGE_SHA256_BACKEND || "",
    readSettings: async () => (await diskService.fileExists(constants.JSON_SETTINGS_FILE))
      ? diskService.readJsonFile(constants.JSON_SETTINGS_FILE)
      : {},
    writeLndConfig: configLogic.writeLndConfig,
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

module.exports = { createBridgeSwitch, instance };
