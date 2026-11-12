// What to call a channel's peer: its alias, or, for a peer whose node
// announcement this node has not seen (a public channel before its sixth
// confirmation, a private one, or a peer that never announces itself), the
// start and end of its public key. The alias arrives with the channel, so an
// empty one is not still loading.
export function shortPubkey(pubkey) {
  const p = String(pubkey || "");
  return p.length > 16 ? `${p.slice(0, 8)}…${p.slice(-6)}` : p;
}

// The alias with the characters BOLT 1 bars from UTF-8 text taken out:
// control and format characters (so no bidirectional overrides that would
// reorder what follows) and line and paragraph separators. A peer chooses its
// alias, so it is shown as text and nothing else.
export function cleanAlias(alias) {
  return String(alias || "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/gu, "")
    .trim();
}

// Whether the channel's peer has an alias to show; without one, peerName is
// its shortened public key, which the views set apart (monospace), so an
// alias made to look like a key doesn't pass for one.
export function hasAlias(channel) {
  return cleanAlias(channel && channel.remoteAlias) !== "";
}

export default function peerName(channel) {
  return (
    cleanAlias(channel && channel.remoteAlias) ||
    shortPubkey(channel && channel.remotePubkey)
  );
}
