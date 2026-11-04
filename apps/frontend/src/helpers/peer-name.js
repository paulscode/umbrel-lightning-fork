// What to call a channel's peer: its alias, or, for a peer whose node
// announcement this node has not seen (a public channel before its sixth
// confirmation, a private one, or a peer that never announces itself), the
// start and end of its public key. The alias arrives with the channel, so an
// empty one is not still loading.
export function shortPubkey(pubkey) {
  const p = String(pubkey || "");
  return p.length > 16 ? `${p.slice(0, 8)}…${p.slice(-6)}` : p;
}

export default function peerName(channel) {
  const alias = String((channel && channel.remoteAlias) || "").trim();
  return alias || shortPubkey(channel && channel.remotePubkey);
}
