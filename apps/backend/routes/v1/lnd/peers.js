// Peers without channels: list them, connect to one by its address, and
// disconnect from one this node holds no channel with.
const express = require("express");
const router = express.Router();

const peersLogic = require("logic/peers.js");
const safeHandler = require("utils/safeHandler");

router.get(
  "/",
  safeHandler(async (req, res) => res.json(await peersLogic.listPeers()))
);

router.post(
  "/connect",
  safeHandler(async (req, res) =>
    res.json(await peersLogic.connectPeer(req.body.address))
  )
);

router.post(
  "/disconnect",
  safeHandler(async (req, res) =>
    res.json(await peersLogic.disconnectPeer(req.body.pubKey))
  )
);

module.exports = router;
