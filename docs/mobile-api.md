# Mobile API

The dashboard's API for the Lightning Fork Android app, and for anything
else that should use the node the way the dashboard does without a web
session. Version 1.

Everything is JSON (booleans are JSON `true`/`false`; nothing else counts as
true). Amounts are whole satoshis, times are Unix seconds,
and every error is `{"error": "<a sentence for the user>"}` with an HTTP
status: 400 for a request the node refuses (with the reason), 401 for a
missing, wrong or removed key, 404 for an unknown call or object, 429 after
repeated bad keys or pairing codes, 503 when LND is not answering or its
wallet is locked.

## Where it is served

| Platform | Address | TLS |
|---|---|---|
| StartOS | the **Dashboard** interface, LAN and onion, under `/api/v1` | the server's own, signed by its root CA |
| Umbrel | port `7157` on the LAN, and an onion of its own on port 443 | the dashboard's own authority (below) |
| Both | the dashboard's own port, behind its sign-in or the app proxy | — |

On Umbrel the app proxy puts plain HTTP and Umbrel's login in front of the
dashboard, so the dashboard serves this API alone on a listener of its own
(`MOBILE_TLS_PORT`), with a certificate from an authority it makes once and
keeps (`mobile-ca.pem` in its data directory). The server certificate is
reissued when the names change or it nears expiry; the authority is not.

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
{"enrollCode": "e_…", "label": "Pixel 8"}
```

→ `{apiKey, deviceId, label, serverId, apiVersion, caPem, caSha256, node}`.
`apiKey` (`lf_<id>_<secret>`) is shown this once; the node keeps only its
SHA-256. A used, expired or unknown code is 401.

Every other call takes the key as `Authorization: Bearer lf_…`.

## Calls

| Call | Body or query | Answer |
|---|---|---|
| `GET /bootstrap` | | `{serverId, apiVersion, deviceId, label, node}` |
| `GET /endpoints` | | `{onionUrl, lanUrl, lanIp, caPem, caSha256}`, the current addresses |
| `GET /wallet` | | `{onchain: {confirmedSat, unconfirmedSat, lockedSat, reservedSat}, lightning: {outboundSat, inboundSat, pendingOutboundSat}, syncedToChain, blockHeight, updatedAt}` |
| `GET /fees` | | `{source: {kind, name}, warning, minimumSatPerVbyte, low, medium, high}`, each rate `{satPerVbyte, label, eta}` |
| `POST /decode` | `{input}` | a payment target, below |
| `POST /onchain/estimate` | `{address, amountSat \| sendAll, satPerVbyte}` | `{amountSat, feeSat, satPerVbyte, totalSat, sendAll, reservedSat?}`; sized by choosing coins largest first, as the node does; a sweep keeps back the anchor-channel reserve |
| `POST /onchain/send` | `{address, amountSat \| sendAll, satPerVbyte, requestId?}` | `{txid, satPerVbyte}` |
| `POST /lightning/pay` | `{request, amountSat?, payerNote?, requestId?}` | `{status, paymentHash, preimage, amountSat, feeSat}` |
| `POST /receive/address` | `{fresh?}` | `{address, type, uri}`; the last unused address unless `fresh` |
| `POST /receive/invoice` | `{amountSat?, memo?, expirySeconds?}` | `{paymentRequest, paymentHash, amountSat, memo, createdAt, expiresAt, uri}` |
| `GET /receive/invoice/<paymentHash>` | | `{state, amountSat, amountPaidSat, settledAt, expiresAt}`; `state` is `open`, `settled`, `canceled`, `accepted` or `expired` |
| `POST /receive/offer` | `{description?, amountSat?}` | `{offer, offerId, amountSat, description, uri}` |
| `GET /activity` | `?limit=1..100` | `{items: [{id, kind, direction, amountSat, feeSat, timestamp, status, confirmations?, description, reference}]}`, newest first |
| `GET /price` | `?currency=USD` | `{currency, price}`, BTC in that currency, or `null` |
| `GET /channels` | | `{channels}`, as the dashboard shows them |
| `POST /channels/open` | `{pubKey, host?, port?, amountSat, satPerVbyte?, isPrivate?, requestId?}` | LND's answer |
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

### Request ids

`/onchain/send`, `/lightning/pay`, `/channels/open` and `/channels/close`
take an optional `requestId` (8–64 letters, digits, `-` or `_`). The id is
bound to the call and its parameters: the same id with different parameters
is refused with 422. The first
call with an id runs; a repeat by the same device within a day returns the
first outcome, success or failure, without acting again. Ids are kept in
memory; an on-chain send is also labelled with its id in the wallet, so
the same request after a dashboard restart finds the transaction instead
of making another.

A send cut off before the node answered (the connection to LND dropped,
or timed out) is a 504 with `"uncertain": true`: the money may have
moved. Ask again with the same id rather than a new one. A client that lost
the answer resends with the same id; a new attempt after a failure the user
has seen uses a new one.

## Managing devices (web session)

| Call | |
|---|---|
| `GET /v1/devices` | `{devices: [{id, label, status, created, lastUsed, lastTransport, enrollExpires}]}` |
| `POST /v1/devices` | starts a pairing: `{device, pairing, qr}` |
| `POST /v1/devices/<id>/label` (or `PATCH /v1/devices/<id>`) | `{label}` |
| `DELETE /v1/devices/<id>` | removes it; its key stops working at once |

Devices are kept in `devices.json` beside the dashboard's state, so they are
in its backups.

## Configuration

| Variable | |
|---|---|
| `MOBILE_TLS_PORT` | serve the API alone over TLS on this port (Umbrel) |
| `MOBILE_PUBLIC_PORT` | the port that listener is published on, for the pairing code |
| `MOBILE_ONION` | the onion address in front of that listener |
| `MOBILE_ENDPOINTS_FILE` | a JSON file `{onion: [urls], lan: [urls], ip: [urls]}` of where the dashboard is reached (StartOS) |
| `MOBILE_CA_FILE` | a certificate chain whose last certificate is the root to pin (StartOS: LND's chain, issued by the server's root CA) |
| `DEVICE_DOMAIN_NAME` | the server's LAN name (Umbrel) |
| `DEVICES_FILE` | where devices are kept, default `devices.json` beside `JSON_STORE_FILE` |
