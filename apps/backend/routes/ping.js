const express = require('express');
const pjson = require('../package.json');
const constants = require('utils/const.js');
const auth = require('logic/auth.js');
const router = express.Router();

// Reachable without a session (middlewares/sessionAuth.js), so a platform
// health check can tell "serving, but no password is set" from "serving":
// with no usable password nobody can sign in, and a check that only looked
// for an HTTP response would call that healthy.
function authState() {
  if (auth.passwordConfigured()) {
    return auth.passwordUsable() ? 'configured' : 'missing';
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
