// Paired phones, as the dashboard's Mobile app screen manages them: list,
// start a pairing (the QR code's contents), rename, remove.
const express = require("express");

const devices = require("logic/devices.js");
const access = require("logic/mobileAccess.js");
const safeHandler = require("utils/safeHandler");
const x509 = require("utils/x509.js");
const { ValidationError } = require("models/errors.js");

const router = express.Router();

const ID = /^[0-9a-f]{12}$/;

router.get(
  "/",
  safeHandler(async (req, res) => {
    res.json({ devices: await devices.list() });
  })
);

// The QR code carries the code, its expiry and how to reach and recognise
// the node, in short keys so the code stays easy to scan.
router.post(
  "/",
  safeHandler(async (req, res) => {
    const { device, enrollCode, enrollExpires } = await devices.createPending((req.body || {}).label);
    const where = access.endpoints(req);
    const caPem = access.rootCaPem();
    const pairing = { lf: 1, code: enrollCode, exp: enrollExpires };
    if (where.onionUrl) {
      pairing.onion = where.onionUrl;
    }
    if (where.lanUrl) {
      pairing.lan = where.lanUrl;
    }
    if (where.lanIp) {
      pairing.ip = where.lanIp;
    }
    if (caPem) {
      pairing.ca = x509.fingerprint(caPem);
    }
    res.status(201).json({ device, pairing, qr: JSON.stringify(pairing) });
  })
);

async function rename(req, res) {
  if (!ID.test(req.params.id)) {
    throw new ValidationError("Not a device id");
  }
  const device = await devices.rename(req.params.id, (req.body || {}).label);
  if (!device) {
    throw new ValidationError("No such device", 404);
  }
  res.json({ device });
}

router.patch("/:id", safeHandler(rename));
// The dashboard's request helper has no PATCH.
router.post("/:id/label", safeHandler(rename));

router.delete(
  "/:id",
  safeHandler(async (req, res) => {
    if (!ID.test(req.params.id)) {
      throw new ValidationError("Not a device id");
    }
    if (!(await devices.revoke(req.params.id))) {
      throw new ValidationError("No such device", 404);
    }
    res.json({ revoked: true });
  })
);

module.exports = router;
