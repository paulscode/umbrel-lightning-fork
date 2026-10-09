const encode = require("lndconnect").encode;

const diskLogic = require("logic/disk");
const NodeError = require("models/errors.js").NodeError;

const constants = require("utils/const.js");

async function getSeed() {
  try {
    const { seed } = await diskLogic.readUserFile();

    return { seed: seed.split(",") };
  } catch (error) {
    console.log("error: ", error);
    throw new NodeError("Unable to retrieve mnemonic seed");
  }
}

async function getTermsAcknowledge() {
  try {
    const terms = await diskLogic.readTermsAcknowledgeFile();
    return terms.accepted;
  } catch (error) {
    throw new NodeError("Unable to get terms status");
  }
}

async function writeTermsAcknowledge() {
  try {
    const status = await diskLogic.writeTermsAcknowledgeFile();
    return status;
  } catch (error) {
    throw new NodeError("Unable to write terms status");
  }
}

// lndconnect URLs for the admin macaroon, or for another one given as bytes
// (a macaroon just made in the Macaroons view).
async function getLndConnectUrls(macaroonOverride = null) {
  let cert;
  try {
    cert = await diskLogic.readLndCert();
  } catch (error) {
    throw new NodeError("Unable to read lnd cert file");
  }

  let macaroon = macaroonOverride;
  if (!macaroon) {
    try {
      macaroon = await diskLogic.readLndAdminMacaroon();
    } catch (error) {
      throw new NodeError("Unable to read lnd macaroon file");
    }
  }

  // For a macaroon made in the Macaroons view, an address that can't be
  // read is left out rather than failing the rest; the Connect wallet view
  // shows all four or none.
  const torUrl = (readHost, port) => {
    let host;
    try {
      host = readHost();
    } catch (error) {
      if (macaroonOverride) {
        return undefined;
      }
      throw new NodeError("Unable to read lnd hidden service hostname");
    }
    return encode({ host: `${host}:${port}`, cert, macaroon });
  };
  const restTor = torUrl(() => diskLogic.readLndRestHiddenService(), constants.LND_REST_PORT);
  const grpcTor = torUrl(() => diskLogic.readLndGrpcHiddenService(), constants.LND_GRPC_PORT);

  let restLocalHost = `${constants.DEVICE_DOMAIN_NAME}:${constants.LND_REST_PORT}`;
  const restLocal = encode({
    host: restLocalHost,
    cert,
    macaroon
  });

  let grpcLocalHost = `${constants.DEVICE_DOMAIN_NAME}:${constants.LND_GRPC_PORT}`;
  const grpcLocal = encode({
    host: grpcLocalHost,
    cert,
    macaroon
  });

  return {
    restTor,
    restLocal,
    grpcTor,
    grpcLocal
  };
}

module.exports = {
  getSeed,
  getTermsAcknowledge,
  writeTermsAcknowledge,
  getLndConnectUrls
};
