const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const x509 = require("../utils/x509.js");

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

test("the authority signs a server certificate for the names asked", () => {
  const authority = x509.createAuthority();
  const ca = new crypto.X509Certificate(authority.certPem);
  assert.ok(ca.ca);
  assert.ok(ca.checkIssued(ca), "the authority is self-signed");
  const server = x509.createServerCert({ authority, names: ["umbrel.local", "192.168.1.20", "abc.onion"] });
  const cert = new crypto.X509Certificate(server.certPem);
  assert.ok(!cert.ca);
  assert.ok(cert.checkIssued(ca));
  assert.ok(cert.verify(ca.publicKey));
  assert.equal(cert.checkHost("umbrel.local"), "umbrel.local");
  assert.equal(cert.checkIP("192.168.1.20"), "192.168.1.20");
  assert.equal(cert.checkHost("other.local"), undefined);
  // The key belongs to the certificate.
  const key = crypto.createPrivateKey(server.keyPem);
  const sig = crypto.sign("sha256", Buffer.from("x"), key);
  assert.ok(crypto.verify("sha256", Buffer.from("x"), cert.publicKey, sig));
});

test("validity runs past 2049 in GeneralizedTime", () => {
  const authority = x509.createAuthority({ now: new Date("2040-01-01T00:00:00Z") });
  const ca = new crypto.X509Certificate(authority.certPem);
  assert.equal(new Date(ca.validTo).getUTCFullYear(), 2059);
});

test("the fingerprint is openssl's whole-certificate SHA-256", { skip: !hasOpenssl() }, () => {
  const authority = x509.createAuthority();
  const server = x509.createServerCert({ authority, names: ["localhost"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x509-"));
  fs.writeFileSync(path.join(dir, "ca.pem"), authority.certPem);
  fs.writeFileSync(path.join(dir, "leaf.pem"), server.certPem);
  const out = execFileSync("openssl", ["x509", "-in", path.join(dir, "ca.pem"), "-noout", "-fingerprint", "-sha256"], {
    encoding: "utf8",
  });
  assert.equal(out.trim().split("=")[1], x509.fingerprint(authority.certPem));
  const verify = execFileSync(
    "openssl",
    ["verify", "-CAfile", path.join(dir, "ca.pem"), "-purpose", "sslserver", path.join(dir, "leaf.pem")],
    { encoding: "utf8" }
  );
  assert.match(verify, /OK/);
});

test("a bundle splits into its certificates", () => {
  const a = x509.createAuthority();
  const b = x509.createAuthority();
  const parts = x509.splitPem(a.certPem + b.certPem);
  assert.equal(parts.length, 2);
  assert.equal(x509.fingerprint(parts[1]), x509.fingerprint(b.certPem));
  assert.deepEqual(x509.splitPem(""), []);
});
