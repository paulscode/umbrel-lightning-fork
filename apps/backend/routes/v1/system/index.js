const express = require("express");
const router = express.Router();

const systemLogic = require("logic/system");
const diskLogic = require('logic/disk');
const safeHandler = require("utils/safeHandler");
const constants = require("utils/const.js");
const validator = require("utils/validator.js");
const umbrelOnly = require("middlewares/umbrelOnly.js");

// Which platform hosts the dashboard, so the frontend can hide what the
// platform provides itself. Answered before any other state is read.
router.get(
  "/platform",
  safeHandler(async (req, res) => res.json({
    platform: constants.PLATFORM,
  }))
);


router.get(
  "/lndconnect-urls",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const urls = await systemLogic.getLndConnectUrls();

    return res.status(constants.STATUS_CODES.OK).json(urls);
  })
);

router.get(
  "/backup-status",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const backup = await systemLogic.getBackupStatus();

    return res.status(constants.STATUS_CODES.OK).json(backup);
  })
);

// backupOverTor is a boolean that determines whether channel backup files should be uploaded/downloaded over Tor or clearnet
router.get(
  "/backup-over-tor",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {backupOverTor} = await diskLogic.getJsonStore();

    return res.json(backupOverTor);
  })
);

router.post(
  "/backup-over-tor",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {backupOverTor} = req.body;

    validator.isBoolean(backupOverTor);

    await diskLogic.updateJsonStore({backupOverTor});

    return res.json({success: true});
  })
);

// automaticBackups determines whether channel backup files should be uploaded automatically.
router.get(
  "/automatic-backups",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {automaticBackups} = await diskLogic.getJsonStore();

    return res.json(automaticBackups);
  })
);

router.post(
  "/automatic-backups",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {automaticBackups} = req.body;

    validator.isBoolean(automaticBackups);

    await diskLogic.updateJsonStore({automaticBackups});

    return res.json({success: true});
  })
);

// retrieves whether the latest backup attempt was successfully uploaded
router.get(
  "/recent-backup-success",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {mostRecentBackupSuccess} = await diskLogic.getJsonStore();

    return res.json(mostRecentBackupSuccess);
  })
);

router.get(
  "/onboarding",
  safeHandler(async (req, res) => {
    // The StartOS package creates and unlocks the wallet, so there is nothing
    // to onboard.
    if (constants.IS_STARTOS) {
      return res.json(false);
    }
    const {onboarding} = await diskLogic.getJsonStore();

    return res.json(onboarding);
  })
);

router.post(
  "/onboarding",
  umbrelOnly,
  safeHandler(async (req, res) => {
    await diskLogic.updateJsonStore({onboarding: false});

    return res.json(false);
  })
);

router.get(
  "/seed",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {seed} = await diskLogic.getJsonStore();

    return res.json({seed});
  })
);

router.get(
  "/seed-exists",
  umbrelOnly,
  safeHandler(async (req, res) => {
    const {seed} = await diskLogic.getJsonStore();

    const seedExists = Boolean(seed && seed.length);

    return res.json(seedExists);
  })
);

router.get("/explorer", safeHandler(async (req, res) => res.json({
  port: constants.EXPLORER_PORT,
  hiddenService: constants.EXPLORER_HIDDEN_SERVICE,
})));

module.exports = router;
