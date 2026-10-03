# Mobile API

The dashboard's API for the Lightning Fork Android app, and for anything
else that should use the node the way the dashboard does without a web
session. Version 1.

Everything is JSON (booleans are JSON `true`/`false`; nothing else counts as
true). Amounts are whole satoshis, times are Unix seconds,
and every error is `{"error": "<a sentence for the user>"}` with an HTTP
status: 400 for a request the node refuses (with the reason), 401 for a
missing, wrong or removed key, 404 for an unknown call or object, 422 for a
request id reused for a different request, 429 after repeated bad keys or
pairing codes, 503 when LND is not answering or its wallet is locked
(nothing was sent), and 504 with `"uncertain": true` when a send was cut off
and may have gone through (see Request ids). Refusals a client may want to
branch on also carry a stable `"code"` (see Paying SHA256 invoices); 409
and 429 come with some of those.

## Where it is served

| Platform | Address | TLS |
|---|---|---|
| StartOS | the **Dashboard** interface, LAN and onion, under `/api/v1` | LAN: the server's own, signed by its root CA; onion: plain HTTP is offered when StartOS serves it (Tor authenticates the node), else HTTPS from the same root |
| Umbrel | port `7157` on the LAN, and an onion of its own on port 443 | the dashboard's own authority (below) |
| Both | the dashboard's own port, behind its sign-in or the app proxy | — |

On Umbrel the app proxy puts plain HTTP and Umbrel's login in front of the
dashboard, so the dashboard serves this API alone on a listener of its own
(`MOBILE_TLS_PORT`), with a certificate from an authority it makes once and
keeps (`mobile-ca.pem` in its data directory). The server certificate is
reissued when the names change or it nears expiry; the authority is not.

The certificate names the addresses the pairing code gives where they are
known, but an address the server cannot know (an IP, a name it was opened
at) need not be among them: a client verifies the pinned root, and should
accept the node's own addresses from pairing as names. That is what the
app does.

A client pins the root: the last certificate of the chain the server
presents, accepted only if its SHA-256 (the whole certificate, as
`openssl x509 -fingerprint -sha256` prints it) equals the pairing code's
`ca`. An onion over plain HTTP needs no certificate.

## Pairing

The web page (menu → **Mobile app** → **Pair a phone**) calls
`POST /v1/devices`, which makes a pending device and a one-time code:

```json
{"lf":1,"code":"e_…","exp":1790913022312,"lan":"https://umbrel.local:7157",
 "ip":"https://192.168.1.20:7157","onion":"https://….onion","ca":"FA:F5:…"}
```

That is the QR code's text (`exp` in epoch milliseconds; fields without a
value are left out). The code works for five minutes; once claimed, the
same code can be claimed again for two minutes (an answer lost on the way
to the phone), which issues a new key and voids the first. The page also
offers it as `lightningfork://pair?c=<base64url of the JSON>` for a phone
that opened the dashboard itself.

### `POST /api/v1/pair` (no key)

```json
{"enrollCode": "e_…", "label": "Pixel 8", "claimNonce": "<16-128 random characters>"}
```

→ `{apiKey, deviceId, label, serverId, apiVersion, caPem, caSha256, node}`.
`apiKey` (`lf_<id>_<secret>`) is shown this once; the node keeps only its
SHA-256. A used, expired or unknown code is 401. If the answer is lost on
its way, the same code with the same `claimNonce` can be claimed again for
two minutes, for a new key that voids the first; without the nonce (anyone
else who saw the QR code), it cannot.

Every other call takes the key as `Authorization: Bearer lf_…`.

## Calls

| Call | Body or query | Answer |
|---|---|---|
| `GET /bootstrap` | | `{serverId, apiVersion, deviceId, label, node}` |
| `POST /unpair` | | `{unpaired: true}`; the phone removes itself, its key stops at once |
| `GET /endpoints` | | `{onionUrl, lanUrl, lanIp, caPem, caSha256}`, the current addresses |
| `GET /wallet` | | `{onchain: {confirmedSat, unconfirmedSat, lockedSat, reservedSat}, lightning: {outboundSat, inboundSat, pendingOutboundSat}, syncedToChain, blockHeight, updatedAt}` |
| `GET /fees` | | `{source: {kind, name}, warning, minimumSatPerVbyte, low, medium, high}`, each rate `{satPerVbyte, label, eta}` |
| `POST /decode` | `{input}` | a payment target, below; send `X-LF-Capabilities` to be shown more kinds |
| `POST /onchain/estimate` | `{address, amountSat \| sendAll, satPerVbyte}` | `{amountSat, feeSat, satPerVbyte, totalSat, sendAll, reservedSat?}`; sized by choosing coins largest first, as the node does; a sweep keeps back the anchor-channel reserve |
| `POST /onchain/send` | `{address, amountSat \| sendAll, satPerVbyte, requestId?}` | `{txid, satPerVbyte}` |
| `POST /lightning/pay` | `{request, amountSat?, payerNote?, requestId?}` | `{status, paymentHash, preimage, amountSat, feeSat}` |
| `POST /pay/bitcoin-invoice` | `{request, maxIncomingSat, requestId?}` | `{status, paymentHash, preimage, amountSat, feeSat, bitcoinInvoice: {amountSat, description, paymentHash}}`, see Paying SHA256 invoices |
| `POST /receive/address` | `{fresh?}` | `{address, type, uri}`; the last unused address unless `fresh` |
| `POST /receive/invoice` | `{amountSat?, memo?, expirySeconds?}` | `{paymentRequest, paymentHash, amountSat, memo, createdAt, expiresAt, uri}` |
| `GET /receive/invoice/<paymentHash>` | | `{state, amountSat, amountPaidSat, settledAt, expiresAt}`; `state` is `open`, `settled`, `canceled`, `accepted` or `expired` |
| `POST /receive/offer` | `{description?, amountSat?}` | `{offer, offerId, amountSat, description, uri}` |
| `GET /activity` | `?limit=1..100` | `{items: [{id, kind, direction, amountSat, feeSat, timestamp, status, confirmations?, description, reference, bitcoinInvoice?, preimage?}]}`, newest first |
| `GET /price` | `?currency=USD` | `{currency, price}`, BTC in that currency, or `null` |
| `GET /channels` | | `{channels}`, as the dashboard shows them |
| `POST /channels/open` | `{pubKey, host?, port?, amountSat, satPerVbyte?, isPrivate?, requestId?}` | `{fundingTxid, outputIndex, opening: true}` |
| `POST /channels/close` | `{channelPoint, force?, requestId?}` | `{closing: true}` |
| `GET /peers` | | `{peers}` |
| `POST /peers/connect` | `{address}` (`pubkey@host:port`) | |
| `POST /peers/disconnect` | `{pubKey}` | |
| `GET /offers` | | `{offers}`, active ones |
| `POST /offers/<offerId>/disable` | | `{disabled: true}` |

All paths are under `/api/v1`.

### Payment targets

`/decode` reads what a user pasted or scanned: an address of the node's
network, a `bitcoin:` URI (BIP 21, with `amount`, `label`, `message`,
`lightning=` and `lno=`), a `lightning:` URI, a BOLT 11 invoice, a BOLT 12
offer or invoice. It answers

```json
{"kind": "onchain | bolt11 | offer | bolt12-invoice | unsupported",
 "request": "…", "amountSat": 2500, "amountEditable": false,
 "description": "…", "address": "…", "addressType": "p2wpkh",
 "issuer": "…", "destination": "…", "paymentHash": "…",
 "createdAt": 0, "expiresAt": 0, "expired": false, "ours": false,
 "message": "…", "fallback": { …an onchain target… }}
```

`request` is what to pass to `/lightning/pay` or, for `onchain`, the
address. A unified BIP 21 request comes back as its Lightning part with the
address as `fallback`. `ours` marks a request this node made. Lightning
addresses, LNURL and invoice requests come back as `unsupported` with a
`message`; anything else that cannot be paid is a 400 saying why (an
address of another network is named as such).

An invoice from a Lightning node that has not upgraded to the BLAKE2b
chain's rules (one without feature bit 512/513, `option_blake2b`) is, in
practice, a SHA256 invoice: both chains' invoices start with `lnbc`. It is
a 400 saying so, unless the client declares that it can show one (below).

### Capabilities

A client declares the kinds it can show beyond those above in the
`X-LF-Capabilities` request header, a comma-separated list, on `/decode`:

| Capability | |
|---|---|
| `bitcoin-invoice` | a SHA256 invoice comes back as `kind: "bitcoin-invoice"` instead of a 400 |

A client that sends nothing gets exactly what it always got. The header is
the opt-in because an older client treats every kind but `onchain` as an
ordinary Lightning invoice, and must never be handed one it would pay
that way.

### Paying SHA256 invoices

A SHA256 invoice can be paid from this node through a service someone
else runs, set up in the dashboard's settings (**Paying SHA256 invoices**,
from a code the service's operator gives out). The service answers with an
invoice on this chain for the **same payment hash**, held until it has paid
the SHA256 invoice: it can only collect by paying, and the preimage the
node gets back is the proof. The node pays nothing the service sends
without checking it first (below).

`/decode`, with the capability, answers

```json
{"kind": "bitcoin-invoice", "request": "lnbc1500n1p…", "amountSat": 150,
 "amountEditable": false, "description": "…", "destination": "…",
 "paymentHash": "…", "createdAt": 0, "expiresAt": 0, "expired": false,
 "ours": false, "payable": true, "message": null,
 "estimate": {"incomingSat": 30919, "feeSat": 307, "maxIncomingSat": 31074,
              "routingFeeLimitSat": 310, "rate": 0.0049, "spread": 0.01,
              "minSat": 100, "maxSat": 500000, "serviceLabel": "…",
              "open": true, "refusal": "…when not open"},
 "reference": {"rate": 0.004875, "premiumAllowed": 0.0638, "premium": 0.0048,
               "withinLimit": true, "source": "Neoxa"},
 "referenceError": "…when there is no market rate"}
```

- `amountSat` is the SHA256 invoice's amount (rounded up from msat), or
  `null` when it names none; those cannot be paid yet.
- `estimate.incomingSat` is what the service would charge now, in BTCB2
  sats, if nothing moves before the payment: `ceil(out_msat / rate * (1 +
  spread))`, rounded up to whole sats. `feeSat` is the part of it that is
  the service's spread. `routingFeeLimitSat` is the most the node will
  spend on routing to the service (1%, at least 10 sats), on top.
- `estimate.maxIncomingSat` is the estimate plus 0.5%, for the service's
  spread moving between the estimate and the payment. **Show it** ("at most
  …"): it is the ceiling the payment is held to.
- `estimate` is `null` when no service is set up or it cannot be asked;
  `message` then says why.
- `reference` is the market rate the price is checked against (below);
  `premium` is how far the estimate is from it, `premiumAllowed` how far it
  may be.
- `payable` is false whenever `message` is set: no service, no amount,
  expired, the service closed or out of its bounds, the price past the
  allowed premium, no market rate. Show `message`.

`POST /pay/bitcoin-invoice` takes `{request, maxIncomingSat, requestId?,
resume?}`, `maxIncomingSat` being the `estimate.maxIncomingSat` the user
agreed to. It asks the service for its invoice at that moment and pays it
only if, decoded by the node:

1. its payment hash is the SHA256 invoice's;
2. it is payable to the node key in the service's code;
3. it is an invoice of this chain (`option_blake2b`);
4. it asks no more than `maxIncomingSat`;
5. its price, bitcoin out per BTCB2 in, is no worse than the market rate
   by more than the premium the user allows (5% unless changed, 0.5%–25%)
   plus the market's own range over the last hour (at most 10%); the rate
   is Neoxa's last BTCB2_BTC trade, fetched over Tor when the node has a
   Tor proxy, and **without it nothing is paid**;
6. it has at least 20 seconds left.

Success is `{status: "succeeded", paymentHash, preimage, amountSat, feeSat,
bitcoinInvoice: {amountSat, description, paymentHash}}`: `amountSat` and
`feeSat` are what it cost in BTCB2 (the service's invoice and routing),
`bitcoinInvoice.amountSat` what was paid on the SHA256 chain, `preimage` the proof.

The service holds the payment until it has paid, which can take a while.
After 90 seconds the answer is 504, `uncertain`, "on its way"; the payment
goes on, and asking again (`resume`, the same id) finds it:

- the node's own payment for the hash comes first: paid gives the proof,
  in flight stays 504;
- there is one attempt at a time per SHA256 invoice, whatever the request
  id or the device, recorded on disk before its payment starts
  (`bitcoin-invoice-payments.json` beside the dashboard's state). An
  attempt recorded as started, with no payment on the node, is resolved
  by the service's word: it has given up, so it never started; it is
  still waiting, so its invoice is paid now; it cannot be asked, so 504;
- the service is asked for a new invoice only once the last attempt has
  ended without paying (the node's payment came back, and the service
  says the attempt ended, or cannot be asked). While its last invoice is
  still waiting to be paid and has time left, that one is paid again
  instead.

The node itself never pays one payment hash twice, which is what makes the
rest safe to repeat.

Refusals carry a `code`. Nothing was paid after any of them.

| `code` | Status | |
|---|---|---|
| `no_service` | 400 | no service is set up |
| `no_amount` | 400 | the SHA256 invoice names no amount |
| `not_bitcoin_invoice` | 400 | the invoice is this chain's; pay it with `/lightning/pay` |
| `already_paid` | 409 | the invoice has been paid (a repeat with `resume` gets the payment instead, when it was this node's) |
| `in_progress` | 409 | the service is still busy with an earlier attempt, or still holding its last price; the sentence says how long when it can |
| `limit` | 429 | too many payments waiting at the service |
| `price_changed` | 409 | the service asks more than `maxIncomingSat`; `/decode` again for the new price |
| `rate` | 400 | the price is past the allowed premium over the market rate |
| `reference_unavailable` | 503 | no market rate to check against |
| `hold_expiring` | 400 | the service's invoice would expire before it could be paid |
| `invalid_hold_invoice` | 400 | the service's invoice failed check 1, 2 or 3: it is not behaving as it must |
| `returned` | 400 | the node's payment came back; a new try may be made |
| `unreachable`, `unavailable`, `internal`, `invalid_response` | 503 | the service did not answer usefully |
| `tor_required` | 400 | the service is an onion and the node has no Tor proxy |
| `cert_mismatch` | 400 | the service did not present the certificate its code pins; nothing was sent to it |
| `not_authorized` | 400 | the service did not accept its code |
| `disabled`, `too_small`, `too_large`, `expires_soon`, `route_budget`, `no_liquidity`, `price_unavailable`, `chain_unmeasured`, `self_payment`, `invalid_invoice`, `no_direction`, `refused` | 400 | the service refused, for the reason the sentence gives |

In `/activity`, a payment that paid a SHA256 invoice keeps `kind:
"lightning"` (its `amountSat` and `feeSat` are what it cost here) and adds
`bitcoinInvoice: {amountSat, description, state}` (`paid`, `pending` or
`returned`), with the SHA256 invoice's description as `description`, and
`preimage` once paid.

### Request ids

`/onchain/send`, `/lightning/pay`, `/pay/bitcoin-invoice`, `/channels/open`
and `/channels/close` take an optional `requestId` (8–64 letters, digits, `-` or `_`). The id is
bound to the call and its parameters: the same id with different parameters
is refused with 422. The first
call with an id runs; a repeat by the same device within a day returns the
first outcome, success or failure, without acting again. Ids are kept in
memory; an on-chain send is also labelled with its id in the wallet, so
the same request after a dashboard restart finds the transaction instead
of making another.

A send cut off before the node answered (the connection to LND dropped,
or timed out) is a 504 with `"uncertain": true`: the money may have moved.
Ask again with the same id and the same body plus `"resume": true` (left
out of the comparison of bodies), never with a new id. The node then finds
out, and keeps finding out across its own restarts:

- an on-chain send by the wallet label it was sent with
  (`lf-mobile:<requestId>`);
- a BOLT 11 or BOLT 12 invoice by its payment hash, before any check of
  the invoice's expiry: paid gives the payment's proof, in flight stays
  504, not found or failed is paid now (it never went through);
- an offer from a journal written before the payment starts
  (`mobile-sends.json` beside the dashboard's state, kept a week): a
  recorded outcome is returned; started without an outcome stays 504 for
  good, and is never paid again. Check the activity.

While the node cannot be asked (LND restarting), a resume answers 504
again, not 503: only a first attempt can be told "nothing was sent".
`resume` without an earlier attempt simply sends.

## Managing devices (web session)

| Call | |
|---|---|
| `GET /v1/devices` | `{devices: [{id, label, status, created, lastUsed, lastTransport, enrollExpires}]}` |
| `POST /v1/devices` | starts a pairing: `{device, pairing, qr, expiresInMs}`; 503 while the mobile listener is not serving |
| `POST /v1/devices/<id>/label` (or `PATCH /v1/devices/<id>`) | `{label}` |
| `DELETE /v1/devices/<id>` | removes it; its key stops working at once. `?pending=1` removes it only if it has not paired yet |

Devices are kept in `devices.json` beside the dashboard's state, so they are
in its backups.

## Paying SHA256 invoices (web session)

The same logic, for the dashboard's page. Answers and errors in this API's
form (`{error, code?, uncertain?}`).

| Call | |
|---|---|
| `GET /v1/bitcoin-invoices` | `{service: {label, url, node, onion, cert, addedAt} \| null, premium, premiumMin, premiumMax}`; never the credential |
| `GET /v1/bitcoin-invoices/status` | `{service, terms: {open, refusal, rate, spread, minSat, maxSat}, reference: {rate, volatilityAllowance, premiumAllowed, at, source}}`, or `error` / `referenceError` sentences |
| `POST /v1/bitcoin-invoices/service` | `{code}`: sets the service from its operator's code (`lfbridge:…`), after asking it once that the code works and the node key matches; answers as `GET`, plus `terms` |
| `DELETE /v1/bitcoin-invoices/service` | removes it |
| `POST /v1/bitcoin-invoices/premium` | `{premium}`, a fraction, 0.005–0.25 |
| `POST /v1/bitcoin-invoices/decode` | `{input}`, as `/decode` with the `bitcoin-invoice` capability |
| `POST /v1/bitcoin-invoices/pay` | as `/pay/bitcoin-invoice`, request ids and all |

A service code is `lfbridge:` and the unpadded base64url of
`{v: 1, label, url, node, macaroon, cert}`: an `https` address (host and
port only), the service's node key, a credential (hex) and the SHA-256 of
the certificate it presents (colon hex), which is required unless the
address is an onion. An onion is reached through the node's Tor proxy
(`TOR_PROXY_IP`, `TOR_PROXY_PORT`), and its certificate is not checked;
any other address only if it presents exactly the pinned certificate,
checked before anything is sent. The service and the premium are kept in
`bitcoin-invoices.json` beside the dashboard's state (private: it holds the
credential), so they are in its backups.

## Configuration

| Variable | |
|---|---|
| `MOBILE_TLS_PORT` | serve the API alone over TLS on this port (Umbrel) |
| `MOBILE_PUBLIC_PORT` | the port that listener is published on, for the pairing code |
| `MOBILE_ONION_FILE` | Tor's `hostname` file for the onion in front of that listener, read when needed (Umbrel; Tor writes it after the first start) |
| `MOBILE_ONION` | that onion address, if there is no file to read |
| `ONION_PROXY_IP`, `ONION_PROXY_PORT` | a Tor SOCKS proxy used only to reach a service for paying SHA256 invoices at an onion address (StartOS; Umbrel uses `TOR_PROXY_*`) |
| `MOBILE_LAN_IP` | the server's LAN IP, offered beside its name (Umbrel; a phone may not resolve `.local`) |
| `MOBILE_ENDPOINTS_FILE` | a JSON file `{onion: [urls], lan: [urls], ip: [urls]}` of where the dashboard is reached (StartOS) |
| `MOBILE_CA_FILE` | a certificate chain whose last certificate is the root to pin (StartOS: LND's chain, issued by the server's root CA) |
| `DEVICE_DOMAIN_NAME` | the server's LAN name (Umbrel) |
| `DEVICES_FILE` | where devices are kept, default `devices.json` beside `JSON_STORE_FILE` |
| `BITCOIN_INVOICES_FILE` | where the service for paying SHA256 invoices is kept, default `bitcoin-invoices.json` beside `JSON_STORE_FILE` |
| `TOR_PROXY_IP`, `TOR_PROXY_PORT` | the Tor proxy for a service on an onion, and for the market rate |
