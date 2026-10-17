// Signing in to Google Drive and Dropbox for channel backups: the date Google
// will end a sign-in, a refused sign-in offered the authorization page again,
// a plain message for a client Google refuses, and how the agent's signin and
// nocreds records read. Google's token endpoint is a stub in place of
// https.request.
const test = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("events");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-cb-signin-"));
process.env.LND_DIR = dir;
process.env.CHANNEL_BACKUP_FILE = path.join(dir, "channel.backup");
const cb = require("../logic/channelBackup.js");

const configFile = path.join(dir, "channel-backup.json");
const stateFile = path.join(dir, ".channel-backup-state.json");

// The next answer Google's token endpoint gives, and what it was asked.
let answer = {};
let asked = null;
https.request = (options, onResponse) => {
  const req = new EventEmitter();
  req.end = body => {
    asked = {host: options.host, path: options.path, body: String(body)};
    const res = new EventEmitter();
    onResponse(res);
    res.emit("data", JSON.stringify(answer));
    res.emit("end");
  };
  req.destroy = () => {};
  return req;
};

test("Google's refresh_token_expires_in gives the date it will end the sign-in", async () => {
  const now = Date.UTC(2026, 9, 17, 12);
  assert.equal(cb.googleSigninEnds({refresh_token_expires_in: 604799}, now).toISOString(), "2026-10-24T11:59:59.000Z");
  for (const r of [{}, {refresh_token_expires_in: 0}, {refresh_token_expires_in: "soon"}, null]) {
    assert.equal(cb.googleSigninEnds(r, now), null, JSON.stringify(r));
  }

  answer = {access_token: "at", refresh_token: "rt", expires_in: 3599, refresh_token_expires_in: 604799};
  const r = await cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: "cs", authCode: "code-1"});
  assert.equal(asked.host, "oauth2.googleapis.com");
  const ends = new Date(r.signinEnds);
  assert.ok(Math.abs(ends - (Date.now() + 604799 * 1000)) < 60 * 1000, r.signinEnds);
  assert.match(r.message, new RegExp(`Google will end this sign-in on ${r.signinEnds.slice(0, 10)}, because the Google Cloud app is still in Testing`));
  assert.match(r.message, /publishing needs a home page, a privacy policy link and an authorized domain under Branding, and no logo\./);
  assert.equal(JSON.parse(JSON.parse(fs.readFileSync(configFile, "utf8")).gdrive.token).refresh_token, "rt");

  // A published app's sign-in carries no end, and gets no warning.
  answer = {access_token: "at2", refresh_token: "rt2", expires_in: 3599};
  const published = await cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: "", authCode: "code-2"});
  assert.equal(published.signinEnds, null);
  assert.doesNotMatch(published.message, /will end this sign-in/);
});

test("a client ID and secret Google refuses get a plain message, and nothing is saved", async () => {
  const before = fs.readFileSync(configFile, "utf8");
  answer = {error: "invalid_client", error_description: "Unauthorized"};
  await assert.rejects(cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: "wrong", authCode: "code-3"}),
    /^Error: Google refused this client ID and client secret\. Copy both again from the same client in Google Cloud\.$/);
  assert.equal(fs.readFileSync(configFile, "utf8"), before);
});

test("while a refused sign-in is on record, saving offers the authorization page again", async () => {
  fs.writeFileSync(stateFile, JSON.stringify({attempt: 4, lastSuccess: null, failures: [{target: "gdrive", code: "signin", detail: ""}]}));
  assert.equal(cb.publicConfig().gdrive.signinRefused, true);
  assert.deepEqual(cb.status().targets, [{provider: "gdrive", ready: false}], "not ready until a new sign-in");

  const r = await cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: "", path: "elsewhere"});
  assert.match(r.message, /^Google refused the saved sign-in\. Open the authorization page/);
  const url = new URL(r.authorizeUrl);
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).gdrive.path, "elsewhere", "the rest of the save still happens");

  // A new code, or a pasted refresh token, is the new sign-in.
  answer = {access_token: "at4", refresh_token: "rt4", expires_in: 3599};
  assert.equal((await cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: "", authCode: "code-4"})).authorizeUrl, null);
  assert.equal((await cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: "", refreshToken: "rt5"})).authorizeUrl, null);
  // Turned off, it is not asked for.
  assert.equal((await cb.saveProvider("gdrive", {enabled: false, clientId: "cid", clientSecret: ""})).authorizeUrl, null);
  // Another target's refusal is not this one's.
  fs.writeFileSync(stateFile, JSON.stringify({failures: [{target: "dropbox", code: "signin", detail: ""}]}));
  assert.equal((await cb.saveProvider("gdrive", {enabled: true, clientId: "cid", clientSecret: ""})).authorizeUrl, null);
  assert.equal(cb.publicConfig().gdrive.signinRefused, false);
});

test("the agent's signin and nocreds records read as sentences", () => {
  const said = (target, code) => cb.failureMessage({target, code, detail: ""});
  assert.equal(said("gdrive", "signin"),
    "Google Drive: Google refused the saved sign-in. Sign in again in Channel backups. While the Google Cloud app is in Testing, Google ends every sign-in after 7 days; publishing the app stops that.");
  assert.equal(said("dropbox", "signin"), "Dropbox: the saved sign-in was refused. Sign in again in Channel backups.");
  assert.equal(said("dropbox", "nocreds"), "Dropbox: not signed in yet. Finish the sign-in in Channel backups.");
  assert.equal(said("sftp", "nocreds"), "SFTP: its saved settings are incomplete. Save it again in Channel backups.");
  assert.equal(cb.failureMessage({target: "nextcloud", code: "upload", detail: "401"}), "Nextcloud: upload (401)");

  fs.writeFileSync(stateFile, JSON.stringify({failures: [{target: "gdrive", code: "signin", detail: ""}]}));
  assert.match(cb.readState().failures[0].message, /^Google Drive: Google refused the saved sign-in/);
});
