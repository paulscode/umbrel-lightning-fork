// The channel-backup module's pure parts and its handling of the agent's
// configuration file: what the dashboard may see, what a save writes, and
// what the agent's exit codes mean. The agent itself is exercised against a
// real SFTP server outside the unit tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-cb-"));
process.env.LND_DIR = dir;
process.env.CHANNEL_BACKUP_FILE = path.join(dir, "channel.backup");
const cb = require("../logic/channelBackup.js");

test("folders are relative and clean, ports are numbers in range", () => {
  assert.equal(cb.folder(""), cb.DEFAULT_FOLDER);
  assert.equal(cb.folder(" backups/lnd "), "backups/lnd");
  for (const bad of ["/abs", "..", "a/../b", "\\\\share"]) {
    assert.throws(() => cb.folder(bad), cb.InputError, bad);
  }
  assert.equal(cb.port(""), "22");
  assert.equal(cb.port("2222"), "2222");
  for (const bad of ["0", "65536", "abc", "22 "]) {
    if (bad === "22 ") {
      assert.equal(cb.port(bad), "22");
    } else {
      assert.throws(() => cb.port(bad), cb.InputError, bad);
    }
  }
  assert.throws(() => cb.line("a" + String.fromCharCode(7) + "b", "X"), cb.InputError);
});

test("an authorization code is found in a redirect URL, a fragment or on its own", () => {
  assert.equal(cb.extractAuthCode("http://localhost/?code=4%2F0Abc-def&scope=drive"), "4/0Abc-def");
  assert.equal(cb.extractAuthCode("code=xyz"), "xyz");
  assert.equal(cb.extractAuthCode("  raw-code  "), "raw-code");
  assert.equal(cb.extractAuthCode(""), "");
  const token = JSON.parse(cb.tokenFromRefresh("r-1", true));
  assert.equal(token.refresh_token, "r-1");
  assert.equal(token.token_type, "Bearer");
  assert.equal(JSON.parse(cb.tokenFromRefresh("r-2", false)).token_type, "bearer");
});

test("the authorization page carries the client id and asks for an offline grant", () => {
  const g = new URL(cb.authUrl("gdrive", "cid"));
  assert.equal(g.hostname, "accounts.google.com");
  assert.equal(g.searchParams.get("access_type"), "offline");
  assert.equal(g.searchParams.get("client_id"), "cid");
  const d = new URL(cb.authUrl("dropbox", "key"));
  assert.equal(d.searchParams.get("token_access_type"), "offline");
  assert.throws(() => cb.authUrl("gdrive", ""), cb.InputError);
  assert.throws(() => cb.authUrl("box", "x"), cb.InputError);
});

test("readiness follows the agent's has_creds", () => {
  assert.equal(cb.ready("sftp", { host: "h", user: "u", hostKeyVerified: true, authType: "password", pass: "p" }), true);
  assert.equal(cb.ready("sftp", { host: "h", user: "u", hostKeyVerified: false, authType: "password", pass: "p" }), false, "an unverified host key is not ready");
  assert.equal(cb.ready("sftp", { host: "h", user: "u", hostKeyVerified: true, authType: "key", keyPem: null }), false);
  assert.equal(cb.ready("nextcloud", { url: "https://x", user: "u", pass: "p" }), true);
  assert.equal(cb.ready("dropbox", { clientId: "a", clientSecret: "b", token: null }), false);
  assert.equal(cb.ready("gdrive", { clientId: "a", clientSecret: "b", token: "{}" }), true);
  assert.equal(cb.ready("sftp", null), false);
});

test("a saved Nextcloud target is written in the agent's shape, with its secret kept out of the public view", async () => {
  const r = await cb.saveProvider("nextcloud", { enabled: true, url: "https://cloud.example/remote.php/dav/files/u/", user: "u", pass: "secret", path: "lnd" });
  assert.match(r.message, /copied to Nextcloud/);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "channel-backup.json"), "utf8"));
  assert.equal(onDisk.nextcloud.pass, "secret");
  assert.equal(onDisk.nextcloud.enabled, true);
  assert.equal(onDisk.sftp, null);
  assert.equal((fs.statSync(path.join(dir, "channel-backup.json")).mode & 0o777), 0o600);
  const pub = cb.publicConfig();
  assert.equal(pub.nextcloud.hasPass, true);
  assert.equal("pass" in pub.nextcloud, false, "the secret itself never leaves the module");
  assert.equal(pub.nextcloud.ready, true);

  // A blank password keeps the stored one; forget drops it.
  await cb.saveProvider("nextcloud", { enabled: true, url: "https://cloud.example/remote.php/dav/files/u/", user: "u", pass: "", path: "lnd" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "channel-backup.json"), "utf8")).nextcloud.pass, "secret");
  await cb.saveProvider("nextcloud", { enabled: false, url: "https://cloud.example/", user: "u", forget: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "channel-backup.json"), "utf8")).nextcloud.pass, null);
  await assert.rejects(cb.saveProvider("nextcloud", { enabled: true, url: "cloud.example", user: "u", pass: "p" }), cb.InputError);
});

test("an OAuth target takes a refresh token straight, and stays not ready without one", async () => {
  await cb.saveProvider("dropbox", { enabled: true, clientId: "key", clientSecret: "sec", refreshToken: "rt", path: "" });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "channel-backup.json"), "utf8"));
  assert.equal(JSON.parse(onDisk.dropbox.token).refresh_token, "rt");
  assert.equal(onDisk.dropbox.path, cb.DEFAULT_FOLDER);
  assert.equal(cb.publicConfig().dropbox.ready, true);
  await cb.saveProvider("gdrive", { enabled: true, clientId: "id", clientSecret: "s" });
  assert.equal(cb.publicConfig().gdrive.ready, false);
  assert.equal(cb.status().targets.map(t => `${t.provider}:${t.ready}`).join(","), "dropbox:true,gdrive:false");
});

test("status reads the agent's state file and notices the backup file", () => {
  fs.writeFileSync(path.join(dir, ".channel-backup-state.json"), JSON.stringify({ attempt: 3, lastSuccess: 1700000000, failures: [{ target: "sftp", code: "upload", detail: "no route" }] }));
  const s = cb.status();
  assert.equal(s.state.attempt, 3);
  assert.equal(s.state.lastSuccess, 1700000000);
  assert.deepEqual(s.state.failures, [{ target: "sftp", code: "upload", detail: "no route" }]);
  assert.equal(s.hasBackup, false);
  fs.writeFileSync(process.env.CHANNEL_BACKUP_FILE, "x");
  assert.equal(cb.status().hasBackup, true);
  fs.writeFileSync(path.join(dir, ".channel-backup-state.json"), "garbage");
  assert.deepEqual(cb.readState(), { attempt: 0, lastSuccess: null, failures: [] });
});

test("a pulled copy is read back by provider name only", () => {
  fs.mkdirSync(path.join(dir, ".channel-backup-restore"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".channel-backup-restore", "sftp"), "scb-bytes");
  assert.equal(cb.pulledBackup("sftp").toString(), "scb-bytes");
  assert.throws(() => cb.pulledBackup("../channel-backup.json"), cb.InputError);
  assert.throws(() => cb.pulledBackup("nextcloud"), /ENOENT/);
});
