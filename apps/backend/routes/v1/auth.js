const express = require("express");
const router = express.Router();

const auth = require("logic/auth.js");
const safeHandler = require("utils/safeHandler");

// What the frontend needs to decide between the sign-in screen and the app.
// With no password configured (Umbrel, whose proxy signs users in) everyone
// is signed in and there is no CSRF token to carry.
router.get(
  "/state",
  safeHandler(async (req, res) => {
    const enabled = auth.passwordConfigured();
    const session = enabled ? auth.sessionFromReq(req) : null;
    return res.json({
      password_enabled: enabled,
      authed: !enabled || Boolean(session),
      csrf: session ? session.csrf : null,
    });
  })
);

router.post(
  "/login",
  safeHandler(async (req, res) => {
    if (!auth.passwordConfigured()) {
      return res.status(400).json({error: "no_password_set"}); // eslint-disable-line no-magic-numbers
    }
    const r = await auth.login(String((req.body && req.body.password) || ""));
    if (!r.ok) {
      const status = r.reason === "locked" ? 429 : 401; // eslint-disable-line no-magic-numbers
      return res.status(status).json({error: r.reason, retry_after: r.retryAfter || 0});
    }
    res.set("Set-Cookie", auth.cookieHeader(r.id));
    res.set("Cache-Control", "no-store");
    return res.json({ok: true, csrf: r.csrf});
  })
);

router.post(
  "/logout",
  safeHandler(async (req, res) => {
    auth.logout(req);
    res.set("Set-Cookie", auth.clearCookieHeader());
    return res.json({ok: true});
  })
);

module.exports = router;
