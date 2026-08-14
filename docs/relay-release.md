# Relay release `0.0.13`

## Scope

This release integrates the relay security audit (T7), capacity/reliability
evidence (T8), and iOS, Android, and macOS QA record (T9). It delivers source,
container configuration, migrations, tests, and an operator runbook. It does
not represent a completed public relay deployment.

## Security model

The relay is a transport fallback for a previously paired device, not an
identity provider or trusted application endpoint. Its three sockets separate
host control (`/v1/host`) from phone and host data sockets (`/v1/client` and
`/v1/stream`). Once both data sockets receive `stream.ready`, the relay forwards
opaque SecureChannel frames without decrypting, parsing, transforming,
compressing, or reframing them.

Host secrets, E2E pairing tokens, relay device credentials, and one-time stream
tickets are distinct values. MySQL and Redis retain only domain-separated
digests; Redis AOF/RDB ticket values omit the raw bearer ticket. The supplied
Compose configuration keeps MySQL, Redis, relay, and metrics off public ports;
Caddy is the only public listener, strips untrusted forwarding headers, and is
the sole fixed peer trusted to supply the client IP. Containers disable core
dumps and apply read-only, capability, PID, temporary-filesystem, and FD-limit
controls. Details and adversarial-test coverage are in
[relay-design.md](relay-design.md) and [relay-security-audit.md](relay-security-audit.md).

## Deployment, operations, and recovery

Follow [the relay runbook](../apps/relay/README.md) for DNS, secrets, Compose,
health/readiness, monitoring, backup/restore, migrations, and rollback. Before
an upgrade, take and test an encrypted MySQL backup, retain the prior image
digest, run migration once, then verify health, readiness, and reconnect
behavior. Roll back application code only across a backward-compatible
migration; otherwise restore the pre-change database before deploying the
previous image. Disabled routes are tombstones and must be explicitly enabled,
not recreated implicitly.

The daemon obtains the optional default relay origin from
`PROSPERO_DEFAULT_RELAY_URL` in its own process environment. A local
`config.json` `relay.url` override takes precedence. Build or service packaging
must inject only a `wss://` URL; secrets belong in the daemon home and QR
ceremony, never in mobile build configuration or logs. Use:

```sh
prosperod relay enable [--url wss://relay.example.com]
prosperod relay status --json
prosperod relay disable
prosperod relay rotate-key --yes
```

`rotate-key` invalidates every relay credential and requires a new QR scan for
each device; it does not revoke existing direct pairing. QR v7 carries an
optional relay extension with a separate device credential. Mobile `auto`
races direct and relay and retains the first E2E `hello.ok`; `direct` and
`relay` force their corresponding path. Pre-relay QR/device records remain
direct-only until re-paired. The full compatibility matrix is in
[relay-design.md](relay-design.md#compatibility-matrix).

## Acceptance evidence and residual risks

### T10 local verification

- `npm install --package-lock-only --ignore-scripts --offline` completed after
  all workspace and relay-to-protocol versions were set to `0.0.13`.
- `npm run typecheck` passed; `npm test` passed: daemon 37 files / 341 tests
  (4 explicit skips), mobile 32 / 201, relay 26 (2 Docker-gated skips), and
  protocol 54. `npm run lint --workspace @prospero/mobile`, relay bench tests
  (9/9), Swift tests (8/8), and the Swift release build also passed.
- Production and local-benchmark Compose files passed `docker compose config
  --quiet`. The relay production dependency audit is zero vulnerabilities.
  The root production audit has 23 findings (9 moderate, 14 high, 0 critical)
  in the Expo/Metro/React Native chain and is not waived by the relay result.
- Fresh local Docker verification completed on the final source: the fixed
  digest for `node:22.14.0-alpine3.21` was pulled, and the production
  `apps/relay/Dockerfile` built successfully as `prospero-relay:t10-verify`.
  `npm run test:integration --workspace @prospero/relay` passed (1/1), as did
  `npm run test:e2e --workspace @prospero/relay` (1/1), including direct,
  relay, and auto paths plus relay forwarding of opaque E2E traffic.
- An isolated `prospero-t10-smoke` Docker project passed a 250 host-control /
  50 active-pair / 30-second smoke: all requested connections established,
  there were no unexpected disconnects, 1,000/1,000 host heartbeats were
  acknowledged, and each direction drained exactly 45,495,600 bytes with zero
  integrity failures. Its local report
  `/tmp/prospero-t10-load-smoke.json` contains desensitized aggregate counters
  only; the dedicated project's containers, volumes, and network were removed
  after the run.
- No Gitleaks-compatible executable is installed locally. A tracked-file
  high-confidence private-key/cloud-token heuristic had no matches; this is a
  fallback, not a replacement for the mandatory CI Gitleaks-or-equivalent scan
  called out by the T7 audit.

| Area | Evidence | Status |
| --- | --- | --- |
| Relay security | [T7 audit](relay-security-audit.md), adversarial unit/integration/E2E coverage | Completed; see audit for boundaries and supply-chain residual risks. |
| Fresh local Docker verification | Production image `prospero-relay:t10-verify`; Docker integration and E2E tests (1/1 each); isolated 250/50/30-second smoke | Passed at this local test scope; not a capacity qualification or public-deployment proof. |
| Capacity and reliability | `apps/relay/reports/t8-acceptance-summary.json`, `t8-local-failure.json`, per-scale reports, and bench harness | **Inconclusive/waived**; not a 5k/1k/600s pass. |
| Client QA | [T9 cross-platform matrix](qa/t9-cross-platform-qa.md) | Completed on simulators and macOS shell; no physical mobile-device coverage. |
| Public deployment | Operator runbook and static Compose/Caddy configuration | Not performed or claimed; public DNS, TLS/WSS, and firewall checks remain operator work. |

The fresh reduced smoke has execution status `passed`, but its qualification
status remains `inconclusive`: it is not the T8 target. The waived T8 evidence
was obtained on a Docker host with 10 vCPU and 11.7 GiB of memory, below the
16 GiB target. It passed 2,500 host controls / 500 active pairs / 60 seconds,
but the 5,000 / 1,000 / 60-second execution recorded 174 unexpected
disconnects and incomplete drain callbacks. There is no successful 5,000 host
/ 1,000 active stream-pair / 600-second result, no 16 GiB qualification, no
same-environment direct RTT baseline, and no public DNS/TLS/WSS validation.
These remain inconclusive/waived release boundaries—not passing criteria—and
no real public deployment has been performed or claimed.

Remaining risks include relay-visible metadata and denial of service by a
malicious or unavailable relay; no physical iOS/Android validation; no safe
live QR session in QA; and the Expo/Metro/React Native dependency chain findings
recorded in the T7 audit (the current root production audit reports 23 items:
9 moderate and 14 high, no critical). Relay-only deployment also requires the
host service to preserve `ulimit -c 0` and configured FD limits. The repository
is licensed under [MIT](../LICENSE).
