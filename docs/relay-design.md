# Relay v1: security and independent data-plane contract

Relay v1 lets an already paired phone reach its Prospero host when a direct
LAN/WireGuard address is unavailable. It is a transport fallback, not an
account, identity provider, message broker, or trusted endpoint. There are no
relay accounts: the host creates an opaque route and a device scans the same
pairing QR in person. The QR remains the out-of-band trust ceremony.

## Security boundary

The relay sees only the route selector, device ID, limited relay ticket,
credential digests, control handshakes, source IP addresses, connection times,
durations, and packet/frame sizes. It sees the SecureChannel public handshake
frames and opaque encrypted data frames after a stream is ready.

The relay does **not** see the pairing E2E token (`PairingPayload.token`), the
host's static private key, application messages, chats, terminal bytes, file
contents, or decrypted application ping/pong values. The `relay.token` field is
a separate route-scoped bearer credential and is never the E2E pairing token.
Neither MySQL nor Redis stores that credential in plaintext: MySQL stores the
domain-separated digest and Redis caches that digest only. Redis stores a
one-time stream ticket under a separate domain-separated hash and its persisted
value omits the raw ticket, so AOF/RDB backups contain no live bearer strings.
The supplied relay deployment disables core dumps and uses a read-only,
capability-dropped container; relay logs and metrics must keep using only the
bounded identifiers/labels documented here.

The data plane is deliberately separate from host control:

```text
host daemon ── /v1/host ── relay      long-lived JSON control only
phone       ── /v1/client ─ relay      JSON until ready, then opaque E2E data
host daemon ── /v1/stream ─ relay      one socket per offer; JSON until ready,
                                       then opaque E2E data
```

`/v1/host` never transports application ciphertext. After both data sockets
receive `stream.ready`, the relay forwards bytes without parsing, modifying, or
injecting frames. A hostile relay can delay, drop, disconnect, rate-limit, or
refuse a stream (DoS), but SecureChannel authenticated encryption detects
application-frame modification and replay.

## Pairing QR and compatibility

`PAIRING_FORMAT_VERSION` stays **7**. A relay is an optional v7 extension, so
old v7 apps retain their direct-address behavior and discard unknown `relay`.
v5 QR payloads remain accepted. A QR contains at least one direct address or a
relay:

```ts
{
  v: 7,
  name: string,
  addrs: string[], // may be [] only when relay is present
  port: number,
  token: string,   // E2E token; never sent to the relay
  pubKey: string,
  relay?: {
    v: 1,
    url: string,
    routeId: string, // base64url SHA-256 selector
    deviceId: string,
    token: string,   // relay-only device credential, distinct from token above
  },
}
```

Relay URLs are `wss:` in production. `ws:` is accepted only for an explicitly
opted-in development connection to `localhost`, `127.0.0.1`, or `::1`. URLs
must not contain credentials, query strings, or fragments. In particular, no
route ID, device ID, stream ticket, relay token, or E2E token enters a URL.

`RELAY_PROTOCOL_VERSION` remains **1**. Pairing stays v7 and the application
protocol remains **v13**; the relay does not change application URLs or E2E
handshake/message contracts.

### Origin and proxy policy

Relay v1 has no browser-cookie session and never treats `Origin` as an
authentication signal. The supported native phone and daemon clients may omit
it, so the relay accepts absent or present Origin headers and always requires
the endpoint's first control message instead. A browser cannot authenticate
without independently possessing the explicit relay credential; deployments
adding a browser UI may enforce its own Caddy allowlist in addition to, never
instead of, this check.

Rate limits use the TCP peer by default. The provided Compose deployment has
Caddy strip public forwarding headers and write `X-Prospero-Source-IP`; relay
honors that header only when the TCP peer is Caddy's configured fixed internal
address. It never trusts caller-controlled `X-Forwarded-For`, which prevents
both rate-limit bypass and secret-shaped header values entering auth logs.

## Endpoint and frame limits

All control JSON schemas are strict: unknown fields are rejected, opaque IDs
and messages have small explicit bounds, a credential snapshot has at most
1,024 entries, and its generation is an unsigned 32-bit integer. Deployment
WebSocket limits are uniform:

| Plane | Endpoints | Maximum received frame |
| --- | --- | --- |
| control | `/v1/host`, and the pre-ready phase of `/v1/client` and `/v1/stream` | 1 MiB |
| opaque data | ready `/v1/client` and ready `/v1/stream` | 16 MiB |

The 1 MiB control ceiling is an envelope/deployment limit, not permission for
unbounded schema fields. The relay closes an endpoint that violates its active
plane's frame limit.

## Host registration and device authorization

The first JSON frame on `/v1/host` is special: the path and position identify
it, so it has **only** these fields and no `type`:

```ts
{ v: 1, routeId, hostSecret }
```

`hostSecret` is 32 random bytes encoded as unpadded base64url. The relay
validates, in constant work, that:

```text
routeId = base64url(SHA-256(
  utf8("prospero.relay.v1.route-id\\0") || base64urlDecode(hostSecret)
))
```

This prevents a route ID from acting as a host identity or a reusable host
credential. It is a route selector derived from a secret known only to the
host and the relay authentication check. There is no user account, route-create
CLI, or device-add CLI: a valid host self-registers its route on first
authentication. A disabled route remains a tombstone and cannot be recreated
by presenting that secret.

Authentication alone does not put a host online. The host must next send an
atomic full replacement snapshot:

```ts
{
  type: "host.device-sync",
  v: 1,
  generation: number,
  credentials: [
    { deviceId, credentialDigest },
    { deviceId, revoked: true },
  ],
}
```

For an active entry, `credentialDigest` is:

```text
base64url(SHA-256(
  utf8("prospero.relay.v1.device-credential\\0") || utf8(relay.token)
))
```

The relay compares that digest with the `token` in `client.open`; it does not
need to store the raw token. A `revoked: true` entry explicitly refuses the
device. Since the message is a full atomic replacement, an active device absent
from a newer snapshot is revoked too; `credentials: []` revokes every previously
known device. Duplicate device IDs are invalid.

Generations are monotonic per route. A relay applies a newer snapshot atomically
and returns `host.device-sync.ack { v, generation }`; it may ACK a semantically
equivalent retransmission of the current generation for recovery. In particular,
MySQL retains devices omitted by a newer snapshot as revoked audit rows, so a
retry may omit those rows or include them as `revoked: true`; active device IDs
and credential digests must still match exactly. It must not merge partial
snapshots. Only after the ack for its initial snapshot does the relay
send `host.ready { v, routeId, generation }` and advertise the host as online.

An online host sends `host.heartbeat { v, generation }`; the relay returns
`host.heartbeat.ack { v, generation }`. Loss of the control socket or heartbeat
ends route availability and cancels pending streams.

## New stream message matrix

| Direction / endpoint | Message | Meaning |
| --- | --- | --- |
| host → relay `/v1/host`, first frame | `{ v, routeId, hostSecret }` | Authenticate route; no `type` and no device/app data. |
| host → relay `/v1/host` | `host.device-sync` | Atomic full credential digest snapshot. |
| relay → host `/v1/host` | `host.device-sync.ack`, then `host.ready` | Persisted generation, then online transition. |
| host ↔ relay `/v1/host` | `host.heartbeat` / `.ack` | Route liveness for the current generation. |
| client → relay `/v1/client`, first frame | `client.open { v, routeId, deviceId, token }` | Authorize a phone data socket. |
| relay → client `/v1/client` | `client.status { status: "pending", streamId, expiresAt }` | Client is waiting for independent host acceptance. |
| relay → host `/v1/host` | `stream.offer { streamId, ticket, deviceId, expiresAt }` | Ask daemon to open an independent data socket. |
| host → relay `/v1/stream`, first frame | `stream.accept { streamId, ticket }` | Consume the one-time ticket; ticket is never a URL value. |
| relay → client `/v1/client` and host `/v1/stream` | `stream.ready { streamId }` | Final `ready` result of `client.open`; both sockets now switch to opaque E2E data. |
| host/relay while pending | `stream.revoke { streamId, code }` | Cancel offer; relay reports `stream.close` to the peer. |
| either endpoint while pending | `stream.close { streamId, code }` | Terminal pre-ready control. |
| relay → caller | `error { code, message, retryAfterMs? }` | Error result of host auth, `client.open`, or pending operation. |

Thus `client.open` yields exactly one initial outcome: `pending`, an `error`, or
(when acceptance can complete immediately) `stream.ready`; a pending client
then receives `stream.ready` or `error`/`stream.close`. `stream.ready` is sent
to the client and host data sockets before either becomes opaque. No JSON relay
control is injected after that transition: termination uses the WebSocket close
and data-plane close policy.

Ticket issuance, expiry comparison, single consumption, and concurrent accept
serialization are relay implementation state, not client-provided JSON state.
The relay stores the offer's `expiresAt`, atomically consumes a matching ticket
once, and returns stable `ticket_invalid`, `ticket_expired`, or `ticket_used`
errors as appropriate. A schema parser can only validate the bounded wire
shape; it cannot prove a ticket's lifetime or whether another connection has
already consumed it.

Stable error codes are `bad_frame`, `unsupported_version`, `unauthorized`,
`route_not_found`, `route_unavailable`, `device_revoked`, `ticket_invalid`,
`ticket_expired`, `ticket_used`, `stream_not_found`, `stream_not_ready`,
`rate_limited`, and `internal`. Error text is bounded and must not expose host
diagnostics, tokens, secrets, credential digests, or application data.

## Application compatibility

The application protocol is **v13**. v13 adds encrypted `connection.ping { id
}` and `connection.pong { id }` for liveness over direct and relay transports.
They are ordinary SecureChannel application frames, never relay controls or
WebSocket ping frames. The supported application-version fallback list remains
`[13, 12, 11, 10, 9, 8, 7, 5]`; versions v8 and later authenticate the negotiated
application version in the daemon identity proof.
