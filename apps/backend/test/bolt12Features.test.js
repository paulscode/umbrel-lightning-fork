const test = require("node:test");
const assert = require("node:assert/strict");
const { setsBlake2b } = require("../utils/bolt12Features.js");

// Minted by a Lightning Fork node in the lab (regtest): sets option_blake2b.
const OURS = "lno1qgsqvgnwgcg35z6ee2h3yczraddm72xrfua9uve2rlrm9deu7xyfzrcyzrw484hegk8n6spkm60tgkftaf4s5zmsv9e8xetjyp6x2um5p3qszqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpvggzj6hgsuwm2qw9elm0txvue4kuj7sp2png22sdrte7euhddjedk2vq";
// BOLT 12's own test vectors: offers as any node on the SHA256 chain makes
// them, without the bit ("with feature" sets a different one).
const MINIMAL = "lno1zcss9mk8y3wkklfvevcrszlmu23kfrxh49px20665dqwmn4p72pksese";
const WITH_FEATURE = "lno1pgx9getnwss8vetrw3hhyucvp5yqqqqqqqqqqqqqqqqqqqqkyypwa3eyt44h6txtxquqh7lz5djge4afgfjn7k4rgrkuag0jsd5xvxg";

test("an offer this chain's nodes mint sets option_blake2b", () => {
  assert.equal(setsBlake2b(OURS), true);
  assert.equal(setsBlake2b(OURS.toUpperCase()), true, "either case");
  const split = `${OURS.slice(0, 40)}+\n  ${OURS.slice(40, 90)}+ ${OURS.slice(90)}`;
  assert.equal(setsBlake2b(split), true, "split with + and whitespace");
});

test("an offer from the SHA256 chain does not", () => {
  assert.equal(setsBlake2b(MINIMAL), false);
  assert.equal(setsBlake2b(WITH_FEATURE), false, "a feature, not this one");
});

test("anything else is not judged", () => {
  assert.equal(setsBlake2b("lnbc1xyz"), null);
  assert.equal(setsBlake2b("lnr1qqq"), null);
  assert.equal(setsBlake2b("lno1pt7s"), null, "truncated");
  assert.equal(setsBlake2b("lno1bio"), null, "not bech32");
  assert.equal(setsBlake2b("LnO1qq"), null, "mixed case");
  assert.equal(setsBlake2b(""), null);
});
