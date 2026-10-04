const mergeWith = require('lodash.mergewith');
const union = require('lodash.union');

const lndConfig = require('utils/lnd-config');
const diskService = require('services/disk');
const constants = require("utils/const");

const DEFAULT_CONFIG = require('utils/defaultConfig');

// lodash mergeWith customizer function to merge arrays and remove duplicates for multi-line config options like externalip
const mergeArraysAndRemoveDuplicates = (objValue, srcValue) => {
  if (Array.isArray(objValue)) {
    return union(objValue, srcValue);
  }
};

// merge config objects into single object with specific order of precedence
// Note for arrays: we currently do not have any config options that are arrays in the DEFAULT_CONFIG (e.g., like externalip).
// When we do, we will need to revisit the mergeArraysAndRemoveDuplicates customizer function and make sure a users config can override defaults if it makes sense.
const deriveConfigObject = (userLndConfigObject, configObject) => {
  return mergeWith({}, DEFAULT_CONFIG, userLndConfigObject, configObject, mergeArraysAndRemoveDuplicates);
}

// The bridge's lines in umbrel-lnd.conf, from settings.json's `bridge`
// section. Kept apart from `lnd`, which is Advanced Settings' and is replaced
// whole whenever that form is saved, and added after everything else so a
// stray line in lnd.conf cannot turn the bridge on or off. On: the bridge, in
// the direction that pays SHA256 invoices (and the one paying BLAKE2b
// invoices, when chosen), through the SHA256 node this app runs for it
// (sha256-lnd in docker-compose.yml), at the address the app gives it
// (BRIDGE_SHA256_RPCHOST; Lightning Fork's default otherwise). Off, once it
// has had a node: that node still, so that a payment left unfinished is
// finished through it (Lightning Fork quotes nothing, and stops once done).
// The bridge's fee lines, from the dashboard's Pricing setting, each only when
// chosen (Lightning Fork's default otherwise: 1.5% each way). The rate is
// always the market's.
const PRICING_KEYS = {
  fee: 'bridgerpc.spread',
  feeToSHA256: 'bridgerpc.fee.tosha256',
  feeToBLAKE2b: 'bridgerpc.fee.toblake2b',
};
function pricingConfig(pricing) {
  if (!pricing || typeof pricing !== 'object') {
    return {};
  }
  const out = {};
  for (const [field, key] of Object.entries(PRICING_KEYS)) {
    if (typeof pricing[field] === 'number' && pricing[field] > 0) {
      out[key] = pricing[field];
    }
  }
  return out;
}

function bridgeConfig(bridge, rpchost = process.env.BRIDGE_SHA256_RPCHOST) {
  if (!bridge || typeof bridge.enabled !== 'boolean') {
    return {};
  }
  // Off with a node too: a payment left unfinished is checked against the
  // price before it is paid.
  const node = {
    'bridgerpc.sha256.supervised': true,
    ...(rpchost ? {'bridgerpc.sha256.rpchost': rpchost} : {}),
    ...pricingConfig(bridge.pricing),
  };
  if (bridge.enabled !== true) {
    return bridge.sha256Node ? node : {};
  }
  return {
    'bridgerpc.enabled': true,
    'bridgerpc.tosha256': true,
    ...(bridge.toBLAKE2b === true ? {'bridgerpc.toblake2b': true} : {}),
    ...node,
  };
}

async function readBridgeSettings() {
  if (!(await diskService.fileExists(constants.JSON_SETTINGS_FILE))) {
    return {};
  }
  const settings = await diskService.readJsonFile(constants.JSON_SETTINGS_FILE);
  return (settings && settings.bridge) || {};
}

// take in a config object and return and lnd.conf string
// whereby the umbrel json store has higher precedence
// but we keep the unmanaged LND conf
const deriveConfigFile = async (configObject, bridge = {}) => {
  let userLndConfig = {};
  
  if (await diskService.fileExists(constants.LND_CONF_FILEPATH)) {
    const userLndConfFile = await diskService.readUtf8File(constants.LND_CONF_FILEPATH);
    userLndConfig = lndConfig.parse(userLndConfFile);
  }
  // Once the switch has been used, whether the bridge is on, its directions
  // and which node it pays through are the switch's. Until then lnd.conf's own bridgerpc
  // lines stand: that is how a bridge through an operator's own LND is set up
  // here. Tuning (spread, limits) stays lnd.conf's either way.
  if (typeof bridge.enabled === 'boolean') {
    for (const key of Object.keys(userLndConfig)) {
      if (key === 'bridgerpc.enabled' || key === 'bridgerpc.tosha256' || key === 'bridgerpc.toblake2b' || key.startsWith('bridgerpc.sha256.')) {
        delete userLndConfig[key];
      }
      // Once the Pricing setting has been saved, the fees are its too, and
      // the rate the market's: a fee cleared there, or a fixed rate set by
      // hand, must not survive in lnd.conf.
      if (bridge.pricing && (key === 'bridgerpc.ratesource' || key === 'bridgerpc.fixedrate' || Object.values(PRICING_KEYS).includes(key))) {
        delete userLndConfig[key];
      }
    }
  }

  const derivedConfigObject = {...deriveConfigObject(userLndConfig, configObject), ...bridgeConfig(bridge)};

  return lndConfig.generate(derivedConfigObject);
}

// writes umbrel-lnd.conf and settings.json to disk
// pass this function DEFAULT_CONFIG to reset the config to defaults
// The bridge section is carried over unless a new one is given.
async function writeLndConfig(configObject, bridge) {
  const bridgeSettings = bridge === undefined ? await readBridgeSettings() : bridge;
  const lndConfigString = await deriveConfigFile(configObject, bridgeSettings);
  await Promise.all([
    diskService.writePlainTextFile(constants.UMBREL_LND_CONF_FILEPATH, lndConfigString),
    diskService.writeJsonFile(constants.JSON_SETTINGS_FILE, {
      lnd: Object.keys(configObject).length > 0 ? configObject : DEFAULT_CONFIG,
      ...(Object.keys(bridgeSettings).length > 0 ? {bridge: bridgeSettings} : {}),
    })
  ]);
}

// checks to see if we need to regenerate umbrel-lnd.conf and/or settings.json on app start
async function isUmbrelLndConfUpToDate(config) {
  const newLndConfigString = await deriveConfigFile(config, await readBridgeSettings());

  let existingLndConfigString = await diskService.fileExists(constants.UMBREL_LND_CONF_FILEPATH)
                                ? await diskService.readUtf8File(constants.UMBREL_LND_CONF_FILEPATH)
                                : '';

  // compare new config to existing umbrel-lnd conf but
  // ignore the first line as it will contained a 'generated at' timestamp
  return newLndConfigString.split(/\r?\n/).slice(2).join('\n') === existingLndConfigString.split(/\r?\n/).slice(2).join('\n');
}

async function getConfig() {
  const config = await diskService.fileExists(constants.JSON_SETTINGS_FILE)
                  ? (await diskService.readJsonFile(constants.JSON_SETTINGS_FILE)).lnd
                  : {};                
  return deriveConfigObject(await getManagedSettingsFromLndConf(), config);
}

// parses lnd.conf and returns an object of only those settings that are managed by Umbrel in [settings.json[].lnd
async function getManagedSettingsFromLndConf() {
  let configObject = {};

  if (await diskService.fileExists(constants.LND_CONF_FILEPATH)) {
    const userLndConfigString = await diskService.readUtf8File(constants.LND_CONF_FILEPATH);
    configObject = lndConfig.getManagedConfig(lndConfig.parse(userLndConfigString), DEFAULT_CONFIG);
  }
  return configObject;
}

module.exports = {
  writeLndConfig,
  isUmbrelLndConfUpToDate,
  readBridgeSettings,
  bridgeConfig,
  getConfig
}