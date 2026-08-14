# Structured Agent Supervisor

## Decision

PTY sessions survive a daemon restart because tmux owns their process. Structured sessions do not: the daemon owns each adapter and its SDK/stdio handle. The durable boundary must therefore be a **per-session supervisor process**, not a special case inside `SessionManager.disposeAll()`.

The supervisor has two deliberately separate responsibilities:

1. **Transport lifetime and durability** — process ownership, private IPC, ordered durable events, reconnect/replay, attachment custody, and explicit kill semantics. This layer is agent-neutral and must not know any provider's request/approval enum values.
2. **Agent protocol compatibility** — the adapter inside that supervisor translates a particular installed CLI/SDK version to Prospero's normalized events. It is versioned per adapter and can change independently of the transport protocol.

That separation is important for the current Codex issue: local `codex 0.147.0 generate-ts` reports v2 decisions `accept`, `acceptForSession`, `decline`, and `cancel`; the current adapter still sends `approved` / `approved_for_session`. T4 owns that translation repair. The supervisor protocol carries the normalized request and resolution records unchanged; it must not duplicate or freeze the Codex-specific mapping.

## Isolated evidence

`apps/daemon/test/daemon-shutdown-survival.test.ts` is a real process probe. Every case creates a fresh temporary Prospero home and `git init` repository, then uses only a fake stdio agent or `custom` echo command. It never attaches to an existing user daemon, tmux server, or provider session.

| signal sent to daemon-like parent | tmux PTY fake/echo | structured fake stdio agent |
| --- | --- | --- |
| `SIGTERM` | survives and writes its marker | does not write its marker: `disposeAll → StructuredSession.dispose → adapter.dispose` closes/kills it |
| `SIGKILL` | survives and writes its marker | does not write its marker: parent death closes its stdio owner transport |

The test passed locally on 2026-08-14. It corroborates the source-level path:

```text
cli SIGTERM → server.close → manager.disposeAll
                          ├─ PTY: detach the tmux client (no kill-session)
                          └─ structured: adapter.dispose
                              ├─ Codex: proc.kill()
                              ├─ Claude: input.close() + SDK interrupt
                              └─ Grok: current turn.kill()
```

`SIGKILL` never runs a cleanup handler. A supervised native process may or may not remain as an OS orphan, but an adapter held by the daemon loses its SDK/stdio protocol state and has no durable owner to reconnect it. That is why “the child PID still exists” is not a recovery guarantee.

## Target boundary

```text
mobile / Mac / daemon (replaceable client)
        │ private Unix socket + capability token
        ▼
per-session supervisor (long lived, owns adapter + native connection)
        │ provider-specific protocol
        ├── Codex app-server / proxy
        ├── Claude Agent SDK
        ├── OpenCode HTTP + SSE
        └── Grok child turn
```

The daemon remains the authority for device authentication and UI fan-out. The supervisor is the authority for one running native agent. A daemon restart, upgrade, or client socket break only removes the top connection; it does not call `interrupt`, `dispose`, or `kill` in the bottom half.

### Private IPC and authentication

On Unix, each supervisor gets a 0700 directory and a 0600 Unix socket. It also has a fresh 256-bit capability token in a 0600 token file. Every NDJSON RPC includes that token; Unix ownership protects local peer access and the capability makes accidental socket-path reuse insufficient for access.

Do not put a capability token in argv. The daemon launcher should pass a pre-opened protected token file/FD, or arrange a private token file before spawning the supervisor. The current vertical slice returns it only to its test parent through a pipe. Windows needs a named-pipe equivalent with the same per-user ACL/token rule before this feature is enabled there.

The external supervisor protocol is not Codex app-server JSON-RPC. It is a small, versioned Prospero envelope:

```text
request  { id, token, method, params }
response { id, ok, result | error }
event    { method: "session.event", params: { sessionId, seq, at, body } }
```

Initial methods are `session.subscribe`, `session.send`, `session.interrupt`, `session.kill`, and `session.status`. `session.subscribe(afterSeq)` responds with all retained events whose sequence is greater than `afterSeq`, then streams new events. The supervisor installs the subscription cursor before writing the response, so a later event is not both replayed and live-delivered on one connection.

Events are written atomically before notification. Delivery to a reconnecting daemon is therefore at-least-once across a crash boundary; the daemon deduplicates by `(sessionId, seq)`. Within retained history, no sequence is skipped. If retention has advanced, `gap: true` forces a durable snapshot/reconciliation instead of pretending an incomplete replay is exact. Command RPCs will gain `commandId`/result persistence before production clients retry mutating commands.

### Supervisor-owned state

The production shape is one directory per session:

```text
~/.prospero/structured-supervisor/<session-id>/
  manifest.json       # agent, cwd identity, adapter/native resume state, lifecycle epoch
  events.jsonl        # monotonic normalized events and request/resolution audit
  commands.jsonl      # idempotency keys and accepted mutating RPCs
  pending.json        # question/permission requests and queued replies
  attachments/<id>    # supervisor-owned immutable attachment copies
  supervisor.sock
  token
```

The vertical slice intentionally uses one `state.json` plus one socket in its temporary `home`; it proves the transport invariant, not final per-session process spawning or log compaction. The durable format must include a schema version, native adapter resume cursor, executable identity/version, PID start time, and supervisor epoch. Events are append-first (or atomic replace in the slice), then visible to clients. Snapshot compaction records the first retained sequence and preserves a reducer snapshot.

Attachments are copied into the supervisor's attachment root before an adapter sees them. IPC carries attachment IDs and metadata, never a daemon-provided absolute path. The supervisor resolves the final path under that root, rejects symlinks/traversal, uses mode 0600, and stores the content hash. This lets a reconnected daemon render a stable attachment reference without gaining arbitrary filesystem access.

### Offline approvals and questions

Daemon-offline means **wait**, never implicit approval. A supervisor persists and emits `permission.request` or `question.request`, keeps the native adapter callback/turn waiting, and replays that request after reconnect. A reply is accepted only for the original request ID and is persisted before forwarding. The UI must show “waiting for input; daemon offline” rather than a false running state.

If a configured policy has a legitimate local auto-allow rule, the supervisor records the policy decision as a resolution event; daemon absence itself is never such a rule. An explicit bounded policy timeout may deny/cancel with an auditable reason, but must be set per agent/policy and must not silently become “accept”. On supervisor process restart, pending native callbacks cannot be reconstructed generically: reconciliation must resume the native session if supported and reissue/mark the request as `needs_reconciliation`; it must not fabricate a reply.

`session.kill` is the only termination request. It first persists the intent, asks the adapter to cancel/kill the native work, writes a terminal event, and prevents further sends. Daemon shutdown only closes its client socket. A user-visible “Stop” remains `session.interrupt`; it is weaker than kill and keeps the session available.

### Startup reconciliation and orphan handling

On daemon startup or upgrade:

1. Scan supervisor manifests, verify socket ownership/mode, PID plus process start time, and lifecycle epoch.
2. Reconnect to each live supervisor and call `session.subscribe(lastAckedSeq)` before serving UI traffic.
3. Reconcile the supervisor's `running`, pending request, terminal, and native-resume records with orchestration task state.
4. Mark a manifest whose process is absent as `orphaned`, preserving logs and attachments. Do not automatically launch another native turn from a stale manifest.
5. Delete only a verified stale socket and fully terminal, retention-expired directory. Never delete an unknown live PID, a nonterminal orphan, or an attachment root during routine startup.

The operator can explicitly reclaim an orphan (adapter-specific resume) or explicitly kill/archive it. The daemon must use a lock/epoch when spawning so two rapidly restarted daemons cannot create competing supervisors for the same session.

## Codex app-server assessment

The current adapter starts `codex app-server` as a daemon-owned stdio child, so it cannot outlive the daemon. It already has useful pieces to reuse: normalized event conversion, persisted `threadId`, thread resume, account-scoped environment/configuration, and adapter-level approval/question tracking.

Official OpenAI documentation says app-server is a bidirectional JSON-RPC integration surface with conversation history, approvals, and streamed agent events. It supports stdio JSONL by default and a Unix-socket listener (`--listen unix://` or a custom path); transport clients initialize then can start or resume a thread. The generated TypeScript/JSON schemas are explicitly version-specific, which supports keeping Codex compatibility in the adapter layer rather than in supervisor transport. [OpenAI Docs: Codex App Server](https://developers.openai.com/codex/app-server)

Local inspection on 2026-08-14 found `codex-cli 0.147.0`. Its `app-server --help` advertises `stdio://`, `unix://`, `unix://PATH`, `ws://IP:PORT`, and `off`; its experimental `generate-ts` output contains v2 `FileChangeApprovalDecision` and `CommandExecutionApprovalDecision` values `accept`, `acceptForSession`, `decline`, and `cancel` (plus command policy-amendment variants). The CLI also exposes `app-server daemon` (`bootstrap`, `start`, `restart`, `stop`, remote-control management, and version) and `app-server proxy --sock <SOCKET_PATH>`, which forwards stdio bytes to an existing app-server Unix control socket. These help/schema commands were inspected only; no existing local Codex daemon was started, stopped, or modified.

For Codex, a durable proxy can therefore own either:

- the existing stdio app-server child inside the supervisor, or
- `codex app-server --listen unix://<private-path>` inside the supervisor, with the supervisor as the sole app-server client.

The native `app-server daemon` / `proxy` pair is a useful optional implementation primitive for Codex: a supervisor could connect a short-lived proxy to a managed Codex control socket instead of owning a direct child. It is not the universal supervisor and must remain behind a Codex-specific capability check: it is global/local-Codex lifecycle management, does not encompass Claude/OpenCode/Grok, and does not itself add Prospero event sequence/replay or daemon-offline approval semantics. Do not call `daemon restart` as part of a Prospero upgrade handoff.

The second is not a replacement for the Prospero supervisor socket: app-server notifications do not provide Prospero's durable, sequenced replay contract, attachment custody, task reconciliation, or daemon-offline semantics. TCP/WebSocket app-server transport is documented as experimental/unsupported for production; do not expose it as the supervisor boundary. [OpenAI Docs: transports and experimental WebSocket warning](https://developers.openai.com/codex/app-server)

Claude, OpenCode, and Grok must not be assumed to offer an equivalent daemon endpoint. Claude currently runs its SDK query in process; OpenCode has a daemon-owned shared `serve` plus SSE subscription; Grok starts a per-turn child process. Each needs a supervisor-resident adapter, even if its native resume story differs.

## Executable vertical slice

`apps/daemon/src/structured-supervisor.ts` implements the transport half:

- private Unix socket plus per-request capability token;
- strict session IDs, bounded NDJSON frames, 0600 token/socket files;
- persisted monotonic `SupervisorEvent` records before live notification;
- `session.subscribe(afterSeq)` replay plus a single live cursor;
- explicit `session.kill` distinct from socket/client disappearance; and
- an adapter-neutral interface with no Codex/Claude/OpenCode/Grok decision enums.

`apps/daemon/test/structured-supervisor.test.ts` starts it in a separate Node process with a fake long-running adapter. Client A subscribes, starts work, and exits. The supervisor records progress while no client exists. Client B reconnects with A's cursor, receives replayed sequence 2 and live sequence 3 exactly once. The test also reads the persisted log and verifies socket/token mode.

The vertical slice does **not** yet make `SessionManager` spawn production supervisors, migrate an existing `StructuredSession`, expose snapshots/command idempotency over the wire, or implement a Codex durable proxy. It is intentionally compatible with T4's independent approval vocabulary repair.

## Migration plan and explicit agent work

1. **Shared transport (this slice)**
   - Add a production launcher/registry and per-session directories.
   - Add a `RemoteStructuredSession` facade with the same public calls/events used by `SessionManager`, so WS/mobile state reducers do not need a large rewrite.
   - Add command idempotency, snapshots, retention/compaction, process lock/epoch, and orphan reconciliation.

2. **Codex**
   - Move `CodexAdapter` ownership and `codex app-server` child into the supervisor.
   - Persist `threadId`, app-server schema/version fingerprint, selected model/mode, and native turn identity.
   - Add a private app-server proxy only after testing resume/reconnect against the installed version.
   - Consume T4's v2 decision mapping; keep it inside the Codex compatibility adapter and record the normalized result in the transport log.

3. **Claude**
   - Move the SDK `query()` lifetime and pending `canUseTool` promises into its supervisor.
   - Define what is recoverable after a supervisor process crash versus merely after daemon disconnect; test the official SDK's resume identifier before enabling auto-reclaim.

4. **OpenCode**
   - Move shared `opencode serve` ownership from daemon global state to either a host supervisor registry or a deliberately separate provider supervisor.
   - Persist session ID and SSE cursor/reconciliation data; prove duplicate SSE event handling by provider event ID before migration.

5. **Grok**
   - Make the supervisor own each headless turn and session resume ID.
   - Keep its coarse approval limitation explicit; do not claim support for interactive approval replay it cannot provide.

6. **Operations**
   - Add upgrade handoff: new daemon attaches before old daemon closes its clients.
   - Add force-kill/admin cleanup tools that require the session ID and show native PID/epoch.
   - Add crash/fault-injection tests for supervisor death, stale socket, interrupted persist, and pending approval/question.

## Rollout and rollback

Ship behind a feature flag that applies only to newly created structured sessions. The existing in-daemon path stays intact until each agent's migration tests are green. A supervisor session carries its implementation kind and protocol version in its manifest; an older daemon that cannot speak it leaves it running/read-only rather than disposing it.

Rollback disables creation of new supervisor sessions and reconnects only compatible existing ones. It never kills a running supervisor just to return to the old daemon-owned implementation. For a failed migration, preserve the event log, native resume cursor, and attachments; the operator chooses explicit resume, archive, or kill after reconciliation.
