const express = require("express");
const router = express.Router();

const systemLogic = require("logic/system");
const diskLogic = require('logic/disk');
const safeHandler = require("utils/safeHandler");
const constants = require("utils/const.js");
const umbrelOnly = require("middlewares/umbrelOnly.js");
const mempoolLogic = require("logic/mempool.js");
const ValidationError = require("models/errors.js").ValidationError;

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

// Where transaction links go: the selected Mempool app, or the wrapper's
// explorer setting when no app is selected.
router.get("/explorer", safeHandler(async (req, res) =>
  res.json(await mempoolLogic.explorer())
));

// The Mempool app used for fee rates and transaction links, and the apps
// the wrapper can reach.
router.get("/mempool", safeHandler(async (req, res) =>
  res.json(await mempoolLogic.settings())
));

router.post("/mempool", safeHandler(async (req, res) => {
  const app = req.body.app;
  if (typeof app !== "string" || app.length > 64) {
    throw new ValidationError("app must be the id of a Mempool app, or empty", 400);
  }
  await mempoolLogic.select(app);
  res.json(await mempoolLogic.settings());
}));

module.exports = router;
