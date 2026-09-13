const express = require("express");
const router = express.Router();

const channelBackup = require("logic/channelBackup.js");
const lnd = require("services/lnd");
const safeHandler = require("utils/safeHandler");
const umbrelOnly = require("middlewares/umbrelOnly.js");

// Umbrel only: StartOS configures and runs the same agent through its own
// actions, and the dashboard there mounts nothing it could configure.
router.use(umbrelOnly);

const inputError = (res, error) => {
  if (error instanceof channelBackup.InputError) {
    return res.status(400).json({error: error.message}); // eslint-disable-line no-magic-numbers
  }
  throw error;
};

router.get("/config", safeHandler(async (req, res) => res.json(channelBackup.publicConfig())));

router.post("/config", safeHandler(async (req, res) => {
  try {
    const {provider, settings} = req.body || {};
    return res.json(await channelBackup.saveProvider(provider, settings || {}));
  } catch (error) {
    return inputError(res, error);
  }
}));

router.get("/status", safeHandler(async (req, res) => res.json(channelBackup.status())));

router.post("/now", safeHandler(async (req, res) => res.json(await channelBackup.backupNow())));

router.get("/oauth/url", safeHandler(async (req, res) => {
  try {
    return res.json({url: channelBackup.authUrl(String(req.query.provider || ""), String(req.query.clientId || ""))});
  } catch (error) {
    return inputError(res, error);
  }
}));

// Recovery: fetch every target's copy, then restore one of them, or a file
// the user uploads.
router.post("/pull", safeHandler(async (req, res) => res.json(await channelBackup.pull())));

router.post("/restore", safeHandler(async (req, res) => {
  const {provider, backup} = req.body || {};
  let bytes;
  try {
    bytes = backup ? Buffer.from(String(backup), "base64") : channelBackup.pulledBackup(String(provider || ""));
  } catch (error) {
    return inputError(res, error);
  }
  if (!bytes || !bytes.length) {
    return res.status(400).json({error: "No backup to restore"}); // eslint-disable-line no-magic-numbers
  }
  await lnd.recoverBackup(bytes);
  return res.json({success: true});
}));

module.exports = router;
