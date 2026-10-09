// The Macaroons view (logic/macaroons.js): what LND can grant, the macaroons
// made here, making one (shown once), and revoking one.
const express = require("express");
const router = express.Router();

const macaroons = require("logic/macaroons.js");
const safeHandler = require("utils/safeHandler");

// A new macaroon is a credential; nothing between here and the page keeps it.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get(
  "/catalog",
  safeHandler(async (req, res) => res.json(await macaroons.catalog()))
);

router.get(
  "/",
  safeHandler(async (req, res) => res.json(await macaroons.list()))
);

router.post(
  "/",
  safeHandler(async (req, res) => {
    const body = req.body || {};
    return res.json(
      await macaroons.create({
        label: body.label,
        permissions: body.permissions,
        expiresInDays: body.expiresInDays,
        password: body.password,
      })
    );
  })
);

router.delete(
  "/:id",
  safeHandler(async (req, res) => res.json(await macaroons.revoke(req.params.id)))
);

module.exports = router;
