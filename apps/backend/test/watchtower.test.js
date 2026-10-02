// How a watchtower's sessions are summed for the Advanced Settings list.
const test = require("node:test");
const assert = require("node:assert/strict");

const { towerSessions } = require("../utils/watchtower.js");

test("sessions are summed across policies", () => {
  assert.deepEqual(towerSessions({
    sessionInfo: [
      { policyType: "LEGACY", numSessions: 1, activeSessionCandidate: false },
      { policyType: "ANCHOR", numSessions: 2, activeSessionCandidate: true },
      { policyType: "TAPROOT", numSessions: 0, activeSessionCandidate: false },
    ],
  }), { sessions: 3, activeCandidate: true });
});

test("a tower that refused this node holds none", () => {
  assert.deepEqual(towerSessions({
    sessionInfo: [{ numSessions: 0, activeSessionCandidate: true }],
  }), { sessions: 0, activeCandidate: true });
});

test("older responses without per-policy info, and nothing at all", () => {
  assert.deepEqual(towerSessions({ numSessions: "4", activeSessionCandidate: true }),
    { sessions: 4, activeCandidate: true });
  assert.deepEqual(towerSessions({}), { sessions: 0, activeCandidate: false });
  assert.deepEqual(towerSessions(null), { sessions: 0, activeCandidate: false });
});
