require("module-alias/register");
require("module-alias").addPath(".");
require("dotenv").config({ path: require("find-config")(".env") });

const express = require("express");
const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const bodyParser = require("body-parser");

const lightningLogic = require("logic/lightning");

const constants = require("utils/const.js");
const startChannelBackupMonitor = require("utils/channel-backup-monitor");

// Keep requestCorrelationId middleware as the first middleware. Otherwise we risk losing logs.
const requestCorrelationMiddleware = require("middlewares/requestCorrelationId.js"); // eslint-disable-line id-length
const camelCaseReqMiddleware = require("middlewares/camelCaseRequest.js")
  .camelCaseRequest;
const errorHandleMiddleware = require("middlewares/errorHandling.js");
const basicAuth = require("middlewares/basicAuth.js");
const LndError = require("models/errors.js").LndError;

const logger = require("utils/logger.js");

const address = require("routes/v1/lnd/address.js");
const channel = require("routes/v1/lnd/channel.js");
const conf = require("routes/v1/lnd/conf.js");
const info = require("routes/v1/lnd/info.js");
const lightning = require("routes/v1/lnd/lightning.js");
const bitcoin = require("routes/v1/bitcoind/info.js");
const transaction = require("routes/v1/lnd/transaction.js");
const util = require("routes/v1/lnd/util.js");
const backups = require("routes/v1/lnd/backups.js");
const wallet = require("routes/v1/lnd/wallet.js");
const watchtower = require("routes/v1/lnd/watchtower.js");
const pages = require("routes/v1/pages.js");
const system = require("routes/v1/system/index.js");
const widgets = require("routes/v1/lnd/widgets.js");
const external = require("routes/v1/external.js");
const ping = require("routes/ping.js");
const app = express();

// StartOS puts nothing in front of the dashboard, so the password check comes
// first, ahead of the static files. Umbrel's app proxy signs users in before
// a request reaches this process.
if (constants.IS_STARTOS) {
  const readPassword = () => {
    if (constants.DASHBOARD_PASSWORD_FILE) {
      try {
        const {password} = JSON.parse(fs.readFileSync(constants.DASHBOARD_PASSWORD_FILE, "utf8"));
        return typeof password === "string" ? password : "";
      } catch (error) {
        return "";
      }
    }
    return constants.DASHBOARD_PASSWORD || "";
  };
  app.use(basicAuth(readPassword));
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(requestCorrelationMiddleware);
app.use(camelCaseReqMiddleware);
app.use(morgan(logger.morganConfiguration));

// serve frontend
app.use("/", express.static("../frontend/dist"));

app.use("/v1/lnd/address", address);
app.use("/v1/lnd/channel", channel);
app.use("/v1/lnd/info", info);
app.use("/v1/lnd/lightning", lightning);
app.use("/v1/bitcoin", bitcoin);
app.use("/v1/lnd/transaction", transaction);
app.use("/v1/lnd/wallet", wallet);
app.use("/v1/lnd/watchtower", watchtower);
app.use("/v1/lnd/util", util);
app.use("/v1/pages", pages);
app.use("/v1/system", system);
app.use("/v1/external", external);
app.use("/ping", ping);

// Umbrel only. StartOS owns lnd.conf and restarts LND itself, keeps its own
// backups rather than Umbrel's backup server, and has no home-screen widgets.
if (!constants.IS_STARTOS) {
  app.use("/v1/lnd/conf", conf);
  app.use("/v1/lnd/backups", backups);
  app.use("/v1/lnd/widgets", widgets);
}

app.use(errorHandleMiddleware);
app.use((req, res) => {
  res.status(404).json(); // eslint-disable-line no-magic-numbers
});

module.exports = app;

const SECOND_IN_MS = 1000;
const MINUTE_IN_MS = 60 * SECOND_IN_MS;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const initLnd = async () => {
  // Wait for LND to be operational
  while (true) {
    console.log('Checking LND status...');
    const {operational, unlocked} = await lightningLogic.getStatus();
    if (unlocked) {
      console.log('LND already unlocked!');
      return;
    }
    if (operational) {
      console.log('LND ready!');
      break;
    }
    console.log('Waiting for LND...');
    await delay(SECOND_IN_MS);
  }

  // Attempt to unlock
  try {
    console.log('Attempting to unlock wallet...');
    await lightningLogic.unlockWallet(constants.LND_WALLET_PASSWORD);
    console.log('Wallet unlocked!');
    return;
  } catch (error) {
    const reason = error.error && error.error.details || error.message;
    console.log(`Unlocking wallet failed: "${reason}"`);
  }

};

// Retry init every 10 seconds in case of LND restart or crash. Not on
// StartOS: the package unlocks the wallet with its own password (or leaves it
// to the user in Cold Storage Mode), and Umbrel's backup server is not in the
// picture, so neither loop runs there.
if (!constants.IS_STARTOS) {
  (async () => {
    while (true) {
      await initLnd();
      await delay(10 * SECOND_IN_MS);
    }
  })();

  // Monitor channel backups for changes and backup
  startChannelBackupMonitor();
}
