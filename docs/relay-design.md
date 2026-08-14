# Relay v1: security and compatibility contract

Relay v1 lets an already paired phone reach its own Prospero host when a direct
LAN/WireGuard address is unavailable. It is a transport fallback, not an
account, identity provider, message broker, or trusted endpoint. There are no
relay accounts: the host creates an opaque route and a device scans the same
pairing QR in person. The QR remains the out-of-band trust ceremony.

## Security boundary

The relay sees only what it needs to route a stream:

- relay URL, route ID, device ID, and the limited relay route ticket;
- client/host source IP addresses, connection times, duration, packet/frame
  sizes, timing, availability, and public relay-control handshakes;
- the client/server ephemeral public keys and encrypted daemon identity proof
  carried by the public SecureChannel handshake;
- the fact that an opaque stream is active.

The relay does **not** see the pairing E2E token (`PairingPayload.token`), the
daemon static public-key proof's private key, application messages, chats,
terminal bytes, file contents, or decrypted application ping/pong values.
The `relay.token` field is a separate, route-scoped bearer ticket; it only lets
the relay select/authorize an opaque route and must never be confused with the
E2E pairing token.

After `stream.open`, the client and host run the unchanged SecureChannel
handshake through the relay and forward only SecureChannel frames. A hostile
relay can delay, drop, disconnect, rate-limit, or refuse to route traffic
(DoS). It cannot alter an application frame or replay one without SecureChannel
rejecting it: authenticated encryption detects modifications, and each direction
uses a monotonically increasing implicit nonce/counter, so a replay fails after
the counter advances. The daemon identity proof also binds the negotiated
application protocol version, preventing a relay from silently downgrading it.

Relay operators should treat route tickets and metadata as sensitive operational
data, but compromise of the relay is not authorization to impersonate either
endpoint or read application content.

## Pairing QR

`PAIRING_FORMAT_VERSION` stays **7**. This is intentional: a relay is an
optional extension, so old v7 apps retain their existing direct-address behavior
and discard the unknown `relay` property. v5 QR payloads remain accepted. A QR
contains at least one direct address or a relay:

```ts
{
  v: 7,
  name: string,
  addrs: string[], // may be [] only when relay is present
  port: number,
  token: string,   // E2E token, never sent to the relay
  pubKey: string,
  relay?: {
    v: 1,
    url: string,
    routeId: string,
    deviceId: string,
    token: string, // relay-only route ticket, distinct from token above
  },
}
```

New clients race/directly try `addrs` as usual and may fall back to the relay.
An old client ignores `relay` when it has direct addresses; it cannot use a
relay-only QR, which is an expected capability limitation rather than a change
to the v7 shape.

Relay URLs are `wss:` in production. `ws:` is accepted only for an explicitly
opted-in development connection to `localhost`, `127.0.0.1`, or `::1`. URLs
must not contain credentials, query strings, or fragments. In particular, no
pairing token, relay ticket, route ID, or device ID may be put in a query string;
the route ticket appears only in its bounded first control frame.

## Relay control protocol

`RELAY_PROTOCOL_VERSION` is **1** and is independent of the app protocol.
Every relay control frame is strict JSON, is at most 4096 UTF-8 bytes, and has
bounded base64url opaque IDs/tickets. Unknown fields are rejected. The relay
never interprets payload bytes after a stream opens.

| Direction | Control message | Required fields |
| --- | --- | --- |
| host → relay | `host.register` | `v`, `routeId`, `deviceId`, `token` |
| relay → host | `host.ready` | `v`, `routeId` |
| client → relay | `client.connect` | `v`, `routeId`, `deviceId`, `token` |
| relay → client | `client.connected` | `v`, `streamId` |
| relay → host | `stream.open` | `v`, `streamId` |
| either direction | `stream.close` | `v`, `streamId`, close `code` |
| relay → caller | `error` | `v`, bounded error `code` and message |

Control errors are one of `bad_frame`, `unsupported_version`, `unauthorized`,
`route_not_found`, `route_unavailable`, `stream_not_found`, `rate_limited`, or
`internal`. They expose no host diagnostics, tokens, or application data.

Once the client has `client.connected` and the host has `stream.open`, the relay
forwards opaque SecureChannel WebSocket frames for that stream. It must not turn
those frames into JSON control messages or inject data into them.

## Application compatibility

The application protocol is **v13**. v13 adds encrypted
`connection.ping { id }` and `connection.pong { id }`, for liveness over both
direct and relay transports. The ID is a bounded correlation value and the pong
echoes it. Both messages are ordinary SecureChannel application frames, not
relay controls and not WebSocket ping frames.

The supported app-version fallback list is `[13, 12, 11, 10, 9, 8, 7, 5]`.
v8 and later authenticate the negotiated application version in the daemon
identity proof; v7/v5 retain their historical handshake form. Clients choose a
listed version explicitly when retrying an older daemon. Implementations must
only send v13-only ping/pong after negotiating v13; older peers continue with
their existing message set.
