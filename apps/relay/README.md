# Prospero relay

`@prospero/relay` is a Node 22 relay for the v1 control contract in
`@prospero/protocol`. It never decrypts, parses, transforms, compresses, or
reframes application payloads after `stream.open`; text/binary WebSocket frame
boundaries are forwarded one for one.

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

All commands require `MYSQL_URL` and `REDIS_URL`. The create command emits
secret material exactly once; save it in the host's private durable settings,
not in source control, shell history, QR URLs, logs, or MySQL.

```sh
npm run admin --workspace @prospero/relay -- route create
npm run admin --workspace @prospero/relay -- device add <routeId>
npm run admin --workspace @prospero/relay -- device revoke <routeId> <deviceId>
npm run admin --workspace @prospero/relay -- route disable <routeId>
npm run admin --workspace @prospero/relay -- route enable <routeId>
npm run admin --workspace @prospero/relay -- route inspect <routeId>
```

`route create` makes a 32-byte `hostSecret`, derives
`routeId = base64url(SHA-256("prospero.relay.route.v1\\0" || hostSecret))`, and
creates a separate host device credential. Every phone gets an independent
32-byte relay token. MySQL stores only SHA-256 token digests.

The host proves its host-device credential in its first `/v1/host` WebSocket
message. During this authentication, the relay takes a locked MySQL snapshot of
all non-revoked devices and warms Redis before advertising `host.ready`; a
partially synchronized device set never becomes online. Phone `/v1/client`
authentication similarly occurs in the first message. The opaque T1 `streamId`
is a single-use, Redis-backed 15-second ticket: host redeems it as the first
strict `stream.open` message on `/v1/stream`, then all following frames are
opaque application frames.

Routes are deleted after 30 days without a seen host/device activity, unless
disabled. Disabled routes are tombstones and are retained. Disable/revoke is
published via Redis and closes matching live sockets on every relay instance.

## Tests

```sh
npm test --workspace @prospero/relay
# Requires Docker Desktop / a container runtime:
npm run test:integration --workspace @prospero/relay
```
