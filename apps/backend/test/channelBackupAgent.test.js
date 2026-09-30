// How the dashboard runs the backup agent now that each node has its own
// folder on every target: the agent names that folder after the node's
// identity pubkey, which it cannot read for itself in this image (no lncli),
// so the dashboard passes it as NODE_PUBKEY, waits for it before starting
// the watcher, and says so when the agent exits 7 without it. A stub agent
// stands in for backup-agent.sh; the real one is tested in its own
// repository (tests/backup-agent.test.sh).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-cb-agent-"));
const seen = path.join(dir, "seen");
const stub = path.join(dir, "agent.sh");
// Records the arguments and NODE_PUBKEY it ran with, then exits with
// $STUB_EXIT, or 7 without a pubkey as the real agent does. The watcher form
// (no arguments) stays up until killed.
fs.writeFileSync(stub, `#!/bin/sh
printf '%s|%s\\n' "$*" "\${NODE_PUBKEY:-}" >> "${seen}"
[ -n "\${NODE_PUBKEY:-}" ] || exit 7
if [ -z "$*" ]; then
  trap 'exit 0' TERM
  while :; do sleep 0.05; done
fi
[ "$1" = --pull ] && echo '{"retrieved":[],"unreachable":[]}'
exit "\${STUB_EXIT:-0}"
`);
process.env.LND_DIR = dir;
process.env.CHANNEL_BACKUP_FILE = path.join(dir, "channel.backup");
process.env.BACKUP_AGENT = stub;
const cb = require("../logic/channelBackup.js");

const KEY = "03" + "ab".repeat(32);
const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").trim().split("\n").filter(Boolean) : []);
const reset = () => fs.rmSync(seen, {force: true});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) {
      return false;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  return true;
};

test("the node's pubkey is taken only when it is one, and only from LND", async () => {
  cb.setPubkeySource(async () => KEY.toUpperCase());
  assert.equal(await cb.nodePubkey(), KEY, "LND's hex, whatever its case");
  for (const bad of ["", null, "04" + "ab".repeat(32), KEY + "00", "not a key"]) {
    cb.setPubkeySource(async () => bad);
    assert.equal(await cb.nodePubkey(), null, String(bad));
  }
  cb.setPubkeySource(async () => {
    throw new Error("wallet locked");
  });
  assert.equal(await cb.nodePubkey(), null, "LND not answering is not an identity");
});

test("Back up now hands the agent the pubkey", async () => {
  reset();
  cb.setPubkeySource(async () => KEY);
  const r = await cb.backupNow();
  assert.equal(r.ok, true);
  assert.deepEqual(runs(), [`--once|${KEY}`]);
});

test("without the identity, Back up now and a restore's pull say why", async () => {
  reset();
  cb.setPubkeySource(async () => {
    throw new Error("wallet locked");
  });
  const r = await cb.backupNow();
  assert.equal(r.ok, false);
  assert.match(r.message, /identity/);
  assert.deepEqual(runs(), ["--once|"], "the agent ran, with no NODE_PUBKEY");
  const p = await cb.pull();
  assert.deepEqual(p.retrieved, []);
  assert.match(p.message, /identity/);
});

test("a pull with the identity passes it and reads the agent's summary", async () => {
  reset();
  cb.setPubkeySource(async () => KEY);
  const p = await cb.pull();
  assert.equal(p.message, null);
  assert.deepEqual(runs(), [`--pull|${KEY}`]);
});

test("the watcher waits for the identity, then runs with it, and follows a change", async () => {
  reset();
  let key = null;
  cb.setPubkeySource(async () => key);
  const logs = [];
  cb.startWatcher(m => logs.push(m), {retryMs: 50, checkMs: 50});
  try {
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(runs(), [], "no watcher runs without an identity");
    assert.ok(logs.some(m => /waiting for LND/.test(m)));
    key = KEY;
    assert.ok(await until(() => runs().length === 1), "started once the identity is known");
    assert.deepEqual(runs(), [`|${KEY}`]);
    const other = "02" + "cd".repeat(32);
    key = other;
    assert.ok(await until(() => runs().length === 2), "restarted for the new identity");
    assert.equal(runs()[1], `|${other}`);
    assert.ok(logs.some(m => /identity changed/.test(m)));
  } finally {
    cb.stopWatcher();
  }
});
