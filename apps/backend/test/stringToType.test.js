const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// logic/config.js resolves its modules from the backend's root.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();

const stringToType = require("../utils/stringToType.js");
const DEFAULT_CONFIG = require("../utils/defaultConfig.js");

test("every managed boolean read from lnd.conf comes back a boolean", () => {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof value !== "boolean") {
      continue;
    }
    assert.equal(stringToType(key, "true"), true, key);
    assert.equal(stringToType(key, "0"), false, key);
  }
});

test("the Tor switches Advanced Settings validates as booleans", () => {
  assert.equal(stringToType("tor.skip-proxy-for-clearnet-targets", "true"), true);
  assert.equal(stringToType("tor.streamisolation", "false"), false);
  assert.equal(stringToType("accept-keysend", "1"), true);
});

test("an invalid boolean is refused, numbers and text pass through", () => {
  assert.throws(() => stringToType("tor.streamisolation", "yes"));
  assert.equal(stringToType("maxpendingchannels", "3"), 3);
  assert.equal(stringToType("alias", "my node"), "my node");
});

test("saved settings holding a boolean as a string are read as booleans", () => {
  const { normalizeSettings } = require("../logic/config.js");
  assert.deepEqual(
    normalizeSettings({ "tor.skip-proxy-for-clearnet-targets": "true", "tor.streamisolation": "nonsense", alias: "x", maxpendingchannels: 2 }),
    { "tor.skip-proxy-for-clearnet-targets": true, alias: "x", maxpendingchannels: 2 },
  );
});
