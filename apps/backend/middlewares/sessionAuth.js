const auth = require("logic/auth.js");

// The gate in front of the API when a password is configured. The static
// frontend stays public so the sign-in screen can render; every /v1 route
// but the sign-in ones needs a session, and every non-GET needs the
// session's CSRF token. /ping stays open for the platform's health check.
const PUBLIC = new Set(["/ping", "/v1/auth/state", "/v1/auth/login"]);

module.exports = (req, res, next) => {
  if (!req.path.startsWith("/v1/") && req.path !== "/v1") {
    return next();
  }
  if (PUBLIC.has(req.path)) {
    return next();
  }
  const session = auth.sessionFromReq(req);
  if (!session) {
    res.set("Cache-Control", "no-store");
    return res.status(401).json({error: "unauthorized"}); // eslint-disable-line no-magic-numbers
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !auth.csrfOk(session, req)) {
    return res.status(403).json({error: "csrf"}); // eslint-disable-line no-magic-numbers
  }
  return next();
};
