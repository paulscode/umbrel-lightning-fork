const test = require("node:test");
const assert = require("node:assert/strict");
const { offerFailure } = require("../utils/offerFailure.js");
const { LndError, ValidationError } = require("../models/errors.js");

const lnd = (details, code = 14) =>
  new LndError("Unable to fetch an invoice for the offer", { code, details });

test("an offer failure reads as a sentence, and LND's wording goes to the log", () => {
  const logged = [];
  const cases = [
    ["request: message names no chain; an absent chain means Bitcoin mainnet", /different network/],
    ["no invoice arrived in time", /did not answer in time/],
    ["the issuer refused: unknown offer", /refused to give an invoice/],
    ["the offer names no way to reach its issuer", /no way to reach/],
    ["amount is below the offer's amount", /less than this offer asks/],
    ["the offer has no amount; one must be given", /Enter how much/],
    ["offer does not set option_blake2b", /has not upgraded/],
    ["unable to find a path to destination", /No route/],
    // The offers service says "unavailable" for this too; it is the offer's
    // node that cannot be reached, not this one.
    ["destination is unreachable", /offer's node cannot be reached/],
  ];
  for (const [details, want] of cases) {
    const err = offerFailure(lnd(details), (line) => logged.push(line));
    assert.ok(err instanceof ValidationError, details);
    assert.equal(err.statusCode, 400);
    assert.match(err.message, want, details);
    // None of the node's own wording reaches the page.
    assert.doesNotMatch(err.message, /request:|invreq|absent chain/);
  }
  assert.equal(logged.length, cases.length);
  assert.match(logged[0], /names no chain/);
});

test("a node that is not answering keeps a 503, and other errors pass through", () => {
  const down = offerFailure(lnd("14 UNAVAILABLE: No connection established"), () => {});
  assert.equal(down.statusCode, 503);
  const plain = new Error("something else");
  assert.equal(offerFailure(plain), plain);
});
