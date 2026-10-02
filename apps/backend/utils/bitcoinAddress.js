// Recognises a Bitcoin address for the network the node runs on, without
// asking the node: segwit addresses by their bech32 or bech32m checksum
// (BIP 173, BIP 350), legacy ones by their base58check checksum. The BLAKE2b
// chain changed proof of work, not addresses, so these are Bitcoin's own
// prefixes.
const crypto = require("crypto");

const NETWORKS = {
  mainnet: { hrp: "bc", p2pkh: 0x00, p2sh: 0x05 },
  testnet: { hrp: "tb", p2pkh: 0x6f, p2sh: 0xc4 },
  testnet4: { hrp: "tb", p2pkh: 0x6f, p2sh: 0xc4 },
  signet: { hrp: "tb", p2pkh: 0x6f, p2sh: 0xc4 },
  regtest: { hrp: "bcrt", p2pkh: 0x6f, p2sh: 0xc4 },
  simnet: { hrp: "sb", p2pkh: 0x3f, p2sh: 0x7b },
};

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        chk ^= gen[i];
      }
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) {
    out.push(hrp.charCodeAt(i) >> 5);
  }
  out.push(0);
  for (let i = 0; i < hrp.length; i++) {
    out.push(hrp.charCodeAt(i) & 31);
  }
  return out;
}

// {hrp, data (5-bit words without the checksum), spec: "bech32"|"bech32m"}
// or null. Mixed case is refused, as BIP 173 requires.
function bech32Decode(text) {
  if (text.length < 8 || text.length > 90) {
    return null;
  }
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) {
    return null;
  }
  const str = text.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length) {
    return null;
  }
  const hrp = str.slice(0, pos);
  const data = [];
  for (const c of str.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) {
      return null;
    }
    data.push(d);
  }
  const check = polymod(hrpExpand(hrp).concat(data));
  let spec;
  if (check === BECH32_CONST) {
    spec = "bech32";
  } else if (check === BECH32M_CONST) {
    spec = "bech32m";
  } else {
    return null;
  }
  return { hrp, data: data.slice(0, -6), spec };
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) {
      return null;
    }
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      out.push((acc << (to - bits)) & maxv);
    }
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

function segwitType(version, program) {
  if (version === 0 && program.length === 20) {
    return "p2wpkh";
  }
  if (version === 0 && program.length === 32) {
    return "p2wsh";
  }
  if (version === 1 && program.length === 32) {
    return "p2tr";
  }
  return "segwit";
}

function decodeSegwit(text, hrp) {
  const dec = bech32Decode(text);
  if (!dec || dec.hrp !== hrp || dec.data.length < 1) {
    return null;
  }
  const version = dec.data[0];
  if (version > 16) {
    return null;
  }
  const program = convertBits(dec.data.slice(1), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) {
    return null;
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    return null;
  }
  // Version 0 uses bech32, every later version bech32m (BIP 350).
  if ((version === 0) !== (dec.spec === "bech32")) {
    return null;
  }
  return { type: segwitType(version, program), version };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text) {
  let num = 0n;
  for (const c of text) {
    const d = BASE58.indexOf(c);
    if (d < 0) {
      return null;
    }
    num = num * 58n + BigInt(d);
  }
  let hex = num.toString(16);
  if (hex.length % 2) {
    hex = "0" + hex;
  }
  let bytes = num === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") {
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

function sha256d(buf) {
  const once = crypto.createHash("sha256").update(buf).digest();
  return crypto.createHash("sha256").update(once).digest();
}

function decodeLegacy(text, net) {
  if (text.length < 26 || text.length > 35) {
    return null;
  }
  const raw = base58Decode(text);
  if (!raw || raw.length !== 25) {
    return null;
  }
  const payload = raw.subarray(0, 21);
  const checksum = raw.subarray(21);
  if (!sha256d(payload).subarray(0, 4).equals(checksum)) {
    return null;
  }
  if (payload[0] === net.p2pkh) {
    return { type: "p2pkh" };
  }
  if (payload[0] === net.p2sh) {
    return { type: "p2sh" };
  }
  return null;
}

// {address, type} for an address of `network`, the address lowercased when
// it is bech32 (a QR code may carry it in upper case); null otherwise.
function parseAddress(text, network) {
  const net = NETWORKS[network] || NETWORKS.mainnet;
  const value = String(text || "").trim();
  if (!value) {
    return null;
  }
  const segwit = decodeSegwit(value, net.hrp);
  if (segwit) {
    return { address: value.toLowerCase(), type: segwit.type };
  }
  const legacy = decodeLegacy(value, net);
  if (legacy) {
    return { address: value, type: legacy.type };
  }
  return null;
}

// Whether `text` is an address of some other network than `network`, for a
// clearer message than "not an address".
function otherNetwork(text, network) {
  for (const name of Object.keys(NETWORKS)) {
    if (NETWORKS[name].hrp === (NETWORKS[network] || NETWORKS.mainnet).hrp) {
      continue;
    }
    if (parseAddress(text, name)) {
      return name;
    }
  }
  return null;
}

module.exports = { parseAddress, otherNetwork, bech32Decode, NETWORKS };
