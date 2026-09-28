# Terminal stream v1 implementation contract

Known recovery defect: real Codex sessions can return `history_gap` and a null
snapshot after history pruning. See [evidence and follow-up](terminal-stream-known-issues.md).

Scope: Rust daemon + Electron desktop. Keep the existing terminal engine and
SQLite schema initially. Do not install or restart the daily application during
development. Existing HTTP management and legacy view routes remain available.

## Transport

- Desktop endpoint: authenticated WebSocket `/v1/terminals/{id}/stream`.
- Capability negotiation checks daemon health `terminal.stream.v1`, then
  `GET /v1/terminals/{id}/stream-capabilities`. A new daemon may still own a
  pinned legacy Host; that session explicitly retains the legacy HTTP path.
- Hosted PTYs: the daemon proxies a persistent connection to the terminal host's
  authenticated `/stream`; it does not poll the host per frame. The same protocol
  is served directly for non-hosted/test PTYs. Existing authorization applies.
- Renderer/main: one MessagePort per attachment, transferred through preload.
  Credentials stay in main. Close ports and sockets on detach/window destruction.
- WebSocket messages are binary, including controls. Header is 16 bytes:
  version:u8 (=1), kind:u8, reserved:u16 (=0), sequence:u64 big-endian,
  payloadLength:u32 big-endian, then payload. JS sequence must be a safe integer.
  Reject malformed/oversized frames. Max frame payload 1 MiB.

Kinds (JSON below means UTF-8 JSON in the binary payload):

| Kind | Direction | Payload / sequence |
|---|---|---|
| 1 Hello | server | JSON `{version:1,epoch,clientId,controllerId:null|string,cols,rows,windowBytes}` |
| 2 Snapshot | server | ANSI bytes; sequence = snapshot output cursor |
| 3 Output | server | raw bytes; sequence = output event cursor |
| 4 Resize | server | cols:u16, rows:u16 BE; sequence = event cursor |
| 5 State | server | JSON `{controllerId,readOnly,exited}`; controller updates broadcast |
| 6 Error | server | JSON `{code,message,recoverable}` |
| 7 Exit | server | JSON `{exitCode:null|number}` |
| 8 Ready | server | empty; sequence = initial replay barrier, input can be enabled after prior frames are consumed |
| 16 Input | client | raw bytes, 1..8192 bytes; sequence = operation id |
| 17 Applied | client | empty; sequence = last fully consumed output/snapshot cursor |
| 18 ResizeRequest | client | cols:u16, rows:u16 BE; sequence = operation id |
| 19 Acquire | client | JSON `{takeover:boolean}`; sequence = operation id |
| 20 Result | server | JSON `{ok:boolean,code?:string}`; sequence echoes operation id |
| 21 Release | client | empty; sequence = operation id |
| 32 Attach | client, first | JSON `{afterSeq?:number,epoch?:string,wantControl:boolean}` |

The server sends Hello after Attach, then Snapshot or ordered replay events and
Ready at an initial captured cursor (not a moving target during continuous
output). Hello also includes `latestSeq` and `floorSeq` for observability.
Snapshot unavailable + retained prefix from sequence zero is allowed; an
unreconstructible truncated prefix must fail explicitly, never be presented as
a complete screen. Cold attachment is host-authoritative; the streaming path
does not depend on an Electron main checkpoint cache. Renderer cursor commits
and Applied happen only after xterm has consumed the whole message.

## Flow control and lifecycle

- Default output consumption window: 256 KiB, tracked using outstanding frames
  and Applied sequence acknowledgements. A single oversized snapshot may occupy
  an otherwise empty window, bounded by the 1 MiB frame limit.
- At most 1,024 unacknowledged data frames and 16 viewers per terminal. Renderer
  buffering allows one maximum snapshot plus 64 KiB for its control envelopes.
- Reject acknowledgements ahead of sent data; tolerate monotonic duplicate acks.
- Input Result success means the input bytes were written to PTY. Do not replay
  unacknowledged input after reconnect. An attachment serializes operation ids;
  reject duplicates/out-of-order commands rather than executing twice.
- Bounded queues, responsive disconnect and explicit stop under backpressure.
  Input waiting must not block output or ownership control processing.
- A slow observer must not stall the PTY or other observers. If its cursor falls
  outside retention, explicitly resync/fail; never silently drop live bytes.
- Stream failure is visible. No automatic fallback that replays input or claims
  a snapshot from a cropped suffix. HTTP compatibility is for older servers only.

## Ownership

- One input/resize controller per live PTY, held by the host. Other attachments
  observe. `wantControl` claims only if free; it never steals an existing lease.
- Takeover is explicit; revocation is broadcast and subsequent old-owner commands
  are rejected. Release on disconnect. Keep stop/close outside the data queue.
- Legacy HTTP/remote input and resize must not bypass an active streaming lease;
  return an explicit conflict. Without a lease, legacy behavior stays available.
- Separate connected/syncing, controller/observer, exited and heuristic activity
  in UI. Do not label heuristic output activity as task completion.

## Validation / measurements

Require binary codec fixtures in Rust and TS; malformed frames; ordering;
bounded slow readers; multi-client takeover; stale-controller writes;
disconnect during input; epoch mismatch and truncated-history recovery;
real PTY + Electron MessagePort end-to-end tests. Preserve existing regression
tests. Measure frame count, bytes in flight, input result latency and replay time.
Change engine/storage only if those measurements identify a concrete bottleneck.

## Implemented architecture

```text
React / xterm
    ↕ MessagePort, binary v1
Electron main (credentials + bounded bridge)
    ↕ authenticated persistent WebSocket
Rust daemon (authorization + transport proxy)
    ↕ authenticated persistent WebSocket
Terminal Host (shared stream_session engine, epoch, control lease, replay)
    ↕ portable-pty
shell / CLI
```

`stream_session.rs` is shared by local and hosted terminals. There is no second
daemon-owned controller map or separate weaker Host stream implementation.
The control check and native queue admission share a lock with takeover.
Already accepted input can finish; input submitted after revocation is rejected.
Disconnect drops pending stream work and releases only that client's lease.

Management, closed-session history and legacy endpoints remain HTTP. The live
stream no longer consults Electron's `TerminalRecovery`; each new viewer obtains
the Host's snapshot or contiguous retained prefix. Reconnect uses the consumed
cursor and process epoch. A stale epoch or history gap requires an explicit
fresh-screen reload; input without a Result is never replayed automatically.

The legacy event representation and SQLite tables are unchanged. Live wire
payloads are binary; this does not claim zero-copy transport or removal of the
legacy Base64 representation inside persistence/compatibility adapters.

## Compatibility and boundaries

- A client with an active lease owns both input and viewport size. Observers
  preserve the owner's geometry; they cannot locally reflow a live PTY.
- Electron exposes claim/takeover/release and reconnect/reload separately.
  Background retained views retain their attachment; merely changing focus is
  not an implicit takeover.
- Existing paired/mobile JSON clients remain usable when the lease is free.
  Their input/resize gets an explicit conflict while a stream controller owns
  the terminal. This change does not add a new mobile takeover UI.
- The terminal engine remains avt. Previously measured truecolor and Tab dump
  incompatibilities are normalized before xterm replay. Unsupported protected
  cells/selective erase now refuse a checkpoint instead of silently restoring
  the wrong state. Combining characters/hyperlinks and truncated full history
  still have the documented engine limitations; no unsafe cropped snapshot is
  invented to hide a gap.
- SQLite schema/storage engine is retained. Measured transport improvements do
  not justify adding a message broker or replacing the database.

## Verification

- Rust/TypeScript binary fixtures, malformed packets, acknowledged byte window,
  oversized snapshot allowance, lease admission and stale-owner rejection.
- Real hosted PTY tests cover two-client takeover, legacy bypass prevention,
  restart of the control daemon while the Host retains its epoch/lease, resume,
  stale epoch, duplicate input, invalid ACK, slow observer and pruned history.
- `npm run check:terminal:stream -w @prospero/desktop` exercises the actual
  Electron/preload/MessagePort/Rust/Host chain in an isolated profile. The debug
  `prosperod-rs` binary must be built first. It checks visible controls, keyboard,
  observation without resize, reload/lease cleanup, Unicode paste over 8 KiB,
  and preservation of the same terminal canvas/final output after process exit.
- `check:terminal` retains the legacy-path UI regression checks.
- Cross-engine snapshot integration tests cover actual RGB colors and Tab
  continuation, not just string substitutions in generated ANSI.

The test artifacts are in `output/desktop-terminal/stream-ui-result.json` and
`stream-benchmark.json`. The latter measures written-input ACK latency against
the existing HTTP route using the same isolated PTY (5 warmups and 20 samples
per mode). The final local debug run measured HTTP median 2.99 ms / p95 3.08 ms
and stream median 3.00 ms / p95 3.06 ms. An earlier run measured 23.0 ms versus
2.49 ms medians, but that advantage did not reproduce. No fixed latency speedup
is established. These figures are neither input-to-paint latency nor a general
network-performance guarantee; sustained throughput, paint latency and memory
under longer workloads remain future measurement work before kernel/storage changes.

Final validation on 2026-09-28:

- Desktop typecheck/build and 538 unit tests passed.
- 22 desktop/Rust integration tests passed (15 snapshots, 1 restart, 6 stream).
- 23 Rust terminal unit tests and 30 terminal integration tests passed.
- Actual Electron stream UI: 9 checks passed; legacy UI: 9 checks passed.
- Broad Rust library run: 113 passed, 1 failed, 1 ignored. The untouched plugin
  process-group test failed waiting for its grandchild startup file; its isolated
  rerun passed. This is recorded as an intermittent failure, not a fully green
  broad-suite result.

The daily installed app/daemon are not changed by this development task.
Strict Clippy still reports the pre-existing `large_enum_variant` in
`apps/daemon-rs/src/agent/runtime.rs`; it is not suppressed as part of this work.
