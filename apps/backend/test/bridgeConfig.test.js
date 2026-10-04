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

test("off, a bridge that has had a node keeps it, to finish what is unfinished", () => {
  assert.deepEqual(config.bridgeConfig({ enabled: false, sha256Node: "paulscode-knots-sha256", toBLAKE2b: true }, "10.21.21.68:10019"), {
    "bridgerpc.sha256.supervised": true,
    "bridgerpc.sha256.rpchost": "10.21.21.68:10019",
  });
  assert.deepEqual(config.bridgeConfig({ sha256Node: "paulscode-knots-sha256" }, "10.21.21.68:10019"), {}, "the switch never used");
});

test("paying BLAKE2b invoices adds its direction", () => {
  assert.equal(config.bridgeConfig({ enabled: true, toBLAKE2b: true })["bridgerpc.toblake2b"], true);
  assert.equal(config.bridgeConfig({ enabled: true })["bridgerpc.toblake2b"], undefined);
  assert.equal(config.bridgeConfig({ enabled: true, toBLAKE2b: true })["bridgerpc.tosha256"], true);
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

test("once the switch is used, the directions are its own, not lnd.conf's", async () => {
  reset(["bridgerpc.toblake2b=true", "bridgerpc.tosha256=false", "bridgerpc.spread=0.02"].join("\n"));
  await config.writeLndConfig(DEFAULT_CONFIG, { enabled: true });
  assert.doesNotMatch(conf(), /toblake2b/);
  assert.match(conf(), /^bridgerpc\.tosha256=true$/m);
  assert.match(conf(), /^bridgerpc\.spread=0\.02$/m, "tuning stays lnd.conf's");
});

test("the Pricing setting writes the rate source and fees, and owns them once saved", async () => {
  assert.deepEqual(config.bridgeConfig({
    enabled: true,
    pricing: { rateSource: "fixed", fee: 0.012, feeToSHA256: null, feeToBLAKE2b: 0.008 },
  }, "10.21.21.68:10019"), {
    "bridgerpc.enabled": true,
    "bridgerpc.tosha256": true,
    "bridgerpc.sha256.supervised": true,
    "bridgerpc.sha256.rpchost": "10.21.21.68:10019",
    "bridgerpc.ratesource": "fixed",
    "bridgerpc.spread": 0.012,
    "bridgerpc.fee.toblake2b": 0.008,
  });
  // Off with a node: still priced, for a payment left to finish.
  assert.equal(config.bridgeConfig({ enabled: false, sha256Node: "x", pricing: { rateSource: "neoxa", fee: 0.015 } }, "h:1")["bridgerpc.ratesource"], "neoxa");

  // A fee set by hand in lnd.conf gives way to the setting once it is saved.
  reset("bridgerpc.fee.tosha256=0.03\nbridgerpc.ratesource=fixed\nbridgerpc.maxswapmsat=5000000\n");
  await config.writeLndConfig(DEFAULT_CONFIG, { enabled: true, pricing: { rateSource: "neoxa", fee: 0.015, feeToSHA256: null, feeToBLAKE2b: null } });
  const written = conf();
  assert.match(written, /bridgerpc\.ratesource=neoxa/);
  assert.match(written, /bridgerpc\.spread=0\.015/);
  assert.doesNotMatch(written, /bridgerpc\.fee\.tosha256/);
  // Tuning the setting does not cover stays lnd.conf's.
  assert.match(written, /bridgerpc\.maxswapmsat=5000000/);
});
