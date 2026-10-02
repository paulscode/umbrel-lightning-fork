const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const access = require("../logic/mobileAccess.js");
const x509 = require("../utils/x509.js");

const ONION = "a".repeat(56) + ".onion";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mobile-access-"));
}

test("Umbrel: the API's own port on the address the page was opened at", () => {
  const env = { MOBILE_TLS_PORT: "3443", MOBILE_PUBLIC_PORT: "7157", DEVICE_DOMAIN_NAME: "umbrel.local", MOBILE_ONION: ONION };
  assert.deepEqual(access.endpoints({ headers: { host: "umbrel.local:7156" } }, env), {
    onionUrl: `https://${ONION}`,
    lanUrl: "https://umbrel.local:7157",
    lanIp: null,
  });
  assert.deepEqual(access.endpoints({ headers: { host: "192.168.1.20:7156" } }, env), {
    onionUrl: `https://${ONION}`,
    lanUrl: "https://umbrel.local:7157",
    lanIp: "https://192.168.1.20:7157",
  });
  // A page opened over the app's onion: no LAN host from the request.
  const viaTor = access.endpoints({ headers: { host: "b".repeat(56) + ".onion" } }, { ...env, MOBILE_ONION: "not-an-onion" });
  assert.equal(viaTor.onionUrl, null);
  assert.equal(viaTor.lanUrl, "https://umbrel.local:7157");
});

test("StartOS: the package's address list, with the page's own address preferred", () => {
  const dir = tmpdir();
  const file = path.join(dir, "endpoints.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      onion: [`http://${ONION}`],
      lan: ["https://quiet-otter.local:49152"],
      ip: ["https://192.168.1.9:49152"],
    })
  );
  const env = { MOBILE_ENDPOINTS_FILE: file };
  assert.deepEqual(access.endpoints({ headers: { host: ONION } }, env), {
    onionUrl: `http://${ONION}`,
    lanUrl: "https://quiet-otter.local:49152",
    lanIp: "https://192.168.1.9:49152",
  });
  assert.equal(access.endpoints({ headers: { host: "192.168.1.9:49153" } }, env).lanIp, "https://192.168.1.9:49153");
  // Without the file, the page's address alone.
  assert.deepEqual(access.endpoints({ headers: { host: "quiet-otter.local:49152" } }, {}), {
    onionUrl: null,
    lanUrl: "https://quiet-otter.local:49152",
    lanIp: null,
  });
});

test("the root of a chain is what the phone pins; a lone self-signed cert is not a root", () => {
  const dir = tmpdir();
  const root = x509.createAuthority();
  const leaf = x509.createServerCert({ authority: root, names: ["x.local"] });
  const chainFile = path.join(dir, "tls.cert");
  fs.writeFileSync(chainFile, leaf.certPem + root.certPem);
  assert.equal(x509.fingerprint(access.rootCaPem({ MOBILE_CA_FILE: chainFile }, dir)), x509.fingerprint(root.certPem));
  fs.writeFileSync(chainFile, root.certPem);
  assert.equal(access.rootCaPem({ MOBILE_CA_FILE: chainFile }, dir), null);
  assert.equal(access.rootCaPem({}, dir), null);
});

test("the own authority is made once; the server cert is reissued only when the names change", () => {
  const dir = tmpdir();
  const first = access.ensureServerCert(["umbrel.local", ONION], dir);
  const again = access.ensureServerCert([ONION, "umbrel.local"], dir);
  assert.equal(first.cert, again.cert);
  const moved = access.ensureServerCert(["umbrel.local", ONION, "localhost"], dir);
  assert.notEqual(moved.cert, first.cert);
  assert.equal(moved.caPem, first.caPem, "the pinned authority stays");
  const leaf = new crypto.X509Certificate(x509.splitPem(moved.cert)[0]);
  assert.equal(leaf.checkHost("localhost"), "localhost");
  assert.ok(leaf.checkIssued(new crypto.X509Certificate(moved.caPem)));
  assert.equal(access.rootCaPem({ MOBILE_TLS_PORT: "3443" }, dir), first.caPem);
  const mode = fs.statSync(path.join(dir, "mobile-ca.key")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("an expiring server certificate is reissued", () => {
  const dir = tmpdir();
  const first = access.ensureServerCert(["umbrel.local"], dir, new Date());
  const later = access.ensureServerCert(["umbrel.local"], dir, new Date(Date.now() + 710 * 24 * 3600 * 1000));
  assert.notEqual(later.cert, first.cert);
});

test("half an authority is not silently replaced", () => {
  const dir = tmpdir();
  access.ensureAuthority(dir);
  fs.unlinkSync(path.join(dir, "mobile-ca.pem"));
  assert.throws(() => access.ensureAuthority(dir), /missing/);
  assert.ok(fs.existsSync(path.join(dir, "mobile-ca.key")), "the key is kept");
});
