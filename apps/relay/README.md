# Prospero relay

`@prospero/relay` is a Node 22 relay for the v1 control contract in
`@prospero/protocol`. `/v1/host` is JSON-only control; after `stream.ready` it
never decrypts, parses, transforms, compresses, or reframes application
payloads on `/v1/client` or `/v1/stream`. Text/binary WebSocket frame boundaries
are forwarded one for one.

## Run

Copy `.env.example` to `.env`, point `RELAY_DOMAIN` at this server, then run:

```sh
docker compose -f apps/relay/compose.yaml --env-file apps/relay/.env up -d --build
```

Only Caddy publishes ports 80 and 443. MySQL, Redis, relay port 8787, and
metrics remain inside the compose network. Caddy obtains/renews TLS
certificates automatically. Use `/health/live` for process liveness and
`/health/ready` for MySQL+Redis readiness. `/metrics` is internal-only by
default; set a 24+ character `METRICS_TOKEN` only when an authenticated scrape
path is intentionally exposed.

Run migrations manually (normally compose runs `migrate` before relay):

```sh
npm run build --workspace @prospero/relay
npm run migrate --workspace @prospero/relay
```

## Route ceremony and administration

All commands require `MYSQL_URL` and `REDIS_URL`.

```sh
npm run admin --workspace @prospero/relay -- route disable <routeId>
npm run admin --workspace @prospero/relay -- route enable <routeId>
npm run admin --workspace @prospero/relay -- route inspect <routeId>
```

There is no user/route-create or device-add ceremony. A host creates and keeps
its own 32-byte `hostSecret`, derives
`routeId = base64url(SHA-256("prospero.relay.v1.route-id\\0" || hostSecret))`,
and self-registers on its first valid host authentication. The host's complete,
generation-numbered snapshot is the only way devices are added. MySQL stores
only device credential digests, never a token or host secret. A disabled route
is a retained tombstone: presenting its valid secret cannot recreate it. An
administrator may explicitly enable a tombstone when that is intended.

The first `/v1/host` WebSocket frame is exactly `{ v, routeId, hostSecret }`.
The relay validates the derivation, then atomically persists the host's full
`host.device-sync` credential snapshot and warms Redis before acknowledging it
and advertising `host.ready`; a partial snapshot never becomes online. Phone
`client.open` is also its first frame. The relay sends `client.status: pending`
and a host-control `stream.offer`; the daemon redeems its one-time Redis ticket
in a first `/v1/stream` `stream.accept`. Tickets are control-frame fields only,
never URL query parameters. It emits `stream.ready` to both data sockets before
either side becomes opaque.

Routes are deleted after 30 days without a seen host/device activity, unless
disabled. Disabled routes are tombstones and are retained. Disable/revoke is
published via Redis and closes matching live sockets on every relay instance.

## Tests

```sh
npm test --workspace @prospero/relay
# Requires Docker Desktop / a container runtime:
npm run test:integration --workspace @prospero/relay
```
