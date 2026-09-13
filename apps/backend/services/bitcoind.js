const fs = require("fs");
const RpcClient = require("bitcoind-rpc");
const camelizeKeys = require("camelize-keys");

const BitcoindError = require("models/errors.js").BitcoindError;
const constants = require("utils/const.js");

const BITCOIND_RPC_PORT = process.env.RPC_PORT || 8332; // eslint-disable-line no-magic-numbers, max-len
const BITCOIND_HOST = process.env.BITCOIN_HOST || "127.0.0.1";
const BITCOIND_RPC_USER = process.env.RPC_USER;
const BITCOIND_RPC_PASSWORD = process.env.RPC_PASSWORD;

// The library bakes the credentials into the client when it is built, so a
// client is built per call: StartOS hands over the node's cookie file, which
// the node rewrites at every start, rather than a fixed username and password.
function credentials() {
  if (constants.RPC_COOKIE_FILE) {
    try {
      const cookie = fs.readFileSync(constants.RPC_COOKIE_FILE, "utf8").trim();
      const colon = cookie.indexOf(":");
      if (colon === -1) {
        // Truncated or half-written: fail the call rather than try a
        // plausible-looking username against the node.
        return { user: "", pass: "" };
      }
      return { user: cookie.slice(0, colon), pass: cookie.slice(colon + 1) };
    } catch (error) {
      // The node is down or not yet started; the call fails as it should.
      return { user: "", pass: "" };
    }
  }
  return { user: BITCOIND_RPC_USER, pass: BITCOIND_RPC_PASSWORD };
}

function client() {
  const { user, pass } = credentials();
  return new RpcClient({
    protocol: "http",
    user, // eslint-disable-line object-shorthand
    pass, // eslint-disable-line object-shorthand
    host: BITCOIND_HOST,
    port: BITCOIND_RPC_PORT,
  });
}

// Method lookup only; every call runs against a client built for it.
const rpcClient = RpcClient.prototype;

function promiseify(rpcObj, rpcFn, what) {
  return new Promise((resolve, reject) => {
    try {
      rpcFn.call(client(), (err, info) => {
        if (err) {
          reject(new BitcoindError(`Unable to obtain ${what}`, err));
        } else {
          resolve(camelizeKeys(info, "_"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function promiseifyParam(rpcObj, rpcFn, param, what) {
  return new Promise((resolve, reject) => {
    try {
      rpcFn.call(client(), param, (err, info) => {
        if (err) {
          reject(new BitcoindError(`Unable to obtain ${what}`, err));
        } else {
          resolve(camelizeKeys(info, "_"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function promiseifyParamTwo(rpcObj, rpcFn, param1, param2, what) {
  return new Promise((resolve, reject) => {
    try {
      rpcFn.call(client(), param1, param2, (err, info) => {
        if (err) {
          reject(new BitcoindError(`Unable to obtain ${what}`, err));
        } else {
          resolve(camelizeKeys(info, "_"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function getBestBlockHash() {
  return promiseify(rpcClient, rpcClient.getBestBlockHash, "best block hash");
}

function getBlockHash(height) {
  return promiseifyParam(
    rpcClient,
    rpcClient.getBlockHash,
    height,
    "block height"
  );
}

function getBlock(hash) {
  return promiseifyParam(rpcClient, rpcClient.getBlock, hash, "block info");
}

function getTransaction(txid) {
  return promiseifyParamTwo(
    rpcClient,
    rpcClient.getRawTransaction,
    txid,
    1,
    "transaction info"
  );
}

function getBlockChainInfo() {
  return promiseify(rpcClient, rpcClient.getBlockchainInfo, "blockchain info");
}

function getPeerInfo() {
  return promiseify(rpcClient, rpcClient.getPeerInfo, "peer info");
}

function getBlockCount() {
  return promiseify(rpcClient, rpcClient.getBlockCount, "block count");
}

function getMempoolInfo() {
  return promiseify(rpcClient, rpcClient.getMemPoolInfo, "get mempool info");
}

function getNetworkInfo() {
  return promiseify(rpcClient, rpcClient.getNetworkInfo, "network info");
}

function getMiningInfo() {
  return promiseify(rpcClient, rpcClient.getMiningInfo, "mining info");
}
function help() {
  // TODO: missing from the library, but can add it not sure how to package.
  // rpc.uptime(function (err, res) {
  //     if (err) {
  //         deferred.reject({status: 'offline'});
  //     } else {
  //         deferred.resolve({status: 'online'});
  //     }
  // });
  return promiseify(rpcClient, rpcClient.help, "help data");
}

module.exports = {
  getMiningInfo,
  getBestBlockHash,
  getBlockHash,
  getBlock,
  getTransaction,
  getBlockChainInfo,
  getBlockCount,
  getPeerInfo,
  getMempoolInfo,
  getNetworkInfo,
  help,
};
