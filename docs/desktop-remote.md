# Desktop remote Shell

Prospero desktop can act as both a host and a remote client. Open the dedicated **远程电脑 / Remote computers** tab in the sidebar. **移动端 / Mobile** remains a separate page for incoming device pairing.

1. On the computer to control, generate a new pairing code under **移动端 → 让其他设备连接本机**. Keep **允许 Shell / Agent 会话** enabled. Copy the pairing code.
2. On the controlling computer, expand **添加远程电脑**, paste the code and select **导入电脑**.
3. Select **连接 Shell**. An existing live PTY is offered first; otherwise a new Shell is created. Run `codex`, `claude` or another installed CLI inside that terminal.

The terminal supports normal keyboard input, Enter, arrows, Tab, Ctrl-C, paste, scrollback and window resizing. **+ Shell** creates another session in the optional remote working directory. Session tabs attach to existing sessions. **断开** stops the client connection; **结束当前 Shell** ends the selected remote process.

LAN candidates race. If a pairing code includes relay credentials, its relay joins after a 750 ms direct connection head start. Codes with no LAN address can connect through relay alone. Configure the host's relay before generating the code; enabling a relay does not add credentials to old codes.

The desktop main process owns the connection, pinned daemon key, pairing token and stable client identity. Pairings are encrypted with Electron safeStorage and replaced atomically. Credential fields never enter renderer IPC. A transient drop reconnects with backoff and attaches at the last received terminal sequence; an old gap falls back to the daemon's snapshot. Authentication failures stop automatic retries and require a fresh pairing code. Early experimental desktop builds did not persist the client identity; their previously bound codes may require re-pairing once.

## Verification

- `npm test -w @prospero/desktop`: credential persistence, redaction, failed writes, cancellation, creation coalescing and repeated reconnect failures.
- `npm exec -w @prospero/daemon -- vitest run test/desktop-remote.e2e.test.ts`: actual desktop client and manager, daemon, PTY and relay data plane. Covers direct, relay-only and unreachable-LAN fallback; creation, input/output, size, existing-session attachment, disconnect recovery, fresh client identity reuse and termination.
- The relay E2E fixture uses the production relay server with in-memory storage adapters and loopback transport. It does not validate deployment TLS, MySQL/Redis operations or a particular external network.
- Native Electron UI checked against an isolated daemon bound to the Mac's LAN address: pairing import, existing Shell restoration, keyboard command execution and 1480/900 px layouts. Test state and credentials use temporary directories.
