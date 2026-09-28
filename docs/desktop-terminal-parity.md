# Desktop terminal parity

This change targets the CLI terminal transport and renderer. It does not replace
CLI interaction with structured chat, install a new desktop build, or restart
existing terminal hosts. The requested manual comparison baseline is iTerm2.

## Reliability

- PTY input is written through a bounded FIFO, keeping the offset of a partially
  written chunk. `WouldBlock` yields to output processing and shutdown. Success
  acknowledges a fully written chunk, rather than just its admission to a queue.
- Input waits independently of ordinary RPC deadlines at the native writer,
  terminal-host client, and desktop client. Explicit shutdown/cancellation and
  transport failure remain observable. An ambiguous transport failure is never
  automatically replayed and no longer automatically kills the terminal.
- Daemon-owned DA1, cursor-position and foreground/background color queries are
  suppressed in the event-mode renderer. Legacy terminals retain xterm replies.
  Cursor replies use the position at the query, including split output chunks.
- Every supported viewport size retains its screen parser. The shadow parser's
  scrollback budget is 3,400 rows, sized for a 500-column, 300-row viewport within
  its existing cell budget. The live xterm scrollback remains 10,000 rows.
- A cold snapshot is still a current-screen checkpoint, not an unlimited terminal
  transcript. Unsupported parser state and discarded historical output are not
  presented as a complete restored history.

## Interaction

- Resize requests retain the newest geometry through output replay, coalesce
  in-flight changes and retry failed updates. Exited terminals resize locally.
- Mouse mode is remembered and synchronized across mounted sessions. The default
  remains local text selection; application mode passes mouse handling to the
  CLI. Focus mode retains a small control strip outside terminal content.
- Session reading/search state is stored separately from bytes in a bounded
  in-memory store. It can restore position when the reconstructed history still
  contains that position; it cannot recreate pruned historical content.
- Plain-text paste retains bracketed-paste handling. Non-text clipboard content
  produces a notice. Automatic terminal replies do not constitute user typing.
- Streaming UTF-8 normalization works around xterm 6's split continuation-byte
  decoding issue, including split ZWJ sequences. Bytewise and coalesced recovery
  retain the same text/cells; the original recovery regression is unchanged.

## Rendering and validation

- Adjacent output events are coalesced inside a page. Resize events remain hard
  boundaries and cancellation is checked between writes.
- WebGL is loaded after terminal open. Initialization failure or context loss
  falls back to the DOM renderer.
- `npm run check:terminal -w @prospero/desktop` builds and exercises the real
  Electron renderer/IPC against an isolated synthetic terminal service. It
  covers live/replayed queries, exactly-once keyboard input, Unicode paste,
  non-text paste feedback, output-time resize, GPU context loss, mouse preference
  and six-session eviction. Temporary profiles never contact the daily daemon.
- `npm run check:terminal:performance -w @prospero/desktop` compares the previous
  per-event writer with current DOM/WebGL rendering, three runs per mode. It
  asserts equal screen text, cursor and geometry and writes results under
  `output/desktop-terminal/performance.json`. This is synthetic renderer
  throughput, not native iTerm2 performance or end-to-end keystroke latency.
- Rust `terminal_backpressure` uses real PTYs: a 1 MiB paste is checked by SHA-256
  after paused stdin and concurrent stdout, and blocked input can be stopped.
  Host tests separately verify input beyond the previous eight-second timeout.

## Manual comparison still required

The computer-use tool denies access to iTerm2 on this host. No iTerm2 interaction
or manual Chinese IME test is claimed. Before a release, compare the same CLI in
iTerm2 and the isolated desktop build for IME candidate confirmation, Option and
Control shortcuts, trackpad scrolling, selection, tmux/vim mouse mode and long
interactive sessions. Windows/macOS platform-specific manual checks remain
distinct from cross-platform unit checks. No production preference is changed
to run this comparison.

## Recorded verification (2026-09-28, macOS)

- Desktop: 73 test files / 519 tests passed; TypeScript check and production
  renderer build passed.
- Rust: terminal-focused library tests and 27 PTY/runtime/screen/backpressure
  integration tests passed. The host input test waits 8.2 seconds; a separate
  transport-error test checks there is no automatic close or replay.
- Desktop/Rust integration: 13 snapshot compatibility tests and one live-PTY
  history-pruning/cold-recovery test passed. The latter supports
  `PROSPERO_TEST_DAEMON` to test an explicitly selected isolated binary.
- Electron: nine checks recorded in `output/desktop-terminal/ui-result.json`;
  screenshot in `output/desktop-terminal/terminal-parity.png`.
- Synthetic renderer median, three runs: previous per-event DOM writer
  6,569.7 ms / 1,276 writes; current DOM 183.4 ms / 24 writes; current WebGL
  183.3 ms / 24 writes. Final text, cursor and dimensions match across modes.
  This workload primarily demonstrates batching, not a measurable WebGL speedup.
- Strict Clippy is blocked by the pre-existing `large_enum_variant` warning in
  `apps/daemon-rs/src/agent/runtime.rs:161`, outside this change. That warning was
  neither suppressed in source nor fixed as unrelated work.

The installed application and daily daemon were not replaced or restarted.
Existing hosted sessions keep their pinned runtime binary until a deliberate
rollout; building this branch alone does not retrofit them.
