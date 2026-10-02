// What the dashboard shows of a watchtower the node's client knows: how many
// sessions it holds with it, across the session policies (legacy, anchor,
// taproot), and whether any policy may still open one.
//
// A tower that holds no session is the sign of one that never accepted this
// node: from 0.21.3-beta-blake2b.14, a stock lnd tower or one on an earlier
// Lightning Fork release refuses it at the handshake, while adding it still
// succeeds.
function towerSessions(tower) {
  const infos = Array.isArray(tower && tower.sessionInfo) ? tower.sessionInfo : [];
  if (infos.length) {
    return {
      sessions: infos.reduce((n, info) => n + (Number(info.numSessions) || 0), 0),
      activeCandidate: infos.some((info) => Boolean(info.activeSessionCandidate)),
    };
  }

  return {
    sessions: Number(tower && tower.numSessions) || 0,
    activeCandidate: Boolean(tower && tower.activeSessionCandidate),
  };
}

module.exports = { towerSessions };
