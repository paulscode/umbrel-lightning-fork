const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// What the user chose rather than took by default survives every write of
// the settings, including ones that don't mention it.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("utils/logger.js", { info() {}, warn() {}, error() {}, debug() {} });

const files = {};
stub("services/disk.js", {
  fileExists: async (p) => p in files,
  readJsonFile: async (p) => JSON.parse(files[p]),
  readUtf8File: async (p) => files[p] || "",
  writeJsonFile: async (p, v) => { files[p] = JSON.stringify(v); },
  writePlainTextFile: async (p, v) => { files[p] = v; },
});
const constants = require("utils/const");
const config = require("logic/config.js");

test("a choice is kept across writes", async () => {
  await config.writeLndConfig({ "protocol.splice": true }, {}, { spliceChosen: true });
  let settings = JSON.parse(files[constants.JSON_SETTINGS_FILE]);
  assert.deepEqual(settings.marks, { spliceChosen: true });

  await config.writeLndConfig({ "protocol.splice": true }, {});
  settings = JSON.parse(files[constants.JSON_SETTINGS_FILE]);
  assert.deepEqual(settings.marks, { spliceChosen: true });
  assert.equal(settings.lnd["protocol.splice"], true);
});

test("resizing channels off is never written, so an older version can start", async () => {
  await config.writeLndConfig({ "protocol.splice": false, alias: "a" }, {});
  const settings = JSON.parse(files[constants.JSON_SETTINGS_FILE]);
  assert.equal("protocol.splice" in settings.lnd, false);
  assert.doesNotMatch(files[constants.UMBREL_LND_CONF_FILEPATH], /protocol\.splice/);

  // Restore Defaults the same.
  await config.writeLndConfig(require("utils/defaultConfig"), {});
  assert.equal("protocol.splice" in JSON.parse(files[constants.JSON_SETTINGS_FILE]).lnd, false);
  assert.doesNotMatch(files[constants.UMBREL_LND_CONF_FILEPATH], /protocol\.splice/);

  // On, it is.
  await config.writeLndConfig({ "protocol.splice": true }, {});
  assert.equal(JSON.parse(files[constants.JSON_SETTINGS_FILE]).lnd["protocol.splice"], true);
  assert.match(files[constants.UMBREL_LND_CONF_FILEPATH], /^protocol\.splice=true$/m);

  // Read back without the key: off, as lnd's default.
  await config.writeLndConfig({ alias: "a" }, {});
  assert.equal((await config.getConfig())["protocol.splice"], false);
});

test("off chosen wins over protocol.splice=true in the user's lnd.conf", async () => {
  files[constants.LND_CONF_FILEPATH] = "[protocol]\nprotocol.splice=true\n";
  try {
    // Turned off in Advanced Settings: not written, as above.
    await config.writeLndConfig({ "protocol.splice": false, alias: "a" }, {});
    assert.doesNotMatch(files[constants.UMBREL_LND_CONF_FILEPATH], /protocol\.splice=true/);

    // The next start reads it back off and finds the file up to date.
    const got = await config.getConfig();
    assert.equal(got["protocol.splice"], false);
    assert.equal(await config.isUmbrelLndConfUpToDate(got), true);

    // A write of the saved settings alone (the bridge's) keeps it off.
    const saved = JSON.parse(files[constants.JSON_SETTINGS_FILE]).lnd;
    await config.writeLndConfig(saved, undefined);
    assert.doesNotMatch(files[constants.UMBREL_LND_CONF_FILEPATH], /protocol\.splice=true/);
  } finally {
    delete files[constants.LND_CONF_FILEPATH];
  }

  // With no saved settings yet, lnd.conf's choice stands.
  delete files[constants.JSON_SETTINGS_FILE];
  files[constants.LND_CONF_FILEPATH] = "[protocol]\nprotocol.splice=true\n";
  try {
    assert.equal((await config.getConfig())["protocol.splice"], true);
  } finally {
    delete files[constants.LND_CONF_FILEPATH];
  }
});
