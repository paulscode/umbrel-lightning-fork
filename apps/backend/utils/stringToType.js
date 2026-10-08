// value argument is passed as a string
function stringToType(key, value) {
  if (value === "" || value === null || value === undefined) return "";
  if (BOOLEAN_KEYS.includes(key)) {
    if (value === 'true' || value === '1') {
      return true;
    } else if (value === 'false' || value === '0') {
      return false;
    } else {
      throw new Error(`Invalid value for boolean key ${key}: ${value}`); 
    }
  }
  if (!isNaN(value)) {
    return Number(value);
  }
  return value;
}

// The boolean options the dashboard manages: those whose default is a
// boolean. A hand-kept list here missed tor.skip-proxy-for-clearnet-targets,
// tor.streamisolation and accept-keysend, so an lnd.conf setting any of them
// came back as the string "true" and Advanced Settings refused to save.
const DEFAULT_CONFIG = require("./defaultConfig.js");
const BOOLEAN_KEYS = Object.keys(DEFAULT_CONFIG).filter(key => typeof DEFAULT_CONFIG[key] === "boolean");

module.exports = stringToType;