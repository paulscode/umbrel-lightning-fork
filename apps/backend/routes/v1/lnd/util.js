const express = require("express");
const router = express.Router();

const applicationLogic = require("logic/application.js");
const safeHandler = require("utils/safeHandler");
const umbrelOnly = require("middlewares/umbrelOnly.js");

// Both Umbrel only: the first rsyncs Umbrel's LND directory to Umbrel's
// backup path, the second serves channel.backup, which StartOS carries in
// its own backups and its Configure Channel Backups action.
router.post(
  "/backup",
  umbrelOnly,
  safeHandler((req, res) =>
    applicationLogic.lndBackup().then(response => res.json(response))
  )
);

router.get(
  "/download-channel-backup",
  umbrelOnly,
  safeHandler((req, res) =>
    applicationLogic
      .lndChannnelBackup()
      .then(backupFile => res.download(backupFile, "channel.backup"))
  )
);

module.exports = router;
