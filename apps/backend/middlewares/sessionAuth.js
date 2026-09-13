const auth = require("logic/auth.js");

// The gate in front of the API when a password is configured, mounted at
// /v1 in app.js so that Express's own matching, not a string compare of
// this module's, decides what is under it (the two disagreed on case once,
// and /V1/... walked straight through). The static frontend stays public so
// the sign-in screen can render; /ping is outside /v1 and stays open for the
// platform's health check. Every non-GET request needs the session's CSRF
// token, and so does the one GET that changes wallet state.
const PUBLIC = new Set(["/auth/state", "/auth/login"]);

module.exports = (req, res, next) => {
  // Mount-relative, lowercased, without a trailing slash: the router
  // treats those the same way.
  const path = req.path.toLowerCase().replace(/\/+$/, "") || "/";
  if (PUBLIC.has(path)) {
    return next();
  }
  const session = auth.sessionFromReq(req);
  if (!session) {
    res.set("Cache-Control", "no-store");
    return res.status(401).json({error: "unauthorized"}); // eslint-disable-line no-magic-numbers
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !auth.csrfOk(session, req)) {
    res.set("Cache-Control", "no-store");
    return res.status(403).json({error: "csrf"}); // eslint-disable-line no-magic-numbers
  }
  return next();
};
