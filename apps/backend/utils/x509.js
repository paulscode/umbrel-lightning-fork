// A certificate authority of the dashboard's own and the server certificate
// it signs, for the mobile API's TLS listener where nothing else terminates
// TLS (Umbrel). Node can make and verify keys but not certificates, so the
// DER is written here; the shapes are RFC 5280's and nothing more.
//
// The phone pins the authority by the SHA-256 of its certificate, so the
// authority is made once and kept: the server certificate can be reissued
// (a new name, an expiry) without pairing again.
const crypto = require("crypto");

function len(n) {
  if (n < 0x80) {
    return Buffer.from([n]);
  }
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), len(content.length), content]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const octets = (buf) => tlv(0x04, buf);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const explicit = (n, content) => tlv(0xa0 + n, content);

function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) {
    b = b.subarray(1);
  }
  if (b[0] & 0x80) {
    b = Buffer.concat([Buffer.from([0]), b]);
  }
  return tlv(0x02, b);
}

function oid(text) {
  const parts = text.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const enc = [part & 0x7f];
    let v = part >> 7;
    while (v > 0) {
      enc.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}

function bitString(buf, unused = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
}

// UTCTime through 2049, GeneralizedTime after, as RFC 5280 4.1.2.5 asks.
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  if (date.getUTCFullYear() < 2050) {
    return tlv(0x17, Buffer.from(iso.slice(2)));
  }
  return tlv(0x18, Buffer.from(iso));
}

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

function name(commonName) {
  return seq(
    set(seq(oid(OID.organization), tlv(0x0c, Buffer.from("Lightning Fork")))),
    set(seq(oid(OID.commonName), tlv(0x0c, Buffer.from(commonName))))
  );
}

function extension(id, critical, value) {
  return critical
    ? seq(oid(id), bool(true), octets(value))
    : seq(oid(id), octets(value));
}

function ipBytes(text) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return Buffer.from(text.split(".").map(Number));
  }
  return null;
}

function subjectAltNames(names) {
  const entries = [];
  for (const entry of names) {
    const ip = ipBytes(entry);
    if (ip) {
      entries.push(tlv(0x87, ip));
    } else if (/^[a-z0-9.-]+$/i.test(entry)) {
      entries.push(tlv(0x82, Buffer.from(entry.toLowerCase())));
    }
  }
  return seq(...entries);
}

function keyId(publicKey) {
  // RFC 5280 4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits.
  const spki = publicKey.export({ type: "spki", format: "der" });
  // The bit string is the last element of the SPKI sequence; for P-256 it
  // is the final 65 bytes (an uncompressed point).
  return crypto.createHash("sha1").update(spki.subarray(spki.length - 65)).digest();
}

function serial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes;
}

function toPem(der) {
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function sign({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const algorithm = seq(oid(OID.ecdsaSha256));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(serial()),
    algorithm,
    name(issuer),
    seq(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(...extensions))
  );
  const signature = crypto.sign("sha256", tbs, signingKey);
  return toPem(seq(tbs, algorithm, bitString(signature)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// {certPem, keyPem}: a P-256 authority valid for 20 years.
function createAuthority({ commonName = "Lightning Fork mobile API", now = new Date() } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ski = keyId(publicKey);
  const certPem = sign({
    subject: commonName,
    issuer: commonName,
    publicKey,
    signingKey: privateKey,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + 20 * 365 * DAY_MS),
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true), int(Buffer.from([0])))),
      // keyCertSign and cRLSign: bits 5 and 6.
      extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
      extension(OID.subjectKeyId, false, octets(ski)),
    ],
  });
  return { certPem, keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

// {certPem, keyPem}: a server certificate for `names` (host names and IPv4
// addresses), signed by the authority, valid for two years.
function createServerCert({ authority, names, now = new Date() }) {
  const caKey = crypto.createPrivateKey(authority.keyPem);
  const caCert = new crypto.X509Certificate(authority.certPem);
  const issuer = /CN=([^\n]+)/.exec(caCert.subject)[1];
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const commonName = names.find((n) => !ipBytes(n)) || names[0] || "lightning-fork";
  const certPem = sign({
    subject: commonName,
    issuer,
    publicKey,
    signingKey: caKey,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + 2 * 365 * DAY_MS),
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      // digitalSignature: bit 0.
      extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, subjectAltNames(names)),
      extension(OID.subjectKeyId, false, octets(keyId(publicKey))),
      extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId(caCert.publicKey)))),
    ],
  });
  return { certPem, keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

// The SHA-256 of a certificate's DER, upper-case hex pairs joined by colons:
// what `openssl x509 -fingerprint -sha256` prints and what the phone pins.
function fingerprint(pem) {
  return new crypto.X509Certificate(pem).fingerprint256;
}

// The certificates in a PEM bundle, in order.
function splitPem(text) {
  return (String(text || "").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map(
    (pem) => pem + "\n"
  );
}

module.exports = { createAuthority, createServerCert, fingerprint, splitPem, toPem };
