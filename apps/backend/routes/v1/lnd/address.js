const express = require("express");
const router = express.Router();
const lightningLogic = require("logic/lightning.js");
const safeHandler = require("utils/safeHandler");

// A POST: this advances the wallet's address index, so it must carry the
// session's CSRF token, which only writes do.
router.post(
  "/",
  safeHandler((req, res) =>
    lightningLogic.generateAddress().then(address => res.json(address))
  )
);

module.exports = router;
