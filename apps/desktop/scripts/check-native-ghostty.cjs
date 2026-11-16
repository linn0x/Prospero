// Isolated libghostty NSView smoke: no Prospero main process or daemon is used.
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const root = path.resolve(__dirname, "../../..");
const bundle = process.env.PROSPERO_NATIVE_GHOSTTY_DIR || path.join(root, "apps/desktop/.native/ghostty");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-ghostty-smoke-"));
app.setPath("userData", path.join(fixture, "electron"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const relay = path.join(bundle, "prospero-terminal-relay");
  if (process.platform === "darwin") {
    const otoolOutput = execFileSync("otool", ["-L", relay], { encoding: "utf8" });
    if (otoolOutput.includes("libc++")) {
      throw new Error(`Expected pure-C prospero-terminal-relay without libc++, got:\n${otoolOutput}`);
    }
  }

  await app.whenReady();
  const native = require(path.join(bundle, "ghostty.node"));
  const baseConfig = fs.readFileSync(path.join(bundle, "config"), "utf8");
  let appConfigPath = path.join(fixture, "app-ghostty.conf");
  let appConfig = baseConfig;
  if (process.env.PROSPERO_NATIVE_GHOSTTY_SMOKE_NO_VSYNC === "1") {
    appConfig = /^\s*window-vsync\s*=.*$/m.test(appConfig)
      ? appConfig.replace(/^\s*window-vsync\s*=.*$/m, "window-vsync = false")
      : `${appConfig.trimEnd()}\nwindow-vsync = false\n`;
    fs.writeFileSync(appConfigPath, appConfig, { mode: 0o600 });
  } else {
    appConfigPath = path.join(bundle, "config");
  }
  native.initialize(appConfigPath, path.join(bundle, "resources"));
  native.setFocusHandler?.((id, focused) => console.log(JSON.stringify({ focus: { id, focused } })));
  native.setShortcutHandler?.((action, id) => console.log(JSON.stringify({ shortcut: { id, action } })));
  native.setPasteImageHandler?.(() => true);
  const openedUrls = [];
  native.onOpenUrl((surfaceId, url) => {
    openedUrls.push({ id: surfaceId, url });
    console.log(JSON.stringify({ openUrl: { id: surfaceId, url } }));
  });

  const window = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await window.loadURL("data:text/html,<html><body style='margin:0;background:%231a1b26;color:%23c0caf5'>Native Ghostty smoke</body></html>");
  window.focus();
  const socketPath = path.join(fixture, "relay.sock");
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = !/\s/.test(relay) && !/\s/.test(socketPath)
    ? `direct:${relay} ${socketPath}`
    : `/bin/sh -c ${shellQuote(`exec ${shellQuote(relay)} ${shellQuote(socketPath)}`)}`;
  const configPath = path.join(fixture, "ghostty.conf");
  const fallbackFontLines = ['font-family = ""', 'font-family = "Menlo"', 'font-family = "PingFang SC"', 'font-family = "Apple Color Emoji"'].join("\n");
  fs.writeFileSync(configPath, baseConfig.replace(/^\s*font-family\s*=.*$/m, fallbackFontLines), { mode: 0o600 });
  let resolveRelay;
  const relayConnected = new Promise(resolve => { resolveRelay = resolve; });
  let resolveResize;
  const resizeReceived = new Promise(resolve => { resolveResize = resolve; });
  const bufferedInputs = [];
  let resolveInput = null;
  const nextInput = () => {
    if (bufferedInputs.length > 0) return Promise.resolve(bufferedInputs.shift());
    return new Promise(resolve => { resolveInput = resolve; });
  };
  let inputReceived = nextInput();
  let relayTextSent = false;
  let activeRelaySocket = null;
  const pendingOutputAcks = new Map();
  let nextAckSeq = 0x2000;
  const sendRelayOutput = bytes => new Promise((resolve, reject) => {
    if (!activeRelaySocket) { reject(new Error("Relay socket is not connected")); return; }
    const ackId = nextAckSeq++;
    const outputId = Buffer.alloc(4);
    outputId.writeUInt32BE(ackId, 0);
    const payload = Buffer.concat([outputId, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")]);
    const header = Buffer.alloc(5);
    header[0] = "O".charCodeAt(0);
    header.writeUInt32BE(payload.length, 1);
    pendingOutputAcks.set(ackId, resolve);
    activeRelaySocket.write(Buffer.concat([header, payload]), err => {
      if (err) {
        pendingOutputAcks.delete(ackId);
        reject(err);
      }
    });
  });

  const relayServer = net.createServer(socket => {
    activeRelaySocket = socket;
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const size = pending.readUInt32BE(1);
        if (pending.length < size + 5) break;
        const kind = String.fromCharCode(pending[0]);
        const payload = pending.subarray(5, size + 5);
        pending = pending.subarray(size + 5);
        if (kind === "R") {
          resolveRelay({ columns: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) });
          resolveResize();
          if (!relayTextSent) {
            relayTextSent = true;
            const outputId = Buffer.alloc(4); outputId.writeUInt32BE(0x12345678);
            const output = Buffer.concat([outputId, Buffer.from("RELAY_GHOSTTY_SMOKE", "utf8")]);
            const header = Buffer.alloc(5); header[0] = "O".charCodeAt(0); header.writeUInt32BE(output.length, 1);
            socket.write(Buffer.concat([header, output]));
          }
        } else if (kind === "A") {
          const acked = payload.readUInt32BE(0);
          if (acked === 0x12345678) console.log("relay output acknowledged by Ghostty PTY");
          const waiter = pendingOutputAcks.get(acked);
          if (waiter) {
            pendingOutputAcks.delete(acked);
            waiter();
          }
        } else if (kind === "I") {
          const text = payload.toString("utf8");
          if (resolveInput) {
            const resolver = resolveInput;
            resolveInput = null;
            resolver(text);
          } else {
            bufferedInputs.push(text);
          }
        }
      }
    });
  });
  await new Promise((resolve, reject) => { relayServer.once("error", reject); relayServer.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  const id = native.create(window.getNativeWindowHandle(), command, { fontSize: 14, fontFamily: "Menlo", configPath });
  native.update(id, { x: 0, y: 0, width: 900, height: 600, visible: true, focus: true });
  console.log(JSON.stringify({ created: id, initialSize: native.size(id), command }));

  const relayGrid = await Promise.race([relayConnected, delay(5000).then(() => null)]);
  if (!relayGrid) {
    let text = "";
    try { text = native.readText(id); } catch (error) { text = `readText failed: ${String(error)}`; }
    console.error(JSON.stringify({ relayTimeout: socketPath, size: native.size(id), text }));
    throw new Error(`Native Ghostty relay did not connect to ${socketPath}`);
  }
  console.log(JSON.stringify({ relayConnected: relayGrid }));
  let output = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(250);
    try { output = native.readText(id); }
    catch (error) { console.error("readText error while surface alive:", error); break; }
    if (attempt % 4 === 0) console.log(JSON.stringify({ attempt, size: native.size(id), text: output.slice(-600) }));
    if (output.includes("RELAY_GHOSTTY_SMOKE")) break;
  }
  if (!output.includes("RELAY_GHOSTTY_SMOKE")) {
    console.error("Ghostty command produced no expected text; final text:", JSON.stringify(output));
    throw new Error("Ghostty relay output did not render in the native surface");
  }
  native.setReadOnly(id, false);
  const initialInspect = native.inspect(id);
  if (initialInspect.selectedRangeLocation !== 0 || initialInspect.selectedRangeLength !== 0) {
    throw new Error(`Expected idle selectedRange {0, 0}, got ${JSON.stringify(initialInspect)}`);
  }
  native.testIMECommit(id, "に", "日本語_IME_COMMIT");
  const imeRelayInput = await Promise.race([inputReceived, delay(5000).then(() => null)]);
  if (imeRelayInput !== "日本語_IME_COMMIT") throw new Error(`Synthetic IME commit did not reach relay as UTF-8: ${JSON.stringify(imeRelayInput)}`);
  console.log(JSON.stringify({ imeRelayInput }));

  // Active CJK IME marked text + Return (36) must commit ONLY "你好" without trailing "\r" or CSI-u Enter.
  native.testSetMarkedText(id, "nihao", 5, 0);
  const composingInspect = native.inspect(id);
  if (!composingInspect.hasMarkedText || composingInspect.selectedRangeLocation !== 5 || composingInspect.selectedRangeLength !== 0) {
    throw new Error(`Expected composing selectedRange {5, 0}, got ${JSON.stringify(composingInspect)}`);
  }
  inputReceived = nextInput();
  native.testKeyDown(id, 36, 0, "\r", { commitText: "你好" });
  const imeReturnCommit = await Promise.race([inputReceived, delay(5000).then(() => null)]);
  await delay(150);
  if (imeReturnCommit !== "你好" || bufferedInputs.length > 0) {
    throw new Error(`IME Return commit leaked raw Return key: got ${JSON.stringify(imeReturnCommit)}, extra=${JSON.stringify(bufferedInputs)}`);
  }
  const postCommitInspect = native.inspect(id);
  if (postCommitInspect.hasMarkedText || postCommitInspect.selectedRangeLocation !== 0) {
    throw new Error(`Expected post-commit selectedRange {0, 0}, got ${JSON.stringify(postCommitInspect)}`);
  }
  console.log(JSON.stringify({ imeReturnCommit }));

  // Active CJK IME marked text + Space (49) must commit ONLY "世界" without trailing " ".
  native.testSetMarkedText(id, "shijie", 6, 0);
  inputReceived = nextInput();
  native.testKeyDown(id, 49, 0, " ", { commitText: "世界" });
  const imeSpaceCommit = await Promise.race([inputReceived, delay(5000).then(() => null)]);
  await delay(150);
  if (imeSpaceCommit !== "世界" || bufferedInputs.length > 0) {
    throw new Error(`IME Space commit leaked raw Space key: got ${JSON.stringify(imeSpaceCommit)}, extra=${JSON.stringify(bufferedInputs)}`);
  }
  console.log(JSON.stringify({ imeSpaceCommit }));

  // Escape (53) cancelling active preedit must NOT leak "\x1b" into the PTY.
  native.testSetMarkedText(id, "nihao", 5, 0);
  native.testKeyDown(id, 53, 0, "\x1b", { unmark: true });
  await delay(150);
  if (bufferedInputs.length > 0) {
    throw new Error(`IME Escape preedit cancel leaked bytes to PTY: ${JSON.stringify(bufferedInputs)}`);
  }

  inputReceived = nextInput();
  // macOS Return keyCode = 36, NumpadEnter keyCode = 76, NSEventModifierFlagShift = 1 << 17.
  native.testKeyDown(id, 36, 1 << 17, "\r");
  const shiftEnterRelayInput = await Promise.race([inputReceived, delay(5000).then(() => null)]);
  if (shiftEnterRelayInput !== "\x1b[13;2u") throw new Error(`Shift+Enter did not emit CSI-u newline sequence: ${JSON.stringify(shiftEnterRelayInput)}`);
  console.log(JSON.stringify({ shiftEnterRelayInput }));
  inputReceived = nextInput();
  native.testKeyDown(id, 76, 1 << 17, "\x03");
  const shiftNumpadEnterRelayInput = await Promise.race([inputReceived, delay(5000).then(() => null)]);
  if (shiftNumpadEnterRelayInput !== "\x1b[13;2u") throw new Error(`Shift+NumpadEnter did not emit CSI-u newline sequence: ${JSON.stringify(shiftNumpadEnterRelayInput)}`);
  console.log(JSON.stringify({ shiftNumpadEnterRelayInput }));

  // Verify Command+Click on URL inside TUI SGR mouse-reporting mode (\x1b[?1000h\x1b[?1006h):
  // 1) Stationary cursor + Command flagsChanged + click
  // 2) Move with Command held + click
  // 3) Read-only surface Command flagsChanged + click
  // All must invoke onOpenUrl("https://example.com/docs") and emit ZERO "\x1b[<" SGR click bytes.
  bufferedInputs.length = 0;
  resolveInput = null;
  await sendRelayOutput("\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006hVisit https://example.com/docs now\r\n");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    if (native.readText(id, true).includes("https://example.com/docs")) break;
  }
  if (!native.readText(id, true).includes("https://example.com/docs")) {
    throw new Error(`URL text did not render in viewport: ${JSON.stringify(native.readText(id, true))}`);
  }
  const measured = native.size(id);
  const inspected = native.inspect(id);
  const scaleX = measured.width / inspected.boundsWidth;
  const scaleY = measured.height / inspected.boundsHeight;
  const cellWidthPt = measured.cellWidth / scaleX;
  const cellHeightPt = measured.cellHeight / scaleY;
  const linkX = 10.5 * cellWidthPt;
  const linkY = 0.5 * cellHeightPt;
  const COMMAND_MOD = 1 << 20;
  const COMMAND_KEYCODE = 0x37;

  // Case 1: Cursor already resting over URL -> press Command in place -> click -> release Command.
  native.testMouseMove(id, linkX, linkY, 0);
  native.testFlagsChanged(id, COMMAND_KEYCODE, COMMAND_MOD);
  if (native.inspect(id).cursorShape !== "pointer") {
    throw new Error(`Expected pointer cursor on stationary Command press over URL in TUI mode, got ${JSON.stringify(native.inspect(id))}`);
  }
  native.testMouseClick(id, linkX, linkY, COMMAND_MOD);
  await delay(150);
  if (openedUrls.length !== 1 || openedUrls[0].id !== id || openedUrls[0].url !== "https://example.com/docs") {
    throw new Error(`Expected stationary Command+Click to open https://example.com/docs, got ${JSON.stringify(openedUrls)}`);
  }
  if (bufferedInputs.some(chunk => chunk.includes("\x1b[<"))) {
    throw new Error(`Command+Click leaked SGR mouse escape sequence to TUI PTY: ${JSON.stringify(bufferedInputs)}`);
  }
  native.testFlagsChanged(id, COMMAND_KEYCODE, 0);
  if (native.inspect(id).cursorShape === "pointer") {
    throw new Error(`Expected cursor shape to restore after releasing Command, got ${JSON.stringify(native.inspect(id))}`);
  }

  // Case 2: Move away, then move onto URL while holding Command -> click.
  native.testMouseMove(id, linkX, 4.5 * cellHeightPt, 0);
  native.testMouseMove(id, linkX, linkY, COMMAND_MOD);
  if (native.inspect(id).cursorShape !== "pointer") {
    throw new Error(`Expected pointer cursor when moving onto URL with Command in TUI mode, got ${JSON.stringify(native.inspect(id))}`);
  }
  native.testMouseClick(id, linkX, linkY, COMMAND_MOD);
  await delay(150);
  if (openedUrls.length !== 2 || openedUrls[1].url !== "https://example.com/docs") {
    throw new Error(`Expected move+Command+Click to open https://example.com/docs, got ${JSON.stringify(openedUrls)}`);
  }
  if (bufferedInputs.some(chunk => chunk.includes("\x1b[<"))) {
    throw new Error(`Move+Command+Click leaked SGR mouse escape sequence to TUI PTY: ${JSON.stringify(bufferedInputs)}`);
  }

  // Case 3: Read-only surface still updates modifier hover & opens URL without writing to relay.
  native.setReadOnly(id, true);
  native.testMouseMove(id, linkX, 4.5 * cellHeightPt, 0);
  native.testMouseMove(id, linkX, linkY, 0);
  native.testFlagsChanged(id, COMMAND_KEYCODE, COMMAND_MOD);
  if (native.inspect(id).cursorShape !== "pointer") {
    throw new Error(`Expected pointer cursor in readOnly surface on Command press, got ${JSON.stringify(native.inspect(id))}`);
  }
  native.testMouseClick(id, linkX, linkY, COMMAND_MOD);
  await delay(150);
  if (openedUrls.length !== 3 || openedUrls[2].url !== "https://example.com/docs") {
    throw new Error(`Expected readOnly Command+Click to open https://example.com/docs, got ${JSON.stringify(openedUrls)}`);
  }
  if (bufferedInputs.length > 0) {
    throw new Error(`ReadOnly Command+Click unexpectedly emitted relay input: ${JSON.stringify(bufferedInputs)}`);
  }
  native.testFlagsChanged(id, COMMAND_KEYCODE, 0);
  native.setReadOnly(id, false);

  // Case 4: OSC-8 hyperlink Command+Click in TUI mouse-reporting mode.
  await sendRelayOutput("\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006hOpen \x1b]8;;https://osc8.example.com/guide\x07Manual\x1b]8;;\x07 here\r\n");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    if (native.readText(id, true).includes("Open Manual here")) break;
  }
  const oscX = 6.5 * cellWidthPt;
  const oscY = 0.5 * cellHeightPt;
  native.testMouseMove(id, oscX, oscY, 0);
  native.testFlagsChanged(id, COMMAND_KEYCODE, COMMAND_MOD);
  if (native.inspect(id).cursorShape !== "pointer") {
    throw new Error(`Expected pointer cursor over OSC-8 link on Command press in TUI mode, got ${JSON.stringify(native.inspect(id))}`);
  }
  native.testMouseClick(id, oscX, oscY, COMMAND_MOD);
  await delay(150);
  if (openedUrls.length !== 4 || openedUrls[3].url !== "https://osc8.example.com/guide") {
    throw new Error(`Expected OSC-8 Command+Click to open https://osc8.example.com/guide, got ${JSON.stringify(openedUrls)}`);
  }
  if (bufferedInputs.some(chunk => chunk.includes("\x1b[<"))) {
    throw new Error(`OSC-8 Command+Click leaked SGR mouse escape sequence to TUI PTY: ${JSON.stringify(bufferedInputs)}`);
  }
  native.testFlagsChanged(id, COMMAND_KEYCODE, 0);

  await sendRelayOutput("\x1b[?1006l\x1b[?1000l");
  console.log(JSON.stringify({ tuiCmdClickVerified: openedUrls.length }));

  const beforeGrid = native.size(id);
  const replayGrid = native.setGrid(id, 80, 24);
  console.log(JSON.stringify({ beforeGrid, replayGrid }));
  native.update(id, { x: 0, y: 0, width: 900, height: 600, visible: true, preserveGrid: true });
  if (native.size(id).columns !== replayGrid.columns) throw new Error("preserveGrid update changed the replay grid");

  native.destroy(id);
  native.shutdown?.();
  relayServer.close();
  window.close();
  app.exit(0);
}

main().catch(error => {
  console.error(error);
  app.exitCode = 1;
  app.exit(1);
}).finally(() => {
  process.on("exit", () => fs.rmSync(fixture, { recursive: true, force: true }));
});
