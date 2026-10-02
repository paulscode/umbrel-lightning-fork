// The dashboard's Peers view: the node's connected peers, connecting to one
// without opening a channel, and disconnecting from one it has no channel
// with. Kept apart from logic/lightning.js so it loads with nothing but the
// lnd service.
const { ValidationError } = require("models/errors.js");
const lndService = require("services/lnd.js");
const { parsePeerAddress } = require("utils/peerAddress.js");

const PUBKEY = /^0[23][0-9a-f]{64}$/;

async function aliasOf(pubKey) {
  try {
    const info = await lndService.getNodeInfo(pubKey, false);
    return (info && info.node && info.node.alias) || "";
  } catch (error) {
    // A peer this node has no announcement for has no alias.
    return "";
  }
}

// Each peer's alias, the address the connection uses, which side opened it,
// and how many open channels this node has with it.
async function listPeers() {
  const [peers, channels] = await Promise.all([
    lndService.getPeers(),
    lndService.getOpenChannels(),
  ]);

  const channelCount = {};
  for (const channel of channels || []) {
    channelCount[channel.remotePubkey] =
      (channelCount[channel.remotePubkey] || 0) + 1;
  }

  return Promise.all(
    peers.map(async (peer) => ({
      pubKey: peer.pubKey,
      alias: await aliasOf(peer.pubKey),
      address: peer.address || "",
      inbound: Boolean(peer.inbound),
      channels: channelCount[peer.pubKey] || 0,
    }))
  );
}

// Connects to a peer given as pubkey@host[:port]. Already being connected
// counts as success.
async function connectPeer(address) {
  const { pubKey, hostPort } = parsePeerAddress(address);

  try {
    await lndService.connectPeer(pubKey, hostPort);
  } catch (error) {
    const details = (error && error.error && error.error.details) || "";
    if (!/already connected/i.test(details)) {
      throw error;
    }
  }

  return { pubKey };
}

// Disconnects from a peer this node holds no channel with; for one it does,
// closing the channel is the way.
async function disconnectPeer(pubKey) {
  const key = String(pubKey || "").toLowerCase();
  if (!PUBKEY.test(key)) {
    throw new ValidationError("That is not a node public key");
  }

  const channels = await lndService.getOpenChannels();
  if ((channels || []).some((channel) => channel.remotePubkey === key)) {
    throw new ValidationError(
      "This node has a channel with that peer; close the channel instead"
    );
  }

  await lndService.disconnectPeer(key);

  return { pubKey: key };
}

module.exports = { listPeers, connectPeer, disconnectPeer };
