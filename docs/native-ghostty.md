# Native Ghostty terminals on macOS

Prospero keeps its Electron shell and Rust daemon. Live local event-mode PTY
sessions on macOS use a native AppKit view backed by Ghostty 1.3.1. Other
platforms, remote-workspace terminals, older daemons, and archived terminal
history retain the existing xterm implementation.

## Architecture

`NativeTerminalPane` supplies the native view's bounds and visibility, with no
persistent status/error footer. Ownership and reconnect actions live in the
session menu; the search row appears only when requested. DOM dialogs, menus, and overlapping popovers
hide the native surface; closing them restores the same surface. Keyboard focus
is transferred only on explicit focus changes, not on every layout update.

`NativeGhosttyManager` owns the native module, local socket, and authenticated
daemon WebSocket. Credentials never reach the renderer or the relay child.
The existing `TerminalStreamController` retains ownership, ordering, and stream
flow-control rules. Snapshot and resize events set the authoritative terminal
grid before replay. The renderer's desired geometry is applied after the initial
stream becomes ready. Busy resize requests receive bounded retries.

Ghostty launches `prospero-terminal-relay` inside its own PTY. The relay bridges
keyboard bytes, dimensions, and output to a private Unix socket. The agent
process remains in the Rust daemon. Destroying a native surface only detaches
that viewer. The relay acknowledges output after its PTY write completes; the
OS PTY buffer supplies backpressure, rather than acknowledging Ghostty parser
completion. The daemon answers selected VT queries, so those queries are
filtered before native display to prevent duplicate responses.

The AppKit bridge supplies text input, preedit/commit handling, clipboard text
and image paste, native selection, search, and application shortcut callbacks.
AppKit-to-JavaScript callbacks use Node-API handle and callback scopes.
Native focus is remembered across app/window deactivation so copying in another
app and returning with Command-Tab does not redirect paste into Chromium.
Explicit DOM focus, hidden panes, and activation clicks outside the terminal
cancel that restoration. Unsafe paste confirmation uses an asynchronous native
sheet; cancelling it does not paste any content.

When macOS reports no active displays, CVDisplayLink creation can fail with
`-6661`. The pinned upstream wrapper previously reported this as out of memory.
The bundled patch keeps Metal rendering and falls back to drawing on changes
when display synchronization is unavailable.

Precision scrolling preserves fractional cell remainders on both axes instead
of discarding them at each whole-row transition. The native config applies a
`precision:1.5` scroll multiplier; discrete wheels retain Ghostty's default.
Mouse enter/exit tracking remains active for inactive windows and keeps TUI
wheel-report coordinates current without changing keyboard focus.

## Building

The complete native C API is pinned to commit
`332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28` (Ghostty v1.3.1). It is not an
unversioned system library. The build script verifies the revision and applies
`native/ghostty/standalone-library.patch`, which emits the native static library
without building Ghostty's GUI or iOS targets.

Prerequisites:

- A checkout of `ghostty-org/ghostty` at the pinned commit.
- Zig 0.15.2, Xcode with its Metal Toolchain component, and Node-API headers.
- On machines with Xcode 26.4's arm64e-only SDK stubs, an older compatible
  Command Line Tools SDK for the Zig build runner. Metal compilation still uses
  Xcode. These paths are scoped to build subprocesses; system Xcode selection
  is not changed.

Set `PROSPERO_GHOSTTY_SOURCE`, `PROSPERO_ZIG`, and optionally
`PROSPERO_NODE_HEADERS` / `PROSPERO_GHOSTTY_DEVELOPER_DIR` to override the local
cache defaults documented in `scripts/build-native-ghostty.mjs`.

```sh
npm run build:native:mac -w @prospero/desktop
npm run build -w @prospero/desktop
npm run check:native:mac -w @prospero/desktop
npm run check:native-terminal -w @prospero/desktop
```

Artifacts go to ignored `apps/desktop/.native/ghostty/` and are packaged under
`Contents/Resources/native-ghostty/`. The macOS package check verifies the
architecture of both the addon and relay. Build on/for each target architecture
before packaging it. The current validated target is Apple Silicon macOS.

## Validation and troubleshooting

The standalone smoke test checks native command launch, relay input/output,
focus callbacks, synthetic NSTextInputClient preedit/commit, and grid sizing.
The integrated test uses a disposable Rust daemon/profile to check native
output, Chinese text, input, resize, modal occlusion, snapshot restoration, and
the absence of duplicate agent processes. It never attaches to user sessions.
Synthetic IME tests do not replace checking the user's actual input method.

`check-native-terminal.cjs --preview` leaves its isolated window open for three
minutes for visual inspection. Chromium's `webContents.capturePage()` does
**not** include the native Metal surface; inspect the actual macOS window.

`PROSPERO_NATIVE_GHOSTTY=0` explicitly selects xterm for troubleshooting.
`PROSPERO_NATIVE_GHOSTTY_DIR` selects a staged native bundle for tests.
`PROSPERO_NATIVE_GHOSTTY_DEBUG=1` adds local bridge diagnostics, including screen
text on relay failure; use this only where terminal contents are safe to log.

Useful upstream references:

- [Pinned Ghostty C API](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/include/ghostty.h)
- [Embedded runtime](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/apprt/embedded.zig)

Two integration details are easy to misread: `ghostty_surface_set_occlusion`
takes **visible**, not hidden, and the embedded command path adds its own
`exec` wrapper, so the relay command must not start with another `exec`.

Native input and resize commands share one serialized daemon queue. Adjacent pending input frames are combined up to the 8 KiB wire limit, without a batching timer or crossing a resize boundary. The first input dispatches immediately; combining only the pending frames avoids a separate daemon round trip for every small TUI wheel report. Byte order, UTF-8 bytes, and keyboard input are preserved. Queue bytes, entries, and promise waiters are bounded; rejected input is never replayed. This reduces transport catch-up in terminal applications; normal Ghostty scrollback is rendered locally and does not use this queue.

For direction changes, the pixel accumulator discards the old direction's fractional cell remainder before accumulating the reverse movement. This is an intentional responsiveness adjustment: same-direction precision and zero-delta events keep their remainder, but reverse gestures no longer first pay off the previous direction's fraction. It does not retract wheel reports already delivered to a terminal program. The native view also updates Ghostty's display ID after creation and when its window changes screens, so an active display link uses the correct screen. Xterm fallback panes use a zero smooth-scroll duration to avoid adding an animation tail on top of system scrolling.

The Rust PTY worker must drain newly admitted controls before its idle output wait. Previously it could admit input after its initial write pass and then wait up to 20 ms before writing that input. An isolated raw `cat` benchmark with 50 wheel reports (25 in each direction) measured input Result median/p95 of 24.08/27.54 ms before the fix and 0.42/0.61 ms after; echo median/p95 were 25.91/29.39 ms and 2.46/2.64 ms respectively. These are local transport measurements, not a claim about every TUI's rendering latency. The regression test checks that newly admitted control input is written and acknowledged before the worker reaches its idle wait.

Deployment limitation: each terminal host pins its runtime executable by hash. Updating the installed runtime cannot update existing host processes, and an old daemon continues starting hosts from its original pinned cache. The new worker behavior requires a new daemon and newly started terminal hosts. Preserve ongoing sessions during desktop-only updates; do not terminate their processes merely to apply a scrolling fix.

Rapid-scroll diagnostics (isolated fixture, 213×73 grid on the internal 120 Hz display) measured native scroll callbacks at 5.1 µs median / 22.5 µs maximum, renderer invocation intervals around 7.5–8.4 ms, and steady draw-call costs of 15–340 µs. The main-queue wakeup backlog stayed at one task; one scheduling delay reached 14.7 ms under ambient host load. These are invocation/timing measurements, not proof of every frame reaching the panel. No native wakeup-coalescing change was justified. See `output/native-ghostty/scroll-performance.json` for the no-content diagnostic snapshot. Temporary instrumentation is excluded from production builds.

Terminal stream state notifications are now deduplicated by all exposed state fields, so ordinary Output batches do not trigger identical Electron IPC/React updates. Output bytes, committed sequence advancement, and cumulative Applied acknowledgments still flow normally; the regression test checks 100 separate output commits and real state transitions.

Unix PTY output now waits for descriptor readiness after `WouldBlock` instead of sleeping for a fixed 2 ms. An owned CLOEXEC descriptor keeps the poll target valid for the reader's lifetime. Readable data is drained before hangup; invalid descriptors and bare hangup/error terminate cleanly. The 100 ms timeout bounds idle shutdown observation and does not delay readable output. Windows retains its existing reader behavior.

Faster output exposed an existing host shutdown race: Axum does not wait for detached WebSocket upgrade tasks. The host now waits up to five seconds for its terminal stream permits and holds the drain guard through cleanup, allowing final output acknowledgments and Exit delivery before the process disappears. A finite-output regression with withheld client credit verifies the drain. Reproduce throughput with `npm --prefix apps/desktop run check:daemon-output-throughput`; set `PROSPERO_RUST_BINARY` to select the old/new binary and `PROSPERO_BENCH_KEEPALIVE=0` to exercise finite-output shutdown. The benchmark gates the producer on stream readiness and places its start marker inside Python after interpreter startup. It measures transport throughput and inter-output gaps, not presented display frames.

Final release comparison with the corrected 174×64 / 600-repaint harness: old runtime 12,757.22 ms / 0.51 MiB/s; new runtime 1,848.67 ms / 3.49 MiB/s with the producer kept alive in both runs. The new finite-producer run also delivered the end marker (1,428.35 ms / 4.52 MiB/s). Logs are under `output/daemon-output-throughput/`. The installed runtime SHA-256 is `6469e6624e2a3b3a63c87e3cd53dd5bac8f07524d469181d25654f949fa667a7`. The affected Codex conversation was resumed in a new host using this hash; the other nine running hosts retained their original processes.
