// Whether a BOLT 12 offer or invoice sets option_blake2b (feature bit 512 or
// 513), read from the string itself.
//
// Every offer and invoice minted for this chain sets it; one from a node on
// the SHA256 chain does not. Their chain fields cannot tell them apart (the
// two chains share a genesis block), and the node's decode does not report
// the features, so this reads them: an offer's offer_features (type 12), an
// invoice's invoice_features (type 174).
//
// The string is bech32 without a checksum, in lowercase or uppercase, and
// may be split with "+" and whitespace. The payload is a TLV stream of BigSize
// types and lengths; a feature vector is a big-endian bitfield, bit 0 in the
// last byte.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BLAKE2B_BITS = [512, 513];
const FEATURE_TYPE = { lno: 12n, lni: 174n };

function payloadOf(text) {
  const joined = String(text || "").replace(/\+\s*/g, "").trim();
  if (joined !== joined.toLowerCase() && joined !== joined.toUpperCase()) {
    return null;
  }
  const s = joined.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1) {
    return null;
  }
  const hrp = s.slice(0, sep);
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) {
      return null;
    }
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return { hrp, bytes: Buffer.from(bytes) };
}

// One BigSize at `at`: [value, next offset], or null when truncated.
function bigSize(buf, at) {
  if (at >= buf.length) {
    return null;
  }
  const first = buf[at];
  const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (width === 0) {
    return [BigInt(first), at + 1];
  }
  if (at + 1 + width > buf.length) {
    return null;
  }
  let v = 0n;
  for (let i = 0; i < width; i++) {
    v = (v << 8n) | BigInt(buf[at + 1 + i]);
  }
  return [v, at + 1 + width];
}

function featureSet(vector, bit) {
  const byte = vector.length - 1 - Math.floor(bit / 8);
  return byte >= 0 && ((vector[byte] >> (bit % 8)) & 1) === 1;
}

// true or false for an offer (lno) or invoice (lni); null for anything
// else, or a string that cannot be read (the node's decode says why).
function setsBlake2b(text) {
  const p = payloadOf(text);
  if (!p || !(p.hrp in FEATURE_TYPE)) {
    return null;
  }
  const want = FEATURE_TYPE[p.hrp];
  let at = 0;
  while (at < p.bytes.length) {
    const t = bigSize(p.bytes, at);
    if (!t) {
      return null;
    }
    const l = bigSize(p.bytes, t[1]);
    if (!l) {
      return null;
    }
    const start = l[1];
    const end = start + Number(l[0]);
    if (end > p.bytes.length) {
      return null;
    }
    if (t[0] === want) {
      const vector = p.bytes.subarray(start, end);
      return BLAKE2B_BITS.some((bit) => featureSet(vector, bit));
    }
    // Types are in ascending order: past it, the field is absent.
    if (t[0] > want) {
      return false;
    }
    at = end;
  }
  return false;
}

module.exports = { setsBlake2b, payloadOf };
