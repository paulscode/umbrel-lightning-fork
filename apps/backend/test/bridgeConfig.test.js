const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// The config writer against real files: where the bridge's lines come from,
// and that saving Advanced Settings never loses them.
process.env.NODE_PATH = path.join(__dirname, "..");
Module._initPaths();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-conf-"));
process.env.JSON_SETTINGS_FILE = path.join(dir, "settings.json");
process.env.UMBREL_LND_CONF_FILEPATH = path.join(dir, "umbrel-lnd.conf");
process.env.LND_CONF_FILEPATH = path.join(dir, "lnd.conf");

const loggerPath = require.resolve("utils/logger");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: quiet };

const config = require("logic/config.js");
const DEFAULT_CONFIG = require("utils/defaultConfig.js");

const conf = () => fs.readFileSync(process.env.UMBREL_LND_CONF_FILEPATH, "utf8");
const settings = () => JSON.parse(fs.readFileSync(process.env.JSON_SETTINGS_FILE, "utf8"));
const reset = (lndConf = "") => {
  for (const f of ["JSON_SETTINGS_FILE", "UMBREL_LND_CONF_FILEPATH", "LND_CONF_FILEPATH"]) {
    fs.rmSync(process.env[f], { force: true });
  }
  if (lndConf) {
    fs.writeFileSync(process.env.LND_CONF_FILEPATH, lndConf);
  }
};

test("off by default: no bridge lines, no bridge section", async () => {
  reset();
  await config.writeLndConfig(DEFAULT_CONFIG);
  assert.doesNotMatch(conf(), /bridgerpc/);
  assert.equal(settings().bridge, undefined);
});

test("on: the three lines, and they survive Advanced Settings being saved", async () => {
  reset();
  await config.writeLndConfig(DEFAULT_CONFIG, { enabled: true });
  for (const line of ["bridgerpc.enabled=true", "bridgerpc.tosha256=true", "bridgerpc.sha256.supervised=true"]) {
    assert.match(conf(), new RegExp(`^${line.replace(/\./g, "\\.")}$`, "m"));
  }

  // What the Advanced Settings route does: write its own keys, no bridge.
  await config.writeLndConfig({ ...DEFAULT_CONFIG, alias: "renamed" });
  assert.match(conf(), /^alias=renamed$/m);
  assert.match(conf(), /^bridgerpc\.sha256\.supervised=true$/m);
  assert.deepEqual(settings().bridge, { enabled: true });
  assert.equal(await config.isUmbrelLndConfUpToDate(settings().lnd), true);

  await config.writeLndConfig(settings().lnd, { enabled: false });
  assert.doesNotMatch(conf(), /bridgerpc/);
  assert.equal(await config.isUmbrelLndConfUpToDate(settings().lnd), true);
});

test("the SHA256 node's address goes in when the app gives one", () => {
  assert.deepEqual(config.bridgeConfig({ enabled: true }, "10.21.21.68:10019"), {
    "bridgerpc.enabled": true,
    "bridgerpc.tosha256": true,
    "bridgerpc.sha256.supervised": true,
    "bridgerpc.sha256.rpchost": "10.21.21.68:10019",
  });
  assert.equal(config.bridgeConfig({ enabled: true }, "")["bridgerpc.sha256.rpchost"], undefined);
  assert.deepEqual(config.bridgeConfig({ enabled: false }, "10.21.21.68:10019"), {});
});

test("a bridge set up by hand in lnd.conf stands until the switch is used", async () => {
  const byHand = [
    "bridgerpc.enabled=true",
    "bridgerpc.sha256.rpchost=10.0.0.9:10009",
    "bridgerpc.spread=0.02",
  ].join("\n");
  reset(byHand);
  await config.writeLndConfig(DEFAULT_CONFIG);
  assert.match(conf(), /^bridgerpc\.sha256\.rpchost=10\.0\.0\.9:10009$/m);
  assert.match(conf(), /^bridgerpc\.enabled=true$/m);

  // Switched off here: the switch owns on/off and the node, tuning stays.
  await config.writeLndConfig(DEFAULT_CONFIG, { enabled: false });
  assert.doesNotMatch(conf(), /bridgerpc\.enabled/);
  assert.doesNotMatch(conf(), /bridgerpc\.sha256\./);
  assert.match(conf(), /^bridgerpc\.spread=0\.02$/m);

  // Switched on: supervised, not the hand-written node.
  await config.writeLndConfig(DEFAULT_CONFIG, { enabled: true });
  assert.match(conf(), /^bridgerpc\.sha256\.supervised=true$/m);
  assert.doesNotMatch(conf(), /rpchost/);
  assert.equal((conf().match(/^bridgerpc\.enabled=/gm) || []).length, 1, "one line, not two");
});

test("a hand-written line with spaces around = is still the switch's once used", async () => {
  reset("bridgerpc.enabled = true\n  bridgerpc.sha256.rpchost =10.0.0.9:10009\nnot a setting\n");
  await config.writeLndConfig(DEFAULT_CONFIG, { enabled: false });
  assert.doesNotMatch(conf(), /bridgerpc/);
});
