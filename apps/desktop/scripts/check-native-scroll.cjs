const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-native-scroll-"));
const bundle = process.env.PROSPERO_NATIVE_GHOSTTY_DIR || path.join(root, "apps/desktop/.native/ghostty");
app.setPath("userData", path.join(dir, "electron"));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const acks = new Map();
const inputs = [];
let socket;
let pending = Buffer.alloc(0);
let seq = 0;
const deadline = setTimeout(() => { console.error("timeout"); app.exit(1); }, 60000);

function write(bytes) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const header = Buffer.alloc(9);
    header[0] = 79;
    header.writeUInt32BE(bytes.length + 4, 1);
    header.writeUInt32BE(id, 5);
    acks.set(id, resolve);
    socket.write(Buffer.concat([header, bytes]), (error) => { if (error) reject(error); });
  });
}

function stats(values) {
  values.sort((a, b) => a - b);
  return { p50: values[Math.floor(values.length * 0.5)], p95: values[Math.floor(values.length * 0.95)], max: values.at(-1) };
}

async function main() {
  await app.whenReady();
  const native = require(path.join(bundle, "ghostty.node"));
  native.initialize(path.join(bundle, "config"), path.join(bundle, "resources"));
  const window = new BrowserWindow({ width: 1600, height: 1000, show: false });
  await window.loadURL("data:text/html,<html/>");
  const socketPath = path.join(dir, "terminal.sock");
  let connected;
  const ready = new Promise((resolve) => { connected = resolve; });
  const server = net.createServer((client) => {
    socket = client;
    connected();
    client.on("data", (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        const kind = pending[0];
        const payload = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        if (kind === 65) {
          const id = payload.readUInt32BE(0);
          acks.get(id)?.();
          acks.delete(id);
        }
        if (kind === 73) inputs.push(payload.toString());
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const id = native.create(window.getNativeWindowHandle(), `direct:${bundle}/prospero-terminal-relay ${socketPath}`, {
    fontSize: 14, fontFamily: "Menlo", configPath: path.join(bundle, "config"),
  });
  native.update(id, { x: 0, y: 0, width: 1600, height: 1000, visible: true });
  window.showInactive();
  await ready;
  native.setReadOnly(id, false);
  native.update(id, { x: 0, y: 0, width: 1600, height: 1000, visible: true, focus: true });

  const history = Buffer.from(Array.from({ length: 10000 }, (_, i) => `line-${i} 中文历史输出 👩‍💻 ${"abcdef 中文 ".repeat(12)}\r\n`).join(""));
  for (let i = 0; i < history.length; i += 48000) await write(history.subarray(i, i + 48000));
  await delay(500);
  const results = [];
  for (const workload of ["idle", "output", "sync-output", "held-sync"]) {
    native.bindingAction(id, "scroll_to_bottom");
    await delay(100);
    let timer;
    if (workload === "held-sync") await write(Buffer.from("\x1b[?2026h"));
    if (workload === "output" || workload === "sync-output") {
      timer = setInterval(() => {
        const frame = `\x1b[60;1HWorking ${Date.now()}\x1b[K`;
        void write(Buffer.from(workload === "sync-output" ? `\x1b[?2026h${frame}\x1b[?2026l` : frame));
      }, 16);
    }
    const callTimes = [], eventGaps = [], drawGaps = [];
    let previous = performance.now();
    let lastDraw = native.inspect(id);
    const initialDraw = lastDraw.scrollFrameCount;
    let lastDrawObserved = performance.now();
    for (let i = 0; i < 240; i++) {
      await delay(8);
      const start = performance.now();
      eventGaps.push(start - previous);
      previous = start;
      native.testScroll(id, 0, i < 120 ? 12 : -12, true);
      callTimes.push(performance.now() - start);
      const draw = native.inspect(id);
      if (draw.scrollFrameCount !== lastDraw.scrollFrameCount) {
        const now = performance.now();
        drawGaps.push(now - lastDrawObserved);
        lastDrawObserved = now;
        lastDraw = draw;
      }
    }
    clearInterval(timer);
    await write(Buffer.from("\x1b[?2026l"));
    results.push({ workload, scrollMs: stats(callTimes), eventGapMs: stats(eventGaps), drawGapMs: stats(drawGaps), draws: lastDraw.scrollFrameCount - initialDraw });
  }

  for (const mode of ["mouse", "alternate"]) {
    await write(Buffer.from(mode === "mouse" ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1049h\x1b[?1007h"));
    await write(Buffer.from("\x1b[?2026h"));
    await delay(30);
    inputs.length = 0;
    native.testMouseMove(id, 100, 100, 0);
    native.testScroll(id, 0, 24, true);
    await write(Buffer.from("\x1b[?2026$p"));
    await delay(50);
    const response = inputs.join("");
    assert(response.includes("\x1b[?2026;1$y"), `${mode} scrolling must retain synchronized output: ${JSON.stringify(response)}`);
    assert(mode === "mouse" ? response.includes("\x1b[<64;") : /\x1b(?:\[A|OA)/.test(response), `${mode} scrolling must still reach the application`);
    await write(Buffer.from("\x1b[?2026l\x1b[?1000l\x1b[?1006l\x1b[?1049l"));
  }
  console.log(JSON.stringify({ results }));
  const held = results.find((result) => result.workload === "held-sync");
  assert(held.drawGapMs.max < 300, `Local scrolling must not wait for the synchronized-output timeout: ${JSON.stringify(held)}`);
  assert(held.draws > 180, "Local scroll redraws must progress while synchronized output is active");
  native.destroy(id);
  server.close();
  clearTimeout(deadline);
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => { console.error(error); app.exit(1); });
