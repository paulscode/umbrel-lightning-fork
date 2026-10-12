// The dashboard password asked again before an action that outlasts the
// session: making a macaroon, pairing a phone. A stolen session cookie must not
// be able to mint a credential that outlives it. Without a dashboard password
// (Umbrel, where Umbrel's own login guards the app) there is nothing to ask.
//
// Refused with 403, not 401: the page takes a 401 to mean the session ended
// and goes back to the sign-in screen.
const { ValidationError } = require("models/errors.js");

function createStepUp({ auth: authDep = null } = {}) {
  const auth = () => authDep || require("logic/auth.js");

  // purpose completes "Enter your dashboard password to ...".
  async function requirePassword(password, purpose) {
    if (!auth().passwordConfigured()) {
      return;
    }
    if (typeof password !== "string" || password.length === 0) {
      throw new ValidationError(`Enter your dashboard password to ${purpose}.`, 403);
    }
    const r = await auth().guardedVerify(password);
    if (!r.ok) {
      if (r.reason === "locked") {
        throw new ValidationError(
          `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfter || 1)} seconds.`,
          429
        );
      }
      throw new ValidationError("That is not your dashboard password.", 403);
    }
  }

  return { requirePassword };
}

module.exports = { createStepUp, ...createStepUp() };
