const constants = require("utils/const.js");

// Routes that only make sense on Umbrel answer 404 on StartOS, so a feature
// hidden in the frontend is also absent from the API.
module.exports = (req, res, next) => {
  if (constants.IS_STARTOS) {
    return res.status(404).json(); // eslint-disable-line no-magic-numbers
  }
  return next();
};
