// Adding a first-party caveat to a macaroon LND baked, as lncli's
// `constrainmacaroon` does, without a macaroon library.
//
// LND bakes macaroons in the version 2 binary format of gopkg.in/macaroon.v2:
//
//   0x02
//   [location field] identifier field, end
//   for each caveat: [location field] identifier field [verification id field], end
//   end
//   signature field
//
// where a field is a type byte, its length as an unsigned varint, and its
// bytes, and "end" is a zero byte. A first-party caveat is an identifier alone,
// and adding one replaces the signature with HMAC-SHA256(old signature,
// caveat). Nothing here needs the root key, which only LND has: a caveat can
// only narrow what a macaroon allows.
const crypto = require("crypto");

const VERSION = 2;
const FIELD_EOS = 0;
const FIELD_LOCATION = 1;
const FIELD_IDENTIFIER = 2;
const FIELD_VID = 4;
const FIELD_SIGNATURE = 6;
const SIGNATURE_LENGTH = 32;

function readVarint(buf, at) {
  let value = 0;
  let shift = 0;
  for (let i = at; i < buf.length && i < at + 5; i++) {
    const byte = buf[i];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, next: i + 1 };
    }
    shift += 7;
  }
  throw new Error("macaroon: bad length");
}

function writeVarint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

// Reads one field at `at`: {type, data, next}, or {type: 0} at an end marker.
function readField(buf, at) {
  if (at >= buf.length) {
    throw new Error("macaroon: truncated");
  }
  const type = buf[at];
  if (type === FIELD_EOS) {
    return { type, next: at + 1 };
  }
  const { value: length, next } = readVarint(buf, at + 1);
  if (next + length > buf.length) {
    throw new Error("macaroon: truncated");
  }
  return { type, data: buf.subarray(next, next + length), next: next + length };
}

function field(type, data) {
  return Buffer.concat([Buffer.from([type]), writeVarint(data.length), data]);
}

// Parses a version 2 binary macaroon. Anything else, or any trailing byte, is
// refused rather than guessed at.
function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2 || buf[0] !== VERSION) {
    throw new Error("macaroon: not a version 2 macaroon");
  }
  let at = 1;
  const mac = { location: null, identifier: null, caveats: [], signature: null };

  let f = readField(buf, at);
  if (f.type === FIELD_LOCATION) {
    mac.location = f.data;
    f = readField(buf, f.next);
  }
  if (f.type !== FIELD_IDENTIFIER) {
    throw new Error("macaroon: no identifier");
  }
  mac.identifier = f.data;
  f = readField(buf, f.next);
  if (f.type !== FIELD_EOS) {
    throw new Error("macaroon: unexpected field in the header");
  }
  at = f.next;

  for (;;) {
    f = readField(buf, at);
    if (f.type === FIELD_EOS) {
      at = f.next;
      break;
    }
    const caveat = { location: null, id: null, vid: null };
    if (f.type === FIELD_LOCATION) {
      caveat.location = f.data;
      f = readField(buf, f.next);
    }
    if (f.type !== FIELD_IDENTIFIER) {
      throw new Error("macaroon: caveat without an identifier");
    }
    caveat.id = f.data;
    f = readField(buf, f.next);
    if (f.type === FIELD_VID) {
      caveat.vid = f.data;
      f = readField(buf, f.next);
    }
    if (f.type !== FIELD_EOS) {
      throw new Error("macaroon: unexpected field in a caveat");
    }
    mac.caveats.push(caveat);
    at = f.next;
  }

  f = readField(buf, at);
  if (f.type !== FIELD_SIGNATURE || f.data.length !== SIGNATURE_LENGTH) {
    throw new Error("macaroon: no signature");
  }
  mac.signature = f.data;
  if (f.next !== buf.length) {
    throw new Error("macaroon: trailing bytes");
  }
  return mac;
}

function serialize(mac) {
  const parts = [Buffer.from([VERSION])];
  if (mac.location) {
    parts.push(field(FIELD_LOCATION, mac.location));
  }
  parts.push(field(FIELD_IDENTIFIER, mac.identifier), Buffer.from([FIELD_EOS]));
  for (const caveat of mac.caveats) {
    if (caveat.location) {
      parts.push(field(FIELD_LOCATION, caveat.location));
    }
    parts.push(field(FIELD_IDENTIFIER, caveat.id));
    if (caveat.vid) {
      parts.push(field(FIELD_VID, caveat.vid));
    }
    parts.push(Buffer.from([FIELD_EOS]));
  }
  parts.push(Buffer.from([FIELD_EOS]), field(FIELD_SIGNATURE, mac.signature));
  return Buffer.concat(parts);
}

// The macaroon, as hex, with a first-party caveat added.
function addFirstPartyCaveat(macaroonHex, condition) {
  if (typeof condition !== "string" || condition.length === 0) {
    throw new Error("macaroon: empty caveat");
  }
  const mac = parse(Buffer.from(macaroonHex, "hex"));
  const id = Buffer.from(condition, "utf8");
  mac.caveats.push({ location: null, id, vid: null });
  mac.signature = crypto.createHmac("sha256", mac.signature).update(id).digest();
  return serialize(mac).toString("hex");
}

// The caveat LND's TimeoutConstraint adds: valid until `date`.
function timeBeforeCaveat(date) {
  return `time-before ${date.toISOString()}`;
}

module.exports = { parse, serialize, addFirstPartyCaveat, timeBeforeCaveat };
