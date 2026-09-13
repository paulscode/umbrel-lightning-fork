const express = require('express');
const fs = require('fs');
const pjson = require('../package.json');
const constants = require('utils/const.js');
const router = express.Router();

// Reachable without a password (middlewares/basicAuth.js), so a platform
// health check can tell "serving, but no password is set" from "serving":
// with no password every other request answers 503, and a check that only
// looked for an HTTP response would call that healthy.
function authState() {
  if (constants.DASHBOARD_PASSWORD_FILE) {
    try {
      const {password} = JSON.parse(fs.readFileSync(constants.DASHBOARD_PASSWORD_FILE, 'utf8'));
      return typeof password === 'string' && password.length > 0 ? 'configured' : 'missing';
    } catch (error) {
      return 'missing';
    }
  }
  if (constants.DASHBOARD_PASSWORD) {
    return 'configured';
  }
  return constants.IS_STARTOS ? 'missing' : 'off';
}

router.get('/', function (req, res) {
  res.json({
    version: 'umbrel-middleware-' + pjson.version,
    platform: constants.PLATFORM,
    auth: authState(),
  });
});

module.exports = router;
