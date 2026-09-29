// Pure helpers over what lnd reports about a node, kept apart from
// logic/lightning.js so they can be tested without the lnd client.

// The addresses a node announces in its node_announcement that someone
// opening a channel to it can dial, clearnet first: they connect directly,
// where an .onion address needs Tor on the side that dials. Only TCP
// addresses are kept; lnd reports an address type it does not know as a hex
// string, which is nothing anyone could dial. Duplicates are dropped.
function announcedAddresses(node) {
  const addrs = ((node && node.addresses) || [])
    .filter(a => a && a.addr && (!a.network || a.network === "tcp"))
    .map(a => a.addr);
  const unique = [...new Set(addrs)];
  const onion = a => /\.onion(:\d+)?$/i.test(a);

  return unique.filter(a => !onion(a)).concat(unique.filter(onion));
}

// Whether a daemon of this version reports option_unified_sigs per channel,
// which Lightning Fork does from 0.21.3-beta-blake2b.13. The release number
// after "-blake2b." counts the fork's releases and never restarts, whatever
// the lnd base underneath.
function reportsUnifiedSigs(version) {
  const m = /-blake2b\.(\d+)/.exec(version || "");
  return m !== null && parseInt(m[1], 10) >= 13;
}

module.exports = { announcedAddresses, reportsUnifiedSigs };
