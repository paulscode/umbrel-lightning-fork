const crypto = require("crypto");

// HTTP Basic authentication for platforms that put nothing in front of the
// dashboard. Umbrel's app proxy signs a user in before a request reaches this
// process; StartOS serves a UI interface straight to the browser, so the
// dashboard has to ask for the password itself. Every path except /ping is
// covered, the static frontend included, so a visitor without the password
// sees the browser's prompt and nothing else. The username is not checked.
const CHALLENGE = 'Basic realm="Lightning Fork", charset="UTF-8"';

function equal(supplied, expected) {
  const a = Buffer.from(String(supplied), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) {
    // Spend the same time on a wrong length as on a wrong character.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// `getPassword` is called on every request and returns the current password,
// or an empty string when none is configured; then nothing gets through.
module.exports = function basicAuth(getPassword) {
  return (req, res, next) => {
    if (req.path === "/ping") {
      return next();
    }
    const password = getPassword();
    if (typeof password !== "string" || password.length === 0) {
      res.set("Cache-Control", "no-store");
      return res.status(503).send("Dashboard password not configured"); // eslint-disable-line no-magic-numbers
    }
    const [scheme, encoded] = String(req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const supplied = colon === -1 ? "" : decoded.slice(colon + 1);
      if (equal(supplied, password)) {
        return next();
      }
    }
    res.set("WWW-Authenticate", CHALLENGE);
    res.set("Cache-Control", "no-store");
    return res.status(401).send("Authentication required"); // eslint-disable-line no-magic-numbers
  };
};
