# Prospero relay

`@prospero/relay` is a Node 22 relay for the v1 control contract in
`@prospero/protocol`. `/v1/host` is JSON-only control; after `stream.ready` it
never decrypts, parses, transforms, compresses, or reframes application
payloads on `/v1/client` or `/v1/stream`. Text/binary WebSocket frame boundaries
are forwarded one for one.

## Security and deployment boundary

The relay does not persist an E2E pairing token, host secret, device relay
credential, one-time stream ticket, or application plaintext. MySQL stores the
domain-separated device credential digest only. Redis caches that digest and
uses a separate domain-separated hash as the key for a stream ticket; its AOF
and RDB values omit the raw ticket. Relay logs redact credential-shaped fields,
and metrics carry only bounded endpoint/reason/direction labels.

The supplied Compose deployment places MySQL, Redis, and relay on an internal
network. Relay trusts the sanitized client-IP header only from Caddy's fixed
backend IP; Caddy deletes public forwarding headers before setting it. Relay
also runs with core dumps disabled, a read-only filesystem, no Linux
capabilities, a bounded PID count, and a small temporary filesystem. Retain
these controls if deploying without the supplied Compose file (`ulimit -c 0`
before starting Node is required).

There is deliberately no Origin allowlist. Native mobile and daemon WebSocket
clients commonly omit `Origin`, so requiring it would break the supported
non-browser transport. The relay accepts no cookie or URL credential and
requires the bounded, schema-validated first control frame with an explicit
bearer credential. Browser Origin is therefore not an authentication decision;
an untrusted browser without that credential cannot open a stream. Deployments
that add a browser UI may layer a same-origin policy at Caddy, but must not
substitute it for first-message authentication.

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
# Starts real MySQL, Redis, relay, and daemon processes, then drives a QR test client:
npm run test:e2e --workspace @prospero/relay
```

## Production runbook

### Before first deployment

1. Create an A/AAAA DNS record for `RELAY_DOMAIN` that reaches this host on
   TCP 80 and 443. Do not put the relay WebSocket port, MySQL, Redis, or
   metrics on a public listener. Caddy uses the DNS name and `ACME_EMAIL` to
   obtain and renew TLS; verify the public endpoint is `wss://<domain>/v1/*`
   only after the certificate is issued.
2. Copy `.env.example` to a host-local, mode-`0600` `.env`. Generate distinct
   long MySQL application and root passwords with the platform secret manager
   or a cryptographic generator. Never commit `.env`, relay host secrets,
   tickets, client credentials, metrics bearer values, or database backups.
3. Set an explicit `RELAY_NOFILE_SOFT/HARD` at or above 131072 and ensure the
   Docker daemon/service manager permits that limit. The production compose
   file makes the relay and Caddy limits explicit; validate with
   `docker compose ... config` before rollout.
4. Bring up the stack with the command in **Run**. `migrate` must complete
   before `relay`; wait for `mysql`, `redis`, and `relay` health to be healthy,
   then check `/health/live` and `/health/ready` from the internal network.
   A ready response requires both MySQL and Redis, so it is the deploy gate.

### Migrations, rollback, and upgrades

Take a MySQL backup before every schema or image change. Build the intended
image, run its migration job once, and only then roll the relay process. Keep
the previous image digest and a tested backup until the health/readiness and
WebSocket smoke checks pass. Application rollback is safe only when the new
migration is backward-compatible; otherwise restore the pre-change MySQL
backup first, deploy the previous image, and verify a disabled route remains a
tombstone rather than being recreated. Do not downgrade blindly across an
unknown schema version.

For a relay-only upgrade, drain or restart one relay instance at a time. Hosts
are expected to reconnect and re-send their snapshot; clients receive a
fail-closed disconnect rather than opaque bytes being replayed or transformed.
Validate reconnect and readiness with the fault harness before treating an
upgrade procedure as reusable.

### Capacity and topology boundaries

The current implementation keeps host presence and stream leases in Redis and
durable routes in MySQL, but capacity has an important per-instance boundary:
the host control connection and both ends of a stream are owned by one relay
process. Load-balancing must therefore use WebSocket affinity/routing that
keeps a route's host and offered streams on the same instance, or use a
dedicated connection-routing layer before horizontal scale is claimed. Do not
equate a multi-instance Caddy deployment with transparent stream mobility.

The local capacity harness is intentionally separate from production compose:

```sh
# Its default project is prospero-t8-capacity and its published ports are 43306/46379/43878.
docker compose -f apps/relay/bench/compose.local.yaml up -d --build
node apps/relay/bench/load.mjs --url ws://127.0.0.1:43878 \
  --metrics-url http://127.0.0.1:43878/metrics --hosts 5000 --streams 1000 \
  --duration-seconds 600 --direct-baseline-report /secure/direct-baseline.json
```

Use a direct-path RTT report produced in the same environment; a relay
round-trip is not an added-RTT measurement. The runner reports `inconclusive`
for reduced scale, insufficient Docker resources, or a missing baseline, and
fails nonzero for connection, delivery, heartbeat, integrity, or harness
failures. Its JSON contains aggregate counters only and uses repository-root
relative output paths, so it can be run from the repository root or an npm
workspace without relocating reports.

### Monitoring and alerts

Scrape `/metrics` only on the internal network (or configure an authenticated
metrics path deliberately). Alert on sustained readiness failures; nonzero
unexpected disconnects; stream-open p95 approaching 500 ms; relay event-loop
lag p99 approaching 100 ms; RSS approaching the 2 GiB acceptance guard; FD
growth approaching the configured nofile limit; send callback errors or queued
write growth; Redis/MySQL reconnect errors; and relay restarts. Track
per-direction forwarded bytes alongside client-visible delivery counts to
distinguish an idle deployment from a forwarding regression.

### Backup, restore, retention, and incidents

Use a consistent MySQL dump (or the managed database equivalent), encrypt it,
store it outside the relay host, and regularly restore it into an isolated
stack. The fault harness proves a route/tombstone backup-restore round trip:

```sh
node apps/relay/bench/failure.mjs --url ws://127.0.0.1:43878 \
  --compose-file apps/relay/bench/compose.local.yaml --project prospero-t8-capacity \
  --confirm-disruption --skip-public-deployment
```

It also validates Redis/MySQL fail-closed behavior and recovery, relay restart
and host reconnect, disabled tombstone rejection, and accelerated proof of the
30-day inactive-route cleanup. Run it only against the explicitly named
isolated project: it intentionally stops dependencies and restores MySQL.

For an incident, first preserve aggregate metrics and service logs, then check
`/health/ready`, Docker health, FD limits, and Redis/MySQL reachability. Keep
the system fail-closed during dependency loss; restore the dependency and wait
for readiness before reconnecting hosts. Do not delete a disabled route to
“repair” it: inspect the tombstone, restore from backup if necessary, and
explicitly enable it only with operator approval.
