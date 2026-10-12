const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-terminal-interaction-"));
app.setPath("userData", path.join(temporary, "profile"));
process.on("exit", () => fs.rmSync(temporary, { recursive: true, force: true }));
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { TerminalPane } from "./apps/desktop/src/renderer/src/TerminalPane";
import { LocaleProvider } from "./apps/desktop/src/renderer/src/locale";
import { readTerminalReadingState, saveTerminalReadingState } from "./apps/desktop/src/renderer/src/workspace/terminal-reading-state";
import { decodeTerminalStreamFrame, encodeTerminalStreamFrame, TerminalStreamKind } from "./apps/desktop/src/shared/terminal-stream";
const open = Terminal.prototype.open;
Terminal.prototype.open = function(...args) { window.term = this; return open.apply(this, args); };
const keyHandler = Terminal.prototype.attachCustomKeyEventHandler;
Terminal.prototype.attachCustomKeyEventHandler = function(handler) { window.keyHandler = handler; return keyHandler.call(this, handler); };
window.inputs = []; window.imageSaves = 0; window.streamOpens = 0; window.streamAttaches = []; window.streamPorts = [];
let first = true;
window.prospero = {
  platform: "darwin",
  getSessionView: async () => {
    if (first) { first = false; return { kind: "pty", mode: "snapshot", cols: 100, rows: 30, seq: 1, ansi: "\\x1b[?2004h" + Array.from({length: 160}, (_, i) => "line " + i).join("\\r\\n") }; }
    return new Promise(resolve => { window.nextFrame = resolve; });
  },
  interact: async (_id, value) => { if (value.type === "term.input") window.inputs.push(value.dataB64); },
  cancelSessionView: async () => {},
  writeClipboard: async () => {},
  openExternal: async () => {},
  saveTerminalClipboardImage: async () => { window.imageSaves++; return { path: "/tmp/My screenshot.png" }; },
  openTerminalStream: async (_id, requestId) => {
    window.streamOpens++;
    const channel = new MessageChannel();
    window.streamPorts.push(channel.port2);
    window.disconnectStream = () => channel.port2.postMessage(encodeTerminalStreamFrame({ kind: TerminalStreamKind.Error, sequence: 0, payload: new TextEncoder().encode(JSON.stringify({ code: "disconnect", message: "fixture disconnect", recoverable: false })) }));
    channel.port2.onmessage = event => {
      const frame = decodeTerminalStreamFrame(event.data, "client");
      if (frame.kind !== TerminalStreamKind.Attach) return;
      window.streamAttaches.push(JSON.parse(new TextDecoder().decode(frame.payload)));
      const hello = new TextEncoder().encode(JSON.stringify({ epoch: "fixture-epoch", clientId: "fixture-client", controllerId: "fixture-client", cols: 100, rows: 30 }));
      channel.port2.postMessage(encodeTerminalStreamFrame({ kind: TerminalStreamKind.Hello, sequence: 0, payload: hello }));
      const first = window.streamAttaches.length === 1;
      const cursor = first ? 1 : 2;
      channel.port2.postMessage(encodeTerminalStreamFrame({ kind: first ? TerminalStreamKind.Snapshot : TerminalStreamKind.Output, sequence: cursor, payload: new TextEncoder().encode(first ? "stream snapshot\\r\\n" : "stream output\\r\\n") }));
      channel.port2.postMessage(encodeTerminalStreamFrame({ kind: TerminalStreamKind.Ready, sequence: cursor, payload: new Uint8Array() }));
    };
    window.postMessage({ type: "terminal:port", requestId }, "*", [channel.port1]);
    return { supported: true };
  },
};
let generation = 0;
const ui = createRoot(document.getElementById("root"));
window.renderPane = (focused = true, status = "running", events = false) => ui.render(<LocaleProvider><TerminalPane key={generation} session={{ id: "fixture", agent: "codex", kind: "pty", cwd: "/tmp", title: "fixture", status, ...(events ? { terminalMode: "events" } : {}) }} focused={focused} fontFamily="monospace" fontSize={13}/></LocaleProvider>);
window.remount = (status = "running", events = false) => { generation++; first = true; window.renderPane(true, status, events); };
window.readReading = () => readTerminalReadingState("fixture");
window.rememberFind = () => saveTerminalReadingState("fixture", { find: "needle", findOpen: false });
window.renderPane();
`;
buildSync({ stdin: { contents: source, loader: "tsx", resolveDir: root }, bundle: true, outfile: path.join(temporary, "fixture.js"), platform: "browser", format: "iife", jsx: "automatic", tsconfig: path.join(root, "apps/desktop/tsconfig.json") });
fs.writeFileSync(path.join(temporary, "index.html"), '<!doctype html><link rel="stylesheet" href="fixture.css"><style>html,body,#root,.terminal-shell{width:100%;height:100%;margin:0}.terminal-host{height:90%;width:100%}.terminal-shell{position:relative}.terminal-find{position:absolute;top:0;z-index:10}</style><div id="root"></div><script src="fixture.js"></script>');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("Terminal interaction check timed out"); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  const run = code => window.webContents.executeJavaScript(code, true);
  const wait = async code => { for (let i = 0; i < 100; i++) { if (await run(`Boolean(${code})`)) return; await delay(30); } throw new Error(`Timed out: ${code}`); };
  try {
    await window.loadFile(path.join(temporary, "index.html"));
    await wait("window.term && !window.term.options.disableStdin && window.nextFrame");
    await run(`(() => {
      const original = term.write.bind(term);
      term.write = (data, done) => original(data, () => { window.finishWrite = done; });
      window.nextFrame({ kind: "pty", mode: "delta", baseSeq: 1, seq: 2, dataB64: btoa("\\r\\nmore output") });
    })()`);
    await wait("window.finishWrite");
    await run("term.options.smoothScrollDuration=0; term.scrollToLine(8); window.finishWrite();");
    await delay(60);
    assert.equal(await run("term.buffer.active.viewportY"), 8, "scrolling during asynchronous output must survive write completion");
    await run('window.nextFrame({ kind: "pty", mode: "events", baseSeq: 2, seq: 3, events: [{ type: "resize", size: { cols: 115, rows: 28 } }] });');
    await wait("term.rows === 28 && term.buffer.active.viewportY === 8");
    assert.equal(await run("term.buffer.active.viewportY"), 8, "an authoritative resize must preserve the saved reading viewport");
    await run(`(() => {
      term.input("中文");
      term._core.coreMouseService.activeProtocol = "VT200";
      term._core.coreMouseService.triggerMouseEvent({ col: 100, row: 4, x: 100, y: 4, button: 0, action: 1, ctrl: false, alt: false, shift: false });
      term.input("after");
    })()`);
    await wait("window.inputs.length === 3");
    const bytes = (await run("window.inputs")).map(value => Buffer.from(value, "base64"));
    assert.deepEqual(Buffer.concat(bytes), Buffer.concat([Buffer.from("中文"), Buffer.from([27, 91, 77, 32, 133, 37]), Buffer.from("after")]));
    await run('window.keyHandler(new KeyboardEvent("keydown",{code:"Enter",key:"Enter",shiftKey:true,cancelable:true}));');
    await wait("window.inputs.length === 4");
    assert.equal(Buffer.from(await run("window.inputs[3]"), "base64").toString(), "\x1b[13;2u");
    assert.equal(await run('window.keyHandler(new KeyboardEvent("keydown",{code:"Enter",key:"Enter",shiftKey:true,isComposing:true,cancelable:true}))'), true);
    await run(`(() => {
      document.querySelector(".xterm-helper-textarea").focus();
      const data = new DataTransfer(); data.items.add(new File(["fixture"], "screenshot.png", { type: "image/png" }));
      document.querySelector(".terminal-host").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    })()`);
    await wait("window.inputs.length === 5");
    assert.equal(await run("window.imageSaves"), 1);
    assert.equal(Buffer.from(await run("window.inputs[4]"), "base64").toString(), '\x1b[200~"/tmp/My screenshot.png"\x1b[201~');
    await run(`(() => {
      window.prospero.saveTerminalClipboardImage = () => new Promise(resolve => { window.finishImage = resolve; });
      const data = new DataTransfer(); data.items.add(new File(["fixture"], "screenshot.png", { type: "image/png" }));
      document.querySelector(".terminal-host").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
      window.renderPane(false);
    })()`);
    await delay(30);
    await run('window.finishImage({ path: "/tmp/late.png" });');
    await delay(30);
    assert.equal(await run("window.inputs.length"), 5, "late image persistence must not type into a pane that lost focus");
    await run("window.renderPane(true);");
    await delay(30);
    await run('window.keyHandler(new KeyboardEvent("keydown",{code:"KeyF",key:"f",metaKey:true,cancelable:true}));');
    await wait('Boolean(document.querySelector(".terminal-find input"))');
    await run('document.querySelector(".terminal-find input").focus(); window.renderPane(false);');
    await delay(30);
    await run("window.renderPane(true);");
    await delay(60);
    assert.equal(await run('document.activeElement === document.querySelector(".terminal-find input")'), true, "pane focus must preserve its search input focus");
    await run('document.querySelector(".terminal-find button:last-child").click(); window.rememberFind(); window.remount();');
    await wait('window.term && !window.term.options.disableStdin && !document.querySelector(".terminal-find")');
    await run('window.keyHandler(new KeyboardEvent("keydown",{code:"KeyF",key:"f",metaKey:true,cancelable:true}));');
    await wait('Boolean(document.querySelector(".terminal-find input"))');
    assert.equal(await run('document.querySelector(".terminal-find input").value'), "needle");
    await run('window.remount("idle", true);');
    await wait('document.querySelector(".terminal-status").textContent.includes("会话已结束")');
    assert.equal(await run("window.streamOpens"), 0);
    await run('window.renderPane(true, "running", true);');
    await wait("window.streamOpens === 1");
    await wait("window.streamAttaches.length === 1");
    assert.deepEqual(await run("window.streamAttaches[0]"), { wantControl: true }, "stream transition must attach from an authoritative cursor and epoch");
    await run('window.renderPane(true, "waiting_input", true);');
    await delay(30);
    await run('window.renderPane(true, "done", true);');
    await delay(30);
    assert.equal(await run("window.streamOpens"), 1);
    assert.equal(await run("window.streamAttaches.length"), 1);
    await run('window.renderPane(true, "running", true);');
    await delay(30);
    await run('window.disconnectStream();');
    await wait('Boolean(document.querySelector(".terminal-control button"))');
    await run('document.querySelector(".terminal-control button").click();');
    await wait("window.streamOpens === 2 && window.streamAttaches.length === 2");
    assert.deepEqual(await run("window.streamAttaches[1]"), { afterSeq: 1, epoch: "fixture-epoch", wantControl: true }, "same-epoch stream reconnect must resume from the committed cursor");
    await run('window.priorTerminal = window.term; window.renderPane(true, "done", true);');
    await wait('document.querySelector(".terminal-status").textContent.includes("会话已结束")');
    assert.equal(await run("window.streamOpens"), 2);
    assert.equal(await run("window.priorTerminal === window.term"), true);
    console.log(JSON.stringify({ ok: true, checks: ["scroll during pending xterm write", "reading viewport survives authoritative resize", "raw DEFAULT mouse bytes and Unicode input ordering", "agent Shift+Enter and IME guard", "screenshot reference through bracketed paste", "late image save rejected after focus change", "search focus preserved on pane focus", "closed search stays closed after remount", "idle startup attaches after becoming live without reattaching on exit"] }));
    clearTimeout(deadline);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.log(await run("({reading:readReading(),viewport:term.buffer.active.viewportY,base:term.buffer.active.baseY,cols:term.cols,rows:term.rows,scroll:term._core._viewport._scrollableElement.getScrollPosition()})"));
    clearTimeout(deadline);
    window.destroy();
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
